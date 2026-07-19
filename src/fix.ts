import type { LanguageId } from "./grammar.ts";
import type { Match } from "./matcher.ts";
import { scanMetavariables } from "./pattern.ts";
import type { LoadedRule } from "./rule.ts";
import { type ByteRange, SourceFile } from "./source_file.ts";

/** A replacement over a half-open range of the original disk bytes. */
export type Patch = {
  range: ByteRange;
  replacement: string;
};

/** An atomic set of patches eligible for automatic application. */
export type Fix = {
  kind: "fix";
  ruleId: string;
  safety: "safe" | "unsafe";
  patches: Patch[];
};

/** A report-only rewrite that is never automatically applied. */
export type Suggestion = {
  kind: "suggestion";
  ruleId: string;
  message: string;
  patches: Patch[];
};

/** A rule-produced automatic fix or report-only suggestion. */
export type Rewrite = Fix | Suggestion;

/** Selects safe fixes only, or both safe and unsafe fixes. */
export type FixMode = "safe" | "unsafe";

/** The structured reason a rewrite was not applied. */
export type FixRejectionCode =
  | "suggestion"
  | "unsafe"
  | "invalid-range"
  | "self-conflict"
  | "conflict"
  | "parse-regression";

/** A rejected rewrite and the reason it was rejected. */
export type FixRejection = {
  rewrite: Rewrite;
  code: FixRejectionCode;
  message: string;
  internalError: boolean;
};

/** Bytes and audit information produced by one apply pass. */
export type ApplyFixesResult = {
  bytes: Uint8Array;
  applied: Fix[];
  rejected: FixRejection[];
};

/** One fixpoint pass result, including whether its bytes were retained. */
export type FixpointApplication = ApplyFixesResult & { committed: boolean };

/** Final bytes and termination details from a file-level fixpoint run. */
export type FixpointResult = {
  bytes: Uint8Array;
  passes: number;
  reason: "no-fixes" | "no-applicable-fixes" | "unchanged" | "cycle" | "max-passes";
  applications: FixpointApplication[];
};

/** Collects fresh fixes from the SourceFile parsed for the current pass. */
export type FixCollector = (
  source: SourceFile,
) => readonly Fix[] | Promise<readonly Fix[]>;

/** Indicates that a fix template cannot be expanded against a Match. */
export class FixTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixTemplateError";
  }
}

/** Expands captures from their original source bytes without indentation changes. */
export function expandFixTemplate(
  source: SourceFile,
  match: Match,
  template: string,
  options: { metaVarPrefix?: string } = {},
): string {
  return expandTemplate(source, match, template, options.metaVarPrefix).map((piece) => piece.text)
    .join("");
}

type TemplatePiece = { text: string; origin: "literal" | "capture" };

function expandTemplate(
  source: SourceFile,
  match: Match,
  template: string,
  metaVarPrefix?: string,
): TemplatePiece[] {
  const prefix = metaVarPrefix ?? "$";
  const occurrences = scanMetavariables(template, prefix, source.language, { allowMatch: true });
  const result: TemplatePiece[] = [];
  let consumed = 0;

  const append = (text: string, origin: TemplatePiece["origin"]) => {
    if (text.length > 0) result.push({ text, origin });
  };
  const appendSource = (range: ByteRange) => append(source.sourceText(range), "capture");

  for (const occurrence of occurrences) {
    append(template.slice(consumed, occurrence.start), "literal");
    const name = occurrence.meta.name;
    if (!name) throw new FixTemplateError("anonymous metavariables cannot be referenced");
    if (name === "MATCH") {
      if (occurrence.meta.variadic) throw new FixTemplateError("MATCH reference must be single");
      appendSource(match.root);
    } else {
      const capture = match.captures.get(name);
      if (!capture) throw new FixTemplateError(`undefined capture reference: ${name}`);
      if (capture.kind === "single") {
        if (occurrence.meta.variadic) throw new FixTemplateError(`capture arity mismatch: ${name}`);
        appendSource(source.rangeOf(capture.node));
      } else {
        if (!occurrence.meta.variadic) {
          throw new FixTemplateError(`capture arity mismatch: ${name}`);
        }
        appendSource(capture.span);
      }
    }
    consumed = occurrence.end;
  }
  append(template.slice(consumed), "literal");
  return result;
}

