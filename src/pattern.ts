import type { Node } from "web-tree-sitter";
import { type LanguageId } from "./grammar.ts";
import { SourceFile } from "./source_file.ts";
import {
  type ComparisonUnit,
  type LanguageSemantics,
  semanticsFor,
  transparentNode,
  units,
} from "./semantics.ts";

export type Metavariable = { name?: string; variadic: boolean };

export type MatcherNode = {
  type: string;
  meta?: Metavariable;
  leafText?: string;
  fixed: MatcherUnit[][];
  variadics: MatcherUnit[];
  /** 
   * True if the node has no trailing anchor token (such as `)` or `}`).
   * Open-ended nodes use prefix matching: once all pattern comparison units
   * are consumed, remaining comparison units in the target are ignored,
   * matching ast-grep's MatchSeq semantics (§4.3.2, step 6).
   */
  openEnded: boolean;
};

export type MatcherUnit = ComparisonUnit<MatcherNode>;

export type CompiledPattern = {
  source: SourceFile;
  root: Node;
  metavars: Map<number, Metavariable>;
  matcherRoot: MatcherNode;
  language: LanguageId;
  rootType?: string;
};

type Occurrence = {
  start: number;
  end: number;
  meta: Metavariable;
};

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export async function compilePattern(
  text: string,
  lang: LanguageId,
  opts: { context?: string; selector?: string; metaVarPrefix?: string } = {},
): Promise<CompiledPattern> {
  const prefix = opts.metaVarPrefix ?? "$";
  validatePrefix(prefix);

  const input = opts.context ?? text;
  const replaced = replaceMetavars(input, prefix, lang);
  const source = await SourceFile.parse(lang, replaced.text);
  if (source.parseProblems.length > 0) {
    const problem = source.parseProblems[0];
    throw new CompileError(`pattern parse error: ${problem.type}`);
  }

  const root = opts.selector
    ? selectRoot(source.tree.rootNode, opts.selector)
    : selectSingleRoot(source.tree.rootNode, lang);
  const metavars = restoreMetavars(source.tree.rootNode, root, replaced.occurrences);

  if (opts.selector) {
    for (const id of metavars.keys()) {
      const node = findById(source.tree.rootNode, id);
      if (!node || !contains(root, node)) {
        throw new CompileError("metavariable outside selector root");
      }
    }
  }

  if (metavars.get(root.id)?.variadic) {
    throw new CompileError("variadic metavariable cannot be pattern root");
  }
  rejectAdjacentVariadics(root, lang, metavars);

  const semantics = semanticsFor(lang);
  const matchRoot = transparentNode(root, semantics).node;
  const rootType = metavars.has(matchRoot.id) ? undefined : matchRoot.type;
  const matcherRoot = compileMatcherNode(root, source, metavars, semantics);
  return { source, root, metavars, matcherRoot, language: lang, rootType };
}

function compileMatcherNode(
  raw: Node,
  source: SourceFile,
  metavars: Map<number, Metavariable>,
  semantics: LanguageSemantics,
): MatcherNode {
  const node = transparentNode(raw, semantics).node;
  const meta = metavars.get(node.id);
  const result: MatcherNode = {
    type: node.type,
    meta,
    fixed: [[]],
    variadics: [],
    openEnded: false,
  };
  if (meta) return result;
  if (node.children.length === 0) {
    result.leafText = source.text.slice(node.startIndex, node.endIndex);
    return result;
  }

  const nodeUnits = units(node, semantics);
  result.openEnded = nodeUnits.length > 0 &&
    node.lastChild?.id === nodeUnits[nodeUnits.length - 1].node.id;
  for (const unit of nodeUnits) {
    const compiled = {
      node: compileMatcherNode(unit.node, source, metavars, semantics),
      field: unit.field,
    };
    if (compiled.node.meta?.variadic) {
      result.variadics.push(compiled);
      result.fixed.push([]);
    } else {
      result.fixed[result.fixed.length - 1].push(compiled);
    }
  }
  return result;
}

function validatePrefix(prefix: string) {
  if (prefix.length === 0) throw new CompileError("metaVarPrefix must not be empty");
  if (/[A-Z0-9_\s]/.test(prefix)) {
    throw new CompileError("metaVarPrefix must not contain name characters or whitespace");
  }
}

