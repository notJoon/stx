import type { Node } from "web-tree-sitter";
import { type CaptureValue, findMatches, type Match, matchNode } from "../src/matcher.ts";
import { type CompiledPattern, compilePattern } from "../src/pattern.ts";
import { type ByteRange, SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

const LANGUAGES = ["typescript", "python"] as const;

Deno.test("matches single metavariables and captures the target node", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("console.log($MSG)", lang);
    const target = await SourceFile.parse(lang, "console.log(userId)");
    const [match] = findMatches(pattern, target);

    assert(match);
    const msg = singleCapture(match, "MSG");
    assertEquals(msg.node.type, "identifier");
    assertEquals(msg.node.text, "userId");
  }
});

Deno.test("matches TypeScript expression patterns inside larger expressions", async () => {
  const parse = await compilePattern("JSON.parse($X)", "typescript");
  const declaration = await SourceFile.parse("typescript", "const x = JSON.parse(y)");
  const [parseMatch] = findMatches(parse, declaration);
  assert(parseMatch);
  assertEquals(singleText(declaration, parseMatch, "X"), "y");

  const error = await compilePattern("new Error($MSG)", "typescript");
  const target = await SourceFile.parse(
    "typescript",
    'throw new Error("x"); const make = (message) => new Error(message)',
  );
  const matches = findMatches(error, target);
  assertEquals(matches.length, 2);
  assertEquals(matches.map((match) => singleText(target, match, "MSG")), ['"x"', "message"]);
});

Deno.test("matches Python expression patterns in conditions", async () => {
  const pattern = await compilePattern("isinstance($X, $T)", "python");
  const target = await SourceFile.parse("python", "if isinstance(v, str):\n  pass\n");
  const [match] = findMatches(pattern, target);

  assert(match);
  assertEquals(singleText(target, match, "X"), "v");
  assertEquals(singleText(target, match, "T"), "str");
});

Deno.test("still matches expression patterns used as statements", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f($X)", lang);
    const target = await SourceFile.parse(lang, "f(value)");
    const [match] = findMatches(pattern, target);

    assert(match);
    assertEquals(singleText(target, match, "X"), "value");
  }
});

Deno.test("uses lazy variadic matching and lets the final variadic absorb the rest", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f($$$A, x, $$$B)", lang);
    const target = await SourceFile.parse(lang, "f(a, b, x, c, x, d)");
    const matches = findMatches(pattern, target);

    assertEquals(matches.length, 1);
    assertEquals(multiTexts(matches[0], "A"), ["a", "b"]);
    assertEquals(multiTexts(matches[0], "B"), ["c", "x", "d"]);
  }
});

Deno.test("enforces repeated named metavariables by byte-for-byte source text", async () => {
  const pattern = await compilePattern("$X == $X", "typescript");

  assertEquals(findMatches(pattern, await SourceFile.parse("typescript", "a.b == a.b")).length, 1);
  assertEquals(
    findMatches(pattern, await SourceFile.parse("typescript", "a.b == a . b")).length,
    0,
  );

  const anonymous = await compilePattern("$_ == $_", "typescript");
  assertEquals(findMatches(anonymous, await SourceFile.parse("typescript", "a == b")).length, 1);
});

Deno.test("does not report alternative variadic splits", async () => {
  const pattern = await compilePattern("f($$$A, x, $$$B)", "typescript");
  const target = await SourceFile.parse("typescript", "f(a, x, b, x, c)");
  const matches = findMatches(pattern, target);

  assertEquals(matches.length, 1);
  assertEquals(multiTexts(matches[0], "A"), ["a"]);
  assertEquals(multiTexts(matches[0], "B"), ["b", "x", "c"]);
});

Deno.test("does not normalize literal spelling", async () => {
  for (const lang of LANGUAGES) {
    assertEquals(
      findMatches(await compilePattern('"a"', lang), await SourceFile.parse(lang, "'a'")).length,
      0,
    );
    assertEquals(
      findMatches(await compilePattern("1", lang), await SourceFile.parse(lang, "1.0")).length,
      0,
    );
  }
});

