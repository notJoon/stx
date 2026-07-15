import type { Node } from "web-tree-sitter";
import type { CompiledPattern, MatcherNode, MatcherUnit } from "./pattern.ts";
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
  const transparentTypes = semanticsFor(pattern.language).transparent_nodes;
  const cursor = target.tree.walk();
  visit();
  cursor.delete();
  return matches;

  function visit() {
    const type = cursor.nodeType;
    if (type === "ERROR" || cursor.nodeIsMissing) return;

    if (
      pattern.rootType === undefined ||
      type === pattern.rootType ||
      transparentTypes.has(type)
    ) {
      const node = cursor.currentNode;
      const match = matchNode(pattern, node, target);
      if (match) matches.push(match);
    }

    if (cursor.gotoFirstChild()) {
      do visit(); while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
}

/** Matches one compiled pattern against one target candidate node. */
export function matchNode(
  pattern: CompiledPattern,
  candidate: Node,
  target: SourceFile,
): Match | undefined {
  const semantics = semanticsFor(pattern.language);
  const captures = matchPatternNode(pattern.matcherRoot, candidate, new Map(), {
    target,
    semantics,
  });
  if (!captures) return undefined;
  return { root: target.rangeOf(candidate), captures };
}

function matchPatternNode(
  p: MatcherNode,
  t: Node,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  const tUnwrapped = unwrapTransparent(t, context);
  if (tUnwrapped.id !== t.id) return matchPatternNode(p, tUnwrapped, bindings, context);

  const meta = p.meta;
  if (meta?.name === undefined && meta?.variadic === false) return bindings;
  if (meta?.name !== undefined && meta.variadic === false) {
    return bindSingle(meta.name, t, bindings, context);
  }
  if (meta?.variadic === true) return undefined;

  if (p.type !== t.type) return undefined;
  if (p.leafText !== undefined) {
    return p.leafText === sourceText(context.target, t) ? bindings : undefined;
  }
  return matchSeq(p.fixed, p.variadics, units(t, context.semantics), bindings, t, context);
}

function matchUnit(
  pu: MatcherUnit,
  tu: ComparisonUnit,
  bindings: Bindings,
  context: MatchContext,
): Bindings | undefined {
  if (pu.field !== tu.field) return undefined;
  return matchPatternNode(pu.node, tu.node, bindings, context);
}

function matchSeq(
  fixed: MatcherUnit[][],
  variadics: MatcherUnit[],
  ts: ComparisonUnit[],
  bindings: Bindings,
  parent: Node,
  context: MatchContext,
): Bindings | undefined {
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
  fixed: MatcherUnit[],
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
  unit: MatcherUnit,
  ts: ComparisonUnit[],
  i: number,
  s: number,
  bindings: Bindings,
  parent: Node,
  context: MatchContext,
): Bindings | undefined {
  const meta = unit.node.meta;
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

  const firstChild = parent.firstChild;
  if (firstChild) {
    const end = target.rangeOf(firstChild).end;
    return { start: end, end };
  }
  const start = target.rangeOf(parent).start;
  return { start, end: start };
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

  bindings.set(name, value);
  return bindings;
}

function unwrapTransparent(node: Node, context: MatchContext): Node {
  if (!context.semantics.transparent_nodes.has(node.type)) return node;
  const inner = units(node, context.semantics);
  return inner.length === 1 ? inner[0].node : node;
}

function sourceText(source: SourceFile, node: Node): string {
  return source.text.slice(node.startIndex, node.endIndex);
}

function captureText(value: CaptureValue, source: SourceFile): string {
  return source.sourceText(value.kind === "single" ? source.rangeOf(value.node) : value.span);
}

type MatchContext = {
  target: SourceFile;
  semantics: ReturnType<typeof semanticsFor>;
};
