# Changelog

## 1.4.0 — MyLang2 2.3: the formatter, symbol members, `++` on members

### Formatting

- **"Format Document" and "Format Selection" run the language's own formatter.** The
  editor loads `mylang prettier` out of the language package — the same code
  `mylang prettier --write` runs on the terminal — so the two can never disagree. It is
  found the way the compiler is found, one folder across
  (`<package>/dist/prettier/index.js`, `<workspace>/dist/prettier`,
  `node_modules/mylang2`, …), and `mylang.compiler.path` points at it as well.
- **The project's settings are the editor's settings.** The `"prettier"` section of the
  nearest `mylang.json` is read through the formatter's own option reader, so `indent`,
  `quote`, `printWidth` and the rest mean exactly what they mean on the command line. An
  option it refuses — a misspelt name, an impossible value — stops the run and says why,
  once, instead of quietly formatting to settings nobody asked for; `mylang prettier`
  exits 2 on the same file.
- **Precedence**, lowest first: the formatter's defaults, what the editor says about the
  file (`tabSize`, `insertSpaces`, `insertFinalNewline`), `mylang.json`, and
  `mylang.format.options` — the editor's equivalent of a flag.
- **The result is the lines that changed**, not one edit replacing the file, so the
  cursor, the selection and the folded regions stay where they were. "Format Selection"
  formats the document whole — indentation comes from the brackets a line is inside — and
  then keeps only the lines inside the selection.
- New settings: **`mylang.format.enable`** (default `true`),
  **`mylang.format.configFile`** and **`mylang.format.options`**
  (`indent`, `useTabs`, `printWidth`, `quote`, `bracketSpacing`, `maxBlankLines`,
  `endOfLine`, `finalNewline`). Works with `editor.formatOnSave`.
- New commands: **MyLang: Format Workspace** (`mylang prettier --write .`) and
  **MyLang: Check Formatting** (`--check`), which run in the terminal because they touch
  the whole project. **`mylang.run.noColors`** adds `--no-colors` to every command the
  extension runs.
- **`mylang.json` is validated and completed** in the editor: the schema that was already
  in the box is now registered, so the whole file — the `"prettier"` section included —
  gets completion, defaults and errors as you write it.
- `mylang/status` and **Show Language Server Status** report the formatter and where it
  was loaded from.

### Symbol members (new in MyLang2 2.3)

- **`func [symbol.dispose]() { ... }` and `func [symbol.iterator]() { ... }` in a struct
  body are understood.** The body is a method body: `this` is the instance, completion
  inside it offers the struct's own members, `private` ones included. Before, everything
  between the brackets and the closing brace was skipped, so the body had no scope at all.
- **The outline lists them**, in source order among the other members, which is where you
  look to see which protocols a struct joins. Hover on a struct says the same
  (**Protocols:** `symbol.dispose` — released by `defer`).
- **Completion inside the brackets** offers `symbol.dispose` and `symbol.iterator`, and
  nothing else; hover on the member explains the protocol it joins.
- **Everything the parser and instantiation refuse is reported**, each as an error:
  `symbol-member-modifier` (`private` / `static` on such a member — a symbol is not a name
  `private` could hide, and a protocol belongs to the instance), `symbol-member-field`
  (a bracketed `var`), `symbol-member-unknown` (an expression that is not a protocol
  symbol) and `symbol-member-duplicate` (the same protocol twice in one struct).
- **The bracketed name is never offered as a member**: `r.` lists the struct's ordinary
  members, as the language does.
- `symbol`, `struct` and `defer` documentation covers the new form, and there are three
  new snippets: `dispose`, `iterator` and `structresource`.

### `private` and `static` members

Modelled at last, which the 2.2 release had left out:

- A **`private`** member is offered on `this` inside the struct and nowhere else, so
  completion stops suggesting code the interpreter refuses.
- Hover writes the modifiers as they are declared: `private func bump()`,
  `static Counter.created (field)`.
- **New diagnostic `duplicate-modifier`:** `private private func f()`, which the parser
  refuses.

### `++` and `--` on a member (new in MyLang2 2.3)

- `o.n++`, `items[i]--`, `this.count++` and `Counter.created++` are the writes they are:
  "assigned but never read", Find All References and Rename see the step, and
  `as readonly` is enforced through it.
- Postfix keeps the type: `var prev = o.n++;` knows `prev` is an `int`, because the value
  is the one _before_ the step.
- **New diagnostic `enum-member-assign`:** `Color.Red++` and `Color.Red = 5` alike. `++`
  goes through the same path as `+= 1`, so an enum member is as constant for one as for
  the other.

### The 2.3 standard library

- `server/data/stdlib.json` is regenerated from **mylang2@2.3.0**: **38 modules, 753
  members**.
- **`iter` has the functions it documented**: `map`, `filter`, `take`, `skip`, `toArray`
  and `forEach` complete, hover and carry their descriptions — as functions taking the
  sequence first (`iter.take(iter.count(), 3)`), which is how the language is written.
- **`tls` is described at all.** It shipped in 2.2 and the generator had never produced a
  single member for it.
