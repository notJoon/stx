import { findMatches } from "../src/matcher.ts";
import { loadRule, RuleLoadError } from "../src/rule.ts";
import { SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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
    { start: 0, end: 47 },
    { start: 22, end: 43 },
    { start: 74, end: 96 },
  ]);
  assertEquals(matches.map(({ root }) => source.sourceText(root)), [
    'console.log(() => {\n  console.log("first");\n});',
    'console.log("first");',
    'console.log("second");',
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
  const [match] = findMatches(rule.pattern, source);
  const capture = match?.captures.get("ARG");
  if (!match || !capture || capture.kind !== "single") throw new Error("missing ARG capture");

  const captureRange = source.rangeOf(capture.node);
  assertEquals(match.root, { start: 28, end: 51 });
  assertEquals(source.sourceText(match.root), 'console.log("값🙂");');
  assertEquals(captureRange, { start: 40, end: 49 });
  assertEquals(source.sourceText(captureRange), '"값🙂"');
});

Deno.test("loads and matches a nested Python fixture in pre-order", async () => {
  const rule = await loadRule(new URL("fixtures/python_nested.yaml", import.meta.url));
  const source = await SourceFile.parse(
    rule.language,
    await Deno.readFile(new URL("fixtures/python_nested.py", import.meta.url)),
  );
  const matches = findMatches(rule.pattern, source);

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
  const matches = findMatches(rule.pattern, source);

  assertEquals(matches.map(({ root }) => source.sourceText(root)), ["f();", "f(a);", "f(a, b);"]);
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
    ["rule_unsupported_combinator.yaml", "rule has unsupported field: kind"],
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
