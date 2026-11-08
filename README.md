# MyLang for VS Code

Language Server (LSP) for the **MyLang2** programming language (`.ml`).

## Features

- **Syntax Errors** — detected by the language's actual `Lexer`/`Parser` (a simplified built-in syntax checker is used when the compiler is unavailable).
- **Diagnostics** — undefined identifiers, assignments to `as const` / `as readonly`, duplicate declarations, nonexistent module members (`strings.splitt` → "Did you mean `split`?"), unknown modules, unused `var` declarations, and unused imports.
- **Autocompletion** — module members, structures, enums, `this`, results returned by `http.Server()`, and `ctx` inside route handlers; keyword snippets; paths in `import "…"`; installed packages from `.module` (`import "Owner:repo"`), and **automatic imports** for built-in modules and installed packages.
- **JSDoc Comments** (`/** ... */`) — parameter descriptions and types, return values, examples, deprecated APIs, and tag suggestions triggered by `@`.
- **Language Features** — Hover documentation, signature help, Go to Definition (including cross-file navigation through `import "./file.ml"`), Find All References, Rename Symbol, Document Outline, Workspace Symbol Search, Code Folding, and Semantic Highlighting.
- **Quick Fixes** — add missing imports, fix typos, and remove unused imports.
- **Commands** — **MyLang: Run Current File**, **Restart Language Server**, and **Show Language Server Status**.

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

## Standard Library API

Autocompletion data for `coreio`, `fs`, `net/http`, and other standard modules is **generated directly from the language's source code**.

```bash
npm run gen:stdlib -- /path/to/LiveServer  # Overwrites server/data/stdlib.json
```

Run this command after making changes to `library/`.

Descriptions are extracted from JSDoc comments placed above classes or their `call()` methods.

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

- `mylang.compiler.path` — path to the MyLang compiler.
- `mylang.executable` — path to the MyLang executable.
- `mylang.diagnostics.*` — diagnostic configuration options.
- `mylang.completion.autoImport` — automatic import suggestions.
- `mylang.globals` — names defined in `initScript` that should not be reported as undefined identifiers.

## Tests

```bash
node test/run.js [path/to/dist/src/index.js]
```

This command starts the actual language server and verifies its functionality through the Language Server Protocol (LSP).

Tests cover JSDoc parsing, Hover documentation, signature help, argument descriptions, tag autocompletion, and other language server features.
