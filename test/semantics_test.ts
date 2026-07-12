import { SourceFile } from "../src/source_file.ts";
import { semanticsFor, transparentNode, units } from "../src/semantics.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

Deno.test("units include named and fielded children but skip punctuation", async () => {
  const source = await SourceFile.parse("typescript", "const x = (a) + b;\n");
  const semantics = semanticsFor("typescript");
  const binary = source.tree.rootNode.descendantsOfType("binary_expression")[0];

  assert(binary);
  assertEquals(
    units(binary!, semantics).map((unit) => [unit.field, unit.node.type, unit.node.text]),
    [
      ["left", "parenthesized_expression", "(a)"],
      ["operator", "+", "+"],
      ["right", "identifier", "b"],
    ],
  );
});

Deno.test("comparison unit overrides can add and remove child kinds", async () => {
  const source = await SourceFile.parse("typescript", "const x = 1;\n");
  const declaration = source.tree.rootNode.descendantsOfType("lexical_declaration")[0];

  assert(declaration);
  assertEquals(
    units(declaration!, {
      comparison_unit_overrides: { ";": true, variable_declarator: false },
      transparent_nodes: new Set(),
      comment_tokens: [],
    }).map((unit) => [unit.field, unit.node.type]),
    [["kind", "const"], [undefined, ";"]],
  );
});

Deno.test("transparent parenthesized expressions unwrap symmetrically", async () => {
  const ts = await SourceFile.parse("typescript", "const x = (a);\n");
  const py = await SourceFile.parse("python", "x = (a)\n");

  for (
    const [source, language] of [[ts, "typescript"], [py, "python"]] as const
  ) {
    const semantics = semanticsFor(language);
    const paren = source.tree.rootNode.descendantsOfType("parenthesized_expression")[0];

    assert(paren);
    const transparent = transparentNode(paren!, semantics);
    assertEquals(transparent.node.text, "a");
    assertEquals(source.sourceText(source.rangeOf(transparent.root)), "(a)");
  }
});

Deno.test("language semantics expose comment tokens", () => {
  assertEquals(semanticsFor("typescript").comment_tokens, ["//", "/*"]);
  assertEquals(semanticsFor("python").comment_tokens, ["#"]);
});