- **`utils/colors` is whole again.** Its 40 colour functions are built from a table and
  spread into `module.exports` since 2.3, which the generator read as nothing; it now
  expands such a spread, so `colors.red`, `colors.hex` and the new `colors.enabled()` are
  all back.
- **A module's imports are followed.** `tcp.connect()`, `tls.connect()`, `udp.open()` and
  `ws.connect()` hand back the socket built in `net/socket`, one folder across; the
  generator now reads that file, so the result lists `read`, `write`, `close` and the rest
  wherever it appears.
- The streaming halves of 2.2 are described as well: `compress.stream` / `compress.file`,
  `archive.extractFile` / `createFile`, `workers.pool`, `process.pipeline`,
  `tcp.connectUnix` / `listenUnix`.

### Option keys

- **`http.Server({ … })` completes its options**, with **`onError`** and **`logErrors`**
  (new in 2.3) offered first and documented: `onError: func(event) { ... }` receives every
  error as a value — `kind`, `status`, `method`, `path`, `code`, `message` — on its own
  task and nothing is printed, so a client that hangs up is no longer a stack trace.
  Keys already written are left out, and a nested object (`cors: { … }`) is not mistaken
  for the call's own options.

### Tests

- 60 end-to-end tests over LSP, up from 46: the formatter (a whole document, a selection,
  the project's settings, a setting it refuses, the off switch, and the line diff on its
  own), symbol members and all four refusals, `private` visibility, `++` on members,
  indexes and statics, the enum rule, the `iter` additions, the `http.Server` option keys
  and the shape of the 2.3 standard-library data. The suite runs with and without the real
  compiler; the formatting tests need the real formatter and are skipped without it.

## 1.3.0 — MyLang2 2.2: the `core:` namespace, typed hints, stricter import checks

### The `core:` namespace (new in MyLang2 2.2)

- **`import "core:fs"` is understood everywhere.** It binds exactly what the bare name
  binds (`core:net/http` → `http`, `core:numbers/bigint` → `bigint`), works with an alias
  (`import "core:net/http" as httpCore`), inside grouped imports
  (`import ("core:arrays", "core:path")`), with destructuring
  (`import "core:test" as { describe, test, assert, finish }`) and in the dynamic form
  (`import("core:strings")`), which now also gives the module's members.
  Before, `core:fs` was mistaken for an `Owner:repo` package and reported as a missing
  dependency.
- **New diagnostic `unknown-core-module`:** `import "core:fss"` is reported as
  “`core:` names a built-in module, and `fss` is not one”, with a quick fix to
  `"core:fs"`. The namespace never falls back to a project dependency, so this cannot be
  a package either.
- **Quick fix on a bare built-in:** “Change to `"core:strings"`”.
- **Completion** offers `core:<name>` for every built-in, ranked above the bare form, and
  hides the bare form once `core:` has been typed. Hover, document links and go-to
  definition all accept the namespaced spelling.
- **Imports the server writes itself** (auto-import, quick fixes, snippets) use the
  `core:` form. The new setting **`mylang.completion.coreNamespace`** (default `true`)
  switches back to the bare name.
- The TextMate grammar highlights the `core:` prefix, and the `Owner:` part of a package
  import, as a namespace.

### All of the 2.2 standard library

- `server/data/stdlib.json` is regenerated from **mylang2@2.2.0**: **37 modules, 735
  members**, including the eleven modules added in 2.2 — `test`, `binary`, `validation`,
  `compress`, `archive`, `dns`, `tcp`, `udp`, `ws`, `workers` and `process`. Members of
  a module added in 2.2 are labelled with the version.
- `os/system` now carries its own 24 members (`getpid`, `argv`, `getMemoryUsage`, …)
  instead of borrowing the sparse description of the `process` global, and the global
  `process` resolves to the same object, so `process.` completes all of them.
- **Nested APIs are described**: objects returned by a library call (`tcp.connect(…)`,
  `ws.connect(…)`, `udp.open(…)`, `workers.start(…)`, `process.run(…)`,
  `binary.reader(…)`, `http.Server()`) list their members, with `close()` / `closed` for
  every owned resource, and so do nested objects such as `test.assert.*`.
- **Documentation coverage**: descriptions now come from the sources _and_ from the
  `| Method | Description |` tables of each `library/<module>/README.md`, matched by
  receiver (`server.get` documents the result of `http.Server()`, never `http.get`).
  652 members have a description, up from a handful.
- Fixed the doc extractor taking everything from the first `/** … */` of a file when a
  declaration had no comment of its own.

### Type hints

- **Arrays have an element type.** `["a", "b"]` is `array<string>`, `items[0]` is its
  element, `text[0]` a `string`, and `for (var item in items)` types `item`. Mixed
  literals stay a plain `array`.
- **Results are typed.** The generator records what each library function returns, so
  `strings.split(…)` is an `array`, `strings.toUpperCase(…)` a `string`, and chained
  access (`strings.split(s, ",").length`) resolves.
- **`length` and `size`** are offered and documented on arrays, strings, `bytes`, maps
  and sets.
- **Nesting is followed**: `cfg.db.host`, `users[0].name` and deeper object literals
  resolve, and hover prints the shape (`{ db: { host: string, port: int }, … }`).
