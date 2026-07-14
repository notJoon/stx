import type { Node } from "web-tree-sitter";
import {
  type CompiledPattern,
  CompileError,
  compilePattern,
  type Metavariable,
} from "../src/pattern.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

const LANGUAGES = ["typescript", "python"] as const;

Deno.test("compiles basic call patterns in TypeScript and Python", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("console.log($MSG)", lang);

    assertEquals(pattern.root.type, lang === "typescript" ? "call_expression" : "call");
    assertEquals(metas(pattern).map((entry) => [entry.node.type, entry.meta]), [
      ["identifier", { name: "MSG", variadic: false }],
    ]);
  }
});

Deno.test("demotes single expression-statement roots once", async () => {
  assertEquals((await compilePattern("JSON.parse($X)", "typescript")).root.type, "call_expression");
  assertEquals((await compilePattern("len($X)", "python")).root.type, "call");

  const notDemoted = await compilePattern("a /* comment */", "typescript");
  assertEquals(notDemoted.root.type, "expression_statement");
});

Deno.test("restores a standalone metavariable to the demoted pattern root", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("$X", lang);

    assertEquals(metas(pattern).map((entry) => entry.node.id), [pattern.root.id]);
    assertEquals(pattern.metavars.get(pattern.root.id), { name: "X", variadic: false });
  }
});

Deno.test("restores variadic call arguments without promoting to argument container", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f($$$ARGS)", lang);
    const [entry] = metas(pattern);

    assertEquals(entry.meta, { name: "ARGS", variadic: true });
    assertEquals(entry.node.type, "identifier");
    assert(["arguments", "argument_list"].includes(entry.node.parent?.type ?? ""));
  }
});

Deno.test("restores statement-body variadics to equal-range wrapper nodes", async () => {
  const ts = await compilePattern("function f() { $$$BODY }", "typescript");
  assertEquals(metas(ts).map((entry) => [entry.node.type, entry.meta]), [
    ["expression_statement", { name: "BODY", variadic: true }],
  ]);

  const py = await compilePattern("def f():\n  $$$BODY\n", "python");
  assertEquals(metas(py).map((entry) => [entry.node.type, entry.meta]), [
    ["block", { name: "BODY", variadic: true }],
  ]);
});

Deno.test("restores string content tokens only when the whole content is a metavariable", async () => {
  const ts = await compilePattern('"$SRC"', "typescript");
  assertEquals(metas(ts).map((entry) => [entry.node.type, entry.meta]), [
    ["string_fragment", { name: "SRC", variadic: false }],
  ]);

  const py = await compilePattern('"$SRC"', "python");
  assertEquals(metas(py).map((entry) => [entry.node.type, entry.meta]), [
    ["string_content", { name: "SRC", variadic: false }],
  ]);

  for (const lang of LANGUAGES) {
    await assertCompileError(() => compilePattern('"pre $X"', lang), "whole token");

    // Previous char e blocks recognition, so this stays literal.
    const literal = await compilePattern('"pre$X"', lang);
    assertEquals(literal.metavars.size, 0);
  }
});

Deno.test("detects partial tokens hidden behind escape sequences", async () => {
  // Leaf text checks miss this when string_content contains escape_sequence.
  await assertCompileError(() => compilePattern("f('it\\'s $X')", "python"), "whole token");
});

Deno.test("rejects invalid prefix run lengths", async () => {
  for (const lang of LANGUAGES) {
    await assertCompileError(() => compilePattern("f($$X)", lang), "run length");
    await assertCompileError(() => compilePattern("f($$$$X)", lang), "run length");
  }
});

Deno.test("rejects partial tokens in comments", async () => {
  await assertCompileError(() => compilePattern("1 /* pre $X */", "typescript"), "whole token");
  await assertCompileError(
    () => compilePattern("def f():\n  # pre $X\n  pass", "python"),
    "whole token",
  );
});

Deno.test("consumes blocked prefix runs entirely", async () => {
  // The blocked prefix run is literal text; scanning must not restart inside it.
  const ts = await compilePattern("a$$$X", "typescript");
  assertEquals(ts.metavars.size, 0);
  assertEquals(ts.root.text, "a$$$X");

  // In Python, the literal dollar run reaches parsing and fails hard.
  await assertCompileError(() => compilePattern("a$$$X", "python"), "parse error");
});

