import { parse as parseYaml } from "@std/yaml";
import { RE2 } from "re2-wasm";
import type { Node } from "web-tree-sitter";
import type { LanguageId } from "./grammar.ts";
import { type CaptureValue, type Match, matchNode } from "./matcher.ts";
import { type CompiledPattern, compilePattern, scanMetavariables } from "./pattern.ts";
import { semanticsFor, units } from "./semantics.ts";
import { SourceFile } from "./source_file.ts";

export type Severity = "error" | "warn" | "info" | "off";

type StopBy = "neighbor" | "end" | { kind: string };
type Regex = InstanceType<typeof RE2>;

type CompiledExpression =
  | { type: "pattern"; pattern: CompiledPattern }
  | { type: "kind"; kind: string }
  | { type: "regex"; regex: Regex }
  | { type: "all" | "any"; children: CompiledExpression[] }
  | { type: "not"; child: CompiledExpression }
  | {
    type: "inside" | "has" | "follows" | "precedes";
    child: CompiledExpression;
    stopBy: StopBy;
  }
  | { type: "matches"; target: CompiledExpression };

type CompiledConstraint = { name: string; expression: CompiledExpression };

export type LoadedRule = {
  version: 1;
  id: string;
  language: LanguageId;
  severity: Severity;
  message: string;
  rule: CompiledExpression;
  constraints: readonly CompiledConstraint[];
  utils: ReadonlyMap<string, CompiledExpression>;
  fix?: string;
  note?: string;
  url?: string;
  metaVarPrefix: string;
  engine: "ast";
  /** Compatibility handle for existing pattern-only callers. */
  pattern?: CompiledPattern;
};

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleLoadError";
  }
}

export async function loadRule(path: string | URL): Promise<LoadedRule> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new RuleLoadError(`cannot read rule file: ${errorMessage(error)}`);
  }
  return await loadRuleText(text);
}

/** Compiles one YAML rule document without performing filesystem I/O. */
export async function loadRuleText(text: string): Promise<LoadedRule> {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new RuleLoadError(`invalid YAML: ${errorMessage(error)}`);
  }

  try {
    return await compileDocument(record(value, "rule file"));
  } catch (error) {
    if (error instanceof RuleLoadError) throw error;
    throw new RuleLoadError(errorMessage(error));
  }
}

