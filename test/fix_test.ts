import {
  applyFixes,
  collectRuleFixes,
  collectRuleRewrites,
  expandFixTemplate,
  type Fix,
  fixFile,
  FixTemplateError,
  type Patch,
  selectFixes,
  type Suggestion,
} from "../src/fix.ts";
import { findRuleMatches, loadRuleText } from "../src/rule.ts";
import { SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function patch(start: number, end: number, replacement: string): Patch {
  return { range: { start, end }, replacement };
}

function fix(ruleId: string, patches: Patch[], safety: Fix["safety"] = "safe"): Fix {
  return { kind: "fix", ruleId, safety, patches };
}

const noJoinOption: NonNullable<Parameters<typeof expandFixTemplate>[3]> = {
  // @ts-expect-error custom join is deliberately outside the public v1 API.
  join: ", ",
};
void noJoinOption;

Deno.test("expands Single, MATCH, and custom-prefix captures from original bytes", async () => {
  const rule = await loadRuleText(`version: 1
id: test/template
language: typescript
severity: warn
message: value
fix: h(µX, µMATCH)
metaVarPrefix: µ
rule:
  pattern: f(µX)
`);
  const source = await SourceFile.parse("typescript", "const 값 = f(é);");
  const [match] = findRuleMatches(rule, source);

  assertEquals(
    expandFixTemplate(source, match, rule.fix!.template, {
      metaVarPrefix: rule.metaVarPrefix,
    }),
    "h(é, f(é))",
  );
});

Deno.test("preserves Multi source separators without a join override", async () => {
  const rule = await loadRuleText(`version: 1
id: test/multi
language: typescript
severity: warn
message: args
fix: g($$$ARGS)
rule:
  pattern: f($$$ARGS)
`);
  const source = await SourceFile.parse("typescript", "f(a, /* keep */ b ,c)");
  const [match] = findRuleMatches(rule, source);
  assertEquals(
    expandFixTemplate(source, match, rule.fix!.template, {
      metaVarPrefix: rule.metaVarPrefix,
    }),
    "g(a, /* keep */ b ,c)",
  );
});

Deno.test("empty Multi inserts nothing and does not clean adjacent punctuation", async () => {
  const rule = await loadRuleText(`version: 1
id: test/empty
language: typescript
severity: warn
message: args
fix: g(0, $$$ARGS)
rule:
  pattern: f($$$ARGS)
`);
  const source = await SourceFile.parse("typescript", "f()");
  const [match] = findRuleMatches(rule, source);

  assertEquals(
    expandFixTemplate(source, match, rule.fix!.template, {
      metaVarPrefix: rule.metaVarPrefix,
    }),
    "g(0, )",
  );
});

Deno.test("never substitutes an undefined capture with an empty string", async () => {
  const source = await SourceFile.parse("typescript", "f(a)");
  const rule = await loadRuleText(`version: 1
id: test/defined
language: typescript
severity: warn
message: value
rule:
  pattern: f($X)
`);
  const [match] = findRuleMatches(rule, source);
  try {
    expandFixTemplate(source, match, "$Y");
  } catch (error) {
    assert(error instanceof FixTemplateError);
    assert(error.message.includes("undefined capture"));
    return;
  }
  throw new Error("expected FixTemplateError");
});

Deno.test("collects string fixes as safe root replacements and excludes severity off", async () => {
  const yaml = `version: 1
id: test/collect
language: typescript
severity: warn
message: call
fix: g($X)
rule:
  pattern: f($X)
`;
  const source = await SourceFile.parse("typescript", "\ufefff(값)");
  const rule = await loadRuleText(yaml);
  const matches = findRuleMatches(rule, source);
  const fixes = collectRuleFixes(rule, source, matches);

  assertEquals(fixes, [fix("test/collect", [patch(3, 9, "g(값)")])]);

  const off = await loadRuleText(yaml.replace("severity: warn", "severity: off"));
  assertEquals(findRuleMatches(off, source).length, 1);
  assertEquals(collectRuleFixes(off, source, findRuleMatches(off, source)), []);
});

Deno.test("preserves a capture that begins with U+FEFF", async () => {
  const rule = await loadRuleText(`version: 1
id: test/capture-feff
language: typescript
severity: warn
message: value
fix: 'g("$X")'
rule:
  pattern: 'f("$X")'
`);
  const source = await SourceFile.parse("typescript", 'f("\ufeffa")');
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  const result = await applyFixes(source, fixes, "safe");
  assertEquals(text(result.bytes), 'g("\ufeffa")');
});

Deno.test("treats an empty string fix as a root deletion", async () => {
  const rule = await loadRuleText(`version: 1
id: test/delete
language: typescript
severity: warn
message: delete
fix: ""
rule:
  pattern: f($X)
`);
  const source = await SourceFile.parse("typescript", "f(a)");
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  assertEquals(fixes, [fix("test/delete", [patch(0, 4, "")])]);
  assertEquals(text((await applyFixes(source, fixes, "safe")).bytes), "");
});

Deno.test("collects unsafe fixes and expanded suggestions as root patches", async () => {
  const rule = await loadRuleText(`version: 1
id: test/rewrites
language: typescript
severity: warn
message: call
fix: { template: "g($X)", safety: unsafe }
suggestions:
  - message: use h($X)
    template: h($X)
  - message: delete $MATCH
    template: ""
rule:
  pattern: f($X)
`);
  const source = await SourceFile.parse("typescript", "f(값)");
  const matches = findRuleMatches(rule, source);
  assertEquals(collectRuleRewrites(rule, source, matches), [
    fix("test/rewrites", [patch(0, 6, "g(값)")], "unsafe"),
    {
      kind: "suggestion",
      ruleId: "test/rewrites",
      message: "use h(값)",
      patches: [patch(0, 6, "h(값)")],
    },
    {
      kind: "suggestion",
      ruleId: "test/rewrites",
      message: "delete f(값)",
      patches: [patch(0, 6, "")],
    },
  ]);

  const off = await loadRuleText(`version: 1
id: test/off-rewrites
language: typescript
severity: off
message: call
fix: g($X)
suggestions: [{ message: use h, template: h($X) }]
rule: { pattern: f($X) }
`);
  assertEquals(collectRuleRewrites(off, source, findRuleMatches(off, source)), []);
});

Deno.test("rejects invalid ranges and a self-conflicting fix atomically", async () => {
  const source = await SourceFile.parse("typescript", "abcdef");
  const selfConflict = fix("test/self", [patch(1, 4, "x"), patch(3, 5, "y")]);
  const invalid = [
    fix("test/negative", [patch(-1, 0, "x")]),
    fix("test/reversed", [patch(2, 1, "x")]),
    fix("test/outside", [patch(0, 7, "x")]),
  ];
  const result = await applyFixes(source, [selfConflict, ...invalid], "unsafe");

  assertEquals(text(result.bytes), "abcdef");
  assertEquals(result.applied, []);
  assertEquals(
    result.rejected.map(({ code, internalError }) => [code, internalError]),
    [
      ["invalid-range", true],
      ["invalid-range", true],
      ["invalid-range", true],
      ["self-conflict", true],
    ],
  );
});

Deno.test("orders non-finite invalid ranges independently of input order", async () => {
  const source = await SourceFile.parse("typescript", "abc");
  const invalid = [
    fix("test/z", [patch(Number.NaN, 1, "x")]),
    fix("test/a", [patch(0, Number.POSITIVE_INFINITY, "y")]),
  ];
  const forward = await applyFixes(source, invalid, "unsafe");
  const reverse = await applyFixes(source, invalid.toReversed(), "unsafe");
  assertEquals(
    forward.rejected.map(({ rewrite }) => rewrite.ruleId),
    reverse.rejected.map(({ rewrite }) => rewrite.ruleId),
  );
  assertEquals(forward.rejected.map(({ rewrite }) => rewrite.ruleId), ["test/a", "test/z"]);
});

Deno.test("sorts fixes deterministically and rejects a conflicting multi-patch fix whole", async () => {
  const source = await SourceFile.parse("typescript", "0123456789");
  const later = fix("test/z", [patch(2, 4, "Z")]);
  const earlier = fix("test/a", [patch(2, 3, "A")]);
  const atomic = fix("test/multi", [patch(0, 1, "M"), patch(8, 9, "N")]);
  const blocksAtomic = fix("test/block", [patch(8, 10, "B")]);

  const forward = await applyFixes(source, [later, blocksAtomic, atomic, earlier], "unsafe");
  const reverse = await applyFixes(source, [earlier, atomic, blocksAtomic, later], "unsafe");

  assertEquals(text(forward.bytes), "M1A34567N9");
  assertEquals(text(reverse.bytes), text(forward.bytes));
  assertEquals(forward.applied.map((item) => item.ruleId), ["test/multi", "test/a"]);
  assertEquals(
    forward.rejected.filter(({ code }) => code === "conflict").map(({ rewrite }) => rewrite.ruleId),
    ["test/z", "test/block"],
  );
});

Deno.test("rejects every patch of a later multi-patch fix when one patch conflicts", async () => {
  const source = await SourceFile.parse("typescript", "abcdefghij");
  const result = await applyFixes(source, [
    fix("test/first", [patch(1, 3, "X")]),
    fix("test/later-multi", [patch(2, 4, "Y"), patch(8, 9, "Z")]),
  ], "safe");

  assertEquals(text(result.bytes), "aXdefghij");
  assertEquals(result.applied.map(({ ruleId }) => ruleId), ["test/first"]);
  assertEquals(result.rejected.map(({ rewrite, code }) => [rewrite.ruleId, code]), [
    ["test/later-multi", "conflict"],
  ]);
});

Deno.test("allows adjacent half-open patches and conservatively conflicts zero-width boundaries", async () => {
  const adjacentSource = await SourceFile.parse("typescript", "abcd");
  const adjacent = await applyFixes(adjacentSource, [
    fix("test/left", [patch(0, 1, "A")]),
    fix("test/right", [patch(1, 2, "B")]),
    fix("test/end-insert", [patch(2, 2, "_")]),
  ], "unsafe");
  assertEquals(text(adjacent.bytes), "AB_cd");

  const cases = [
    [patch(2, 2, "x"), patch(2, 2, "y")],
    [patch(2, 2, "x"), patch(2, 4, "y")],
    [patch(3, 3, "x"), patch(2, 4, "y")],
  ];
  for (const [first, second] of cases) {
    const result = await applyFixes(adjacentSource, [
      fix("test/a", [first]),
      fix("test/b", [second]),
    ], "unsafe");
    assertEquals(result.applied.length, 1);
    assertEquals(result.rejected.map(({ code }) => code), ["conflict"]);
  }
});

Deno.test("splices UTF-8 disk bytes from back to front while preserving BOM and outside bytes", async () => {
  const source = await SourceFile.parse("typescript", "\ufeffconst 값 = 'é';\r\nnext();\r\n");
  const valueStart = encoder.encode("\ufeffconst ").length;
  const valueEnd = valueStart + encoder.encode("값").length;
  const stringStart = encoder.encode("\ufeffconst 값 = ").length;
  const stringEnd = stringStart + encoder.encode("'é'").length;
  const result = await applyFixes(source, [fix("test/bytes", [
    patch(valueStart, valueEnd, "이름"),
    patch(stringStart, stringEnd, "'🙂'"),
  ])], "safe");

  assertEquals(text(result.bytes), "\ufeffconst 이름 = '🙂';\r\nnext();\r\n");
  assertEquals(result.applied.map((item) => item.ruleId), ["test/bytes"]);
});

Deno.test("uses existing parse problems as baseline and rolls back only regressions", async () => {
  const original = "const = ;\nlet x = 1;\n";
  const source = await SourceFile.parse("typescript", original);
  assert(source.parseProblems.length > 0);
  const lineEnd = encoder.encode("const = ;").length;
  const improved = await applyFixes(source, [
    fix("test/improve", [patch(0, lineEnd, "const ok = 0;")]),
  ], "safe");
  assertEquals(text(improved.bytes), "const ok = 0;\nlet x = 1;\n");

  const x = encoder.encode("const = ;\nlet ").length;
  const same = await applyFixes(source, [fix("test/same", [patch(x, x + 1, "y")])], "safe");
  assertEquals(text(same.bytes), "const = ;\nlet y = 1;\n");

  const valid = await SourceFile.parse("typescript", "let x = 1;\n");
  const broken = await applyFixes(valid, [fix("test/bad", [patch(8, 9, "")])], "safe");
  assertEquals(text(broken.bytes), "let x = 1;\n");
  assertEquals(broken.rejected.map(({ code }) => code), ["parse-regression"]);
});

Deno.test("greedy parse survivors always restart from the original pass bytes", async () => {
  const source = await SourceFile.parse("typescript", "let a = 1; let b = 2;\n");
  const result = await applyFixes(source, [
    fix("test/good", [patch(4, 5, "alpha")]),
    fix("test/bad", [patch(8, 9, "")]),
    fix("test/later-good", [patch(15, 16, "beta")]),
  ], "safe");

  assertEquals(text(result.bytes), "let alpha = 1; let beta = 2;\n");
  assertEquals(result.applied.map((item) => item.ruleId), ["test/good", "test/later-good"]);
  assertEquals(result.rejected.map(({ rewrite, code }) => [rewrite.ruleId, code]), [
    ["test/bad", "parse-regression"],
  ]);
});

Deno.test("safe mode excludes unsafe fixes and suggestions are never applied", async () => {
  const source = await SourceFile.parse("typescript", "abc");
  const safe = fix("test/safe", [patch(0, 1, "A")]);
  const unsafe = fix("test/unsafe", [patch(1, 2, "B")], "unsafe");
  const suggestion: Suggestion = {
    kind: "suggestion",
    ruleId: "test/suggestion",
    message: "try C",
    patches: [patch(2, 3, "C")],
  };

  assertEquals(selectFixes([unsafe, suggestion, safe], "safe"), [safe]);
  assertEquals(selectFixes([suggestion, unsafe, safe], "unsafe"), [unsafe, safe]);

  for (const mode of ["safe", "unsafe"] as const) {
    const suggestionResult = await applyFixes(source, [suggestion], mode);
    assertEquals(text(suggestionResult.bytes), "abc");
    assertEquals(suggestionResult.applied, []);
    assertEquals(suggestionResult.rejected.map(({ code }) => code), ["suggestion"]);
  }

  const safeResult = await applyFixes(source, [unsafe, safe], "safe");
  assertEquals(text(safeResult.bytes), "Abc");
  assertEquals(safeResult.rejected.map(({ code }) => code), ["unsafe"]);

  const unsafeResult = await applyFixes(
    source,
    selectFixes([suggestion, unsafe, safe], "unsafe"),
    "unsafe",
  );
  assertEquals(text(unsafeResult.bytes), "ABc");
  assertEquals(unsafeResult.rejected, []);
});

Deno.test("fixpoint reparses and recollects ranges from current bytes every pass", async () => {
  const seen: string[] = [];
  const result = await fixFile("typescript", "x + x", (source) => {
    const current = source.sourceText(source.rangeOf(source.tree.rootNode));
    seen.push(current);
    const index = current.indexOf("x");
    if (index < 0) return [];
    const start = encoder.encode(current.slice(0, index)).length;
    return [fix("test/rematch", [patch(start, start + 1, "long")])];
  });

  assertEquals(text(result.bytes), "long + long");
  assertEquals(seen, ["x + x", "long + x", "long + long"]);
  assertEquals(result.reason, "no-fixes");
  assertEquals(result.passes, 3);
});

Deno.test("fixpoint stops on unchanged output", async () => {
  let calls = 0;
  const result = await fixFile("typescript", "x", () => {
    calls++;
    return [fix("test/same", [patch(0, 1, "x")])];
  });

  assertEquals(text(result.bytes), "x");
  assertEquals({ calls, passes: result.passes, reason: result.reason }, {
    calls: 1,
    passes: 1,
    reason: "unchanged",
  });
});

Deno.test("fixpoint detects a three-state cycle and returns the source before repetition", async () => {
  const next: Record<string, string> = { a: "b", b: "c", c: "a" };
  const result = await fixFile("typescript", "a", (source) => {
    const current = source.sourceText(source.rangeOf(source.tree.rootNode));
    return [fix("test/cycle", [patch(0, 1, next[current])])];
  });

  assertEquals(text(result.bytes), "c");
  assertEquals({ passes: result.passes, reason: result.reason }, {
    passes: 3,
    reason: "cycle",
  });
  assertEquals(result.applications.map(({ committed }) => committed), [true, true, false]);
});

Deno.test("fixpoint runs at most exactly ten passes", async () => {
  let calls = 0;
  const result = await fixFile("typescript", "x0", (source) => {
    calls++;
    const root = source.rangeOf(source.tree.rootNode);
    return [fix("test/ten", [patch(root.start, root.end, `x${calls}`)])];
  });

  assertEquals(text(result.bytes), "x10");
  assertEquals({ calls, passes: result.passes, reason: result.reason }, {
    calls: 10,
    passes: 10,
    reason: "max-passes",
  });
});

Deno.test("preserves the first template line and indents only later template lines", async () => {
  const cases = [
    {
      language: "typescript" as const,
      source: "function f() {\n  old();\n}\n",
      yaml: `version: 1
id: test/indent-ts
language: typescript
severity: warn
message: old
fix: "  if (ok) {\\n    run();\\n  }"
rule:
  pattern:
    context: old();
    selector: expression_statement
`,
      expected: "function f() {\n    if (ok) {\n      run();\n    }\n}\n",
    },
    {
      language: "python" as const,
      source: "def f():\n    old()\n",
      yaml: `version: 1
id: test/indent-py
language: python
severity: warn
message: old
fix: "  if ok:\\n    run()"
rule:
  pattern: old()
`,
      expected: "def f():\n      if ok:\n        run()\n",
    },
  ];

  for (const item of cases) {
    const source = await SourceFile.parse(item.language, item.source);
    const rule = await loadRuleText(item.yaml);
    const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
    const result = await applyFixes(source, fixes, "safe");
    assertEquals(text(result.bytes), item.expected);
  }
});

Deno.test("uses first-line indentation after a file BOM", async () => {
  const source = await SourceFile.parse("typescript", "\ufeff  old();\r\n");
  const rule = await loadRuleText(`version: 1
id: test/bom-indent
language: typescript
severity: warn
message: old
fix: "if (ok) {\\n  run();\\n}"
rule:
  pattern:
    context: old();
    selector: expression_statement
`);
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  const result = await applyFixes(source, fixes, "safe");
  assertEquals(text(result.bytes), "\ufeff  if (ok) {\n    run();\n  }\r\n");
});

Deno.test("preserves every byte of a general multiline capture", async () => {
  const source = await SourceFile.parse(
    "typescript",
    "function f() {\n  old({\n      a: 1,\n    b: 2,\n  });\n}\n",
  );
  const rule = await loadRuleText(`version: 1
id: test/capture-bytes
language: typescript
severity: warn
message: capture
fix: use($X)
rule:
  pattern: old($X)
`);
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  const result = await applyFixes(source, fixes, "safe");
  assertEquals(
    text(result.bytes),
    "function f() {\n  use({\n      a: 1,\n    b: 2,\n  });\n}\n",
  );
});

Deno.test("does not reindent bytes captured from template and triple-quoted strings", async () => {
  const cases = [
    {
      language: "typescript" as const,
      source: "function f() {\n  const x = `first\n    raw`;\n}\n",
      pattern: "const x = $X",
      expected: "function f() {\n  use(`first\n    raw`)\n}\n",
    },
    {
      language: "python" as const,
      source: 'def f():\n    x = """first\n    raw"""\n',
      pattern: "x = $X",
      expected: 'def f():\n    use("""first\n    raw""")\n',
    },
  ];

  for (const item of cases) {
    const source = await SourceFile.parse(item.language, item.source);
    const rule = await loadRuleText(`version: 1
id: test/literal
language: ${item.language}
severity: warn
message: literal
fix: use($X)
rule:
  pattern: ${JSON.stringify(item.pattern)}
`);
    const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
    const result = await applyFixes(source, fixes, "safe");
    assertEquals(text(result.bytes), item.expected);
  }
});

Deno.test("reindents template-owned code before a protected multiline literal", async () => {
  const source = await SourceFile.parse(
    "typescript",
    "function f() {\n  old(`first\n    raw`);\n}\n",
  );
  const rule = await loadRuleText(`version: 1
id: test/literal-prefix
language: typescript
severity: warn
message: literal
fix: "if (ok) {\\n  use($X);\\n}"
rule:
  pattern: old($X)
`);
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  const result = await applyFixes(source, fixes, "safe");
  assertEquals(
    text(result.bytes),
    "function f() {\n  if (ok) {\n    use(`first\n    raw`);\n  };\n}\n",
  );
});

Deno.test("uses the line indentation when replacing a nested expression", async () => {
  const source = await SourceFile.parse(
    "typescript",
    "function f() {\n  return old();\n}\n",
  );
  const rule = await loadRuleText(`version: 1
id: test/nested-indent
language: typescript
severity: warn
message: nested
fix: "wrap(\\n  value\\n)"
rule:
  pattern: old()
`);
  const fixes = collectRuleFixes(rule, source, findRuleMatches(rule, source));
  const result = await applyFixes(source, fixes, "safe");
  assertEquals(
    text(result.bytes),
    "function f() {\n  return wrap(\n    value\n  );\n}\n",
  );
});
