# Changelog

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
