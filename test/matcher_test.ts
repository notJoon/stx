import { type CaptureValue, findMatches, type Match, matchNode } from "../src/matcher.ts";
import { compilePattern } from "../src/pattern.ts";
import { type ByteRange, SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed"): asserts condition {
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

Deno.test("starts from immutable captures and keeps the first equal-text range", async () => {
  const target = await SourceFile.parse("typescript", "f(a); f(a); f(b)");
  const calls = target.tree.rootNode.descendantsOfType("call_expression");
  const identifiers = target.tree.rootNode.descendantsOfType("identifier");
  const first = calls[0];
  const third = calls[2];
  const secondA = identifiers[3];
  assert(first && third && secondA);
  const initial = new Map<string, CaptureValue>([["X", { kind: "single", node: secondA }]]);
  const pattern = await compilePattern("f($X)", "typescript");

  const match = matchNode(pattern, first, target, initial);
  assert(match);
  assertEquals(singleText(target, match, "X"), "a");
  assertEquals(singleCapture(match, "X").node.id, secondA.id);
  assertEquals(initial.size, 1);
  assertEquals(matchNode(pattern, third, target, initial), undefined);
  assertEquals(initial.size, 1);
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

Deno.test("root prefilter keeps metavariable and transparent-root matches", async () => {
  const target = await SourceFile.parse("typescript", "(a)");
  const fixed = findMatches(await compilePattern("a", "typescript"), target);
  const metavariable = findMatches(await compilePattern("$X", "typescript"), target);

  assertEquals(fixed.map((match) => text(target, match.root)), ["(a)", "a"]);
  assertEquals(metavariable.map((match) => text(target, match.root)), [
    "(a)",
    "(a)",
    "(a)",
    "(",
    "a",
    ")",
  ]);
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

Deno.test("field labels are part of MatchUnit", async () => {
  const pattern = await compilePattern("a + b", "typescript");
  const target = await SourceFile.parse("typescript", "a + b");
  const candidate = target.tree.rootNode.descendantsOfType("binary_expression")[0];
  if (!candidate) throw new Error("missing binary expression");
  pattern.matcherRoot.fixed[0][0].field = "right";

  assertEquals(matchNode(pattern, candidate, target), undefined);
});

Deno.test("matches Python block-promoted variadics as sibling units", async () => {
  const pattern = await compilePattern("def f():\n  $$$BODY\n", "python");
  const target = await SourceFile.parse("python", "def f():\n  a\n  b\n");
  const matches = findMatches(pattern, target);

  assertEquals(matches.length, 1);
  assertEquals(multiTexts(matches[0], "BODY"), ["a\n  b"]);
  assertEquals(multiCapture(matches[0], "BODY").nodes.map((node) => node.type), ["block"]);
});

Deno.test("open-ended pattern nodes tolerate optional trailing clauses", async () => {
  const ifPattern = await compilePattern("if ($COND) { $$$BODY }", "typescript");
  const ifElse = await SourceFile.parse("typescript", "if (a) { b(); } else { c(); }");
  assertEquals(findMatches(ifPattern, ifElse).length, 1);

  const raisePattern = await compilePattern("raise $ERR($$$ARGS)", "python");
  const raiseFrom = await SourceFile.parse("python", 'raise E("x") from None\n');
  assertEquals(findMatches(raisePattern, raiseFrom).length, 1);

  const blockPattern = await compilePattern("if x:\n  a()\n", "python");
  const blockSuffix = await SourceFile.parse("python", "if x:\n  a()\n  b()\n");
  assertEquals(findMatches(blockPattern, blockSuffix).length, 1);
});

Deno.test("trailing anchor tokens still reject leftover target units", async () => {
  const call = await compilePattern("f($X)", "typescript");
  const twoArgs = await SourceFile.parse("typescript", "f(a, b)");
  assertEquals(findMatches(call, twoArgs).length, 0);

  const emptyCall = await compilePattern("f()", "python");
  const oneArg = await SourceFile.parse("python", "f(a)");
  assertEquals(findMatches(emptyCall, oneArg).length, 0);

  const block = await compilePattern("while (x) { a(); }", "typescript");
  const longerBlock = await SourceFile.parse("typescript", "while (x) { a(); b(); }");
  assertEquals(findMatches(block, longerBlock).length, 0);
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
