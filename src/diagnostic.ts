import { collectRuleRewrites, expandFixTemplate } from "./fix.ts";
import type { Match } from "./matcher.ts";
import type { LoadedRule } from "./rule.ts";
import type { ByteRange, SourceFile } from "./source_file.ts";

export type DiagnosticRange = { start: number; end: number };
export type DiagnosticCapture = DiagnosticRange | (DiagnosticRange & { parts: DiagnosticRange[] });
export type DiagnosticPatch = DiagnosticRange & { text: string };
export type DiagnosticFix = {
  safety: "safe" | "unsafe";
  patches: DiagnosticPatch[];
};
export type DiagnosticSuggestion = { message: string; patches: DiagnosticPatch[] };

export type Diagnostic = {
  schema: 1;
  rule_id: string;
  severity: "error" | "warn" | "info";
  message: string;
  path: string;
  range: DiagnosticRange;
  source_hash: string;
  captures: Record<string, DiagnosticCapture>;
  fix?: DiagnosticFix;
  suggestions?: DiagnosticSuggestion[];
  note?: string;
  url?: string;
};

const ENCODER = new TextEncoder();

export async function sourceHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function diagnosticFromMatch(
  path: string,
  source: SourceFile,
  rule: LoadedRule,
  match: Match,
  hash?: string,
): Promise<Diagnostic> {
  if (rule.severity === "off") throw new TypeError("off rules do not produce diagnostics");
  const captures: Record<string, DiagnosticCapture> = {};
  for (const [name, capture] of match.captures) {
    if (name === "MATCH") continue;
    if (capture.kind === "single") {
      captures[name] = source.rangeOf(capture.node);
    } else {
      captures[name] = {
        ...capture.span,
        parts: capture.nodes.map((node) => source.rangeOf(node)),
      };
    }
  }

  const rewrites = collectRuleRewrites(rule, source, [match]);
  const fix = rewrites.find((rewrite) => rewrite.kind === "fix");
  const suggestions = rewrites.filter((rewrite) => rewrite.kind === "suggestion");
  return {
    schema: 1,
    rule_id: rule.id,
    severity: rule.severity,
    message: expandFixTemplate(source, match, rule.message, {
      metaVarPrefix: rule.metaVarPrefix,
    }),
    path,
    range: match.root,
    source_hash: hash ?? await sourceHash(source.diskBytes),
    captures,
    ...(fix && {
      fix: {
        safety: fix.safety,
        patches: fix.patches.map(({ range, replacement }) => ({ ...range, text: replacement })),
      },
    }),
    ...(suggestions.length > 0 && {
      suggestions: suggestions.map(({ message, patches }) => ({
        message,
        patches: patches.map(({ range, replacement }) => ({ ...range, text: replacement })),
      })),
    }),
    ...(rule.note !== undefined && { note: rule.note }),
    ...(rule.url !== undefined && { url: rule.url }),
  };
}

export function toolDiagnostic(
  path: string,
  hash: string,
  ruleId: "tool/parse-error" | "tool/internal-error",
  severity: "error" | "warn",
  message: string,
  range: DiagnosticRange,
): Diagnostic {
  return {
    schema: 1,
    rule_id: ruleId,
    severity,
    message,
    path,
    range,
    source_hash: hash,
    captures: {},
  };
}

export function serializeDiagnostic(diagnostic: Diagnostic): string {
  return `${JSON.stringify(diagnostic)}\n`;
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return compareBytes(ENCODER.encode(a.path), ENCODER.encode(b.path)) ||
    a.range.start - b.range.start || a.range.end - b.range.end ||
    compareBytes(ENCODER.encode(a.rule_id), ENCODER.encode(b.rule_id)) ||
    compareBytes(ENCODER.encode(serializeDiagnostic(a)), ENCODER.encode(serializeDiagnostic(b)));
}

export function parseDiagnosticJsonl(input: string): Diagnostic[] {
  if (input === "") return [];
  const lines = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
  return lines.map((line, index) => {
    if (line === "") throw new SyntaxError(`JSONL line ${index + 1} is empty`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`JSONL line ${index + 1}: ${errorMessage(error)}`);
    }
    try {
      return parseDiagnostic(value);
    } catch (error) {
      throw new SyntaxError(`JSONL line ${index + 1}: ${errorMessage(error)}`);
    }
  });
}

function parseDiagnostic(value: unknown): Diagnostic {
  const record = object(value, "diagnostic");
  if (record.schema !== 1) throw new TypeError("schema must be 1");
  const severity = string(record.severity, "severity");
  if (severity !== "error" && severity !== "warn" && severity !== "info") {
    throw new TypeError("severity must be error, warn, or info");
  }
  const hash = string(record.source_hash, "source_hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError("source_hash must be lowercase SHA-256");
  const capturesRecord = object(record.captures, "captures");
  const captures = Object.fromEntries(
    Object.entries(capturesRecord).map(([name, capture]) => [name, parseCapture(capture)]),
  );
  return {
    schema: 1,
    rule_id: string(record.rule_id, "rule_id"),
    severity,
    message: string(record.message, "message"),
    path: string(record.path, "path"),
    range: range(record.range, "range"),
    source_hash: hash,
    captures,
    ...(record.fix !== undefined && { fix: parseFix(record.fix) }),
    ...(record.suggestions !== undefined && {
      suggestions: array(record.suggestions, "suggestions").map(parseSuggestion),
    }),
    ...(record.note !== undefined && { note: string(record.note, "note") }),
    ...(record.url !== undefined && { url: string(record.url, "url") }),
  };
}

function parseCapture(value: unknown): DiagnosticCapture {
  const record = object(value, "capture");
  const span = range(record, "capture");
  if (record.parts === undefined) return span;
  return {
    ...span,
    parts: array(record.parts, "capture.parts").map((part) => range(part, "part")),
  };
}

function parseFix(value: unknown): DiagnosticFix {
  const record = object(value, "fix");
  if (record.safety !== "safe" && record.safety !== "unsafe") {
    throw new TypeError("fix.safety must be safe or unsafe");
  }
  return {
    safety: record.safety,
    patches: array(record.patches, "fix.patches").map(parsePatch),
  };
}

function parseSuggestion(value: unknown): DiagnosticSuggestion {
  const record = object(value, "suggestion");
  return {
    message: string(record.message, "suggestion.message"),
    patches: array(record.patches, "suggestion.patches").map(parsePatch),
  };
}

function parsePatch(value: unknown): DiagnosticPatch {
  const record = object(value, "patch");
  return { ...range(record, "patch"), text: string(record.text, "patch.text") };
}

function range(value: unknown, field: string): ByteRange {
  const record = object(value, field);
  const start = integer(record.start, `${field}.start`);
  const end = integer(record.end, `${field}.end`);
  if (start < 0 || start > end) throw new TypeError(`${field} must be a half-open byte range`);
  return { start, end };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`);
  return value as number;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
