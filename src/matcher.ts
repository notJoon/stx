import type { Node } from "web-tree-sitter";
import type { CompiledPattern, Metavariable } from "./pattern.ts";
import { type ByteRange, SourceFile } from "./source_file.ts";
import { type ComparisonUnit, semanticsFor, units } from "./semantics.ts";

/** Captured target syntax from a named metavariable binding. */
export type CaptureValue =
  | { kind: "single"; node: Node }
  | { kind: "multi"; nodes: Node[]; span: ByteRange };

/** A successful structural match rooted at a target source range. */
export type Match = {
  root: ByteRange;
  captures: Map<string, CaptureValue>;
};

type Bindings = Map<string, CaptureValue>;

/** Finds every candidate-root match in target tree pre-order. */
export function findMatches(pattern: CompiledPattern, target: SourceFile): Match[] {
  const matches: Match[] = [];
  visit(target.tree.rootNode);
  return matches;

  function visit(node: Node) {
    if (target.isInsideParseProblem(node)) return;

    const match = matchNode(pattern, node, target);
    if (match) matches.push(match);

    for (const child of node.children) {
      if (child) visit(child);
    }
  }
}

/** Matches one compiled pattern against one target candidate node. */
export function matchNode(
  pattern: CompiledPattern,
  candidate: Node,
  target: SourceFile,
): Match | undefined {
  const semantics = semanticsFor(languageOf(pattern.source));
  const captures = matchPatternNode(pattern.root, candidate, new Map(), {
    pattern,
    target,
    semantics,
  });
  if (!captures) return undefined;
  return { root: target.rangeOf(candidate), captures };
}

function matchPatternNode(
  p: Node,
  t: Node,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  const pUnwrapped = unwrapTransparent(p, context);
  if (pUnwrapped.id !== p.id) return matchPatternNode(pUnwrapped, t, bindings, context);

  const tUnwrapped = unwrapTransparent(t, context);
  if (tUnwrapped.id !== t.id) return matchPatternNode(p, tUnwrapped, bindings, context);

  const meta = context.pattern.metavars.get(p.id);
  if (meta?.name === undefined && meta?.variadic === false) return bindings;
  if (meta?.name !== undefined && meta.variadic === false) {
    return bindSingle(meta.name, t, bindings, context);
  }
  if (meta?.variadic === true) return undefined;

  if (p.type !== t.type) return undefined;
  if (p.children.length === 0) {
    return sourceText(context.pattern.source, p) === sourceText(context.target, t)
      ? bindings
      : undefined;
  }
  return matchSeq(
    units(p, context.semantics),
    units(t, context.semantics),
    bindings,
    t,
    context,
  );
}

function matchUnit(
  pu: ComparisonUnit,
  tu: ComparisonUnit,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  if (pu.field !== tu.field) return undefined;
  return matchPatternNode(pu.node, tu.node, bindings, context);
}

function matchSeq(
  ps: ComparisonUnit[],
  ts: ComparisonUnit[],
  bindings: Bindings,
  parent: Node,
  context: MatchContext,
): Bindings | undefined {
  const { fixed, variadics } = splitSegments(ps, context);
  let current = bindings;
  let i = 0;

  for (const p of fixed[0]) {
    if (i >= ts.length) return undefined;
    const next = matchUnit(p, ts[i], current, context);
    if (!next) return undefined;
    current = next;
    i += 1;
  }

  for (let j = 0; j < variadics.length; j++) {
    const variadic = variadics[j];
    const anchor = fixed[j + 1];

    if (anchor.length === 0) {
      const next = bindVariadic(variadic, ts, i, ts.length, current, parent, context);
      if (!next) return undefined;
      current = next;
      i = ts.length;
    } else {
      let s = i;
      while (true) {
        if (anchorMatches(anchor, ts, s, current, context)) break;
        s += 1;
        if (s + anchor.length > ts.length) return undefined;
      }

      const next = bindVariadic(variadic, ts, i, s, current, parent, context);
      if (!next) return undefined;
      current = next;

      for (const p of anchor) {
        const consumed = matchUnit(p, ts[s], current, context);
        if (!consumed) return undefined;
        current = consumed;
        s += 1;
      }
      i = s;
    }
  }

  return i === ts.length ? current : undefined;
}

