import type { Diagnostic, DiagnosticRange } from "./diagnostic.ts";

export type ReportFormat = "console" | "sarif" | "github" | "junit";

export function renderReport(format: ReportFormat, diagnostics: readonly Diagnostic[]): string {
  switch (format) {
    case "console":
      return diagnostics.map((diagnostic) =>
        `${diagnostic.path}:${diagnostic.range.start}:${diagnostic.range.end}: ` +
        `${diagnostic.severity}[${diagnostic.rule_id}]: ${diagnostic.message}\n`
      ).join("");
    case "sarif":
      return `${JSON.stringify(sarif(diagnostics))}\n`;
    case "github":
      return diagnostics.map((diagnostic) => {
        const level = diagnostic.severity === "error"
          ? "error"
          : diagnostic.severity === "warn"
          ? "warning"
          : "notice";
        return `::${level} file=${githubProperty(diagnostic.path)},title=${
          githubProperty(diagnostic.rule_id)
        }::${githubData(diagnostic.message)}\n`;
      }).join("");
    case "junit":
      return junit(diagnostics);
  }
}

function sarif(diagnostics: readonly Diagnostic[]) {
  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "tool" } },
      results: diagnostics.map((diagnostic) => ({
        ruleId: diagnostic.rule_id,
        level: diagnostic.severity === "warn"
          ? "warning"
          : diagnostic.severity === "info"
          ? "note"
          : "error",
        message: { text: diagnostic.message },
        locations: [sarifLocation(diagnostic.path, diagnostic.range)],
        relatedLocations: relatedLocations(diagnostic),
      })),
    }],
  };
}

function relatedLocations(diagnostic: Diagnostic) {
  let id = 0;
  return Object.entries(diagnostic.captures).flatMap(([name, capture]) => {
    const ranges = "parts" in capture ? [capture, ...capture.parts] : [capture];
    return ranges.map((range, index) => ({
      id: ++id,
      message: { text: index === 0 ? `capture ${name}` : `capture ${name} part ${index}` },
      ...sarifLocation(diagnostic.path, range),
    }));
  });
}

function sarifLocation(path: string, range: DiagnosticRange) {
  return {
    physicalLocation: {
      artifactLocation: { uri: path.split("/").map(encodeURIComponent).join("/") },
      region: { byteOffset: range.start, byteLength: range.end - range.start },
    },
  };
}

function githubData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function githubProperty(value: string): string {
  return githubData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function junit(diagnostics: readonly Diagnostic[]): string {
  const cases = diagnostics.map((diagnostic) =>
    `<testcase name="${xml(diagnostic.rule_id)}" classname="${xml(diagnostic.path)}">` +
    `<failure message="${xml(diagnostic.message)}">${xml(diagnostic.message)}</failure>` +
    `</testcase>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<testsuites tests="${diagnostics.length}" failures="${diagnostics.length}">` +
    `<testsuite name="tool" tests="${diagnostics.length}" failures="${diagnostics.length}">` +
    `${cases}</testsuite></testsuites>\n`;
}

function xml(value: string): string {
  const valid = [...value].map((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
        codePoint >= 0x20 && codePoint <= 0xd7ff ||
        codePoint >= 0xe000 && codePoint <= 0xfffd ||
        codePoint >= 0x10000 && codePoint <= 0x10ffff
      ? character
      : "�";
  }).join("");
  return valid.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}
