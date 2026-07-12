import { Language, Parser } from "web-tree-sitter";
import "tree-sitter-wasms/package.json" with { type: "json" };

export type LanguageId = "typescript" | "python";

const GRAMMAR_FILE: Record<LanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  python: "tree-sitter-python.wasm",
};

let parserInit: Promise<void> | undefined;

function ensureParserInit(): Promise<void> {
  if (!parserInit) parserInit = Parser.init();
  return parserInit;
}

function grammarWasmUrl(id: LanguageId): URL {
  const pkgJsonUrl = import.meta.resolve("tree-sitter-wasms/package.json");
  return new URL(`./out/${GRAMMAR_FILE[id]}`, pkgJsonUrl);
}

const languageCache = new Map<LanguageId, Promise<Language>>();

export function loadLanguage(id: LanguageId): Promise<Language> {
  let cached = languageCache.get(id);
  if (!cached) {
    cached = (async () => {
      await ensureParserInit();
      const bytes = await Deno.readFile(grammarWasmUrl(id));
      return await Language.load(bytes);
    })();
    languageCache.set(id, cached);
  }
  return cached;
}

export async function createParser(id: LanguageId): Promise<Parser> {
  const language = await loadLanguage(id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