Deno.test("keeps empty variadic spans at the insertion point", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f($$$ARGS)", lang);
    const target = await SourceFile.parse(lang, "f()");
    const [match] = findMatches(pattern, target);
    const args = multiCapture(match, "ARGS");

    assertEquals(args.nodes.length, 0);
    assertEquals(args.span, { start: 2, end: 2 });
  }
});

Deno.test("reports nested and overlapping matches in pre-order", async () => {
  const pattern = await compilePattern("f($X)", "typescript", { selector: "call_expression" });
  const target = await SourceFile.parse("typescript", "f(f(a)); f(b)");
  const matches = findMatches(pattern, target);

  assertEquals(matches.map((match) => text(target, match.root)), ["f(f(a))", "f(a)", "f(b)"]);
});

Deno.test("unwraps transparent nodes on both pattern and target sides", async () => {
  const targetSide = await compilePattern("$A + $B", "typescript");
  const target = await SourceFile.parse("typescript", "(a) + b");
  const [targetMatch] = findMatches(targetSide, target);
  assertEquals(singleText(target, targetMatch, "A"), "a");
  assertEquals(singleText(target, targetMatch, "B"), "b");

  const patternSide = await compilePattern("($A) + $B", "typescript");
  const plain = await SourceFile.parse("typescript", "a + b");
  const [patternMatch] = findMatches(patternSide, plain);
  assertEquals(singleText(plain, patternMatch, "A"), "a");
  assertEquals(singleText(plain, patternMatch, "B"), "b");
});

Deno.test("supports anonymous variadics without captures", async () => {
  const pattern = await compilePattern("f($$$_, x)", "typescript");
  const target = await SourceFile.parse("typescript", "f(a, b, x)");
  const [match] = findMatches(pattern, target);

  assert(match);
  assertEquals([...match.captures.keys()], []);
});

Deno.test("field labels are part of MatchUnit", () => {
  const patternRoot = fakeNode(1, "root", [fakeNode(2, "identifier", [], true)], true, ["left"]);
  const targetRoot = fakeNode(3, "root", [fakeNode(4, "identifier", [], true)], true, ["right"]);
  const pattern = {
    source: fakeSource("program"),
    root: patternRoot,
    metavars: new Map(),
  } as unknown as CompiledPattern;

  assertEquals(matchNode(pattern, targetRoot, fakeSource("program")), undefined);
});

Deno.test("matches Python block-promoted variadics as sibling units", async () => {
  const pattern = await compilePattern("def f():\n  $$$BODY\n", "python");
  const target = await SourceFile.parse("python", "def f():\n  a\n  b\n");
  const matches = findMatches(pattern, target);

  assertEquals(matches.length, 1);
  assertEquals(multiTexts(matches[0], "BODY"), ["a\n  b"]);
  assertEquals(multiCapture(matches[0], "BODY").nodes.map((node) => node.type), ["block"]);
});

function capture(match: Match, name: string): CaptureValue {
  const value = match.captures.get(name);
  if (!value) throw new Error(`missing capture ${name}`);
  return value;
}

function singleCapture(match: Match, name: string): Extract<CaptureValue, { kind: "single" }> {
  const value = capture(match, name);
  if (value.kind !== "single") throw new Error(`expected single capture ${name}`);
  return value;
}

function multiCapture(match: Match, name: string): Extract<CaptureValue, { kind: "multi" }> {
  const value = capture(match, name);
  if (value.kind !== "multi") throw new Error(`expected multi capture ${name}`);
  return value;
}

function multiTexts(match: Match, name: string): string[] {
  const value = multiCapture(match, name);
  return value.nodes.map((node) => node.text);
}

function singleText(source: SourceFile, match: Match, name: string): string {
  const value = singleCapture(match, name);
  return text(source, source.rangeOf(value.node));
}

function text(source: SourceFile, range: ByteRange): string {
  return source.sourceText(range);
}

function fakeNode(
  id: number,
  type: string,
  children: Node[],
  isNamed: boolean,
  fields: (string | undefined)[] = [],
): Node {
  return {
    id,
    type,
    children,
    isNamed,
    fieldNameForChild: (index: number) => fields[index] ?? null,
  } as unknown as Node;
}

function fakeSource(rootType: string): SourceFile {
  return {
    tree: { rootNode: { type: rootType } },
  } as unknown as SourceFile;
}
