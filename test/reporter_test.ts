import Ajv from "ajv";
import draft4 from "ajv-draft-04" with { type: "json" };
import { XMLValidator } from "fast-xml-parser";
import type { Diagnostic } from "../src/diagnostic.ts";
import { parseDiagnosticJsonl, serializeDiagnostic } from "../src/diagnostic.ts";
import { renderReport } from "../src/reporter.ts";
import sarifSchema from "./fixtures/sarif-schema-2.1.0.json" with { type: "json" };

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const diagnostic: Diagnostic = {
  schema: 1,
  rule_id: "test/escape",
  severity: "error",
  message: "100% bad, first\r\n<&\"' second",
  path: "src/a&b.ts",
  range: { start: 2, end: 7 },
  source_hash: "00".repeat(32),
  captures: {
    X: { start: 3, end: 5 },
    XS: { start: 3, end: 6, parts: [{ start: 3, end: 4 }, { start: 5, end: 6 }] },
  },
};

Deno.test("all reporters consume the same parsed Diagnostic JSONL", () => {
  const input = parseDiagnosticJsonl(serializeDiagnostic(diagnostic));
  assertEquals(
    renderReport("console", input),
    "src/a&b.ts:2:7: error[test/escape]: 100% bad, first\r\n<&\"' second\n",
  );

  const sarif = JSON.parse(renderReport("sarif", input));
  assertEquals(sarif.version, "2.1.0");
  assertEquals(
    sarif.$schema,
    "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  );
  assertEquals(sarif.runs[0].results[0].locations[0].physicalLocation.region, {
    byteOffset: 2,
    byteLength: 5,
  });
  assertEquals(sarif.runs[0].results[0].relatedLocations.length, 4);
  assert(sarif.runs[0].tool.driver.name === "tool");
  const validateSarif = new Ajv({ schemaId: "id", meta: false })
    .addMetaSchema(draft4)
    .compile(sarifSchema);
  assert(validateSarif(sarif), JSON.stringify(validateSarif.errors));

  const github = renderReport("github", input);
  assert(github.includes("::error "));
  assert(github.includes("100%25 bad, first%0D%0A<&\"' second"));

  const junit = renderReport("junit", input);
  assert(junit.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert(junit.includes("src/a&amp;b.ts"));
  assert(junit.includes("100% bad, first&#13;&#10;&lt;&amp;&quot;&apos; second"));
  assertEquals(XMLValidator.validate(junit), true);
});

Deno.test("JUnit replaces XML 1.0 forbidden characters", () => {
  const junit = renderReport("junit", [{
    ...diagnostic,
    message: "nul\0 control\u0001 nonchar\ufffe lone\ud800 done",
  }]);
  assertEquals(XMLValidator.validate(junit), true);
  assertEquals(junit.includes("\0"), false);
  assertEquals(junit.includes("\u0001"), false);
  assertEquals(junit.includes("\ufffe"), false);
  assertEquals(junit.includes("\ud800"), false);
});
