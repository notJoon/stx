import type { Node, Tree } from "web-tree-sitter";
import { createParser, type LanguageId } from "./grammar.ts";

export type ByteRange = {
  start: number;
  end: number;
};

export type ParseProblem = {
  type: string;
  range: ByteRange;
  isMissing: boolean;
  isError: boolean;
};

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class SourceFile {
  readonly #diskBytes: Uint8Array;
  readonly #bytes: Uint8Array;
  readonly #indexToByte: readonly number[];

  readonly bomLen: number;
  /** Language used to parse this source and interpret its syntax. */
  readonly language: LanguageId;
  readonly text: string;
  readonly tree: Tree;
  readonly lineIndex: readonly number[];
  readonly parseProblems: readonly ParseProblem[];

  private constructor(language: LanguageId, diskBytes: Uint8Array, text: string, tree: Tree) {
    this.#diskBytes = diskBytes;
    this.language = language;
    this.bomLen = hasBom(diskBytes) ? BOM.length : 0;
    this.#bytes = diskBytes.slice(this.bomLen);
    this.text = text;
    this.tree = tree;
    this.lineIndex = buildLineIndex(this.#bytes);
    this.#indexToByte = buildIndexToByte(text);
    this.parseProblems = collectParseProblems(tree.rootNode, (node) => this.rangeOf(node));
  }

  static async parse(language: LanguageId, input: string | Uint8Array): Promise<SourceFile> {
    const diskBytes = typeof input === "string" ? new TextEncoder().encode(input) : input.slice();
    const bomLen = hasBom(diskBytes) ? BOM.length : 0;
    const text = UTF8.decode(diskBytes.slice(bomLen));
    const parser = await createParser(language);
    const tree = parser.parse(text);
    if (!tree) throw new Error(`failed to parse ${language}`);
    return new SourceFile(language, diskBytes, text, tree);
  }

  get diskBytes(): Uint8Array {
    return this.#diskBytes.slice();
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  get byteLength(): number {
    return this.#diskBytes.length;
  }

  rangeOf(node: Node): ByteRange {
    return this.externalRange({
      start: this.byteIndex(node.startIndex),
      end: this.byteIndex(node.endIndex),
    });
  }

  externalRange(range: ByteRange): ByteRange {
    return { start: range.start + this.bomLen, end: range.end + this.bomLen };
  }

  internalRange(range: ByteRange): ByteRange {
    return { start: range.start - this.bomLen, end: range.end - this.bomLen };
  }

  sourceText(range: ByteRange): string {
    return UTF8.decode(this.#diskBytes.slice(range.start, range.end));
  }

  isInsideParseProblem(node: Node): boolean {
    for (let current: Node | null = node; current; current = current.parent) {
      if (current.isError || current.isMissing) return true;
    }
    return false;
  }

  private byteIndex(parserIndex: number): number {
    const byte = this.#indexToByte[parserIndex];
    if (byte === undefined) throw new Error(`parser index out of bounds: ${parserIndex}`);
    return byte;
  }
}

function hasBom(bytes: Uint8Array): boolean {
  return BOM.every((byte, i) => bytes[i] === byte);
}

function buildLineIndex(bytes: Uint8Array): number[] {
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) starts.push(i + 1);
  }
  return starts;
}

function buildIndexToByte(text: string): number[] {
  const indexToByte = new Array(text.length + 1);
  let byte = 0;
  for (let i = 0; i < text.length;) {
    indexToByte[i] = byte;
    const codePoint = text.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    const codeUnits = char.length;
    if (codeUnits === 2) indexToByte[i + 1] = byte;
    byte += new TextEncoder().encode(char).length;
    i += codeUnits;
  }
  indexToByte[text.length] = byte;
  return indexToByte;
}

function collectParseProblems(root: Node, rangeOf: (node: Node) => ByteRange): ParseProblem[] {
  const problems: ParseProblem[] = [];
  visit(root);
  return problems;

  function visit(node: Node) {
    if (node.isError || node.isMissing) {
      problems.push({
        type: node.type,
        range: rangeOf(node),
        isMissing: node.isMissing,
        isError: node.isError,
      });
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  }
}