Deno.test("rejects parse errors and invalid custom prefixes", async () => {
  await assertCompileError(() => compilePattern("function {", "typescript"), "parse error");
  await assertCompileError(
    () => compilePattern("$X", "typescript", { metaVarPrefix: "" }),
    "metaVarPrefix",
  );
  await assertCompileError(
    () => compilePattern("AX", "typescript", { metaVarPrefix: "A" }),
    "metaVarPrefix",
  );
  await assertCompileError(
    () => compilePattern(" X", "typescript", { metaVarPrefix: " " }),
    "metaVarPrefix",
  );
});

Deno.test("does not recognize metavariables after identifier characters", async () => {
  const ascii = await compilePattern("a$X", "typescript");
  const unicode = await compilePattern("π$X", "typescript");
  const nonBmp = await compilePattern("𝒳$X", "typescript");

  assertEquals(ascii.metavars.size, 0);
  assertEquals(ascii.root.text, "a$X");
  assertEquals(unicode.metavars.size, 0);
  assertEquals(unicode.root.text, "π$X");
  assertEquals(nonBmp.metavars.size, 0);
  assertEquals(nonBmp.root.text, "𝒳$X");
});

Deno.test("does not split lowercase identifier suffixes into partial metavariables", async () => {
  const pattern = await compilePattern("f($Xfoo)", "typescript");

  assertEquals(pattern.metavars.size, 0);
  assertEquals(pattern.root.text, "f($Xfoo)");
});

Deno.test("shares placeholders for repeated named metavariables", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("$X == $X", lang);
    const entries = metas(pattern);

    assertEquals(entries.length, 2);
    assert(entries.every((entry) => entry.meta.name === "X"));
    assertEquals(entries[0].node.text, entries[1].node.text);
  }
});

Deno.test("supports anonymous metavariables", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f($_, $_FN)", lang);

    assertEquals(metas(pattern).map((entry) => entry.meta), [
      { name: undefined, variadic: false },
      { name: undefined, variadic: false },
    ]);
  }
});

Deno.test("rejects reserved name and named arity mixing", async () => {
  for (const lang of LANGUAGES) {
    await assertCompileError(() => compilePattern("f($MATCH)", lang), "MATCH");
    await assertCompileError(() => compilePattern("f($X, $$$X)", lang), "arity");
  }
});

Deno.test("rejects adjacent variadic metavariables", async () => {
  for (const lang of LANGUAGES) {
    await assertCompileError(() => compilePattern("f($$$A, $$$B)", lang), "adjacent");
  }
});

Deno.test("rejects invalid implicit roots", async () => {
  await assertCompileError(() => compilePattern("", "typescript"), "root");
  await assertCompileError(() => compilePattern("a; b;", "typescript"), "root");

  for (const lang of LANGUAGES) {
    await assertCompileError(() => compilePattern("$$$X", lang), "variadic");
  }
});

Deno.test("supports context selector and rejects missing or outside metavariables", async () => {
  const ok = await compilePattern("", "typescript", {
    context: "class C { $M() {} }",
    selector: "method_definition",
  });
  assertEquals(ok.root.type, "method_definition");
  assertEquals(metas(ok).map((entry) => entry.meta), [{ name: "M", variadic: false }]);

  await assertCompileError(
    () =>
      compilePattern("", "typescript", {
        context: "class C { $M() {} }",
        selector: "function_declaration",
      }),
    "selector",
  );
  await assertCompileError(
    () =>
      compilePattern("", "typescript", {
        context: "$OUT; function f() { $IN }",
        selector: "function_declaration",
      }),
    "outside",
  );
});

Deno.test("supports custom metavariable prefix", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("console.log(µMSG)", lang, { metaVarPrefix: "µ" });

    assertEquals(metas(pattern).map((entry) => entry.meta), [
      { name: "MSG", variadic: false },
    ]);
  }
});

Deno.test("regenerates placeholders deterministically on source collision", async () => {
  for (const lang of LANGUAGES) {
    const pattern = await compilePattern("f(__stx_meta_0__, $X)", lang);
    const [entry] = metas(pattern);

    assertEquals(entry.node.text, "__stx_meta_1__");
  }
});

function metas(pattern: CompiledPattern): { node: Node; meta: Metavariable }[] {
  const entries: { node: Node; meta: Metavariable }[] = [];
  visit(pattern.source.tree.rootNode);
  return entries;

  function visit(node: Node) {
    const meta = pattern.metavars.get(node.id);
    if (meta) entries.push({ node, meta });
    for (const child of node.children) {
      if (child) visit(child);
    }
  }
}

async function assertCompileError(fn: () => Promise<unknown>, includes: string) {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof CompileError)) {
      throw new Error(`expected CompileError, got ${error}`);
    }
    assert(error.message.includes(includes), `expected message to include ${includes}`);
    return;
  }
  throw new Error("expected CompileError");
}
