import { basename, dirname, extname, join } from "node:path";
import {
  compareDiagnostics,
  type Diagnostic,
  diagnosticFromMatch,
  sourceHash,
  toolDiagnostic,
} from "./diagnostic.ts";
import { collectRuleFixes, type Fix, fixFile, type FixMode } from "./fix.ts";
import type { LanguageId } from "./grammar.ts";
import { type EvaluationLimits, findRuleMatches, type LoadedRule } from "./rule.ts";
import { type ByteRange, SourceFile } from "./source_file.ts";
import { suppressionFor } from "./suppression.ts";

export type AnalyzeFileOptions = {
  root?: string;
  fixMode?: FixMode;
  strict?: boolean;
  evaluationLimits?: EvaluationLimits;
};

export type AnalyzeFileResult = {
  diagnostics: Diagnostic[];
  internalError: boolean;
};

type InternalIssue = { message: string; range: ByteRange };

export async function analyzeFile(
  path: string,
  rules: readonly LoadedRule[],
  options: AnalyzeFileOptions = {},
): Promise<AnalyzeFileResult> {
  const diagnosticPath = path.replaceAll("\\", "/");
  const language = languageFor(path);
  const filePath = join(options.root ?? Deno.cwd(), path);
  const original = await Deno.readFile(filePath);
  const internalErrors = new Map<string, InternalIssue>();
  const failedRules = new Set<LoadedRule>();
  let finalBytes: Uint8Array = original;

  if (options.fixMode) {
    try {
      await SourceFile.parse(language, original);
    } catch {
      return parseFailure(diagnosticPath, original, options.strict);
    }
    const originalHash = await sourceHash(original);
    try {
      const fixed = await fixFile(
        language,
        original,
        (source) =>
          collectFixes(
            source,
            rules,
            options.evaluationLimits,
            internalErrors,
            failedRules,
          ),
        options.fixMode,
      );
      finalBytes = fixed.bytes;
      for (const application of fixed.applications) {
        for (const rejection of application.rejected) {
          if (rejection.internalError) {
            const ruleId = rejection.rewrite.ruleId;
            addInternal(
              internalErrors,
              `fix:${ruleId}:${rejection.code}:${JSON.stringify(rejection.rewrite.patches)}`,
              `${ruleId}: ${rejection.code}: ${rejection.message}`,
              { start: 0, end: 0 },
            );
          }
        }
      }
      if (!equalBytes(original, finalBytes)) {
        const staleBytes = await replaceFile(filePath, originalHash, finalBytes);
        if (staleBytes) {
          finalBytes = staleBytes;
          addInternal(
            internalErrors,
            "write:stale",
            "file changed while fixes were being computed",
          );
        }
      } else {
        const current = await Deno.readFile(filePath);
        if (await sourceHash(current) !== originalHash) {
          finalBytes = current;
          addInternal(
            internalErrors,
            "write:stale",
            "file changed while fixes were being computed",
          );
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      addInternal(internalErrors, `write:${message}`, message);
      finalBytes = await Deno.readFile(filePath);
    }
  }

  let source: SourceFile;
  try {
    source = await SourceFile.parse(language, finalBytes);
  } catch {
    const hash = await sourceHash(finalBytes);
    const diagnostics = [toolDiagnostic(
      diagnosticPath,
      hash,
      "tool/parse-error",
      options.strict ? "error" : "warn",
      "file could not be parsed",
      { start: 0, end: 0 },
    )];
    for (const issue of internalErrors.values()) {
      diagnostics.push(toolDiagnostic(
        diagnosticPath,
        hash,
        "tool/internal-error",
        "error",
        issue.message,
        issue.range,
      ));
    }
    return { diagnostics, internalError: internalErrors.size > 0 };
  }

  const hash = await sourceHash(finalBytes);
  const diagnostics: Diagnostic[] = [];
  if (source.parseProblems[0]) {
    diagnostics.push(toolDiagnostic(
      diagnosticPath,
      hash,
      "tool/parse-error",
      options.strict ? "error" : "warn",
      "file contains syntax errors",
      source.parseProblems[0].range,
    ));
  }

  const suppressed = suppressionFor(source);
  for (const rule of rules) {
    if (rule.language !== language || rule.severity === "off" || failedRules.has(rule)) {
      continue;
    }
    try {
      const matches = findRuleMatches(rule, source, options.evaluationLimits)
        .filter((match) => !suppressed(rule.id, match.root));
      const ruleDiagnostics = await Promise.all(
        matches.map((match) => diagnosticFromMatch(diagnosticPath, source, rule, match, hash)),
      );
      diagnostics.push(...ruleDiagnostics);
    } catch (error) {
      addInternal(internalErrors, `rule:${rule.id}`, `${rule.id}: ${errorMessage(error)}`);
      failedRules.add(rule);
    }
  }

  for (const issue of internalErrors.values()) {
    diagnostics.push(toolDiagnostic(
      diagnosticPath,
      hash,
      "tool/internal-error",
      "error",
      issue.message,
      issue.range,
    ));
  }
  diagnostics.sort(compareDiagnostics);
  return { diagnostics, internalError: internalErrors.size > 0 };
}

function collectFixes(
  source: SourceFile,
  rules: readonly LoadedRule[],
  limits: EvaluationLimits | undefined,
  internalErrors: Map<string, InternalIssue>,
  failedRules: Set<LoadedRule>,
): Fix[] {
  const fixes: Fix[] = [];
  const suppressed = suppressionFor(source);
  for (const rule of rules) {
    if (
      rule.language !== source.language || rule.severity === "off" || failedRules.has(rule)
    ) {
      continue;
    }
    try {
      const matches = findRuleMatches(rule, source, limits)
        .filter((match) => !suppressed(rule.id, match.root));
      fixes.push(...collectRuleFixes(rule, source, matches));
    } catch (error) {
      addInternal(internalErrors, `rule:${rule.id}`, `${rule.id}: ${errorMessage(error)}`);
      failedRules.add(rule);
    }
  }
  return fixes;
}

function languageFor(path: string): LanguageId {
  const extension = extname(path).toLowerCase();
  if (extension === ".ts") return "typescript";
  if (extension === ".py") return "python";
  throw new TypeError(`unsupported source extension: ${extension || path}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function addInternal(
  issues: Map<string, InternalIssue>,
  key: string,
  message: string,
  range: ByteRange = { start: 0, end: 0 },
) {
  issues.set(key, { message, range });
}

async function replaceFile(
  path: string,
  expectedHash: string,
  bytes: Uint8Array,
): Promise<Uint8Array | undefined> {
  const temporary = join(dirname(path), `.${basename(path)}.tool-${crypto.randomUUID()}.tmp`);
  let staleBytes: Uint8Array | undefined;
  try {
    const storedMode = (await Deno.stat(path)).mode;
    const mode = storedMode === null ? undefined : storedMode & 0o7777;
    await Deno.writeFile(temporary, bytes, { createNew: true, mode });
    if (!equalBytes(await Deno.readFile(temporary), bytes)) {
      throw new Error("temporary file contents do not match the requested fix");
    }
    if (mode !== undefined) await Deno.chmod(temporary, mode);
    const current = await Deno.readFile(path);
    if (await sourceHash(current) !== expectedHash) staleBytes = current;
    else await Deno.rename(temporary, path);
  } catch (error) {
    try {
      await removeIfExists(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${errorMessage(error)}; temporary cleanup failed: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
  await removeIfExists(temporary);
  return staleBytes;
}

async function removeIfExists(path: string) {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function parseFailure(
  path: string,
  bytes: Uint8Array,
  strict = false,
): Promise<AnalyzeFileResult> {
  return {
    diagnostics: [toolDiagnostic(
      path,
      await sourceHash(bytes),
      "tool/parse-error",
      strict ? "error" : "warn",
      "file could not be parsed",
      { start: 0, end: 0 },
    )],
    internalError: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
