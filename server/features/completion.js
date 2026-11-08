"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const lang = require("../data/language");
const M = require("../core/modules");
const { scopeAt, visibleSymbols } = require("../core/analyzer");
const { formatParams } = require("../core/util");
const { renderSymbol, renderStdMember, renderModule } = require("./render");

const Kind = {
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Module: 9,
  Property: 10,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  File: 17,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
};

const SYMBOL_KIND = {
  variable: Kind.Variable,
  parameter: Kind.Variable,
  catch: Kind.Variable,
  function: Kind.Function,
  method: Kind.Method,
  struct: Kind.Struct,
  enum: Kind.Enum,
  enumMember: Kind.EnumMember,
  field: Kind.Field,
  property: Kind.Property,
  import: Kind.Module,
};

const md = (value) => ({ kind: "markdown", value });

function callSnippet(name, params) {
  if (!params) return `${name}($0)`;
  if (params.length === 0) return `${name}()`;
  const required = params.filter((p) => !p.optional && !p.rest);
  const shown = required.length ? required : [params[0]];
  return `${name}(${shown.map((p, i) => `\${${i + 1}:${p.name}}`).join(", ")})`;
}

/** Build a member completion item, including callable snippets and Hover docs. */
function memberItem(member, range, text, offset) {
  const isCall = member.kind === "function" || member.kind === "method" || member.kind === "class";
  const nextIsParen = text[offset] === "(";
  const item = {
    label: member.name,
    kind: memberKind(member),
    detail: isCall ? `(${formatParams(member.params)})` : member.kind,
    sortText: "0" + member.name,
    textEdit: {
      range,
      newText: isCall && !nextIsParen ? callSnippet(member.name, member.params) : member.name,
    },
    insertTextFormat: isCall && !nextIsParen ? 2 : 1,
  };
  if (member.origin === "std") item.documentation = md(renderStdMember(member));
  else if (member.symbol) {
    item.documentation = md(renderSymbol(member.symbol));
    if (member.symbol.jsdoc?.deprecated !== null && member.symbol.jsdoc?.deprecated !== undefined) {
      item.tags = [1]; // LSP CompletionItemTag.Deprecated
    }
  }
  return item;
}

function memberKind(member) {
  if (member.origin === "std") {
    if (member.kind === "class") return Kind.Class;
    if (member.kind === "function") return Kind.Function;
    if (member.kind === "object") return Kind.Module;
    return Kind.Constant;
  }
  return SYMBOL_KIND[member.kind] || Kind.Property;
}

/** Offset just after the last top-level import statement (or 0). */
function importInsertPosition(analysis, lines) {
  let end = -1;
  for (const imp of analysis.imports)
    if (imp.kind !== "dynamic" && imp.stmtEnd > end) end = imp.stmtEnd;
  if (end < 0) return { offset: 0, prefix: "", suffix: "\n" };
  const pos = lines.positionAt(end);
  return { offset: end, line: pos.line, prefix: "\n", suffix: "" };
}

function importEdit(analysis, lines, moduleName) {
  const where = importInsertPosition(analysis, lines);
  const pos = lines.positionAt(where.offset);
  return {
    range: { start: pos, end: pos },
    newText: `${where.prefix}import "${moduleName}";${where.suffix}`,
  };
}

/** Which built-in module (by alias) provides `name`, preferring the shortest path. */
function aliasIndex() {
  const map = new Map();
  for (const name of M.BUILTIN_MODULES) {
    const alias = name.includes("/") ? name.split("/")[1] : name;
    if (!map.has(alias)) map.set(alias, []);
    map.get(alias).push(name);
  }
  return map;
}

// ───────────────────────── import path completion ─────────────────────────

/** Complete built-in imports or filesystem paths relative to the .ml file. */
function importPathItems(doc, entryTok, offset) {
  const prefix = doc.text.slice(entryTok.start + 1, offset);
  const start = doc.lines.positionAt(entryTok.start + 1);
  const end = doc.lines.positionAt(offset);
  const range = { start, end };
  const items = [];

  if (/^(\.{1,2}[\\/]|[\\/]|\.)/.test(prefix) || prefix.startsWith("~")) {
    let dir;
    try {
      dir = path.dirname(fileURLToPath(doc.uri));
    } catch {
      return items;
    }
    const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const typedDir = slash >= 0 ? prefix.slice(0, slash + 1) : "";
    const abs = path.resolve(dir, typedDir || ".");
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return items;
    }
    const wordStart = doc.lines.positionAt(entryTok.start + 1 + typedDir.length);
    const wordRange = { start: wordStart, end };
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        items.push({
          label: e.name + "/",
          kind: Kind.Folder,
          textEdit: { range: wordRange, newText: e.name + "/" },
          command: { title: "", command: "editor.action.triggerSuggest" },
          sortText: "1" + e.name,
        });
      } else if (/\.(ml|json|js)$/.test(e.name)) {
        items.push({
          label: e.name,
          kind: Kind.File,
          textEdit: { range: wordRange, newText: e.name },
          sortText: "0" + e.name,
        });
      }
    }
    return items;
  }

  for (const name of M.BUILTIN_MODULES) {
    items.push({
      label: name,
      kind: Kind.Module,
      detail: "built-in module",
      documentation: md(renderModule(name)),
      textEdit: { range, newText: name },
      filterText: name,
      sortText: "0" + name,
    });
  }
  items.push({
    label: "./",
    kind: Kind.Folder,
    detail: "relative file",
    textEdit: { range, newText: "./" },
    command: { title: "", command: "editor.action.triggerSuggest" },
    sortText: "2",
  });
  return items;
}

