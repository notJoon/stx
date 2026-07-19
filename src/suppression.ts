import { semanticsFor } from "./semantics.ts";
import type { ByteRange, SourceFile } from "./source_file.ts";

type Directive = {
  kind: "line" | "next-line" | "file";
  line: number;
  ids?: ReadonlySet<string>;
};

export function suppressionFor(source: SourceFile) {
  const comments = source.tree.rootNode.descendantsOfType("comment")
    .filter((node) => node !== null)
    .map((node) => source.rangeOf(node))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const firstContent = firstNonCommentContent(source.diskBytes, source.bomLen, comments);
  const directives = comments.flatMap((range) => {
    const directive = parseDirective(source, range);
    return directive && (directive.kind !== "file" || range.start < firstContent)
      ? [directive]
      : [];
  });

  return (ruleId: string, range: ByteRange): boolean => {
    const line = lineOf(source, range.start);
    return directives.some((directive) =>
      (!directive.ids || directive.ids.has(ruleId)) &&
      (directive.kind === "file" ||
        (directive.kind === "line" && directive.line === line) ||
        (directive.kind === "next-line" && directive.line + 1 === line))
    );
  };
}

function parseDirective(source: SourceFile, range: ByteRange): Directive | undefined {
  const text = source.sourceText(range);
  const token = semanticsFor(source.language).comment_tokens.find((token) =>
    text.startsWith(token)
  );
  if (!token) return undefined;
  let body = text.slice(token.length).trim();
  if (token === "/*" && body.endsWith("*/")) body = body.slice(0, -2).trim();
  const match = /^(tool-ignore-next-line|tool-ignore-file|tool-ignore)(?:\s+(.+?))?\s*$/.exec(body);
  if (!match) return undefined;
  const ids = match[2]?.split(",").map((id) => id.trim());
  if (ids?.some((id) => !/^[^/\s]+\/[^/\s]+$/.test(id))) return undefined;
  return {
    kind: match[1] === "tool-ignore-next-line"
      ? "next-line"
      : match[1] === "tool-ignore-file"
      ? "file"
      : "line",
    line: lineOf(source, match[1] === "tool-ignore-next-line" ? range.end : range.start),
    ...(ids?.length && { ids: new Set(ids) }),
  };
}

function firstNonCommentContent(
  bytes: Uint8Array,
  bomLen: number,
  comments: readonly ByteRange[],
): number {
  let comment = 0;
  for (let position = bomLen; position < bytes.length;) {
    while (comment < comments.length && comments[comment].end <= position) comment++;
    if (comments[comment]?.start === position) {
      position = comments[comment++].end;
    } else if (isWhitespace(bytes[position])) {
      position++;
    } else {
      return position;
    }
  }
  return Infinity;
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
}

function lineOf(source: SourceFile, diskOffset: number): number {
  const offset = Math.max(0, diskOffset - source.bomLen);
  let low = 0;
  let high = source.lineIndex.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (source.lineIndex[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}