function replaceMetavars(input: string, prefix: string, lang: LanguageId) {
  const assigned = new Map<string, { placeholder: string; meta: Metavariable }>();
  const usedPlaceholders = new Set<string>();
  const arityByName = new Map<string, boolean>();
  const occurrences: Occurrence[] = [];
  let nextPlaceholder = 0;
  let output = "";

  // Pure text scan. DO NOT track strings or comments here.
  for (let i = 0; i < input.length;) {
    if (!input.startsWith(prefix, i)) {
      const char = codePointAt(input, i);
      output += char;
      i += char.length;
      continue;
    }

    let k = 0;
    while (input.startsWith(prefix, i + k * prefix.length)) k++;
    const runEnd = i + k * prefix.length;

    // if blocked by an identifier char, consume the whole prefix run as literal text.
    if (isIdentifierChar(codePointBefore(input, i), lang)) {
      output += input.slice(i, runEnd);
      i = runEnd;
      continue;
    }

    const nameEnd = identifierRunEnd(input, runEnd, lang);
    const rawName = input.slice(runEnd, nameEnd);
    // keep the prefix run as literal text for empty identifier.
    if (rawName.length === 0) {
      output += input.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    // Non-name chars make the whole candidate literal text.
    if (![...rawName].every(isNameChar)) {
      output += input.slice(i, nameEnd);
      i = nameEnd;
      continue;
    }
    // Pure name: choose arity from the prefix run length.
    if (k !== 1 && k !== 3) {
      throw new CompileError(`invalid metavariable prefix run length: ${k}`);
    }
    if (rawName === "MATCH") throw new CompileError("MATCH is a reserved metavariable name");

    const variadic = k === 3;
    const name = rawName.startsWith("_") ? undefined : rawName;
    if (name) {
      const prior = arityByName.get(name);
      if (prior !== undefined && prior !== variadic) {
        throw new CompileError(`metavariable arity mismatch: ${name}`);
      }
      arityByName.set(name, variadic);
    }

    const key = `${variadic ? "multi" : "single"}:${name ?? `_${rawName}`}`;
    let found = assigned.get(key);
    if (!found) {
      const next = nextAvailablePlaceholder(input, usedPlaceholders, nextPlaceholder);
      nextPlaceholder = next.index + 1;
      const placeholder = next.placeholder;
      found = { placeholder, meta: { name, variadic } };
      assigned.set(key, found);
      usedPlaceholders.add(placeholder);
    }

    occurrences.push({
      start: output.length,
      end: output.length + found.placeholder.length,
      meta: found.meta,
    });
    output += found.placeholder;
    i = nameEnd;
  }

  return { text: output, occurrences };
}

function nextAvailablePlaceholder(
  input: string,
  used: Set<string>,
  start: number,
): { placeholder: string; index: number } {
  for (let n = start;; n++) {
    const candidate = `__stx_meta_${n}__`;
    if (!input.includes(candidate) && !used.has(candidate)) {
      return { placeholder: candidate, index: n };
    }
  }
}

function restoreMetavars(root: Node, patternRoot: Node, occurrences: Occurrence[]) {
  const metavars = new Map<number, Metavariable>();
  for (const occ of occurrences) {
    // Whole-token check: the smallest covering node must exactly match the occurrence.
    // Leaf text checks miss token-like nodes that contain child nodes.
    let node = smallestCovering(root, occ.start, occ.end);
    if (node.startIndex !== occ.start || node.endIndex !== occ.end) {
      throw new CompileError("metavariable must occupy a whole token");
    }
    // Restore by climbing equal-range ancestors, stopping at the pattern root.
    while (
      node.parent &&
      node.id !== patternRoot.id &&
      node.parent.startIndex === occ.start &&
      node.parent.endIndex === occ.end
    ) {
      node = node.parent;
    }
    metavars.set(node.id, occ.meta);
  }
  return metavars;
}

function smallestCovering(root: Node, start: number, end: number): Node {
  let node = root;
  descend: while (true) {
    for (const child of node.children) {
      if (child && child.startIndex <= start && child.endIndex >= end) {
        node = child;
        continue descend;
      }
    }
    return node;
  }
}

function selectSingleRoot(root: Node, lang: LanguageId): Node {
  const semantics = semanticsFor(lang);
  const rootUnits = units(root, semantics);
  if (rootUnits.length !== 1) {
    throw new CompileError(`pattern must have exactly one root node, got ${rootUnits.length}`);
  }
  const selected = rootUnits[0].node;
  if (selected.type !== "expression_statement") return selected;

  const expressionUnits = units(selected, semantics);
  return expressionUnits.length === 1 ? expressionUnits[0].node : selected;
}

function selectRoot(root: Node, selector: string): Node {
  const selected = findFirst(root, (node) => node.type === selector);
  if (!selected) throw new CompileError(`selector kind not found: ${selector}`);
  return selected;
}

function rejectAdjacentVariadics(
  root: Node,
  lang: LanguageId,
  metavars: Map<number, Metavariable>,
) {
  const semantics = semanticsFor(lang);
  visit(root);

  function visit(node: Node) {
    let previousVariadic = false;
    for (const unit of units(node, semantics)) {
      const variadic = metavars.get(unit.node.id)?.variadic === true;
      if (previousVariadic && variadic) {
        throw new CompileError("adjacent variadic metavariables are not allowed");
      }
      previousVariadic = variadic;
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  }
}

function findFirst(root: Node, predicate: (node: Node) => boolean): Node | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) {
    if (!child) continue;
    const found = findFirst(child, predicate);
    if (found) return found;
  }
}

function findById(root: Node, id: number): Node | undefined {
  return findFirst(root, (node) => node.id === id);
}

function contains(root: Node, child: Node): boolean {
  for (let current: Node | null = child; current; current = current.parent) {
    if (current.id === root.id) return true;
  }
  return false;
}

function isNameChar(char: string): boolean {
  return /^[A-Z0-9_]$/.test(char);
}

function isIdentifierChar(char: string, lang: LanguageId): boolean {
  if (char.length === 0) return false;
  if (lang === "typescript" && char === "$") return true;
  return /^[_\p{L}\p{N}\p{M}\p{Pc}\u200c\u200d]$/u.test(char);
}

function identifierRunEnd(input: string, start: number, lang: LanguageId): number {
  let end = start;
  while (end < input.length) {
    const char = codePointAt(input, end);
    if (!isIdentifierChar(char, lang)) break;
    end += char.length;
  }
  return end;
}

function codePointAt(input: string, index: number): string {
  return index < input.length ? String.fromCodePoint(input.codePointAt(index)!) : "";
}

function codePointBefore(input: string, index: number): string {
  if (index <= 0) return "";
  const code = input.charCodeAt(index - 1);
  const start = code >= 0xdc00 && code <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(input, start);
}
