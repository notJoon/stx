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
