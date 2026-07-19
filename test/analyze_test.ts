import * as analyzeApi from "../src/analyze.ts";
import { sourceHash } from "../src/diagnostic.ts";
import { loadRuleText } from "../src/rule.ts";

const { analyzeFile } = analyzeApi;
const realWriteFile = Deno.writeFile;

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withTempFile(
  name: string,
  text: string,
  fn: (root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/${name}`, text);
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function withWriteFile<T>(
  writeFile: typeof Deno.writeFile,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(Deno, "writeFile");
  Object.defineProperty(Deno, "writeFile", { ...previous, value: writeFile });
  try {
    return await fn();
  } finally {
    Object.defineProperty(Deno, "writeFile", previous!);
  }
}

Deno.test("analyze API does not expose mutable test seams", () => {
  assertEquals("internals" in analyzeApi, false);
});

async function rule(language: "typescript" | "python", extra = "") {
  return await loadRuleText(`version: 1
id: test/bad
language: ${language}
severity: warn
message: bad
${extra}rule:
  pattern: bad()
`);
}

Deno.test("TypeScript suppression uses comments, scope, and selected rule IDs", async () => {
  const text = `// tool-ignore-next-line other/rule
bad();
// tool-ignore-next-line other/rule, test/bad
bad();
bad(); // tool-ignore test/bad
"// tool-ignore-next-line";
bad();
bad(); // tool-ignore ,
`;
  await withTempFile("a.ts", text, async (root) => {
    const result = await analyzeFile("a.ts", [await rule("typescript")], { root });
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.range.start), [36, 155, 162]);
  });
});

Deno.test("TypeScript file suppression also accepts an actual block comment", async () => {
  await withTempFile("a.ts", "/* tool-ignore-file test/bad */\nbad();\n", async (root) => {
    assertEquals(
      (await analyzeFile("a.ts", [await rule("typescript")], { root })).diagnostics,
      [],
    );
  });
});

Deno.test("multiline block next-line suppression starts after the comment ends", async () => {
  await withTempFile(
    "a.ts",
    "/* tool-ignore-next-line test/bad\n */\nbad();\n",
    async (root) => {
      assertEquals(
        (await analyzeFile("a.ts", [await rule("typescript")], { root })).diagnostics,
        [],
      );
    },
  );
});

Deno.test("suppression line lookup keeps BOM, CRLF, and UTF-8 byte offsets separate", async () => {
  await withTempFile(
    "a.ts",
    "\ufeff// tool-ignore-next-line test/bad\r\nbad();\r\n값(); // tool-ignore\r\nbad();\r\n",
    async (root) => {
      const result = await analyzeFile("a.ts", [await rule("typescript")], { root });
      assertEquals(result.diagnostics.length, 1);
      assertEquals(result.diagnostics[0].range.start, 69);
    },
  );
});

Deno.test("file suppression must precede the first code and omitted IDs suppress all", async () => {
  await withTempFile("valid.py", "# tool-ignore-file\nbad()\n", async (root) => {
    assertEquals(
      (await analyzeFile("valid.py", [await rule("python")], { root })).diagnostics,
      [],
    );
  });
  await withTempFile("late.py", "bad()\n# tool-ignore-file test/bad\nbad()\n", async (root) => {
    assertEquals(
      (await analyzeFile("late.py", [await rule("python")], { root })).diagnostics.length,
      2,
    );
  });
  await withTempFile(
    "line.py",
    "# tool-ignore-next-line\nbad()\nbad()  # tool-ignore\n",
    async (root) => {
      assertEquals(
        (await analyzeFile("line.py", [await rule("python")], { root })).diagnostics,
        [],
      );
    },
  );
  await withTempFile("string.py", 'text = "# tool-ignore-next-line"\nbad()\n', async (root) => {
    assertEquals(
      (await analyzeFile("string.py", [await rule("python")], { root })).diagnostics.length,
      1,
    );
  });
});

Deno.test("fixpoint reevaluates suppression against every current SourceFile", async () => {
  const move = await loadRuleText(`version: 1
id: test/move
language: typescript
severity: warn
message: move
fix: |-

  $X
rule:
  pattern: wrap($X)
`);
  const fixBad = await rule("typescript", "fix: good()\n");
  await withTempFile(
    "a.ts",
    "// tool-ignore-next-line test/bad\nwrap(bad())\n",
    async (root) => {
      const result = await analyzeFile("a.ts", [move, fixBad], { root, fixMode: "safe" });
      assertEquals(
        await Deno.readTextFile(`${root}/a.ts`),
        "// tool-ignore-next-line test/bad\n\ngood()\n",
      );
      assertEquals(result.diagnostics, []);
      assertEquals(result.internalError, false);
    },
  );
});

Deno.test("fix mode never overwrites a file changed after its initial read", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const path = `${root}/a.ts`;
    let changed = false;
    const result = await withWriteFile(async (temporary, bytes, options) => {
      if (!changed) {
        changed = true;
        await Deno.writeTextFile(path, "external();\n");
      }
      await realWriteFile(temporary, bytes, options);
    }, async () =>
      await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
        root,
        fixMode: "safe",
      }));

    assertEquals(await Deno.readTextFile(path), "external();\n");
    assertEquals(result.internalError, true);
    assertEquals(result.diagnostics.map(({ source_hash }) => source_hash), [
      await sourceHash(new TextEncoder().encode("external();\n")),
    ]);
  });
});

Deno.test("fix mode diagnoses current disk bytes even when no fix is applied", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const path = `${root}/a.ts`;
    let changed = false;
    const unsafe = await rule(
      "typescript",
      "fix:\n  safety: unsafe\n  template: good()\n",
    );
    const changedRule = new Proxy(unsafe, {
      get(target, property, receiver) {
        if (typeof property === "symbol" && !changed) {
          changed = true;
          Deno.writeTextFileSync(path, "external();\n");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await analyzeFile("a.ts", [changedRule], {
      root,
      fixMode: "safe",
    });

    assertEquals(result.internalError, true);
    assertEquals(result.diagnostics.map(({ source_hash }) => source_hash), [
      await sourceHash(new TextEncoder().encode("external();\n")),
    ]);
  });
});

Deno.test("write failure diagnoses the bytes that remain on disk", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const path = `${root}/a.ts`;
    const result = await withWriteFile(
      () => Promise.reject(new Error("write failed")),
      async () =>
        await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
          root,
          fixMode: "safe",
        }),
    );

    const hash = await sourceHash(new TextEncoder().encode("bad();\n"));
    assertEquals(await Deno.readTextFile(path), "bad();\n");
    assertEquals(result.internalError, true);
    assertEquals(result.diagnostics.map(({ rule_id }) => rule_id).sort(), [
      "test/bad",
      "tool/internal-error",
    ]);
    assertEquals(result.diagnostics.every(({ source_hash }) => source_hash === hash), true);
  });
});

Deno.test("partial temporary writes never replace the source file", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const path = `${root}/a.ts`;
    const result = await withWriteFile(
      (temporary) => Deno.writeTextFile(temporary, "g", { createNew: true }),
      async () =>
        await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
          root,
          fixMode: "safe",
        }),
    );

    assertEquals(await Deno.readTextFile(path), "bad();\n");
    assertEquals(result.internalError, true);
  });
});

Deno.test("temporary cleanup failure is included in the internal error", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const result = await withWriteFile(
      async (temporary) => {
        await Deno.mkdir(temporary);
        await Deno.writeTextFile(`${temporary}/child`, "left behind");
      },
      async () =>
        await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
          root,
          fixMode: "safe",
        }),
    );

    assertEquals(result.internalError, true);
    assertEquals(
      result.diagnostics.some((diagnostic) =>
        diagnostic.rule_id === "tool/internal-error" &&
        diagnostic.message.includes("temporary cleanup failed")
      ),
      true,
    );
  });
});

Deno.test("atomic fix replacement preserves executable mode bits", async () => {
  if (Deno.build.os === "windows") return;
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const path = `${root}/a.ts`;
    await Deno.chmod(path, 0o777);

    await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
      root,
      fixMode: "safe",
    });

    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o777);
  });
});

Deno.test("parse errors use final bytes and strict only changes severity", async () => {
  await withTempFile("a.ts", "const = ;\n", async (root) => {
    const normal = await analyzeFile("a.ts", [], { root });
    const strict = await analyzeFile("a.ts", [], { root, strict: true });
    assertEquals(normal.diagnostics.length, 1);
    assertEquals(normal.diagnostics[0].rule_id, "tool/parse-error");
    assertEquals(normal.diagnostics[0].severity, "warn");
    assertEquals(strict.diagnostics[0].severity, "error");
  });
});

Deno.test("unparseable bytes stay a parse finding in fix mode", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeFile(`${root}/a.ts`, new Uint8Array([0xff]));
    const result = await analyzeFile("a.ts", [await rule("typescript", "fix: good()\n")], {
      root,
      fixMode: "safe",
    });

    assertEquals(result.diagnostics.map(({ rule_id }) => rule_id), ["tool/parse-error"]);
    assertEquals(result.internalError, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("one crashing rule becomes internal-error without stopping another rule", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const good = await rule("typescript");
    const crash = new Proxy(good, {
      get(target, property, receiver) {
        if (typeof property === "symbol") throw new Error("boom");
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await analyzeFile("a.ts", [crash, good], { root });
    assertEquals(result.diagnostics.map(({ rule_id }) => rule_id).sort(), [
      "test/bad",
      "tool/internal-error",
    ]);
    assertEquals(result.internalError, true);
  });
});

Deno.test("a failed rule is not retried in later fix passes or final diagnosis", async () => {
  await withTempFile("a.ts", "bad();\n", async (root) => {
    const crashBase = await loadRuleText(`version: 1
id: test/crash
language: typescript
severity: warn
message: crash
rule:
  pattern: bad()
`);
    let evaluations = 0;
    const crash = new Proxy(crashBase, {
      get(target, property, receiver) {
        if (typeof property === "symbol") {
          evaluations++;
          throw new Error("boom");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fixer = await rule("typescript", "fix: good()\n");

    const result = await analyzeFile("a.ts", [crash, fixer], { root, fixMode: "safe" });
    assertEquals(evaluations, 1);
    assertEquals(await Deno.readTextFile(`${root}/a.ts`), "good();\n");
    assertEquals(result.diagnostics.map(({ rule_id }) => rule_id), ["tool/internal-error"]);
  });
});