/** Evaluates a compiled rule against every valid candidate node in source order. */
export function findRuleMatches(rule: LoadedRule, source: SourceFile): Match[] {
  if (rule.severity === "off") return [];
  const result: Match[] = [];
  const context: EvalContext = { source, semantics: semanticsFor(rule.language) };
  const cursor = source.tree.walk();
  visit();
  cursor.delete();
  return result;

  function visit() {
    if (cursor.nodeType === "ERROR" || cursor.nodeIsMissing) return;
    const node = cursor.currentNode;
    const captures = evaluate(rule.rule, node, new Map(), context);
    if (captures && constraintsPass(rule.constraints, node, captures, context)) {
      result.push({ root: source.rangeOf(node), captures });
    }
    if (cursor.gotoFirstChild()) {
      do visit(); while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
}

async function compileDocument(document: Record<string, unknown>): Promise<LoadedRule> {
  if ("extends" in document) throw new RuleLoadError("extends is not supported");
  onlyKeys(
    document,
    [
      "version",
      "id",
      "language",
      "severity",
      "message",
      "rule",
      "constraints",
      "utils",
      "fix",
      "note",
      "url",
      "metaVarPrefix",
      "engine",
    ],
    "rule file",
  );

  if (document.version !== 1) throw new RuleLoadError("version must be the number 1");
  const id = string(document, "id");
  if (id.startsWith("tool/")) throw new RuleLoadError("id must not use the tool/ prefix");
  const language = string(document, "language");
  if (language !== "typescript" && language !== "python") {
    throw new RuleLoadError(`unsupported language: ${language}`);
  }
  const severity = string(document, "severity");
  if (severity !== "error" && severity !== "warn" && severity !== "info" && severity !== "off") {
    throw new RuleLoadError(`unsupported severity: ${severity}`);
  }
  const message = string(document, "message");
  const engine = document.engine === undefined ? "ast" : string(document, "engine");
  if (engine !== "ast") throw new RuleLoadError(`unsupported engine: ${engine}`);
  const metaVarPrefix = document.metaVarPrefix === undefined
    ? "$"
    : string(document, "metaVarPrefix");

  // Reuse the pattern scanner for prefix validation and every capture reference vocabulary.
  scanMetavariables("", metaVarPrefix, language, true);
  const rawUtils = document.utils === undefined ? {} : record(document.utils, "utils");
  const compiledUtils = new Map<string, CompiledExpression>();
  const compiling = new Set<string>();
  const arities = new Map<string, boolean>();

  const compileUtil = async (name: string): Promise<CompiledExpression> => {
    const existing = compiledUtils.get(name);
    if (existing) return existing;
    if (!(name in rawUtils)) throw new RuleLoadError(`unknown util: ${name}`);
    if (compiling.has(name)) throw new RuleLoadError(`cyclic util reference: ${name}`);
    compiling.add(name);
    const compiled = await compileExpression(rawUtils[name], `utils.${name}`, compileUtil, {
      language,
      metaVarPrefix,
      arities,
    });
    compiling.delete(name);
    compiledUtils.set(name, compiled);
    return compiled;
  };

  for (const name of Object.keys(rawUtils)) await compileUtil(name);
  const rule = await compileExpression(document.rule, "rule", compileUtil, {
    language,
    metaVarPrefix,
    arities,
  });

  for (const [name, util] of compiledUtils) {
    if (expandedDepth(util) > 32) throw new RuleLoadError(`utils.${name} exceeds depth 32`);
  }
  if (expandedDepth(rule) > 32) throw new RuleLoadError("rule exceeds depth 32");

  const guaranteed = guaranteedBindings(rule);
  const refs = [
    ...templateReferences(message, metaVarPrefix, language, arities, "message"),
  ];
  const fix = optionalString(document, "fix");
  if (fix !== undefined) {
    refs.push(...templateReferences(fix, metaVarPrefix, language, arities, "fix"));
  }

  const constraints: CompiledConstraint[] = [];
  const rawConstraints = document.constraints === undefined
    ? {}
    : record(document.constraints, "constraints");
  for (const [key, rawConstraint] of Object.entries(rawConstraints)) {
    const name = constraintName(key, metaVarPrefix, language, arities);
    requireGuaranteed(name, guaranteed, `constraints key ${key}`);
    const expression = await compileExpression(
      rawConstraint,
      `constraints.${key}`,
      compileUtil,
      { language, metaVarPrefix, arities },
    );
    if (expandedDepth(expression) > 32) {
      throw new RuleLoadError(`constraints.${key} exceeds depth 32`);
    }
    for (const referenced of expressionBindings(expression)) {
      requireGuaranteed(referenced, guaranteed, `constraints.${key}`);
    }
    constraints.push({ name, expression });
  }
  for (const ref of refs) requireGuaranteed(ref, guaranteed, "template");

  return {
    version: 1,
    id,
    language,
    severity,
    message,
    rule,
    constraints,
    utils: compiledUtils,
    fix,
    note: optionalString(document, "note"),
    url: optionalString(document, "url"),
    metaVarPrefix,
    engine: "ast",
    pattern: rule.type === "pattern" ? rule.pattern : undefined,
  };
}

type CompileContext = {
  language: LanguageId;
  metaVarPrefix: string;
  arities: Map<string, boolean>;
};

async function compileExpression(
  value: unknown,
  field: string,
  compileUtil: (name: string) => Promise<CompiledExpression>,
  context: CompileContext,
): Promise<CompiledExpression> {
  const expression = record(value, field);
  const keys = Object.keys(expression);
  if (keys.length !== 1) {
    throw new RuleLoadError(`${field} must contain exactly one combinator`);
  }
  const key = keys[0];
  if (!COMBINATORS.has(key)) throw new RuleLoadError(`${field} has unsupported combinator: ${key}`);
  const payload = expression[key];

  switch (key) {
    case "pattern": {
      const pattern = await compilePatternValue(payload, field, context);
      recordPatternArities(pattern, context.arities, field);
      return { type: "pattern", pattern };
    }
    case "kind":
      return { type: "kind", kind: string(expression, key, `${field}.kind`) };
    case "regex": {
      const source = string(expression, key, `${field}.regex`);
      try {
        return { type: "regex", regex: new RE2(source, "u") };
      } catch (error) {
        throw new RuleLoadError(`${field}.regex: ${errorMessage(error)}`);
      }
    }
    case "all":
    case "any": {
      if (!Array.isArray(payload)) throw new RuleLoadError(`${field}.${key} must be an array`);
      const children: CompiledExpression[] = [];
      for (let i = 0; i < payload.length; i++) {
        children.push(
          await compileExpression(payload[i], `${field}.${key}[${i}]`, compileUtil, context),
        );
      }
      return { type: key, children };
    }
    case "not":
      return {
        type: "not",
        child: await compileExpression(payload, `${field}.not`, compileUtil, context),
      };
    case "inside":
    case "has":
    case "follows":
    case "precedes": {
      const relation = record(payload, `${field}.${key}`);
      onlyKeys(relation, [...COMBINATORS, "stopBy"], `${field}.${key}`);
      const childKeys = Object.keys(relation).filter((item) => item !== "stopBy");
      if (childKeys.length !== 1) {
        throw new RuleLoadError(`${field}.${key} must contain exactly one combinator`);
      }
      const childKey = childKeys[0];
      const child = await compileExpression(
        { [childKey]: relation[childKey] },
        `${field}.${key}`,
        compileUtil,
        context,
      );
      return { type: key, child, stopBy: compileStopBy(relation.stopBy, `${field}.${key}`) };
    }
    case "matches":
      return {
        type: "matches",
        target: await compileUtil(string(expression, key, `${field}.matches`)),
      };
  }
  throw new RuleLoadError(`${field} has unsupported combinator: ${key}`);
}

async function compilePatternValue(
  value: unknown,
  field: string,
  context: CompileContext,
): Promise<CompiledPattern> {
  try {
    if (typeof value === "string") {
      return await compilePattern(value, context.language, {
        metaVarPrefix: context.metaVarPrefix,
      });
    }
    const options = record(value, `${field}.pattern`);
    onlyKeys(options, ["context", "selector"], `${field}.pattern`);
    const patternContext = string(options, "context", `${field}.pattern.context`);
    const selector = string(options, "selector", `${field}.pattern.selector`);
    return await compilePattern("", context.language, {
      context: patternContext,
      selector,
      metaVarPrefix: context.metaVarPrefix,
    });
  } catch (error) {
    throw new RuleLoadError(`${field}.pattern: ${errorMessage(error)}`);
  }
}

function compileStopBy(value: unknown, field: string): StopBy {
  if (value === undefined || value === "neighbor") return "neighbor";
  if (value === "end") return "end";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const boundary = value as Record<string, unknown>;
    onlyKeys(boundary, ["kind"], `${field}.stopBy`);
    if (Object.keys(boundary).length === 1) {
      return { kind: string(boundary, "kind", `${field}.stopBy.kind`) };
    }
  }
  throw new RuleLoadError(`${field}.stopBy must be neighbor, end, or {kind: string}`);
}

function evaluate(
  expression: CompiledExpression,
  node: Node,
  captures: ReadonlyMap<string, CaptureValue>,
  context: EvalContext,
): Map<string, CaptureValue> | undefined {
  switch (expression.type) {
    case "pattern":
      return matchNode(expression.pattern, node, context.source, captures)?.captures;
    case "kind":
      return node.type === expression.kind ? new Map(captures) : undefined;
    case "regex":
      return expression.regex.test(context.source.sourceText(context.source.rangeOf(node)))
        ? new Map(captures)
        : undefined;
    case "all": {
      let current = new Map(captures);
      for (const child of expression.children) {
        const next = evaluate(child, node, current, context);
        if (!next) return undefined;
        current = next;
      }
      return current;
    }
    case "any":
      for (const child of expression.children) {
        const result = evaluate(child, node, captures, context);
        if (result) return result;
      }
      return undefined;
    case "not":
      return evaluate(expression.child, node, captures, context) ? undefined : new Map(captures);
    case "matches":
      return evaluate(expression.target, node, captures, context);
    case "inside":
    case "has":
    case "follows":
    case "precedes":
      for (const candidate of relatedNodes(expression.type, node, expression.stopBy, context)) {
        const result = evaluate(expression.child, candidate, captures, context);
        if (result) return result;
      }
      return undefined;
  }
}

function* relatedNodes(
  relation: "inside" | "has" | "follows" | "precedes",
  node: Node,
  stopBy: StopBy,
  context: EvalContext,
): Generator<Node> {
  if (relation === "inside") {
    for (let current = node.parent; current; current = current.parent) {
      yield current;
      if (stopBy === "neighbor" || isBoundary(current, stopBy)) return;
    }
    return;
  }
  if (relation === "has") {
    const visit = function* (parent: Node): Generator<Node> {
      for (const { node: child } of units(parent, context.semantics)) {
        if (context.source.isInsideParseProblem(child)) continue;
        yield child;
        if (stopBy !== "neighbor" && !isBoundary(child, stopBy)) yield* visit(child);
      }
    };
    yield* visit(node);
    return;
  }

  const parent = node.parent;
  if (!parent) return;
  const siblings = units(parent, context.semantics).map((unit) => unit.node);
  const index = siblings.findIndex((sibling) => sibling.id === node.id);
  if (index < 0) return;
  const candidates = relation === "follows"
    ? siblings.slice(0, index).reverse()
    : siblings.slice(index + 1);
  for (const sibling of candidates) {
    if (context.source.isInsideParseProblem(sibling)) continue;
    yield sibling;
    if (stopBy === "neighbor" || isBoundary(sibling, stopBy)) return;
  }
}

function constraintsPass(
  constraints: readonly CompiledConstraint[],
  matchRoot: Node,
  captures: ReadonlyMap<string, CaptureValue>,
  context: EvalContext,
): boolean {
  for (const constraint of constraints) {
    const value = constraint.name === "MATCH"
      ? { kind: "single" as const, node: matchRoot }
      : captures.get(constraint.name);
    if (!value) return false;
    const nodes = value.kind === "single" ? [value.node] : value.nodes;
    for (const node of nodes) {
      if (!evaluate(constraint.expression, node, captures, context)) return false;
    }
  }
  return true;
}

function guaranteedBindings(expression: CompiledExpression): Set<string> {
  switch (expression.type) {
    case "pattern":
      return patternBindings(expression.pattern);
    case "kind":
    case "regex":
    case "not":
      return new Set();
    case "all":
      return union(expression.children.map(guaranteedBindings));
    case "any":
      return intersection(expression.children.map(guaranteedBindings));
    case "inside":
    case "has":
    case "follows":
    case "precedes":
      return guaranteedBindings(expression.child);
    case "matches":
      return guaranteedBindings(expression.target);
  }
}

function expressionBindings(expression: CompiledExpression): Set<string> {
  switch (expression.type) {
    case "pattern":
      return patternBindings(expression.pattern);
    case "kind":
    case "regex":
      return new Set();
    case "all":
    case "any":
      return union(expression.children.map(expressionBindings));
    case "not":
    case "inside":
    case "has":
    case "follows":
    case "precedes":
      return expressionBindings(expression.child);
    case "matches":
      return expressionBindings(expression.target);
  }
}

function patternBindings(pattern: CompiledPattern): Set<string> {
  return new Set([...pattern.metavars.values()].flatMap((meta) => meta.name ? [meta.name] : []));
}

function recordPatternArities(
  pattern: CompiledPattern,
  arities: Map<string, boolean>,
  field: string,
) {
  for (const meta of pattern.metavars.values()) {
    if (meta.name) recordArity(meta.name, meta.variadic, arities, field);
  }
}

function templateReferences(
  text: string,
  prefix: string,
  language: LanguageId,
  arities: Map<string, boolean>,
  field: string,
): string[] {
  return scanMetavariables(text, prefix, language, true).flatMap(({ meta }) => {
    if (!meta.name) return [];
    if (meta.name === "MATCH") {
      if (meta.variadic) throw new RuleLoadError(`${field}: MATCH reference must be single`);
      return [meta.name];
    }
    recordArity(meta.name, meta.variadic, arities, field);
    return [meta.name];
  });
}

function constraintName(
  key: string,
  prefix: string,
  language: LanguageId,
  arities: Map<string, boolean>,
): string {
  const occurrences = scanMetavariables(key, prefix, language, true);
  const occurrence = occurrences[0];
  if (
    occurrences.length !== 1 || occurrence.start !== 0 || occurrence.end !== key.length ||
    !occurrence.meta.name
  ) {
    throw new RuleLoadError(`constraint key must be one named metavariable: ${key}`);
  }
  if (occurrence.meta.name === "MATCH" && occurrence.meta.variadic) {
    throw new RuleLoadError("MATCH constraint must be single");
  }
  if (occurrence.meta.name !== "MATCH") {
    recordArity(occurrence.meta.name, occurrence.meta.variadic, arities, `constraints key ${key}`);
  }
  return occurrence.meta.name;
}

function recordArity(
  name: string,
  variadic: boolean,
  arities: Map<string, boolean>,
  field: string,
) {
  const prior = arities.get(name);
  if (prior !== undefined && prior !== variadic) {
    throw new RuleLoadError(`${field}: metavariable arity mismatch: ${name}`);
  }
  arities.set(name, variadic);
}

function requireGuaranteed(name: string, guaranteed: Set<string>, field: string) {
  if (name !== "MATCH" && !guaranteed.has(name)) {
    throw new RuleLoadError(`${field}: undefined capture reference: ${name}`);
  }
}

function expandedDepth(
  expression: CompiledExpression,
  memo = new Map<CompiledExpression, number>(),
): number {
  const known = memo.get(expression);
  if (known) return known;
  let depth: number;
  switch (expression.type) {
    case "pattern":
    case "kind":
    case "regex":
      depth = 1;
      break;
    case "matches":
      depth = expandedDepth(expression.target, memo);
      break;
    case "not":
    case "inside":
    case "has":
    case "follows":
    case "precedes":
      depth = 1 + expandedDepth(expression.child, memo);
      break;
    case "all":
    case "any":
      depth = 1 + Math.max(0, ...expression.children.map((child) => expandedDepth(child, memo)));
      break;
  }
  memo.set(expression, depth);
  return depth;
}

function union(sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersection(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]].filter((name) => sets.slice(1).every((set) => set.has(name))));
}

function isBoundary(node: Node, stopBy: StopBy): boolean {
  return typeof stopBy === "object" && node.type === stopBy.kind;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuleLoadError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: Record<string, unknown>, key: string, field = key): string {
  if (typeof value[key] !== "string") throw new RuleLoadError(`${field} must be a string`);
  return value[key];
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined) return undefined;
  return string(value, key);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new RuleLoadError(`${field} has unsupported field: ${unknown}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EvalContext = {
  source: SourceFile;
  semantics: ReturnType<typeof semanticsFor>;
};

const COMBINATORS = new Set([
  "pattern",
  "kind",
  "regex",
  "all",
  "any",
  "not",
  "inside",
  "has",
  "follows",
  "precedes",
  "matches",
]);
