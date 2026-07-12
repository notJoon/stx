import { createParser, loadLanguage } from "../src/grammar.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

Deno.test("loads typescript grammar and parses source", async () => {
  const parser = await createParser("typescript");
  const tree = parser.parse("const x = 1;");
  assertEquals(tree?.rootNode.hasError, false);
  assertEquals(tree?.rootNode.type, "program");
});

Deno.test("loads python grammar and parses source", async () => {
  const parser = await createParser("python");
  const tree = parser.parse("x = 1\n");
  assertEquals(tree?.rootNode.hasError, false);
  assertEquals(tree?.rootNode.type, "module");
});

Deno.test("grammar load is cached per language", async () => {
  const a = await loadLanguage("typescript");
  const b = await loadLanguage("typescript");
  assertEquals(a, b);
});
