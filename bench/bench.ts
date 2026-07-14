// Measures stx match behavior on real codebases, using ast-grep as reference.
// Usage: deno task bench   (see bench/README.md)
import { SourceFile } from "../src/source_file.ts";
import { compilePattern } from "../src/pattern.ts";
import { findMatches } from "../src/matcher.ts";

const BENCH_DIR = import.meta.dirname!;
const CORPORA_DIR = `${BENCH_DIR}/corpora`;

type Corpus = {
  lang: "typescript" | "python";
  sgLang: string;
  repo: string;
  subdir: string;
  ext: string;
  patterns: string[];
};

const CORPORA: Record<string, Corpus> = {
  zod: {
    lang: "typescript",
    sgLang: "ts",
    repo: "https://github.com/colinhacks/zod.git",
    subdir: "packages/zod/src",
    ext: ".ts",
    patterns: [
      "console.log($$$ARGS)",
      "JSON.parse($X)",
      "$X === $X",
      "new Error($$$ARGS)",
      "if ($COND) { $$$BODY }",
      "$OBJ.push($$$ARGS)",
      "throw new Error($MSG)",
    ],
  },
  flask: {
    lang: "python",
    sgLang: "python",
    repo: "https://github.com/pallets/flask.git",
    subdir: "src",
    ext: ".py",
    patterns: [
      "print($$$ARGS)",
      "isinstance($X, $T)",
      "$X == None",
      "self.$ATTR = $VAL",
      "raise $ERR($$$ARGS)",
      "len($X)",
    ],
  },
};

async function ensureCorpus(name: string, corpus: Corpus): Promise<string> {
  const root = `${CORPORA_DIR}/${name}`;
  try {
    Deno.statSync(root);
  } catch {
    console.log(`cloning ${corpus.repo} ...`);
    const clone = await new Deno.Command("git", {
      args: ["clone", "--depth", "1", corpus.repo, root],
    }).output();
    if (!clone.success) throw new Error(`git clone failed for ${corpus.repo}`);
  }
  return `${root}/${corpus.subdir}`;
}

function walk(dir: string, ext: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) files.push(...walk(path, ext));
    else if (entry.name.endsWith(ext)) files.push(path);
  }
  return files.sort();
}

type Span = { file: string; start: number; end: number };

async function runStx(corpus: Corpus, files: string[]) {
  const sources = new Map<string, SourceFile>();
  const parseStart = performance.now();
  let skipped = 0;
  for (const file of files) {
    const source = await SourceFile.parse(corpus.lang, Deno.readTextFileSync(file));
    if (source.parseProblems.length > 0) skipped++; // problem subtrees are excluded per-node
    sources.set(file, source);
  }
  const parseMs = performance.now() - parseStart;

  const perPattern = new Map<string, { spans: Span[]; ms: number }>();
  for (const patternText of corpus.patterns) {
    const pattern = await compilePattern(patternText, corpus.lang);
    const spans: Span[] = [];
    const start = performance.now();
    for (const [file, source] of sources) {
      for (const match of findMatches(pattern, source)) {
        spans.push({ file, start: match.root.start, end: match.root.end });
      }
    }
    perPattern.set(patternText, { spans, ms: performance.now() - start });
  }
  return { perPattern, parseMs, skipped };
}

async function runAstGrep(
  corpus: Corpus,
  files: string[],
  patternText: string,
): Promise<{ spans: Span[]; ms: number }> {
  const cmd = new Deno.Command("ast-grep", {
    args: [
      "run",
      "-p",
      patternText,
      "-l",
      corpus.sgLang,
      "--json=compact",
      "--threads",
      "1", // stx matching is single-threaded; compare like for like
      ...files,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const start = performance.now();
  const output = await cmd.output();
  const ms = performance.now() - start;
  const stdout = new TextDecoder().decode(output.stdout);
  // ast-grep exits 1 when there are zero matches; only fail on unparseable output.
  if (!output.success && !stdout.trim().startsWith("[")) {
    throw new Error(`ast-grep failed: ${new TextDecoder().decode(output.stderr)}`);
  }
  const parsed = JSON.parse(stdout) as {
    file: string;
    range: { byteOffset: { start: number; end: number } };
  }[];
  const spans = parsed.map((m) => ({
    file: m.file,
    start: m.range.byteOffset.start,
    end: m.range.byteOffset.end,
  }));
  return { spans, ms };
}

// A stx match and an ast-grep match agree when one range contains the other in
// the same file (stx roots can be wrapper nodes like expression_statement).
function pairUp(stx: Span[], sg: Span[]) {
  const sgLeft = [...sg];
  let paired = 0;
  const stxOnly: Span[] = [];
  for (const a of stx) {
    const idx = sgLeft.findIndex((b) =>
      b.file === a.file &&
      ((a.start <= b.start && b.end <= a.end) || (b.start <= a.start && a.end <= b.end))
    );
    if (idx >= 0) {
      sgLeft.splice(idx, 1);
      paired++;
    } else stxOnly.push(a);
  }
  return { paired, stxOnly, sgOnly: sgLeft };
}

function snippet(span: Span): string {
  const bytes = Deno.readFileSync(span.file);
  const text = new TextDecoder().decode(bytes.slice(span.start, span.end));
  const line = new TextDecoder().decode(bytes.slice(0, span.start)).split("\n").length;
  const rel = span.file.replace(`${CORPORA_DIR}/`, "");
  return `${rel}:${line}  ${text.split("\n")[0].slice(0, 80)}`;
}

for (const [name, corpus] of Object.entries(CORPORA)) {
  const dir = await ensureCorpus(name, corpus);
  const files = walk(dir, corpus.ext);
  const totalBytes = files.reduce((sum, f) => sum + Deno.statSync(f).size, 0);
  console.log(
    `\n=== ${name} (${corpus.lang}): ${files.length} files, ${
      (totalBytes / 1024).toFixed(0)
    } KiB ===`,
  );

  const stx = await runStx(corpus, files);
  console.log(
    `parse: ${stx.parseMs.toFixed(0)}ms total (${stx.skipped} files with parse problems)`,
  );

  for (const patternText of corpus.patterns) {
    const { spans, ms } = stx.perPattern.get(patternText)!;
    const sg = await runAstGrep(corpus, files, patternText);
    const { paired, stxOnly, sgOnly } = pairUp(spans, sg.spans);
    const throughput = totalBytes / 1024 / (ms / 1000);
    console.log(
      `\n"${patternText}"  stx=${spans.length} sg=${sg.spans.length} agree=${paired}  ` +
        `(stx ${ms.toFixed(0)}ms ${throughput.toFixed(0)} KiB/s, sg ${sg.ms.toFixed(0)}ms)`,
    );
    for (const span of stxOnly.slice(0, 3)) console.log(`  stx-only: ${snippet(span)}`);
    if (stxOnly.length > 3) console.log(`  stx-only: ... ${stxOnly.length - 3} more`);
    for (const span of sgOnly.slice(0, 3)) console.log(`  sg-only:  ${snippet(span)}`);
    if (sgOnly.length > 3) console.log(`  sg-only:  ... ${sgOnly.length - 3} more`);
  }
}
