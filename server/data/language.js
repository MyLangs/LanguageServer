"use strict";
/**
 * Static knowledge about the MyLang2 language itself (everything that is not generated
 * from the standard library sources): keywords, code snippets, implicit global objects.
 *
 * The keyword list mirrors KeywordType / ReflectType in src/lexer/token/TokenType.ts.
 */

const KEYWORDS = [
  "var",
  "as",
  "const",
  "readonly",
  "lazy",
  "func",
  "return",
  "import",
  "export",
  "if",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "wait",
  "spawn",
  "enum",
  "throw",
  "match",
  "case",
  "default",
  "defer",
  "struct",
  "typeof",
  "in",
];

/** Keywords that are only meaningful after `as` (variable modifiers). */
const MODIFIERS = ["const", "readonly", "lazy"];

/** Literal values (separate token types in the lexer). */
const LITERALS = ["true", "false", "nil"];

/**
 * Statement snippets. `insertText` uses LSP snippet syntax.
 * `keyword` snippets replace the bare keyword completion of the same label.
 */
const SNIPPETS = [
  {
    label: "var",
    insertText: "var ${1:name} = ${2:value};",
    detail: "variable declaration",
    keyword: "var",
  },
  {
    label: "func",
    insertText: "func ${1:name}(${2}) {\n\t$0\n}",
    detail: "function declaration",
    keyword: "func",
  },
  {
    label: "struct",
    insertText: "struct ${1:Name} {\n\tvar ${2:field};\n\n\tfunc init(${3}) {\n\t\t$0\n\t}\n}",
    detail: "struct with constructor",
    keyword: "struct",
  },
  {
    label: "enum",
    insertText: "enum ${1:Name} {\n\t${2:First};\n\t${3:Second};\n}",
    detail: "enumeration",
    keyword: "enum",
  },
  {
    label: "if",
    insertText: "if (${1:condition}) {\n\t$0\n}",
    detail: "if statement",
    keyword: "if",
  },
  {
    label: "ifelse",
    insertText: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}",
    detail: "if / else",
  },
  {
    label: "for",
    insertText: "for (var ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t$0\n}",
    detail: "for loop",
    keyword: "for",
  },
  {
    label: "forin",
    insertText: "for (var ${1:item} in ${2:items}) {\n\t$0\n}",
    detail: "for-in loop",
  },
  {
    label: "while",
    insertText: "while (${1:condition}) {\n\t$0\n}",
    detail: "while loop",
    keyword: "while",
  },
  {
    label: "match",
    insertText:
      "match (${1:value}) {\n\tcase (${2:pattern}): {\n\t\t$3\n\t}\n\tdefault: {\n\t\t$0\n\t}\n}",
    detail: "match statement",
    keyword: "match",
  },
  {
    label: "try",
    insertText: "try {\n\t$1\n} catch (${2:err}) {\n\t$0\n}",
    detail: "try / catch",
    keyword: "try",
  },
  {
    label: "tryfinally",
    insertText: "try {\n\t$1\n} catch (${2:err}) {\n\t$3\n} finally {\n\t$0\n}",
    detail: "try / catch / finally",
  },
  {
    label: "import",
    insertText: 'import "${1:coreio}";',
    detail: "import a module",
    keyword: "import",
  },
  {
    label: "importmany",
    insertText: 'import (\n\t"${1:coreio}",\n\t"${2:fs}",\n);',
    detail: "import several modules",
  },
  {
    label: "export",
    insertText: "export(${1:name});",
    detail: "export symbols",
    keyword: "export",
  },
  {
    label: "spawn",
    insertText: "spawn {\n\t$0\n}",
    detail: "run a block as a task",
    keyword: "spawn",
  },
  {
    label: "defer",
    insertText: "defer ${1:cleanup()};",
    detail: "run on scope exit",
    keyword: "defer",
  },
  {
    label: "main",
    insertText: 'import "coreio";\n\ncoreio.print("${1:Hello, MyLang2!}");\n',
    detail: "hello world",
  },
];

// ───────────────── implicit global objects (Interpreter.ts) ─────────────────
// Same descriptor shape as stdlib.json: {kind, params?, doc?, members?}

const GLOBALS = {
  import: {
    kind: "object",
    doc: "Module system information and helpers.",
    members: {
      base: { kind: "value", doc: "Directory of the main file." },
      main: { kind: "value", doc: "Path of the main file." },
      cache: { kind: "value", doc: "Import cache." },
      paths: { kind: "value", doc: "All imported paths (the import chain)." },
      resolve: {
        kind: "function",
        params: [{ name: "path" }],
        doc: "Resolves a `.ml` / `.json` path relative to `import.base`.",
      },
      as: {
        kind: "function",
        params: [{ name: "path" }, { name: "type", optional: true }],
        doc: 'Loads a file as `"buffer"` (default), `"json"` or `"mylang"`.',
      },
    },
  },
  wait: {
    kind: "object",
    doc: "Combinators for spawned tasks (`wait handle` is the keyword form).",
    members: {
      all: {
        kind: "function",
        params: [{ name: "tasks" }],
        doc: "Waits for every task; fails on the first failure.",
      },
      race: {
        kind: "function",
        params: [{ name: "tasks" }],
        doc: "Settles with the first task that settles.",
      },
      allSettled: {
        kind: "function",
        params: [{ name: "tasks" }],
        doc: "Waits for every task and reports each outcome.",
      },
      any: {
        kind: "function",
        params: [{ name: "tasks" }],
        doc: "Resolves with the first task that succeeds.",
      },
    },
  },
  symbol: {
    kind: "object",
    doc: "Well-known symbols.",
    members: {
      dispose: { kind: "value", doc: "Key of the cleanup method used by `defer`." },
      iterator: { kind: "value", doc: "Key of the iterator factory used by `for ... in`." },
    },
  },
  length: {
    kind: "function",
    params: [{ name: "value" }],
    doc: "Universal size: characters, elements, properties, parameters, fields + methods ...",
  },
  process: {
    kind: "object",
    doc: "The running process (same object as the `os/system` module).",
    members: {
      version: { kind: "value", doc: "MyLang2 version." },
      nodejs: {
        kind: "object",
        doc: "Host Node.js information.",
        members: { version: { kind: "value", doc: "Node.js version." } },
      },
    },
  },
  global: { kind: "object", doc: "Shared global object.", members: {} },
};

/** Words that are always resolvable without a declaration. */
const IMPLICIT_NAMES = new Set(Object.keys(GLOBALS));

// ───────────────── documentation (curated overlay) ─────────────────

const docs = require("./docs.js");

// Entries of the curated docs that were written against an older API surface.
const DOC_KEY_RENAMES = { "time.sleep": "time.Sleep" };

function normalizeMemberDocs() {
  const out = {};
  for (const [key, value] of Object.entries(docs.MEMBER_DOCS)) {
    const fixed = DOC_KEY_RENAMES[key] || key;
    out[fixed] =
      fixed === key
        ? value
        : { ...value, syntax: (value.syntax || "").replace(/\.sleep\b/, ".Sleep") };
  }
  return out;
}

module.exports = {
  KEYWORDS,
  MODIFIERS,
  LITERALS,
  SNIPPETS,
  GLOBALS,
  IMPLICIT_NAMES,
  KEYWORD_DOCS: docs.KEYWORD_DOCS,
  GLOBAL_DOCS: docs.GLOBAL_DOCS,
  LIB_DOCS: docs.LIB_DOCS,
  MEMBER_DOCS: normalizeMemberDocs(),
};
