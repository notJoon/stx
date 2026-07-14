# bench

Measures stx match behavior on real codebases, using [ast-grep](https://ast-grep.github.io/) as the
reference implementation. First used for the Phase 4 matcher evaluation
([#1](https://github.com/notJoon/stx/issues/1), [#2](https://github.com/notJoon/stx/issues/2)).

## Run

```sh
deno task bench
```

Requirements: `git` and `npx` on PATH (ast-grep runs via `npx @ast-grep/cli`, cached by npm). On the
first run the corpora are shallow-cloned into `bench/corpora/` (gitignored).

## What it does

For each corpus (currently zod for TypeScript, flask for Python):

1. Parse every source file once with `SourceFile.parse`.
2. For each pattern, run `compilePattern` + `findMatches` over the whole corpus and time it.
3. Run ast-grep with the identical pattern on the identical file list.
4. Pair matches by range containment — an stx match and an ast-grep match agree when one byte range
   contains the other in the same file (stx roots can be wrapper nodes such as
   `expression_statement`, so exact range equality would undercount agreement).

## Reading the output

```
"$OBJ.push($$$ARGS)"  stx=217 sg=218 agree=217  (2833ms, 772 KiB/s)
  sg-only:  zod/packages/zod/src/...:1257  capturedPaths.push(ctx.path.join("/"))
```

- `stx` / `sg` — match counts from stx and ast-grep.
- `agree` — matches paired by range containment.
- `stx-only` — stx matched, ast-grep did not (potential false positive or intended semantic
  difference, e.g. strict child consumption per spec §4.3.2).
- `sg-only` — ast-grep matched, stx did not (potential missed detection; see #2).
- Time and throughput cover stx matching only (parsing is reported once per corpus, and ast-grep
  time is not comparable since it includes process startup).

Counts drift as the corpora move: clones are unpinned `--depth 1`, so absolute numbers are not
comparable across days. Delete `bench/corpora/` to re-clone. The stable signals are the stx/sg
agreement ratio and stx-only counts on the same run.

## Adding corpora or patterns

Edit `CORPORA` in `bench.ts`: each entry declares the language, the ast-grep language id, the repo
URL, the source subdirectory, the file extension, and its pattern list. Patterns use stx syntax
(`$X` single, `$$$X` variadic), which matches ast-grep notation for these cases.