// ───────────────────────── JSDoc tag completion ─────────────────────────

/**
 * Provide tag snippets inside JSDoc block comments. Ordinary comments still
 * suppress code completion, so typing prose never shows language keywords.
 */
function jsdocItems(doc, comment, offset) {
  if (!comment.value.startsWith("/**")) return [];

  const lineStart = doc.text.lastIndexOf("\n", offset - 1) + 1;
  const beforeCursor = doc.text.slice(lineStart, offset);
  const match = /@[\w-]*$/.exec(beforeCursor);
  if (!match) return [];

  const range = doc.lines.range(offset - match[0].length, offset);
  // Find the following function/method to offer its real parameter names.
  const following = doc.analysis.symbols.find(
    (symbol) =>
      (symbol.kind === "function" || symbol.kind === "method") &&
      symbol.start >= comment.end &&
      symbol.start - comment.end < 150,
  );

  const tags = [
    ["returns", "@returns {${1:type}} ${2:description}", "Describe a function's return value"],
    ["return", "@return {${1:type}} ${2:description}", "Alias of @returns"],
    ["type", "@type {${1:type}}", "Specify the documented type"],
    ["example", "@example\n * ${1:example}", "Include a usage example"],
    ["deprecated", "@deprecated ${1:reason}", "Mark the declaration as deprecated"],
    ["throws", "@throws {${1:Error}} ${2:description}", "Document an error"],
    ["see", "@see ${1:reference}", "Link related documentation"],
    ["since", "@since ${1:version}", "Version that introduced this symbol"],
    ["template", "@template ${1:T}", "Document a generic type parameter"],
    ["remarks", "@remarks ${1:details}", "Add extra details"],
  ];

  const parameterTags = (following?.params || []).length
    ? following.params.map((param) => [
        `param ${param.name}`,
        "@param {${1:type}} " + param.name + " - ${2:description}",
        `Document the ${param.name} parameter`,
      ])
    : [["param", "@param {${1:type}} ${2:name} - ${3:description}", "Describe a parameter"]];

  return [...parameterTags, ...tags].map(([label, snippet, description]) => ({
    label: `@${label}`,
    kind: Kind.Snippet,
    detail: description,
    filterText: label.startsWith("param ") ? "@param" : `@${label}`,
    sortText: label.startsWith("param") ? "0" + label : "1" + label,
    textEdit: { range, newText: snippet },
    insertTextFormat: 2,
  }));
}

// ───────────────────────── main entry ─────────────────────────

/**
 * @returns {object[]} LSP CompletionItems
 */