- **User functions get a result type** from their `return` statements (several returns
  are unified, `nil` ignored), so `var u = make();` knows what `make` builds.
- **Fields a constructor fills in** are typed from the assignment (`this.items = []`).
- **JSDoc types are used when the code cannot say more**: `@type`, `@param {T}` and
  `@returns {T}` are read, including `T[]` / `Array<T>` and the file's own structs and
  enums (`@returns {User}` → a `User` instance). Inference still wins over documentation.
- Number literals are told apart as `int`, `float` and `bigint`, matching `typeof`.
- **Signatures show parameter types** where the standard library or `@param` provides
  them: `strings.split(str: string, separator, limit): array`. Signature help keeps
  highlighting the active parameter.
- Hover for a function shows its result type; hover for a standard-library member shows
  its `Returns:` kind and the members of its result.

### Stricter import checks

- **Destructured names are verified** against what the import really exposes — built-in
  modules as before, and now also `.ml` files, `.json` files and installed packages:
  `import "./math.ml" as { add, divide }` reports `divide` with a “did you mean” fix.
- **New diagnostic `module-not-found`:** `import "./helpers.ml"` that resolves to no file
  on disk is reported on the import string.
- **`import "./config.json"`** exposes the document's top-level keys with their types, so
  `config.` completes and `config.port` is an `int`.
- **New diagnostic `deprecated`** (setting `mylang.diagnostics.deprecated`, default
  `warning`): uses of anything marked `@deprecated`, in your code and in the standard
  library, are flagged with the LSP deprecation tag and the reason.
- **Completion inside `as { … }`** offers the members of the module or file being
  imported, and leaves out the ones already taken.
- **Hover on any import string** now says something useful: the resolved path of a file,
  the keys of a JSON document, the exported names, a remote URL, package status, or why a
  `core:` name does not exist.

### Editor data

- Snippets use the `core:` form, and there are new ones: `importas`, `testfile` (a
  `core:test` file skeleton) and `tcpserver`.
- Curated documentation covers every module, including the 2.2 additions, and the
  `import` keyword documents the namespace, packages and the destructuring form.
- `mylang/status` keeps reporting which stdlib snapshot is loaded (now `mylang2@2.2.0`).

### Tests

- 16 new end-to-end tests over LSP: the `core:` namespace, the 2.2 modules, array and
  nested types, standard-library result types, documented types, constructor fields,
  destructuring and JSON imports, missing files, deprecation, and the shape of the
  generated standard-library data. The suite runs with and without the real compiler.

## 1.2.0 — Package imports (`.module`)

- **Package imports:** `import "Owner:repo"` now resolves to the package installed in `.module/<owner>/<repo>` (entry file taken from the package's `mylang.json`, searched upwards like `node_modules`).
- **IntelliSense for packages:** member completion, Go to Definition (on the import string and on `pkg.member`), Hover with version/description, document links, signature help from the package's JSDoc.
- **Completion:** installed packages are suggested inside `import "…"`, and typing a package name offers an automatic import.
- **Diagnostics:** `package-not-declared` (missing in `dependencies`), `package-not-installed` (run `mylang install`), `package-no-main` (entry file missing). Severity follows `mylang.diagnostics.unknownModules`.
- Diagnostics refresh automatically after `mylang install` or edits of `mylang.json`.

## 1.1.0 — JSDoc Support and Code Readability Improvements

- **Improved Code Readability:** Refined comments and formatting across core JavaScript modules while preserving the existing architecture, project structure, and file paths.
- **Added JSDoc Support:** Implemented parsing for `@param`, `@returns`, `@type`, `@deprecated`, `@example`, `@throws`, `@see`, and custom JSDoc tags.
- **Enhanced IntelliSense:** Hover, Autocompletion, and Signature Help now display structured documentation, type information, and parameter descriptions.
- **JSDoc Syntax Highlighting:** Added syntax highlighting and automatic tag suggestions when typing `@`, including automatic insertion of function parameter names.
- **Expanded Automated Testing:** Added LSP tests to verify documentation parsing, IntelliSense functionality, and correct association of comments with declarations.

## 1.0.0

Complete rewrite as a real language server (LSP).

- Language server (`server/`, zero dependencies) with an error-tolerant analyzer
- Exact syntax errors from the real MyLang2 Lexer/Parser (`mylang.compiler.path`)
- Semantic diagnostics: undefined names, `as const` / `as readonly` violations, duplicate declarations,
  unknown members of built-in modules (with “did you mean”), unknown modules, unused variables/imports
- Completion: members (modules, structs, enums, `this`, `http.Server()` results, route `ctx`), keywords with snippets,
  scope-aware symbols, import paths, auto-import of built-in modules
- Hover, signature help, go to definition (also across `import "./file.ml"`), references, rename,
  document highlights, outline, workspace symbols, folding, document links, semantic highlighting
- Quick fixes: add import, did-you-mean, remove unused import
- Standard-library API generated from the language sources (`npm run gen:stdlib`)
- New TextMate grammar matching the current lexer (`$"…{expr}…"`, `"""…"""`, numeric literals, …)
