import type { Node } from "web-tree-sitter";
import type { LanguageId } from "./grammar.ts";

/** A child that participates in structural comparison, including its grammar field. */
export type ComparisonUnit<TNode = Node> = {
  node: TNode;
  field?: string;
};

/** A transparent-node view that preserves the original candidate root. */
export type TransparentNode = {
  root: Node;
  node: Node;
};

/** Language-specific syntax policy used by structural matching. */
export type LanguageSemantics = {
  comparison_unit_overrides: Readonly<Record<string, boolean>>;
  transparent_nodes: ReadonlySet<string>;
  comment_tokens: readonly string[];
};

const EMPTY_OVERRIDES = Object.freeze({});
// TypeScript string quote tokens are anonymous, but quote spelling is significant.
const TYPESCRIPT_OVERRIDES = Object.freeze({ '"': true, "'": true });
const TRANSPARENT_NODE_TYPES = new Set(["parenthesized_expression"]);

export const LANGUAGE_SEMANTICS: Readonly<Record<LanguageId, LanguageSemantics>> = {
  typescript: {
    comparison_unit_overrides: TYPESCRIPT_OVERRIDES,
    transparent_nodes: TRANSPARENT_NODE_TYPES,
    comment_tokens: ["//", "/*"],
  },
  python: {
    comparison_unit_overrides: EMPTY_OVERRIDES,
    transparent_nodes: TRANSPARENT_NODE_TYPES,
    comment_tokens: ["#"],
  },
};

export function semanticsFor(language: LanguageId): LanguageSemantics {
  return LANGUAGE_SEMANTICS[language];
}

/** Returns the named or fielded children visible to the matcher. */
export function units(node: Node, semantics: LanguageSemantics): ComparisonUnit[] {
  const result: ComparisonUnit[] = [];
  const cursor = node.walk();
  if (cursor.gotoFirstChild()) {
    do {
      const field = cursor.currentFieldName ?? undefined;
      const override = semantics.comparison_unit_overrides[cursor.nodeType];
      if (override ?? (cursor.nodeIsNamed || field !== undefined)) {
        result.push({ node: cursor.currentNode, field });
      }
    } while (cursor.gotoNextSibling());
  }
  cursor.delete();
  return result;
}

/** Unwraps transparent nodes while keeping the candidate root for reporting. */
export function transparentNode(node: Node, semantics: LanguageSemantics): TransparentNode {
  let current = node;
  while (semantics.transparent_nodes.has(current.type)) {
    const inner = units(current, semantics);
    if (inner.length !== 1) break;
    current = inner[0].node;
  }
  return { root: node, node: current };
}
