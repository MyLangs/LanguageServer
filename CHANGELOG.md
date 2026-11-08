# Changelog

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