/** Expands rule fixes and suggestions into root replacements. */
export function collectRuleRewrites(
  rule: LoadedRule,
  source: SourceFile,
  matches: readonly Match[],
): Rewrite[] {
  if (rule.severity === "off") return [];
  const bytes = source.diskBytes;
  return matches.flatMap((match): Rewrite[] => {
    const range = match.root;
    const indentation = indentationAt(source, bytes, range.start);
    const rewrites: Rewrite[] = [];
    if (rule.fix !== undefined) {
      rewrites.push({
        kind: "fix",
        ruleId: rule.id,
        safety: rule.fix.safety,
        patches: [{
          range,
          replacement: indentTemplate(
            expandTemplate(source, match, rule.fix.template, rule.metaVarPrefix),
            indentation,
          ),
        }],
      });
    }
    for (const suggestion of rule.suggestions) {
      rewrites.push({
        kind: "suggestion",
        ruleId: rule.id,
        message: expandFixTemplate(source, match, suggestion.message, {
          metaVarPrefix: rule.metaVarPrefix,
        }),
        patches: [{
          range,
          replacement: indentTemplate(
            expandTemplate(source, match, suggestion.template, rule.metaVarPrefix),
            indentation,
          ),
        }],
      });
    }
    return rewrites;
  });
}

/** Collects rule fixes while excluding suggestions and severity-off rules. */
export function collectRuleFixes(
  rule: LoadedRule,
  source: SourceFile,
  matches: readonly Match[],
): Fix[] {
  return collectRuleRewrites(rule, source, matches).filter((rewrite): rewrite is Fix =>
    rewrite.kind === "fix"
  );
}

function indentationAt(source: SourceFile, bytes: Uint8Array, position: number): string {
  let lineStart = position;
  while (lineStart > 0 && bytes[lineStart - 1] !== 0x0a) lineStart--;
  lineStart = Math.max(lineStart, source.bomLen);
  const prefix = source.sourceText({ start: lineStart, end: position });
  return prefix.match(/^[\t ]*/)![0];
}

function indentTemplate(pieces: readonly TemplatePiece[], indentation: string): string {
  let result = "";
  let afterLiteralNewline = false;
  for (const piece of pieces) {
    if (piece.text.length === 0) continue;
    if (afterLiteralNewline) {
      result += indentation;
      afterLiteralNewline = false;
    }
    if (piece.origin === "capture") {
      result += piece.text;
      continue;
    }
    let consumed = 0;
    for (const match of piece.text.matchAll(/\r\n|\r|\n/g)) {
      result += piece.text.slice(consumed, match.index + match[0].length);
      consumed = match.index + match[0].length;
      afterLiteralNewline = true;
      if (consumed < piece.text.length) {
        result += indentation;
        afterLiteralNewline = false;
      }
    }
    result += piece.text.slice(consumed);
  }
  return result;
}

/** Applies one deterministic, parse-validated pass and rejects all suggestions. */
export async function applyFixes(
  source: SourceFile,
  rewrites: readonly Rewrite[],
  mode: FixMode,
): Promise<ApplyFixesResult> {
  const original = source.diskBytes;
  const rejected: FixRejection[] = [];
  const candidates: Fix[] = [];

  for (const rewrite of rewrites) {
    if (rewrite.kind === "suggestion") {
      rejected.push(rejection(rewrite, "suggestion", "suggestions are never auto-applied"));
    } else if (mode === "safe" && rewrite.safety === "unsafe") {
      rejected.push(rejection(rewrite, "unsafe", "unsafe fix excluded by safe mode"));
    } else if (!validPatches(rewrite.patches, original.length)) {
      rejected.push(rejection(rewrite, "invalid-range", "invalid patch range", true));
    } else if (hasOverlap(rewrite.patches)) {
      rejected.push(rejection(rewrite, "self-conflict", "fix patches overlap", true));
    } else {
      candidates.push(rewrite);
    }
  }

  candidates.sort(compareFixes);
  const accepted: Fix[] = [];
  const ranges: ByteRange[] = [];
  for (const candidate of candidates) {
    if (candidate.patches.some((patch) => ranges.some((range) => overlaps(patch.range, range)))) {
      rejected.push(rejection(candidate, "conflict", "fix conflicts with an earlier fix"));
      continue;
    }
    accepted.push(candidate);
    ranges.push(...candidate.patches.map((patch) => patch.range));
  }

  if (accepted.length === 0) return result(original, [], rejected);

  const baseline = source.parseProblems.length;
  const batch = splice(original, accepted);
  if (await parsesWithoutRegression(source, batch, baseline)) {
    return result(batch, accepted, rejected);
  }

  const survivors: Fix[] = [];
  for (const candidate of accepted) {
    const bytes = splice(original, [...survivors, candidate]);
    if (await parsesWithoutRegression(source, bytes, baseline)) {
      survivors.push(candidate);
    } else {
      rejected.push(rejection(candidate, "parse-regression", "fix increases parse problems"));
    }
  }
  return result(splice(original, survivors), survivors, rejected);
}

function result(
  bytes: Uint8Array,
  applied: Fix[],
  rejected: FixRejection[],
): ApplyFixesResult {
  rejected.sort((a, b) => {
    const codeOrder = lexical(a.code, b.code);
    if (codeOrder) return codeOrder;
    if (
      a.rewrite.kind === "fix" && b.rewrite.kind === "fix" &&
      sortablePatches(a.rewrite.patches) && sortablePatches(b.rewrite.patches)
    ) {
      return compareFixes(a.rewrite, b.rewrite);
    }
    return lexical(canonicalRewrite(a.rewrite), canonicalRewrite(b.rewrite));
  });
  return { bytes, applied, rejected };
}

