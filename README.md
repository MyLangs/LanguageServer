# MyLang for VS Code

Language Server (LSP) for the **MyLang2** programming language (`.ml`), tracking
**MyLang2 2.3**.

## Features

- **Formatting** — **Format Document** and **Format Selection** run the language's own formatter (`mylang prettier`, MyLang2 2.3), reading the `"prettier"` section of your `mylang.json`, so the editor and the command line can never disagree. Works with **Format on Save**; **MyLang: Format Workspace** and **MyLang: Check Formatting** run the whole-project commands in a terminal.
- **Syntax Errors** — detected by the language's actual `Lexer`/`Parser` (a simplified built-in syntax checker is used when the compiler is unavailable).
- **Symbol members** — `func [symbol.dispose]() { … }` and `func [symbol.iterator]() { … }` in a struct body (MyLang2 2.3): the body is a method body (`this`, the struct's `private` members), the outline shows which protocols a struct joins, the brackets complete, and everything the parser refuses is reported — a modifier on such a member, a bracketed field, an expression that is not a protocol symbol, and the same protocol declared twice.
- **`++` and `--` on members** — `o.n++`, `items[i]--`, `this.count++`, `Counter.created++` are understood as the writes they are, and obey the same rules as `+= 1`.
- **The `core:` namespace** — `import "core:fs"` is understood in every form (alias, grouped, destructuring, dynamic). It is the spelling the interpreter recommends, because a project dependency can never shadow it, so it is the one the editor completes and inserts. The bare name keeps working.
- **Diagnostics** — undefined identifiers, assignments to `as const` / `as readonly`, duplicate declarations, nonexistent module members (`strings.splitt` → "Did you mean `split`?"), unknown modules, a `core:` name that is not built in, imports that resolve to no file, names a destructuring import cannot take out of its target, uses of `@deprecated` APIs, unused `var` declarations, and unused imports.
- **Type hints** — arrays carry an element type (`array<string>`), indexing and `for … in` follow it, nested objects resolve (`cfg.db.host`), results of standard-library and user functions are typed, `length` / `size` are offered on arrays, strings, `bytes`, maps and sets, and `@type` / `@param` / `@returns` fill in what the code does not say.
- **Autocompletion** — module members, structures, enums, `this`, results returned by library calls (`http.Server()`, `tcp.connect()`, `binary.reader()`, …), `ctx` inside route handlers, names inside `import … as { … }`, keys of an imported `.json` file; keyword snippets; paths and module names in `import "…"`; installed packages from `.module` (`import "Owner:repo"`), and **automatic imports** for built-in modules and installed packages.
- **JSDoc Comments** (`/** ... */`) — parameter descriptions and types, return values, examples, deprecated APIs, and tag suggestions triggered by `@`.
- **Language Features** — Hover documentation, signature help (with parameter types), Go to Definition (including cross-file navigation through `import "./file.ml"`), Find All References, Rename Symbol, Document Outline, Workspace Symbol Search, Code Folding, and Semantic Highlighting.
- **Quick Fixes** — add missing imports, switch an import to the `core:` namespace, fix typos, and remove unused imports.
- **`mylang.json`** — validated and completed as you write it, the `"prettier"` section included.
- **Commands** — **MyLang: Run Current File**, **Format Workspace**, **Check Formatting**, **Restart Language Server**, and **Show Language Server Status**.

## Installation and Setup

```bash
npm install            # Install vscode-languageclient (the only dependency)
# Press F5 in VS Code to launch the Extension Development Host
npm run package        # Build the .vsix extension package
```

Connect the compiler to enable accurate syntax error detection using the `mylang.compiler.path` setting.

Specify either the package directory or the path to `dist/src/index.js` after running `npx tsc`.

If no path is provided, the language server searches the following locations in order:

1. `<workspace>/dist/src/index.js`
2. `<workspace>/node_modules/mylang2`
3. The `mylang2` package located next to the extension.

## Imports

Every form the interpreter accepts is understood, checked and completed:

```javascript
import "core:coreio";                     // built-in, namespaced (recommended)
import "coreio";                          // the bare form still works
import "core:net/http" as httpCore;       // alias
import ("core:arrays", "core:path");      // several at once
import "core:test" as { describe, test, assert, finish };
import "./utils.ml" as { add, PI };       // another file of the project
import "./config.json" as config;         // keys and their types are known
import "Owner:repo";                      // package installed in .module
import "https://example.com/library.ml";  // remote module
var strings = import("core:strings");     // dynamic
```

`core:<name>` can only ever be a module that ships with the interpreter, so a dependency
cannot shadow it. The server reports a `core:` name that is not built in, offers the
`core:` spelling first in completion, and writes it into the imports it inserts itself
(turn that off with `mylang.completion.coreNamespace`).

Checks on an import: the module or package exists, it is listed in `dependencies` and
installed, the file it points to is really there, and every name a destructuring import
takes out of it is really exposed.

## Standard Library API

Autocompletion data for `coreio`, `fs`, `net/http`, `tcp`, `test`, and every other standard module is **generated directly from the language's source code**.

```bash
npm run gen:stdlib -- /path/to/mylang2   # Overwrites server/data/stdlib.json
```

Run this command after making changes to `library/`. The current snapshot covers
**mylang2@2.3.0**: 38 modules and 753 members. **MyLang: Show Language Server Status**
reports which snapshot is loaded, and whether a formatter was found.

For every member the generator records:

- **parameters**, from `const [a, b = 1] = this.args;`
- **parameter types**, from the `this.validateString(str)` / `this.assertInteger(n)` guards and from `isTypeArgs(x) !== "int"` checks
- **the result kind** produced by the `call()` body (`array`, `string`, `bool`, `object`, …)
- **members of the result**, including resources built with `createResource({ members })` — sockets, streams and workers all get `close()` and `closed`
- **descriptions**, from JSDoc above the class or its `call()`, and from the `| Method | Description |` tables of `library/<module>/README.md`
- **the version** a module was added in, from the `// added in …` markers of `buildInModule`

It follows what a module's `index.ts` actually exports: a spread of a table of classes
(`...Object.fromEntries(Object.entries(producers)…)`, which is how `utils/colors` is
written since 2.3) is expanded entry by entry, and a file the module imports from
elsewhere in `library/` is read too, so the socket `tcp`, `tls`, `udp` and `ws` all build
in `net/socket` describes itself wherever it is handed back.

## JSDoc Support for Your Code

The extension recognizes JSDoc comments preceding `func`, `struct`, `enum`, and `var` declarations, as well as fields and methods.

Regular `//` and `/* ... */` comments are still supported as plain descriptions.

```javascript
/**
 * Returns the sum of two numbers.
 *
 * @param {number} a - The first operand.
 * @param {number} [b=1] - The second operand.
 * @returns {number} The sum of the numbers.
 * @example
 * add(5, 3)
 * @see sum
 */
func add(a, b = 1) {
  return a + b;
}

var answer = add(5, 3);
```

Hovering over `add` displays its description, parameters, `@returns` information, and example.

When typing `add(`, VS Code displays **descriptions for individual arguments** through Signature Help.

Hovering over a local parameter reveals its JSDoc type and description.

Inside `/** ... */`, typing `@` triggers tag autocompletion, including `@param` suggestions populated with the function's actual parameter names.

### Supported JSDoc Tags

The following tags are recognized:

- `@param`, `@arg` — parameter documentation.
- `@returns`, `@return` — return value documentation.
- `@type` — type information.
- `@deprecated` — marks deprecated APIs.
- `@example` — usage examples.
- `@throws` — possible exceptions.
- `@see` — references to related symbols.

Other tags are also preserved and displayed in Hover documentation.

Multiline tag descriptions are supported.

**Note:** JSDoc types are used exclusively for **documentation and editor assistance**. They do not modify type checking or interpreter behavior.

## Configuration

See the **MyLang** section in VS Code settings.

Available settings include:

- `mylang.compiler.path` — path to the MyLang compiler. The formatter is found the same way, one folder across (`<package>/dist/prettier`).
- `mylang.executable` — path to the MyLang executable.
- `mylang.run.noColors` — pass `--no-colors` to every command the extension runs (MyLang2 2.3).
- `mylang.format.enable` — format `.ml` files with `mylang prettier` (on by default).
- `mylang.format.configFile` — read formatter settings from a file other than the nearest `mylang.json`.
- `mylang.format.options` — formatter settings that win over `mylang.json`, the way a flag beats the file on the command line: `indent`, `useTabs`, `printWidth`, `quote`, `bracketSpacing`, `maxBlankLines`, `endOfLine`, `finalNewline`.
- `mylang.diagnostics.*` — diagnostic configuration options, including `unknownModules` (which also covers `core:` names and imports that resolve to no file), `unknownMembers` (which also covers destructuring imports) and `deprecated`.
- `mylang.completion.autoImport` — automatic import suggestions.
- `mylang.completion.coreNamespace` — write inserted imports as `import "core:fs"` (default) or as `import "fs"`.
- `mylang.globals` — names defined in `initScript` that should not be reported as undefined identifiers.

## Tests

```bash
node test/run.js [path/to/dist/src/index.js]
```

This command starts the actual language server and verifies its functionality through the Language Server Protocol (LSP).

Tests cover JSDoc parsing, Hover documentation, signature help, argument descriptions, tag autocompletion, the `core:` namespace and the modules added in 2.2, inferred types (arrays, nesting, call results, documented types), import checks, and other language server features. They pass with or without the compiler; pass its path to also exercise the real parser **and the real formatter** — the formatting tests are skipped without it, because an approximation of the formatter would be worse than none.

For 2.3 they also cover the `iter` additions, symbol members and everything the parser refuses about them, `private` members, `++` on members, indexes and statics, the option keys of `http.Server`, and formatting: the whole document, a selection, the project's settings, a setting the formatter refuses, and the switch that turns it off.
