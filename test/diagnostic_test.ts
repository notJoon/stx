import {
  compareDiagnostics,
  diagnosticFromMatch,
  parseDiagnosticJsonl,
  serializeDiagnostic,
} from "../src/diagnostic.ts";
import { findRuleMatches, loadRuleText } from "../src/rule.ts";
import { SourceFile } from "../src/source_file.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("Diagnostic preserves disk-byte captures, rewrites, and expanded messages", async () => {
  const bytes = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode("f(값, x)\r\nf()\r\n"),
  ]);
  const source = await SourceFile.parse("typescript", bytes);
  const rule = await loadRuleText(`version: 1
id: test/diagnostic
language: typescript
severity: warn
message: "args: $$$ARGS in $MATCH"
note: keep
url: https://example.test/rule
fix:
  safety: unsafe
  template: g($$$ARGS)
suggestions:
  - message: "replace $$$ARGS"
    template: h($$$ARGS)
rule:
  pattern: f($$$ARGS)
`);
  const matches = findRuleMatches(rule, source);
  const first = await diagnosticFromMatch("src/값.ts", source, rule, matches[0]);
  const empty = await diagnosticFromMatch("src/값.ts", source, rule, matches[1]);

  assertEquals(first, {
    schema: 1,
    rule_id: "test/diagnostic",
    severity: "warn",
    message: "args: 값, x in f(값, x)",
    path: "src/값.ts",
    range: { start: 3, end: 12 },
    source_hash: "280832e13dcb2c5cea744ca2a68ea077cd211892ba3ec25324155f4e48cfc80f",
    captures: {
      ARGS: {
        start: 5,
        end: 11,
        parts: [{ start: 5, end: 8 }, { start: 10, end: 11 }],
      },
    },
    fix: { safety: "unsafe", patches: [{ start: 3, end: 12, text: "g(값, x)" }] },
    suggestions: [{
      message: "replace 값, x",
      patches: [{ start: 3, end: 12, text: "h(값, x)" }],
    }],
    note: "keep",
    url: "https://example.test/rule",
  });
  assertEquals(empty.captures, { ARGS: { start: 16, end: 16, parts: [] } });
  assertEquals(Object.keys(empty).includes("line"), false);
});

Deno.test("Diagnostic uses Single captures and omits absent optional fields and MATCH", async () => {
  const source = await SourceFile.parse("typescript", "f(é)\n");
  const rule = await loadRuleText(`version: 1
id: test/single
language: typescript
severity: info
message: "$X"
rule:
  pattern: f($X)
`);
  const diagnostic = await diagnosticFromMatch(
    "a.ts",
    source,
    rule,
    findRuleMatches(rule, source)[0],
  );

  assertEquals(diagnostic.captures, { X: { start: 2, end: 4 } });
  assertEquals("fix" in diagnostic, false);
  assertEquals("suggestions" in diagnostic, false);
  assertEquals("note" in diagnostic, false);
  assertEquals("url" in diagnostic, false);
});

Deno.test("JSONL is one escaped line, validates shape, and ignores unknown fields", () => {
  const line = serializeDiagnostic({
    schema: 1,
    rule_id: "test/newline",
    severity: "error",
    message: "first\nsecond",
    path: "a.ts",
    range: { start: 0, end: 1 },
    source_hash: "00".repeat(32),
    captures: {},
  });
  assertEquals(line.endsWith("\n"), true);
  assertEquals(line.split("\n").length, 2);
  const withUnknown = `${line.slice(0, -2)},"future":true}\n`;
  assertEquals(parseDiagnosticJsonl(withUnknown)[0].message, "first\nsecond");
});

Deno.test("Diagnostic sorting has a serialized UTF-8 byte total-order tie breaker", () => {
  const base = {
    schema: 1 as const,
    rule_id: "test/tie",
    severity: "warn" as const,
    path: "a.ts",
    range: { start: 1, end: 2 },
    source_hash: "00".repeat(32),
    captures: {},
  };
  const diagnostics = [
    { ...base, message: "🙂" },
    { ...base, message: "é" },
    { ...base, message: "a" },
  ].sort(compareDiagnostics);
  assertEquals(diagnostics.map(({ message }) => message), ["a", "é", "🙂"]);
});
