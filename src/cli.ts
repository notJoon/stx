import {
  argument,
  choice,
  command,
  constant,
  formatMessage,
  type InferValue,
  multiple,
  object,
  option,
  or,
  parseSync,
  string,
} from "@optique/core";
import { extname, relative, resolve } from "node:path";
import { analyzeFile } from "./analyze.ts";
import {
  compareDiagnostics,
  type Diagnostic,
  parseDiagnosticJsonl,
  serializeDiagnostic,
} from "./diagnostic.ts";
import type { FixMode } from "./fix.ts";
import { renderReport, type ReportFormat } from "./reporter.ts";
import { type LoadedRule, loadRule } from "./rule.ts";

const ENCODER = new TextEncoder();

const REPORT_FORMATS: readonly ReportFormat[] = ["console", "sarif", "github", "junit"];

const cliParser = or(
  command(
    "check",
    object({
      action: constant("check"),
      rulePaths: multiple(option("--rule", string({ metavar: "YAML" })), { min: 1 }),
      fix: option("--fix"),
      fixUnsafe: option("--fix-unsafe"),
      stream: option("--stream"),
      strict: option("--strict"),
      targets: multiple(argument(string({ metavar: "PATH" })), { min: 1 }),
    }),
  ),
  command(
    "report",
    object({
      action: constant("report"),
      format: option("--format", choice(REPORT_FORMATS)),
    }),
  ),
);

type CliCommand = InferValue<typeof cliParser>;

export async function runCli(args: readonly string[]): Promise<number> {
  try {
    const result = parseSync(cliParser, args);
    if (!result.success) throw new CliError(formatMessage(result.error));
    if (result.value.action === "check") return await runCheck(result.value);
    return await runReport(result.value.format);
  } catch (error) {
    await write(Deno.stderr, `${errorMessage(error)}\n`);
    return 3;
  }
}

async function runCheck(parsed: CliCommand & { action: "check" }): Promise<number> {
  if (parsed.fix && parsed.fixUnsafe) {
    throw new CliError("--fix and --fix-unsafe are mutually exclusive");
  }
  const fixMode: FixMode | undefined = parsed.fix
    ? "safe"
    : parsed.fixUnsafe
    ? "unsafe"
    : undefined;
  const rules: LoadedRule[] = [];
  for (const path of parsed.rulePaths) rules.push(await loadRule(path));

  const root = Deno.cwd();
  const paths = await discoverFiles(root, parsed.targets);
  const diagnostics: Diagnostic[] = [];
  let internalError = false;
  let findingCount = 0;
  for (const path of paths) {
    try {
      const result = await analyzeFile(path, rules, {
        root,
        fixMode,
        strict: parsed.strict,
      });
      internalError ||= result.internalError;
      findingCount += result.diagnostics.length;
      if (parsed.stream) {
        await write(Deno.stdout, result.diagnostics.map(serializeDiagnostic).join(""));
      } else {
        diagnostics.push(...result.diagnostics);
      }
    } catch (error) {
      internalError = true;
      await write(Deno.stderr, `${path}: ${errorMessage(error)}\n`);
    }
  }
  if (!parsed.stream) {
    diagnostics.sort(compareDiagnostics);
    await write(Deno.stdout, diagnostics.map(serializeDiagnostic).join(""));
  }
  return internalError ? 2 : findingCount > 0 ? 1 : 0;
}

async function runReport(format: ReportFormat): Promise<number> {
  const input = await new Response(Deno.stdin.readable).text();
  const diagnostics = parseDiagnosticJsonl(input);
  await write(Deno.stdout, renderReport(format, diagnostics));
  return 0;
}

async function discoverFiles(root: string, targets: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const target of targets) await visit(resolve(root, target));
  return [...files].sort(compareUtf8);

  async function visit(path: string): Promise<void> {
    const info = await Deno.lstat(path);
    if (info.isSymlink) return;
    if (info.isFile) {
      const extension = extname(path);
      if (extension === ".ts" || extension === ".py") {
        files.add(relative(root, path).replaceAll("\\", "/"));
      }
      return;
    }
    if (!info.isDirectory) return;
    const entries = [];
    for await (const entry of Deno.readDir(path)) entries.push(entry);
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      if (!entry.isSymlink) await visit(resolve(path, entry.name));
    }
  }
}

function compareUtf8(a: string, b: string): number {
  const left = ENCODER.encode(a);
  const right = ENCODER.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

async function write(stream: { write(data: Uint8Array): Promise<number> }, text: string) {
  if (text.length > 0) await writeAll(stream, ENCODER.encode(text));
}

export async function writeAll(
  stream: { write(data: Uint8Array): Promise<number> },
  data: Uint8Array,
) {
  for (let offset = 0; offset < data.length;) {
    const written = await stream.write(data.subarray(offset));
    if (written <= 0 || written > data.length - offset) throw new Error("invalid partial write");
    offset += written;
  }
}

class CliError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) Deno.exit(await runCli(Deno.args));
