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
    insertText: 'import "core:${1:coreio}";',
    detail: "import a module",
    keyword: "import",
  },
  {
    label: "importmany",
    insertText: 'import (\n\t"core:${1:coreio}",\n\t"core:${2:fs}",\n);',
    detail: "import several modules",
  },
  {
    label: "importas",
    insertText: 'import "core:${1:test}" as { ${2:describe, test, assert, finish} };',
    detail: "import selected members",
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
    insertText: 'import "core:coreio";\n\ncoreio.print("${1:Hello, MyLang2!}");\n',
    detail: "hello world",
  },
  {
    label: "testfile",
    insertText:
      'import "core:test" as { describe, test, assert, finish };\n\n' +
      'describe("${1:unit}", func() {\n\ttest("${2:works}", func() {\n\t\tassert.equal(${3:actual}, ${4:expected});\n\t});\n});\n\nfinish("${1:unit}");\n',
    detail: "test file skeleton",
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
    doc:
      "Well-known symbols: the two protocols of the language itself.\n\n" +
      "Since MyLang2 2.3 a struct declares one in its own body — " +
      "`func [symbol.dispose]() { ... }` — instead of assigning it in `init`.",
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
  arguments: {
    kind: "value",
    type: "array",
    doc: "Every value passed to the call, as an array. Only inside a function.",
  },
  // `workers/runner.js` creates this in the global scope of a file started by `workers.start`
  worker: {
    kind: "object",
    doc: "The worker side of the `workers` module. Only defined in a file started with `workers.start(...)`.",
    members: {
      post: {
        kind: "function",
        params: [{ name: "message" }],
        doc: "Sends a message to the parent program.",
      },
      receive: {
        kind: "function",
        doc: "Takes the next message from the parent, waiting for one if the inbox is empty.",
      },
      pending: { kind: "function", returns: "int", doc: "How many messages are waiting." },
      data: { kind: "value", doc: "The `data` option `workers.start` was called with." },
    },
  },
};

/** Words that are always resolvable without a declaration. */
const IMPLICIT_NAMES = new Set(Object.keys(GLOBALS));

/** Implicit names that only exist inside a function body. */
const FUNCTION_SCOPED_NAMES = new Set(["arguments"]);

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

/**
 * The protocols a struct may join by naming a member after a symbol (MyLang2 2.3):
 *
 *     struct Report {
 *       func [symbol.dispose]()  { ... }   // `defer Report(...)` releases it
 *       func [symbol.iterator]() { ... }   // `for (x in report)` walks it
 *     }
 *
 * A bracketed member has to reach one of these two; anything else is refused when the
 * struct is instantiated.
 */
const PROTOCOL_SYMBOLS = [
  {
    name: "dispose",
    detail: "disposer — released by defer and symbol.dispose",
    doc:
      "`func [symbol.dispose]() { ... }` — what releases the instance.\n\n" +
      "An ordinary method: `this` is the instance, it reaches the struct's `private` " +
      "members, it may call the struct's other methods and it may suspend. It runs when " +
      "a `defer` unwinds, including while a task is being cancelled, and releasing twice " +
      "is not an error.",
  },
  {
    name: "iterator",
    detail: "iterator factory — walked by for … in and the iter module",
    doc:
      "`func [symbol.iterator]() { ... }` — hands back the iterator the instance is " +
      "walked with.\n\n" +
      "`for (x in value)` uses it, and since 2.3 so does every `iter` function, which " +
      "calls the `next` it returns as the language function it is.",
  },
];

/**
 * Option objects a standard-library call takes, keyed by `<module>.<member>`.
 *
 * The options of a call are prose in the library's README and nowhere in the data the
 * generator can reach, so the few that are worth completing are written out here. Each
 * entry is `{name, detail, doc, since?}`.
 */
const CALL_OPTIONS = {
  "net/http.Server": [
    { name: "port", detail: "int", doc: "Port to listen on; `0` asks the system for a free one." },
    { name: "host", detail: "string", doc: "Interface to bind to." },
    {
      name: "key",
      detail: "bytes | string",
      doc: "Private key — with `cert`, the server speaks HTTPS.",
    },
    {
      name: "cert",
      detail: "bytes | string",
      doc: "Certificate chain — with `key`, the server speaks HTTPS.",
    },
    {
      name: "onError",
      detail: "func(event)",
      since: "2.3",
      doc:
        "`onError: func(event) { ... }` receives every error the server meets as a value — " +
        "`kind` (`client` / `request` / `server`), `status`, `method`, `path`, `code`, " +
        "`message` — on its own task, and nothing is printed: the program decides.\n\n" +
        "Without it only the server's own failures (the server itself, a 5xx) are printed, " +
        "one line each.",
    },
    {
      name: "logErrors",
      detail: "bool",
      since: "2.3",
      doc:
        "`true` prints every error the server meets, `false` prints none. Left out, only " +
        "the server's own failures are printed — a client that hung up is not worth a word.",
    },
    {
      name: "static",
      detail: "object",
      doc: "Files served from disk: `root`, `index`, `maxAge`, `spa`, `dotfiles`, `etag`, `lastModified`.",
    },
    {
      name: "cors",
      detail: "object",
      doc: "Cross-origin rules: `origin`, `methods`, `credentials`, `allowedHeaders`, `exposedHeaders`, `maxAge`.",
    },
    {
      name: "security",
      detail: "object",
      doc: "Response headers: `helmet`, `xss`, `noSniff`, `frameOptions`, `hsts`.",
    },
    {
      name: "compression",
      detail: "object",
      doc: "Response compression: `threshold`, `level`, `filter`.",
    },
    { name: "cache", detail: "object", doc: "Response cache settings." },
    {
      name: "bodyLimit",
      detail: "int",
      doc: "Largest request body accepted, in bytes (2 MB by default).",
    },
    {
      name: "trustProxy",
      detail: "bool",
      doc: "Read `X-Forwarded-For` / `X-Forwarded-Proto` as the client's own.",
    },
    {
      name: "timeout",
      detail: "int",
      doc: "Milliseconds a request may take before the socket is closed.",
    },
    { name: "keepAliveTimeout", detail: "int", doc: "Milliseconds an idle connection is kept." },
    { name: "maxConnections", detail: "int", doc: "Most connections held at once." },
  ],
};

module.exports = {
  KEYWORDS,
  MODIFIERS,
  LITERALS,
  PROTOCOL_SYMBOLS,
  CALL_OPTIONS,
  SNIPPETS,
  GLOBALS,
  IMPLICIT_NAMES,
  FUNCTION_SCOPED_NAMES,
  KEYWORD_DOCS: docs.KEYWORD_DOCS,
  GLOBAL_DOCS: docs.GLOBAL_DOCS,
  LIB_DOCS: docs.LIB_DOCS,
  MEMBER_DOCS: normalizeMemberDocs(),
};
