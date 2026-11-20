"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const lang = require("../data/language");
const M = require("../core/modules");
const { scopeAt, visibleSymbols } = require("../core/analyzer");
const { formatParams } = require("../core/util");
const { renderSymbol, renderStdMember, renderModule, renderPackage } = require("./render");
const { listInstalledPackages, isDeclaredDependency } = require("../core/packages");

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
  Event: 23,
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

/**
 * How a built-in is spelled in an import the server writes itself. `core:` is the
 * spelling the interpreter recommends (it can never be shadowed by a dependency);
 * `mylang.completion.coreNamespace: false` goes back to the bare name.
 */
function importSpelling(moduleName, settings) {
  const useCore = !settings || !settings.completion || settings.completion.coreNamespace !== false;
  if (!useCore || !M.BUILTIN_MODULES.has(M.stripCoreNamespace(moduleName))) return moduleName;
  return `${M.CORE_NAMESPACE}${M.stripCoreNamespace(moduleName)}`;
}

function importEdit(analysis, lines, moduleName, settings) {
  const where = importInsertPosition(analysis, lines);
  const pos = lines.positionAt(where.offset);
  return {
    range: { start: pos, end: pos },
    newText: `${where.prefix}import "${importSpelling(moduleName, settings)}";${where.suffix}`,
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

// ───────────────────────── installed packages (.module) ─────────────────────────

/** Packages installed in `.module` folders visible from the document (nearest first). */
function installedPackages(doc) {
  try {
    return listInstalledPackages(path.dirname(fileURLToPath(doc.uri))).map((pkg) => ({
      pkg,
      declared: isDeclaredDependency(path.dirname(fileURLToPath(doc.uri)), pkg.source),
    }));
  } catch {
    return [];
  }
}

function packageDetail(pkg, declared) {
  return (
    "package" + (pkg.version ? ` v${pkg.version}` : "") + (declared ? "" : " (not in dependencies)")
  );
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

  // `core:<name>` first: it is the recommended spelling, and a dependency can never
  // shadow it. The bare form stays available, ranked below.
  const typedCore = prefix.startsWith(M.CORE_NAMESPACE);
  for (const name of M.BUILTIN_MODULES) {
    const core = `${M.CORE_NAMESPACE}${name}`;
    const mod = M.moduleDescriptor(name);
    const detail = "built-in module" + (mod && mod.since ? ` · since ${mod.since}` : "");
    items.push({
      label: core,
      kind: Kind.Module,
      detail,
      documentation: md(renderModule(name)),
      textEdit: { range, newText: core },
      filterText: core,
      sortText: "0" + name,
    });
    if (typedCore) continue;
    items.push({
      label: name,
      kind: Kind.Module,
      detail: detail + " (bare form)",
      documentation: md(renderModule(name)),
      textEdit: { range, newText: name },
      filterText: name,
      sortText: "3" + name,
    });
  }
  for (const { pkg, declared } of installedPackages(doc)) {
    items.push({
      label: pkg.source,
      kind: Kind.Module,
      detail: packageDetail(pkg, declared),
      documentation: md(
        renderPackage(pkg.source, { status: declared ? "ok" : "not-declared", pkg }),
      ),
      textEdit: { range, newText: pkg.source },
      filterText: pkg.source,
      sortText: "1" + pkg.source,
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

// ───────────────────────── destructuring imports ─────────────────────────

/**
 * Inside `import "core:test" as { … }` the only useful names are the ones the module
 * actually exposes, so they are offered instead of the usual scope completion.
 * @returns {object[]|null} items, or null when the caret is somewhere else
 */
function importDestructuringItems(doc, offset, range) {
  const { analysis, text } = doc;
  const imp = analysis.imports.find(
    (i) => i.kind !== "dynamic" && offset > i.tok.end && offset <= Math.max(i.stmtEnd, i.tok.end),
  );
  if (!imp) return null;

  const between = text.slice(imp.tok.end, offset);
  const open = between.lastIndexOf("{");
  if (open < 0 || between.slice(open).includes("}") || !/\bas\b/.test(between.slice(0, open)))
    return null;

  // a destructured import binds member types to its symbols, so the namespace itself
  // comes from the module descriptor or from what the resolved file exports
  const owner = imp.builtin
    ? M.moduleType(imp.module || imp.source)
    : imp.members
      ? { kind: "file", path: imp.source, members: imp.members }
      : null;
  const members = M.membersOf(owner);
  if (!members.length) return [];

  // names already taken out are not offered again - except the one being typed
  const taken = new Set(
    (imp.destructured || [])
      .filter((entry) => offset < entry.start || offset > entry.end)
      .map((entry) => entry.name),
  );
  return members
    .filter((m) => !taken.has(m.name))
    .map((m) => {
      const item = memberItem(m, range, text, offset);
      // a destructured name is written plainly, never as a call snippet
      item.textEdit = { range, newText: m.name };
      item.insertTextFormat = 1;
      return item;
    });
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
/**
 * Option keys of a standard-library call, where the cursor sits in the object literal it
 * takes: `http.Server({ | })`.
 *
 * The enclosing `{` has to be the call's own argument — `{ cors: { | } }` is a nested
 * object this does not describe — and a key already written is left out.
 *
 * @returns {object[]|null} items, or null when this is not such a place
 */
function callOptionItems(doc, offset, range) {
  const sig = doc.analysis.tokens.filter((t) => t.type !== "comment");

  // the innermost bracket still open at the cursor
  let depth = 0;
  let openIdx = -1;
  for (let i = sig.length - 1; i >= 0; i--) {
    const t = sig[i];
    if (t.start >= offset) continue;
    if (t.type !== "punct") continue;
    if (t.value === "}" || t.value === ")" || t.value === "]") depth++;
    else if (t.value === "{" || t.value === "(" || t.value === "[") {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx < 1 || sig[openIdx].value !== "{") return null;
  if (sig[openIdx - 1].type !== "punct" || sig[openIdx - 1].value !== "(") return null;

  // the member the call names, so the owner module is known rather than guessed
  const nameTok = sig[openIdx - 2];
  if (!nameTok) return null;
  const ref = doc.analysis.memberRefs.find(
    (r) => r.start === nameTok.start && r.end === nameTok.end,
  );
  if (!ref || !ref.ownerModule) return null;
  const options = lang.CALL_OPTIONS[`${ref.ownerModule}.${ref.name}`];
  if (!options) return null;

  // keys the object already has
  const written = new Set();
  let level = 0;
  for (let i = openIdx + 1; i < sig.length; i++) {
    const t = sig[i];
    if (t.type === "punct" && "{[(".includes(t.value)) level++;
    else if (t.type === "punct" && "}])".includes(t.value)) {
      if (level === 0) break;
      level--;
    } else if (level === 0 && t.type === "punct" && t.value === ":") {
      const key = sig[i - 1];
      // the key being typed is not "already written": it is what is being completed
      if (key && !(offset >= key.start && offset <= key.end)) written.add(key.value);
    }
  }

  return options
    .filter((o) => !written.has(o.name))
    .map((o) => ({
      label: o.name,
      kind: Kind.Property,
      detail: o.detail + (o.since ? `  ·  new in ${o.since}` : ""),
      documentation: md(o.doc),
      sortText: o.since ? `0${o.name}` : `1${o.name}`,
      textEdit: { range, newText: `${o.name}: ` },
    }));
}

/**
 * Whether a member may be named at `offset`.
 *
 * A `private` struct member (MyLang2 2.2) is reachable only from inside the struct that
 * declares it, so offering it anywhere else would suggest code the interpreter refuses.
 * Everything else is visible, and a member the analyzer knows nothing about stays visible
 * too: a missing suggestion is worse than a redundant one.
 */
function isVisibleFrom(member, ownerType, offset) {
  const sym = member && member.symbol;
  if (!sym || !sym.mods || !sym.mods.private) return true;
  const owner = ownerType && ownerType.symbol;
  if (!owner) return true;
  return offset >= owner.start && offset <= owner.end;
}

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
    return M.membersOf(dot.ownerType)
      .filter((m) => isVisibleFrom(m, dot.ownerType, offset))
      .map((m) => memberItem(m, range, text, offset));
  }

  // 3b. `import "core:test" as { describe, | }`
  const destructuring = importDestructuringItems(doc, offset, range);
  if (destructuring) return destructuring;
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

  // 4a. `http.Server({ | })`: the option keys of the call
  const callOptions = callOptionItems(doc, offset, range);
  if (callOptions) return callOptions;

  // 4b. `func [|]` in a struct body: only a protocol symbol can stand there (MyLang2 2.3)
  if (prev && prev.type === "punct" && prev.value === "[") {
    const before = prevIdx > 0 ? sig[prevIdx - 1] : null;
    if (before && before.type === "keyword" && before.value === "func") {
      return lang.PROTOCOL_SYMBOLS.map((p) => ({
        label: `symbol.${p.name}`,
        kind: Kind.Event,
        detail: p.detail,
        documentation: md(p.doc),
        textEdit: { range, newText: `symbol.${p.name}` },
      }));
    }
  }

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
    return [...M.BUILTIN_MODULES]
      .map((n) => {
        const spelling = importSpelling(n, settings);
        return {
          label: `"${spelling}"`,
          kind: Kind.Module,
          detail: "built-in module",
          documentation: md(renderModule(n)),
          insertText: `"${spelling}";`,
          sortText: "0" + n,
        };
      })
      .concat(
        installedPackages(doc).map(({ pkg, declared }) => ({
          label: `"${pkg.source}"`,
          kind: Kind.Module,
          detail: packageDetail(pkg, declared),
          insertText: `"${pkg.source}";`,
          sortText: "1" + pkg.source,
        })),
      );
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

  const insideFunction = (() => {
    for (let s = scope; s; s = s.parent) if (s.kind === "function") return true;
    return false;
  })();
  for (const [name, desc] of Object.entries(lang.GLOBALS)) {
    // `arguments` exists only inside a function body
    if (lang.FUNCTION_SCOPED_NAMES.has(name) && !insideFunction) continue;
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
        detail: `auto-import "${importSpelling(moduleName, settings)}"`,
        sortText: "4" + alias,
        documentation: md(renderModule(moduleName)),
        textEdit: { range, newText: alias },
        additionalTextEdits: [importEdit(analysis, lines, moduleName, settings)],
      });
    }
  }

  // auto-import: installed packages that are listed in mylang.json
  if (
    settings.completion &&
    settings.completion.autoImport !== false &&
    wordMatch &&
    wordMatch[0].length >= 1
  ) {
    for (const { pkg, declared } of installedPackages(doc)) {
      if (!declared || seen.has(pkg.name)) continue;
      add({
        label: pkg.name,
        kind: Kind.Module,
        detail: `auto-import "${pkg.source}"`,
        sortText: "4" + pkg.name,
        documentation: md(renderPackage(pkg.source, { status: "ok", pkg })),
        textEdit: { range, newText: pkg.name },
        additionalTextEdits: [importEdit(analysis, lines, pkg.source, settings)],
      });
    }
  }
  return items;
}

module.exports = { complete, importEdit, importSpelling, aliasIndex, installedPackages, Kind };
