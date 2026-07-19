import { writeAll } from "../src/cli.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const decoder = new TextDecoder();

Deno.test("CLI output retries partial writes until every byte is written", async () => {
  const chunks: Uint8Array[] = [];
  await writeAll({
    write(data: Uint8Array) {
      const chunk = data.slice(0, Math.min(2, data.length));
      chunks.push(chunk);
      return Promise.resolve(chunk.length);
    },
  }, new TextEncoder().encode("abcdef"));
  assertEquals(decoder.decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))), "abcdef");
});

async function run(cwd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(Deno.execPath(), {
    cwd,
    args: ["run", "--allow-read", "--allow-write", CLI, ...args],
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const output = await child.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function fixture() {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/nested`);
  await Deno.writeTextFile(
    `${root}/rule.yaml`,
    `version: 1
id: test/bad
language: typescript
severity: warn
message: "bad: $MATCH"
fix:
  safety: unsafe
  template: good()
suggestions:
  - message: consider good
    template: good()
rule:
  pattern: bad()
`,
  );
  await Deno.writeTextFile(`${root}/nested/b.ts`, "bad();\n");
  await Deno.writeTextFile(`${root}/a.ts`, "bad();\n");
  await Deno.symlink("a.ts", `${root}/link.ts`);
  return root;
}

Deno.test("check emits only deterministic JSONL and report reconsumes it", async () => {
  const root = await fixture();
  try {
    const checked = await run(root, ["check", "--rule", "rule.yaml", "."]);
    assertEquals(checked.code, 1);
    assertEquals(checked.stderr, "");
    const lines = checked.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assertEquals(lines.map(({ path }: { path: string }) => path), ["a.ts", "nested/b.ts"]);
    assert(checked.stdout.endsWith("\n"));
    assertEquals(lines.every(({ schema }: { schema: number }) => schema === 1), true);

    const streamed = await run(root, ["check", "--rule", "rule.yaml", "--stream", "."]);
    assertEquals(streamed.code, 1);
    assertEquals(streamed.stdout, checked.stdout);

    const reported = await run(root, ["report", "--format", "console"], checked.stdout);
    assertEquals(reported.code, 0);
    assert(reported.stdout.startsWith("a.ts:0:5: warn[test/bad]: bad: bad()\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check fix flags delegate safe/unsafe and never apply suggestions", async () => {
  const root = await fixture();
  try {
    const safe = await run(root, ["check", "--rule", "rule.yaml", "--fix", "a.ts"]);
    assertEquals(safe.code, 1);
    assertEquals(await Deno.readTextFile(`${root}/a.ts`), "bad();\n");

    const unsafe = await run(root, ["check", "--rule", "rule.yaml", "--fix-unsafe", "a.ts"]);
    assertEquals(unsafe.code, 0);
    assertEquals(unsafe.stdout, "");
    assertEquals(await Deno.readTextFile(`${root}/a.ts`), "good();\n");

    await Deno.writeTextFile(
      `${root}/suggest.yaml`,
      `version: 1
id: test/suggest
language: typescript
severity: warn
message: suggest
suggestions:
  - message: use good
    template: good()
rule:
  pattern: bad()
`,
    );
    const suggestion = await run(
      root,
      ["check", "--rule", "suggest.yaml", "--fix-unsafe", "nested/b.ts"],
    );
    assertEquals(suggestion.code, 1);
    assertEquals(await Deno.readTextFile(`${root}/nested/b.ts`), "bad();\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI errors are stderr/code 3 and compilation failure never modifies files", async () => {
  const root = await fixture();
  try {
    const flags = await run(root, [
      "check",
      "--rule",
      "rule.yaml",
      "--fix",
      "--fix-unsafe",
      "a.ts",
    ]);
    assertEquals(flags.code, 3);
    assertEquals(flags.stdout, "");
    assert(flags.stderr.length > 0);

    await Deno.writeTextFile(`${root}/broken.yaml`, "not: a rule\n");
    const compile = await run(root, [
      "check",
      "--rule",
      "rule.yaml",
      "--rule",
      "broken.yaml",
      "--fix-unsafe",
      "a.ts",
    ]);
    assertEquals(compile.code, 3);
    assertEquals(await Deno.readTextFile(`${root}/a.ts`), "bad();\n");

    const malformed = await run(root, ["report", "--format", "sarif"], "not-json\n");
    assertEquals(malformed.code, 3);
    assertEquals(malformed.stdout, "");
    assert(malformed.stderr.length > 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