function anchorMatches(
  fixed: ComparisonUnit[],
  ts: ComparisonUnit[],
  s: number,
  bindings: Bindings,
  context: MatchContext,
): boolean {
  if (fixed.length > ts.length - s) return false;
  let copy = new Map(bindings);
  for (let m = 0; m < fixed.length; m++) {
    const next = matchUnit(fixed[m], ts[s + m], copy, context);
    if (!next) return false;
    copy = next;
  }
  return true;
}

function bindVariadic(
  unit: ComparisonUnit,
  ts: ComparisonUnit[],
  i: number,
  s: number,
  bindings: Bindings,
  parent: Node,
  context: MatchContext,
): Bindings | undefined {
  const meta = context.pattern.metavars.get(unit.node.id);
  if (!meta?.variadic) return undefined;
  if (meta.name === undefined) return bindings;

  const nodes = ts.slice(i, s).map((item) => item.node);
  const span = nodes.length === 0 ? emptySpan(ts, i, s, parent, context.target) : {
    start: context.target.rangeOf(nodes[0]).start,
    end: context.target.rangeOf(nodes[nodes.length - 1]).end,
  };
  const value: CaptureValue = { kind: "multi", nodes, span };
  return bindValue(meta.name, value, bindings, context);
}

function emptySpan(
  ts: ComparisonUnit[],
  i: number,
  s: number,
  parent: Node,
  target: SourceFile,
): ByteRange {
  if (s < ts.length) {
    const start = target.rangeOf(ts[s].node).start;
    return { start, end: start };
  }
  if (i > 0) {
    const end = target.rangeOf(ts[i - 1].node).end;
    return { start: end, end };
  }

  const firstChild = parent.children.find((child: Node | null): child is Node => child !== null);
  if (firstChild) {
    const end = target.rangeOf(firstChild).end;
    return { start: end, end };
  }
  const start = target.rangeOf(parent).start;
  return { start, end: start };
}

function splitSegments(ps: ComparisonUnit[], context: MatchContext) {
  const fixed: ComparisonUnit[][] = [[]];
  const variadics: ComparisonUnit[] = [];

  for (const unit of ps) {
    const meta = context.pattern.metavars.get(unit.node.id);
    if (meta?.variadic) {
      variadics.push(unit);
      fixed.push([]);
    } else {
      fixed[fixed.length - 1].push(unit);
    }
  }

  return { fixed, variadics };
}

function bindSingle(
  name: string,
  node: Node,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  return bindValue(name, { kind: "single", node }, bindings, context);
}

function bindValue(
  name: string,
  value: CaptureValue,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  const existing = bindings.get(name);
  if (existing && captureText(existing, context.target) !== captureText(value, context.target)) {
    return undefined;
  }

  const next = new Map(bindings);
  next.set(name, value);
  return next;
}

function unwrapTransparent(node: Node, context: MatchContext): Node {
  if (!context.semantics.transparent_nodes.has(node.type)) return node;
  const inner = units(node, context.semantics);
  return inner.length === 1 ? inner[0].node : node;
}

function sourceText(source: SourceFile, node: Node): string {
  return source.sourceText(source.rangeOf(node));
}

function captureText(value: CaptureValue, source: SourceFile): string {
  return source.sourceText(value.kind === "single" ? source.rangeOf(value.node) : value.span);
}

function languageOf(source: SourceFile) {
  return source.tree.rootNode.type === "module" ? "python" : "typescript";
}

type MatchContext = {
  pattern: CompiledPattern;
  target: SourceFile;
  semantics: ReturnType<typeof semanticsFor>;
};