function complete(doc, offset, settings) {
  const { analysis, text, lines } = doc;
  const tokens = analysis.tokens;

  // 1. inside comments: show JSDoc tag snippets only
  for (const token of tokens) {
    if (token.start >= offset) break;
    if (token.type !== "comment") continue;

    const insideComment =
      offset < token.end ||
      (token.kind === "line" && offset === token.end) ||
      (token.kind === "block" && !token.terminated);
    if (insideComment && offset > token.start) {
      return jsdocItems(doc, token, offset);
    }
  }

  // 2. inside a string
  for (const t of tokens) {
    if (t.type !== "string") continue;
    if (offset > t.start && (offset < t.end || (!t.terminated && offset <= t.end))) {
      const entry = analysis.imports.find((i) => i.tok === t || i.tok.start === t.start);
      if (entry) return importPathItems(doc, t, offset);
      // interpolation: `$"... {na|me} ..."`
      if (
        t.kind === "interp" &&
        t.exprs &&
        t.exprs.some((r) => offset >= r.start && offset <= r.end)
      )
        break;
      return [];
    }
  }

  // 3. member access:  owner.<partial>
  const wordMatch = /[A-Za-z_]\w*$/.exec(text.slice(0, offset));
  const wordStart = wordMatch ? offset - wordMatch[0].length : offset;
  const range = { start: lines.positionAt(wordStart), end: lines.positionAt(offset) };

  const dot = analysis.dots.find((entry) => {
    const gap = text.slice(entry.dotEnd, wordStart);
    return (
      entry.dotEnd === wordStart ||
      (entry.dotEnd <= wordStart && /^\s*$/.test(gap) && !gap.includes("\n"))
    );
  });
  if (dot) {
    // owner type may have been enriched after parsing (imported files)
    return M.membersOf(dot.ownerType).map((m) => memberItem(m, range, text, offset));
  }
  // typing a `.` that the parser has not seen as postfix (e.g. after a number) -> nothing
  if (text[wordStart - 1] === ".") return [];

  // 4. naming position (after var/func/struct/enum/catch( ): suggest nothing
  const sig = tokens.filter((t) => t.type !== "comment");
  let prevIdx = -1;
  for (let i = 0; i < sig.length; i++) {
    if (sig[i].end <= wordStart) prevIdx = i;
    else break;
  }
  const prev = prevIdx >= 0 ? sig[prevIdx] : null;
  if (prev && prev.type === "keyword" && ["var", "func", "struct", "enum"].includes(prev.value))
    return [];
  if (prev && prev.type === "keyword" && prev.value === "as") {
    return lang.MODIFIERS.map((k) => ({
      label: k,
      kind: Kind.Keyword,
      textEdit: { range, newText: k },
      detail: "variable modifier",
    }));
  }
  if (prev && prev.type === "keyword" && prev.value === "import" && !wordMatch) {
    return [...M.BUILTIN_MODULES].map((n) => ({
      label: `"${n}"`,
      kind: Kind.Module,
      detail: "built-in module",
      insertText: `"${n}";`,
      sortText: "0" + n,
    }));
  }

  // 5. general completion
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (seen.has(item.label)) return;
    seen.add(item.label);
    items.push(item);
  };

  const scope = scopeAt(analysis, offset);
  for (const sym of visibleSymbols(scope)) {
    if (sym.name.startsWith("(")) continue;
    const isCall = sym.kind === "function" || sym.kind === "struct";
    const nextIsParen = text[offset] === "(";
    add({
      label: sym.name,
      kind: SYMBOL_KIND[sym.kind] || Kind.Variable,
      detail: sym.kind === "function" ? `(${formatParams(sym.params || [])})` : sym.kind,
      sortText: "0" + sym.name,
      documentation: md(renderSymbol(sym)),
      tags: sym.jsdoc?.deprecated != null ? [1] : undefined,
      textEdit: {
        range,
        newText:
          isCall && !nextIsParen && sym.kind === "function"
            ? callSnippet(sym.name, sym.params)
            : sym.name,
      },
      insertTextFormat: isCall && !nextIsParen && sym.kind === "function" ? 2 : 1,
    });
  }

  for (const [name, desc] of Object.entries(lang.GLOBALS)) {
    add({
      label: name,
      kind: desc.kind === "function" ? Kind.Function : Kind.Variable,
      detail: "global",
      documentation: md(desc.doc || ""),
      sortText: "1" + name,
      textEdit: { range, newText: name },
    });
  }

  const snippetByKeyword = new Map(
    lang.SNIPPETS.filter((s) => s.keyword).map((s) => [s.keyword, s]),
  );
  for (const k of lang.KEYWORDS) {
    if (lang.MODIFIERS.includes(k) || k === "as") continue;
    const snip = snippetByKeyword.get(k);
    add({
      label: k,
      kind: snip ? Kind.Snippet : Kind.Keyword,
      detail: snip ? snip.detail : "keyword",
      sortText: "2" + k,
      textEdit: { range, newText: snip ? snip.insertText : k },
      insertTextFormat: snip ? 2 : 1,
      documentation: lang.KEYWORD_DOCS[k]
        ? md(require("./render").renderDoc(k, lang.KEYWORD_DOCS[k]))
        : undefined,
    });
  }
  for (const k of lang.LITERALS)
    add({ label: k, kind: Kind.Constant, sortText: "2" + k, textEdit: { range, newText: k } });
  for (const s of lang.SNIPPETS) {
    if (s.keyword) continue;
    add({
      label: s.label,
      kind: Kind.Snippet,
      detail: s.detail,
      sortText: "3" + s.label,
      textEdit: { range, newText: s.insertText },
      insertTextFormat: 2,
    });
  }

  // auto-import: module namespaces that are not imported yet
  if (
    settings.completion &&
    settings.completion.autoImport !== false &&
    wordMatch &&
    wordMatch[0].length >= 1
  ) {
    const idx = aliasIndex();
    for (const [alias, modules] of idx) {
      if (seen.has(alias)) continue;
      const moduleName =
        modules.length === 1 ? modules[0] : modules.find((m) => !m.includes("/")) || modules[0];
      add({
        label: alias,
        kind: Kind.Module,
        detail: `auto-import "${moduleName}"`,
        sortText: "4" + alias,
        documentation: md(renderModule(moduleName)),
        textEdit: { range, newText: alias },
        additionalTextEdits: [importEdit(analysis, lines, moduleName)],
      });
    }
  }
  return items;
}

module.exports = { complete, importEdit, aliasIndex, Kind };
