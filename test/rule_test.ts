import { findMatches } from "../src/matcher.ts";
import { findRuleMatches, loadRule, loadRuleText, RuleLoadError } from "../src/rule.ts";
import { SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function yaml(rule: string, extra = ""): string {
  return `version: 1
id: test/rule
language: typescript
severity: warn
${extra.split("\n").some((line) => line.startsWith("message:")) ? "" : "message: test\n"}
${extra}rule:
${rule}`;
}

async function assertLoadError(text: string, message: string) {
  try {
    await loadRuleText(text);
  } catch (error) {
    if (error instanceof RuleLoadError && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected RuleLoadError containing ${message}`);
}

Deno.test("loads a YAML pattern rule and matches a real TypeScript file", async () => {
  const rule = await loadRule(new URL("fixtures/console_log.yaml", import.meta.url));
  const bytes = await Deno.readFile(new URL("fixtures/console_log.ts", import.meta.url));
  const source = await SourceFile.parse(rule.language, bytes);
  const matches = findMatches(rule.pattern, source);

  assertEquals(
    {
      version: rule.version,
      id: rule.id,
      language: rule.language,
      severity: rule.severity,
      message: rule.message,
    },
    {
      version: 1,
      id: "smoke/console-log",
      language: "typescript",
      severity: "warn",
      message: "console.log call",
    },
  );
  assertEquals(matches.length, 3);
  assertEquals(matches.map(({ root }) => root), [
    { start: 0, end: 46 },
    { start: 22, end: 42 },
    { start: 74, end: 95 },
  ]);
  assertEquals(matches.map(({ root }) => source.sourceText(root)), [
    'console.log(() => {\n  console.log("first");\n})',
    'console.log("first")',
    'console.log("second")',
  ]);
  assertEquals(
    matches.map(({ captures }) => {
      const capture = captures.get("ARG");
      if (!capture || capture.kind !== "single") throw new Error("missing ARG capture");
      const range = source.rangeOf(capture.node);
      return { range, text: source.sourceText(range) };
    }),
    [
      { range: { start: 12, end: 45 }, text: '() => {\n  console.log("first");\n}' },
      { range: { start: 34, end: 41 }, text: '"first"' },
      { range: { start: 86, end: 94 }, text: '"second"' },
    ],
  );
});

Deno.test("reports UTF-8 byte ranges through the YAML smoke path", async () => {
  const rule = await loadRule(new URL("fixtures/console_log.yaml", import.meta.url));
  const source = await SourceFile.parse(
    rule.language,
    await Deno.readFile(new URL("fixtures/console_log_utf8.ts", import.meta.url)),
  );
  const [match] = findRuleMatches(rule, source);
  const capture = match?.captures.get("ARG");
  if (!match || !capture || capture.kind !== "single") throw new Error("missing ARG capture");

  const captureRange = source.rangeOf(capture.node);
  assertEquals(match.root, { start: 28, end: 50 });
  assertEquals(source.sourceText(match.root), 'console.log("값🙂")');
  assertEquals(captureRange, { start: 40, end: 49 });
  assertEquals(source.sourceText(captureRange), '"값🙂"');
});

Deno.test("loads and matches a nested Python fixture in pre-order", async () => {
  const rule = await loadRule(new URL("fixtures/python_nested.yaml", import.meta.url));
  const source = await SourceFile.parse(
    rule.language,
    await Deno.readFile(new URL("fixtures/python_nested.py", import.meta.url)),
  );
  const matches = findRuleMatches(rule, source);

  assertEquals(rule.language, "python");
  assertEquals(matches.map(({ root }) => root), [
    { start: 0, end: 36 },
    { start: 14, end: 36 },
    { start: 37, end: 55 },
  ]);
  assertEquals(matches.map(({ root }) => source.sourceText(root)), [
    "if outer:\n    if inner:\n        pass",
    "if inner:\n        pass",
    "if later:\n    pass",
  ]);
  assertEquals(
    matches.map(({ captures }) => {
      const capture = captures.get("COND");
      if (!capture || capture.kind !== "single") throw new Error("missing COND capture");
      const range = source.rangeOf(capture.node);
      return { range, text: source.sourceText(range) };
    }),
    [
      { range: { start: 3, end: 8 }, text: "outer" },
      { range: { start: 17, end: 22 }, text: "inner" },
      { range: { start: 40, end: 45 }, text: "later" },
    ],
  );
});

Deno.test("loads variadic captures with zero, one, and many nodes", async () => {
  const rule = await loadRule(new URL("fixtures/variadic.yaml", import.meta.url));
  const source = await SourceFile.parse(
    rule.language,
    await Deno.readFile(new URL("fixtures/variadic.ts", import.meta.url)),
  );
  const matches = findRuleMatches(rule, source);

  assertEquals(matches.map(({ root }) => source.sourceText(root)), ["f()", "f(a)", "f(a, b)"]);
  assertEquals(
    matches.map(({ captures }) => {
      const capture = captures.get("ARGS");
      if (!capture || capture.kind !== "multi") throw new Error("missing ARGS capture");
      return {
        nodes: capture.nodes.map((node) => source.sourceText(source.rangeOf(node))),
        span: capture.span,
        text: source.sourceText(capture.span),
      };
    }),
    [
      { nodes: [], span: { start: 55, end: 55 }, text: "" },
      { nodes: ["a"], span: { start: 60, end: 61 }, text: "a" },
      { nodes: ["a", "b"], span: { start: 66, end: 70 }, text: "a, b" },
    ],
  );
});

Deno.test("rejects invalid pattern-only rule files with clear load errors", async () => {
  const cases = [
    ["rule_missing_id.yaml", "id must be a string"],
    ["rule_wrong_type.yaml", "id must be a string"],
    ["rule_unsupported_language.yaml", "unsupported language: javascript"],
    ["rule_unsupported_combinator.yaml", "rule has unsupported combinator: sibling"],
  ];

  for (const [fixture, message] of cases) {
    try {
      await loadRule(new URL(`fixtures/${fixture}`, import.meta.url));
    } catch (error) {
      if (error instanceof RuleLoadError && error.message === message) continue;
      throw error;
    }
    throw new Error(`expected RuleLoadError for ${fixture}`);
  }
});

Deno.test("compiles and evaluates atomic and logical combinators in order", async () => {
  const source = await SourceFile.parse("typescript", "f(a); f(b)");
  const rule = await loadRuleText(`
version: 1
id: test/atoms
language: typescript
severity: warn
message: call
rule:
  all:
    - kind: call_expression
    - regex: 'f\\('
    - any:
        - pattern: f($X)
        - pattern: $X
    - not:
        pattern: g($_)
`);

  const matches = findRuleMatches(rule, source);
  assertEquals(matches.map((match) => source.sourceText(match.root)), ["f(a)", "f(b)"]);
  assertEquals(
    matches.map((match) => {
      const capture = match.captures.get("X");
      return capture?.kind === "single" ? capture.node.text : undefined;
    }),
    ["a", "b"],
  );

  const conflict = await loadRuleText(`
version: 1
id: test/conflict
language: typescript
severity: warn
message: conflict
rule:
  all:
    - pattern: f($X)
    - pattern: $X
`);
  assertEquals(findRuleMatches(conflict, source), []);

  const isolated = await loadRuleText(yaml(`  all:
    - pattern: f($X)
    - not:
        pattern: f($Y, extra)`));
  assertEquals(
    findRuleMatches(isolated, source).map((match) => [...match.captures.keys()]),
    [["X"], ["X"]],
  );
});

Deno.test("evaluates four relation axes with inclusive stop boundaries and units siblings", async () => {
  const source = await SourceFile.parse("typescript", "f(a, b, c)");
  const cases = [
    [
      `  all:
    - kind: identifier
    - regex: ^b$
    - inside:
        kind: arguments`,
      ["b"],
    ],
    [
      `  all:
    - kind: identifier
    - regex: ^b$
    - inside:
        kind: call_expression
        stopBy: end`,
      ["b"],
    ],
    [
      `  all:
    - kind: identifier
    - regex: ^b$
    - inside:
        kind: call_expression
        stopBy: { kind: call_expression }`,
      ["b"],
    ],
    [
      `  all:
    - kind: call_expression
    - has:
        kind: arguments
        stopBy: { kind: arguments }`,
      ["f(a, b, c)"],
    ],
    [
      `  all:
    - kind: call_expression
    - has:
        regex: ^b$
        stopBy: end`,
      ["f(a, b, c)"],
    ],
    [
      `  all:
    - kind: call_expression
    - has:
        kind: arguments`,
      ["f(a, b, c)"],
    ],
    [
      `  all:
    - regex: ^b$
    - follows:
        regex: ^a$`,
      ["b"],
    ],
    [
      `  all:
    - regex: ^c$
    - follows:
        regex: ^a$
        stopBy: end`,
      ["c"],
    ],
    [
      `  all:
    - regex: ^c$
    - follows:
        regex: ^b$
        stopBy: { kind: identifier }`,
      ["c"],
    ],
    [
      `  all:
    - regex: ^b$
    - precedes:
        regex: ^c$
        stopBy: { kind: identifier }`,
      ["b"],
    ],
    [
      `  all:
    - regex: ^a$
    - precedes:
        regex: ^c$
        stopBy: end`,
      ["a"],
    ],
    [
      `  all:
    - regex: ^a$
    - precedes:
        regex: ^b$`,
      ["a"],
    ],
  ] as const;

  for (const [body, expected] of cases) {
    const rule = await loadRuleText(yaml(body));
    assertEquals(
      findRuleMatches(rule, source).map((match) => source.sourceText(match.root)),
      expected,
    );
  }

  const nested = await SourceFile.parse("typescript", "f(g(), f())");
  const unified = await loadRuleText(yaml(`  all:
    - pattern: $NAME($$$ARGS)
    - has:
        pattern: $NAME()
        stopBy: end`));
  assertEquals(
    findRuleMatches(unified, nested).map((match) => nested.sourceText(match.root)),
    ["f(g(), f())"],
  );

  const pruned = await loadRuleText(yaml(`  all:
    - pattern: f($$$ARGS)
    - has:
        pattern: f()
        stopBy: { kind: call_expression }`));
  const deep = await SourceFile.parse("typescript", "f(g(f()))");
  assertEquals(findRuleMatches(pruned, deep), []);
});

Deno.test("computes guaranteed bindings through all, any, not, relations, and matches", async () => {
  await loadRuleText(yaml(
    `  all:
    - pattern: f($X, $_)
    - pattern: f($_, $Y)`,
    "message: $X $Y\n",
  ));

  await assertLoadError(
    yaml(
      `  any:
    - pattern: f($X)
    - pattern: g($Y)`,
      "message: $X\n",
    ),
    "undefined capture reference: X",
  );
  await assertLoadError(
    yaml(
      `  not:
    pattern: f($X)`,
      "message: $X\n",
    ),
    "undefined capture reference: X",
  );
  await loadRuleText(yaml(
    `  has:
    pattern: f($X)
    stopBy: end`,
    "message: $X\n",
  ));
  await loadRuleText(yaml(
    `  matches: call`,
    `message: $X
utils:
  call:
    pattern: f($X)
`,
  ));
  await loadRuleText(yaml(
    `  kind: identifier`,
    `message: $MATCH
constraints:
  $MATCH: { kind: identifier }
`,
  ));

  await assertLoadError(
    yaml(`  pattern: f($X)`, "message: $X\nfix: g($Y)\n"),
    "undefined capture reference: Y",
  );
  await assertLoadError(
    yaml(`  pattern: f($X)`, "message: $X\nfix: g($$$X)\n"),
    "arity mismatch: X",
  );
  await assertLoadError(
    yaml(`  kind: identifier`, "message: $$$MATCH\n"),
    "MATCH reference must be single",
  );
  await assertLoadError(
    yaml(
      `  pattern: f($X)`,
      `message: $X
constraints:
  $Y: { kind: identifier }
`,
    ),
    "undefined capture reference: Y",
  );
  await assertLoadError(
    yaml(
      `  pattern: f($X)`,
      `message: $X
constraints:
  $X: { pattern: $Y }
`,
    ),
    "undefined capture reference: Y",
  );
});

Deno.test("applies constraints after branch selection without adding captures", async () => {
  const source = await SourceFile.parse("typescript", "f(); f(a, b); f(a, 1)");
  const multi = await loadRuleText(yaml(
    `  pattern: f($$$ARGS)`,
    `constraints:
  $$$ARGS: { kind: identifier }
`,
  ));
  assertEquals(
    findRuleMatches(multi, source).map((match) => source.sourceText(match.root)),
    ["f()", "f(a, b)"],
  );

  const singles = await SourceFile.parse("typescript", "f(a, a); f(a, b)");
  const unified = await loadRuleText(yaml(
    `  pattern: f($X, $Y)`,
    `constraints:
  $Y: { pattern: $X }
`,
  ));
  const [match] = findRuleMatches(unified, singles);
  assertEquals(match && singles.sourceText(match.root), "f(a, a)");
  assertEquals([...match.captures.keys()], ["X", "Y"]);

  const committed = await loadRuleText(yaml(
    `  all:
    - kind: call_expression
    - any:
        - pattern: $X
        - pattern: f($X)`,
    `constraints:
  $X: { regex: ^a$ }
`,
  ));
  assertEquals(findRuleMatches(committed, await SourceFile.parse("typescript", "f(a)")), []);
});

Deno.test("uses RE2 regex search semantics and rejects unsupported backreferences", async () => {
  const source = await SourceFile.parse("typescript", "TODOx");
  const partial = await loadRuleText(yaml(`  all:
    - kind: identifier
    - regex: ODO`));
  const anchored = await loadRuleText(yaml(`  all:
    - kind: identifier
    - regex: ^ODO$`));
  assertEquals(findRuleMatches(partial, source).length, 1);
  assertEquals(findRuleMatches(anchored, source).length, 0);
  await assertLoadError(yaml(`  regex: '(a)\\1'`), "invalid escape sequence");
});

Deno.test("keeps utils local and shared, rejects cycles, and limits expanded depth", async () => {
  await assertLoadError(yaml(`  matches: missing`), "unknown util: missing");
  await assertLoadError(
    yaml(
      `  matches: a`,
      `utils:
  a: { matches: a }
`,
    ),
    "cyclic util reference: a",
  );
  await assertLoadError(
    yaml(
      `  matches: a`,
      `utils:
  a: { matches: b }
  b: { matches: a }
`,
    ),
    "cyclic util reference",
  );

  const dag = await loadRuleText(yaml(
    `  any:
    - matches: left
    - matches: right`,
    `utils:
  leaf: { pattern: f($X) }
  left: { matches: leaf }
  right: { matches: leaf }
`,
  ));
  assertEquals(
    findRuleMatches(dag, await SourceFile.parse("typescript", "f(a)")).length,
    1,
  );

  await loadRuleText(yaml(`  matches: deep`, deepUtil(31)));
  await assertLoadError(yaml(`  matches: deep`, deepUtil(32)), "exceeds depth 32");
});

Deno.test("applies metaVarPrefix to patterns, templates, fixes, and constraints", async () => {
  const rule = await loadRuleText(`version: 1
id: test/prefix
language: typescript
severity: warn
message: value µX
fix: g(µX)
note: note
url: https://example.test/rule
metaVarPrefix: µ
rule:
  pattern:
    context: f(µX)
    selector: call_expression
constraints:
  µX: { pattern: µX }
`);
  const matches = findRuleMatches(rule, await SourceFile.parse("typescript", "f(a)"));
  assertEquals(matches.length, 1);
  assertEquals([...matches[0].captures.keys()], ["X"]);
  assertEquals({ fix: rule.fix, note: rule.note, url: rule.url }, {
    fix: { template: "g(µX)", safety: "safe" },
    note: "note",
    url: "https://example.test/rule",
  });
});

Deno.test("normalizes fix shorthand and loads long fixes with suggestions", async () => {
  const shorthand = await loadRuleText(yaml(
    `  pattern: f($X)`,
    `fix: g($X)
`,
  ));
  assertEquals(shorthand.fix, { template: "g($X)", safety: "safe" });
  assertEquals(shorthand.suggestions, []);

  const long = await loadRuleText(`version: 1
id: test/rewrites
language: typescript
severity: warn
message: call $X
fix:
  template: g($X)
  safety: unsafe
suggestions:
  - message: use h($X)
    template: h($X)
  - message: delete $MATCH
    template: ""
rule:
  pattern: f($X)
`);
  assertEquals(long.fix, { template: "g($X)", safety: "unsafe" });
  assertEquals(long.suggestions, [
    { message: "use h($X)", template: "h($X)" },
    { message: "delete $MATCH", template: "" },
  ]);
});

Deno.test("strictly validates fix and suggestion object schemas", async () => {
  const cases = [
    ["fix: { template: g($X), safety: risky }", "fix.safety"],
    ["fix: { safety: safe }", "fix.template"],
    ["fix: { template: g($X), extra: true }", "fix has unsupported field: extra"],
    ["suggestions: nope", "suggestions must be an array"],
    ["suggestions: [{ template: g($X) }]", "suggestions[0].message"],
    ["suggestions: [{ message: use g }]", "suggestions[0].template"],
    [
      "suggestions: [{ message: use g, template: g($X), extra: true }]",
      "suggestions[0] has unsupported field: extra",
    ],
  ];
  for (const [schema, message] of cases) {
    await assertLoadError(yaml(`  pattern: f($X)`, `${schema}\n`), message);
  }
});

Deno.test("validates metavariable references in suggestion messages and templates", async () => {
  const cases = [
    ["use $Y", "g($X)", "undefined capture reference: Y"],
    ["use $X", "g($Y)", "undefined capture reference: Y"],
    ["use $$$X", "g($X)", "arity mismatch: X"],
    ["use $X", "g($$$X)", "arity mismatch: X"],
  ];
  for (const [message, template, error] of cases) {
    await assertLoadError(
      yaml(
        `  pattern: f($X)`,
        `suggestions:
  - message: ${message}
    template: ${template}
`,
      ),
      error,
    );
  }
});

Deno.test("rejects anonymous metavariables in every reporting template", async () => {
  const cases = [
    "message: use $_",
    "fix: g($_)",
    "suggestions: [{ message: use $_, template: g($X) }]",
    "suggestions: [{ message: use $X, template: g($_) }]",
  ];
  for (const schema of cases) {
    await assertLoadError(
      yaml(`  pattern: f($X)`, `${schema}\n`),
      "anonymous metavariables cannot be referenced",
    );
  }
});

Deno.test("strictly rejects unsupported rule schema and relation modifiers", async () => {
  const cases = [
    [yaml(`  kind: identifier`).replace("test/rule", "tool/internal"), "tool/ prefix"],
    [yaml(`  kind: identifier`, "extends: base\n"), "extends is not supported"],
    [yaml(`  kind: identifier`, "unknown: true\n"), "unsupported field: unknown"],
    [yaml(`  sibling: identifier`), "unsupported combinator: sibling"],
    [yaml(`  all: []\n  any: []`), "exactly one combinator"],
    [yaml(`  has:\n    kind: identifier\n    stopBy: far`), "stopBy must be"],
    [
      yaml(`  pattern:\n    context: a\n    selector: identifier\n    alias: a`),
      "unsupported field: alias",
    ],
    [yaml(`  kind: identifier`, "engine: structural\n"), "unsupported engine: structural"],
  ];
  for (const [text, message] of cases) await assertLoadError(text, message);
});

Deno.test("parse-error siblings still consume neighbor distance", async () => {
  const rule = await loadRuleText(yaml(`  all:
    - regex: ^b$
    - follows:
        regex: ^a$`));
  const source = await SourceFile.parse("typescript", "f(a, +, b)");
  assertEquals(findRuleMatches(rule, source), []);
});

Deno.test("severity off does not change the rule MatchSet", async () => {
  const rule = await loadRuleText(
    yaml(`  pattern: f($X)`).replace("severity: warn", "severity: off"),
  );
  assertEquals(
    findRuleMatches(rule, await SourceFile.parse("typescript", "f(a)")).length,
    1,
  );
});

Deno.test("requires canonical package/rule IDs", async () => {
  for (const id of ["", "foo", "/x", "x/", "x/y/z", " x/y"]) {
    await assertLoadError(
      yaml(`  kind: identifier`).replace("id: test/rule", `id: ${JSON.stringify(id)}`),
      "canonical",
    );
  }
});

Deno.test("evaluates sibling relations through Python units", async () => {
  const rule = await loadRuleText(`version: 1
id: test/python-relation
language: python
severity: warn
message: test
rule:
  all:
    - regex: ^b$
    - follows:
        regex: ^a$
`);
  const source = await SourceFile.parse("python", "f(a, b)\n");
  assertEquals(
    findRuleMatches(rule, source).map((match) => source.sourceText(match.root)),
    ["b"],
  );
});

Deno.test("keeps relation and util negative cases negative", async () => {
  const source = await SourceFile.parse("typescript", "f(a, b)");
  const cases = [
    `  all:
    - regex: ^b$
    - inside: { kind: function_declaration }`,
    `  all:
    - regex: ^b$
    - follows: { regex: ^c$ }`,
    `  all:
    - regex: ^a$
    - precedes: { regex: ^c$ }`,
  ];
  for (const body of cases) {
    assertEquals(findRuleMatches(await loadRuleText(yaml(body)), source), []);
  }

  const util = await loadRuleText(yaml(
    `  matches: g-call`,
    `utils:
  g-call: { pattern: g($_) }
`,
  ));
  assertEquals(findRuleMatches(util, source), []);
});

Deno.test("does not evaluate ERROR or MISSING nodes as rule candidates", async () => {
  const rule = await loadRuleText(yaml(`  kind: ERROR`));
  const source = await SourceFile.parse("typescript", "f(a, +, b)");
  assertEquals(source.parseProblems.some((problem) => problem.isError), true);
  assertEquals(findRuleMatches(rule, source), []);

  const missingRule = await loadRuleText(yaml(`  kind: ";"`));
  const missing = await SourceFile.parse("typescript", "if (x)");
  assertEquals(missing.parseProblems.some((problem) => problem.isMissing), true);
  assertEquals(findRuleMatches(missingRule, missing), []);
});

function nestedNots(count: number): string {
  let expression = "kind: identifier";
  for (let i = 0; i < count; i++) expression = `not:\n${indent(expression)}`;
  return indent(expression);
}

function deepUtil(count: number): string {
  return `utils:\n  deep:\n${indent(nestedNots(count))}\n`;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