/** Re-parses, re-collects, and applies fixes for at most ten passes. */
export async function fixFile(
  language: LanguageId,
  input: string | Uint8Array,
  collect: FixCollector,
  mode: FixMode = "safe",
): Promise<FixpointResult> {
  let bytes: Uint8Array = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input.slice();
  const seen = new Set([await hash(bytes)]);
  const applications: FixpointApplication[] = [];

  for (let pass = 1; pass <= 10; pass++) {
    const source = await SourceFile.parse(language, bytes);
    const rewrites = await collect(source);
    if (rewrites.length === 0) {
      return { bytes, passes: pass, reason: "no-fixes", applications };
    }

    const application = await applyFixes(source, rewrites, mode);
    if (application.applied.length === 0) {
      applications.push({ ...application, committed: false });
      return { bytes, passes: pass, reason: "no-applicable-fixes", applications };
    }
    if (equalBytes(application.bytes, bytes)) {
      applications.push({ ...application, committed: false });
      return { bytes, passes: pass, reason: "unchanged", applications };
    }

    const nextHash = await hash(application.bytes);
    if (seen.has(nextHash)) {
      applications.push({ ...application, committed: false });
      return { bytes, passes: pass, reason: "cycle", applications };
    }
    applications.push({ ...application, committed: true });
    seen.add(nextHash);
    bytes = application.bytes;
  }
  return { bytes, passes: 10, reason: "max-passes", applications };
}

function rejection(
  rewrite: Rewrite,
  code: FixRejectionCode,
  message: string,
  internalError = false,
): FixRejection {
  return { rewrite, code, message, internalError };
}

function validPatches(patches: readonly Patch[], length: number): boolean {
  return sortablePatches(patches) &&
    patches.every(({ range }) =>
      range.start >= 0 && range.start <= range.end && range.end <= length
    );
}

function sortablePatches(patches: readonly Patch[]): boolean {
  return patches.length > 0 &&
    patches.every(({ range }) =>
      Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    );
}

function hasOverlap(patches: readonly Patch[]): boolean {
  return patches.some((patch, index) =>
    patches.slice(index + 1).some((other) => overlaps(patch.range, other.range))
  );
}

function overlaps(a: ByteRange, b: ByteRange): boolean {
  if (a.start === a.end) {
    // Conservative boundary: insertion conflicts at a replacement start or inside it, not its end.
    return b.start === b.end ? a.start === b.start : a.start >= b.start && a.start < b.end;
  }
  if (b.start === b.end) return b.start >= a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function compareFixes(a: Fix, b: Fix): number {
  const aStart = Math.min(...a.patches.map((patch) => patch.range.start));
  const bStart = Math.min(...b.patches.map((patch) => patch.range.start));
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = Math.min(...a.patches.map((patch) => patch.range.end));
  const bEnd = Math.min(...b.patches.map((patch) => patch.range.end));
  if (aEnd !== bEnd) return aEnd - bEnd;
  const ruleOrder = lexical(a.ruleId, b.ruleId);
  return ruleOrder || lexical(canonicalFix(a), canonicalFix(b));
}

function canonicalFix(fix: Fix): string {
  const patches = fix.patches.map((patch) => [
    numberToken(patch.range.start),
    numberToken(patch.range.end),
    patch.replacement,
  ]).sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b)));
  return JSON.stringify([fix.ruleId, fix.safety, patches]);
}

function canonicalRewrite(rewrite: Rewrite): string {
  if (rewrite.kind === "fix") return `fix:${canonicalFix(rewrite)}`;
  const patches = rewrite.patches.map((patch) => [
    numberToken(patch.range.start),
    numberToken(patch.range.end),
    patch.replacement,
  ]).sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b)));
  return JSON.stringify(["suggestion", rewrite.ruleId, rewrite.message, patches]);
}

function numberToken(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function splice(bytes: Uint8Array, fixes: readonly Fix[]): Uint8Array {
  let result = bytes;
  const patches = fixes.flatMap((fix) => fix.patches).sort((a, b) =>
    b.range.start - a.range.start || b.range.end - a.range.end
  );
  for (const patch of patches) {
    const replacement = new TextEncoder().encode(patch.replacement);
    const next = new Uint8Array(
      result.length - (patch.range.end - patch.range.start) + replacement.length,
    );
    next.set(result.subarray(0, patch.range.start));
    next.set(replacement, patch.range.start);
    next.set(result.subarray(patch.range.end), patch.range.start + replacement.length);
    result = next;
  }
  return result;
}

async function parsesWithoutRegression(
  source: SourceFile,
  bytes: Uint8Array,
  baseline: number,
): Promise<boolean> {
  try {
    return (await SourceFile.parse(source.language, bytes)).parseProblems.length <= baseline;
  } catch {
    return false;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
