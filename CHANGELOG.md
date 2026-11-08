# Changelog

## 1.1.0 — JSDoc и улучшение читаемости (обновлённая сборка)

- Комментарии и форматирование основных JavaScript-модулей приведены к более понятному стилю без изменения архитектуры и путей файлов.
- Добавлен разбор JSDoc: `@param`, `@returns`, `@type`, `@deprecated`, `@example`, `@throws`, `@see` и произвольные теги.
- Hover, автодополнение и Signature Help показывают структурированную документацию, типы и описания параметров.
- Подсветка JSDoc и автодополнение тегов при вводе `@`, с подстановкой имён аргументов функций.
- Расширены автоматические LSP-тесты на документацию, подсказки и привязку комментариев.

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
