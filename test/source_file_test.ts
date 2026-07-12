import { SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

Deno.test("SourceFile owns parsed bytes, tree, and line index", async () => {
  const source = await SourceFile.parse("typescript", "const x = 1;\nlet y = 2;\n");

  assertEquals(source.tree.rootNode.type, "program");
  assertEquals(source.tree.rootNode.hasError, false);
  assertEquals(source.lineIndex, [0, 13, 24]);
  assertEquals(source.rangeOf(source.tree.rootNode), { start: 0, end: 24 });
  assertEquals(source.parseProblems.length, 0);
});

Deno.test("SourceFile strips BOM for parsing but reports disk byte ranges", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("const x = 1;\n")]);
  const source = await SourceFile.parse("typescript", bytes);

  assertEquals(source.bomLen, 3);
  assertEquals(source.tree.rootNode.startIndex, 0);
  assertEquals(source.rangeOf(source.tree.rootNode), { start: 3, end: 16 });
  assertEquals(source.sourceText(source.rangeOf(source.tree.rootNode)), "const x = 1;\n");
});

Deno.test("SourceFile reports UTF-8 byte ranges for non-ASCII source", async () => {
  const source = await SourceFile.parse("typescript", 'const x = "é";\n');
  const string = source.tree.rootNode.descendantsOfType("string")[0];

  assert(string);
  assertEquals(source.bytes.length, 16);
  assertEquals(source.rangeOf(source.tree.rootNode), { start: 0, end: 16 });
  assertEquals(source.sourceText(source.rangeOf(string!)), '"é"');
});

Deno.test("SourceFile owns input bytes and does not expose mutable internal bytes", async () => {
  const bytes = new TextEncoder().encode("const x = 1;\n");
  const source = await SourceFile.parse("typescript", bytes);
  const range = source.rangeOf(source.tree.rootNode);

  bytes[0] = "X".charCodeAt(0);
  source.diskBytes[1] = "X".charCodeAt(0);
  source.bytes[2] = "X".charCodeAt(0);

  assertEquals(source.sourceText(range), "const x = 1;\n");
});

Deno.test("SourceFile rejects invalid UTF-8 bytes", async () => {
  const invalid = new Uint8Array([
    ..."const x = ".split("").map((c) => c.charCodeAt(0)),
    0xff,
    ...";\nconst y = 2;\n".split("").map((c) => c.charCodeAt(0)),
  ]);

  await assertRejects(() => SourceFile.parse("typescript", invalid), TypeError);
});

Deno.test("SourceFile records ERROR and MISSING nodes with external ranges", async () => {
  const source = await SourceFile.parse("typescript", "\ufeffconst = ;\n");

  assert(source.tree.rootNode.hasError);
  assert(source.parseProblems.length > 0);
  assert(source.parseProblems.every((problem) => problem.range.start >= source.bomLen));
});

Deno.test("SourceFile can identify nodes inside parse problem subtrees", async () => {
  const source = await SourceFile.parse("typescript", "const = ;\n");
  const problem = source.tree.rootNode.descendantsOfType("ERROR")[0];

  assert(problem);
  assert(source.isInsideParseProblem(problem!));
});

async function assertRejects(
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error,
) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof errorClass);
    return;
  }
  throw new Error("expected rejection");
}
