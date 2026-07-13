import { parse as parseYaml } from "@std/yaml";
import type { LanguageId } from "./grammar.ts";
import { type CompiledPattern, compilePattern } from "./pattern.ts";

export type Severity = "error" | "warn" | "info" | "off";

export type LoadedRule = {
  version: 1;
  id: string;
  language: LanguageId;
  severity: Severity;
  message: string;
  pattern: CompiledPattern;
};

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleLoadError";
  }
}

export async function loadRule(path: string | URL): Promise<LoadedRule> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new RuleLoadError(`cannot read rule file: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new RuleLoadError(`invalid YAML: ${errorMessage(error)}`);
  }

  const document = record(value, "rule file");
  onlyKeys(document, ["version", "id", "language", "severity", "message", "rule"], "rule file");

  if (document.version !== 1) {
    throw new RuleLoadError("version must be the number 1");
  }
  const id = string(document, "id");
  const language = string(document, "language");
  if (language !== "typescript" && language !== "python") {
    throw new RuleLoadError(`unsupported language: ${language}`);
  }
  const severity = string(document, "severity");
  if (severity !== "error" && severity !== "warn" && severity !== "info" && severity !== "off") {
    throw new RuleLoadError(`unsupported severity: ${severity}`);
  }
  const message = string(document, "message");
  const rule = record(document.rule, "rule");
  onlyKeys(rule, ["pattern"], "rule");
  const patternText = string(rule, "pattern", "rule.pattern");

  try {
    return {
      version: 1,
      id,
      language,
      severity,
      message,
      pattern: await compilePattern(patternText, language),
    };
  } catch (error) {
    throw new RuleLoadError(`rule.pattern: ${errorMessage(error)}`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuleLoadError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: Record<string, unknown>,
  key: string,
  field = key,
): string {
  if (typeof value[key] !== "string") throw new RuleLoadError(`${field} must be a string`);
  return value[key];
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], field: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new RuleLoadError(`${field} has unsupported field: ${unknown}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
