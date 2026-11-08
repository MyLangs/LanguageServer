"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const lang = require("../data/language");
const M = require("../core/modules");
const { occurrenceAt } = require("../core/analyzer");

const SymKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Function: 12,
  Variable: 13,
  Constant: 14,
  Object: 19,
  EnumMember: 22,
  Struct: 23,
};

/** Resolves an import source relative to the importing document. */
function resolveImportFile(docUri, source) {
  if (/^https?:\/\//.test(source)) return null;
  if (!/\.(ml|json|js)$/.test(source)) return null;
  try {
    const dir = path.dirname(fileURLToPath(docUri));
    const abs = path.resolve(dir, source);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

function symbolLocation(sym, fallbackDoc) {
  const uri = sym.docUri || fallbackDoc.uri;
  const lines = sym.docUri && sym.docLines ? sym.docLines : fallbackDoc.lines;
  return { uri, range: lines.range(sym.nameStart, sym.nameEnd) };
}

/** Symbol (user-defined) under the cursor, including members resolved at query time. */
function symbolAt(doc, offset) {
  const occ = occurrenceAt(doc.analysis, offset);
  if (!occ) return { occ: null, symbol: null };
  let symbol = occ.symbol;
  if (!symbol && occ.kind === "member") {
    const m = occ.member;
    const member = m.ownerType ? M.memberOf(m.ownerType, m.name) : null;
    if (member && member.origin === "user") symbol = member.symbol;
  }
  return { occ, symbol };
}

// ───────────────────────── definition ─────────────────────────

function definition(doc, offset) {
  // import path -> target file
  const imp = doc.analysis.imports.find((i) => offset >= i.tok.start && offset <= i.tok.end);
  if (imp) {
    const file = resolveImportFile(doc.uri, imp.source);
    if (file) {
      return [
        {
          uri: pathToFileURL(file).toString(),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ];
    }
  }
  const { symbol } = symbolAt(doc, offset);
  if (!symbol) return [];
  if (symbol.kind === "import" && symbol.type && symbol.type.kind === "file") {
    const file = resolveImportFile(doc.uri, symbol.importSource);
    if (file)
      return [
        {
          uri: pathToFileURL(file).toString(),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ];
  }
  return [symbolLocation(symbol, doc)];
}

// ───────────────────────── references / highlight / rename ─────────────────────────

function occurrencesOf(symbol) {
  const out = [];
  out.push({ start: symbol.nameStart, end: symbol.nameEnd, write: true, decl: true });
  for (const r of symbol.refs)
    out.push({ start: r.start, end: r.end, write: !!r.write, decl: false });
  return out;
}

function references(doc, offset, includeDeclaration = true) {
  const { symbol } = symbolAt(doc, offset);
  if (!symbol) return [];
  return occurrencesOf(symbol)
    .filter((o) => includeDeclaration || !o.decl)
    .map((o) => ({ uri: symbol.docUri || doc.uri, range: doc.lines.range(o.start, o.end) }));
}

function documentHighlights(doc, offset) {
  const { symbol } = symbolAt(doc, offset);
  if (!symbol) return [];
  return occurrencesOf(symbol).map((o) => ({
    range: doc.lines.range(o.start, o.end),
    kind: o.write ? 3 : 2,
  }));
}

const RENAMABLE = new Set([
  "variable",
  "function",
  "parameter",
  "struct",
  "enum",
  "catch",
  "import",
  "field",
  "method",
  "enumMember",
  "property",
]);

function prepareRename(doc, offset) {
  const { occ, symbol } = symbolAt(doc, offset);
  if (!occ || !symbol || !RENAMABLE.has(symbol.kind)) return null;
  if (symbol.implicitName) return null; // `import "coreio"` has no editable name
  if (symbol.docUri && symbol.docUri !== doc.uri) return null; // declared in another file
  return { range: doc.lines.range(occ.start, occ.end), placeholder: symbol.name };
}

function rename(doc, offset, newName) {
  const prep = prepareRename(doc, offset);
  if (!prep) return null;
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) ||
    lang.KEYWORDS.includes(newName) ||
    lang.LITERALS.includes(newName)
  ) {
    throw Object.assign(new Error(`'${newName}' is not a valid identifier`), { rpcCode: -32602 });
  }
  const { symbol } = symbolAt(doc, offset);
  const edits = occurrencesOf(symbol).map((o) => ({
    range: doc.lines.range(o.start, o.end),
    newText: newName,
  }));
  // shorthand `{ name }` and exports are references too and are covered by symbol.refs
  return { changes: { [doc.uri]: edits } };
}

// ───────────────────────── document symbols ─────────────────────────

function kindOf(sym) {
  switch (sym.kind) {
    case "function":
      return SymKind.Function;
    case "method":
      return SymKind.Method;
    case "struct":
      return SymKind.Struct;
    case "enum":
      return SymKind.Enum;
    case "enumMember":
      return SymKind.EnumMember;
    case "field":
      return SymKind.Field;
    case "property":
      return SymKind.Property;
    case "import":
      return SymKind.Module;
    default:
      if (sym.mods && sym.mods.const) return SymKind.Constant;
      if (sym.type && sym.type.kind === "object") return SymKind.Object;
      return SymKind.Variable;
  }
}

function toDocumentSymbol(doc, sym, children) {
  const end = Math.max(sym.end, sym.nameEnd);
  const start = Math.min(sym.start, sym.nameStart);
  return {
    name: sym.name,
    detail:
      sym.kind === "function" || sym.kind === "method"
        ? `(${(sym.params || []).map((p) => (p.rest ? "..." : "") + p.name).join(", ")})`
        : sym.importSource || "",
    kind: kindOf(sym),
    range: doc.lines.range(start, end),
    selectionRange: doc.lines.range(sym.nameStart, sym.nameEnd),
    children,
  };
}

function documentSymbols(doc) {
  const { analysis } = doc;
  const build = (sym) => {
    let children = [];
    if ((sym.kind === "struct" || sym.kind === "enum") && sym.members) {
      children = [...sym.members.values()].map(build);
    } else if (
      sym.kind === "variable" &&
      sym.type &&
      sym.type.kind === "object" &&
      sym.type.members
    ) {
      children = [...sym.type.members.values()].map(build);
    } else if (sym.kind === "function") {
      // nested declarations
      children = analysis.symbols
        .filter(
          (s) =>
            !s.isMember &&
            s.scope &&
            s.scope.fn === sym &&
            ["function", "struct", "enum"].includes(s.kind),
        )
        .map(build);
    }
    return toDocumentSymbol(doc, sym, children);
  };
  return analysis.symbols
    .filter(
      (s) =>
        !s.isMember &&
        s.scope === analysis.root &&
        !s.name.startsWith("(") &&
        s.kind !== "parameter",
    )
    .map(build);
}

function flattenSymbols(doc, query) {
  const q = query.toLowerCase();
  const out = [];
  const visit = (sym, container) => {
    if (!sym.name.startsWith("(") && (!q || sym.name.toLowerCase().includes(q))) {
      out.push({
        name: sym.name,
        kind: kindOf(sym),
        containerName: container || undefined,
        location: { uri: doc.uri, range: doc.lines.range(sym.nameStart, sym.nameEnd) },
      });
    }
    if ((sym.kind === "struct" || sym.kind === "enum") && sym.members) {
      for (const m of sym.members.values()) visit(m, sym.name);
    }
  };
  for (const s of doc.analysis.symbols) {
    if (!s.isMember && s.scope === doc.analysis.root && s.kind !== "import") visit(s, null);
  }
  return out;
}

// ───────────────────────── links / folding ─────────────────────────

function documentLinks(doc) {
  const links = [];
  for (const imp of doc.analysis.imports) {
    const range = doc.lines.range(
      imp.tok.start + 1,
      Math.max(imp.tok.start + 1, imp.tok.end - (imp.tok.terminated ? 1 : 0)),
    );
    if (/^https?:\/\//.test(imp.source)) {
      links.push({ range, target: imp.source });
      continue;
    }
    const file = resolveImportFile(doc.uri, imp.source);
    if (file) links.push({ range, target: pathToFileURL(file).toString() });
  }
  return links;
}

function foldingRanges(doc) {
  const { analysis, lines } = doc;
  const ranges = [];
  const stack = [];
  const sig = analysis.tokens.filter((t) => t.type !== "comment" && t.type !== "eof");
  const pairs = { "{": "}", "(": ")", "[": "]" };
  for (const t of sig) {
    if (t.type !== "punct") continue;
    if (pairs[t.value]) stack.push(t);
    else if (t.value === "}" || t.value === ")" || t.value === "]") {
      const open = stack.pop();
      if (!open || pairs[open.value] !== t.value) continue;
      const a = lines.positionAt(open.start).line;
      const b = lines.positionAt(t.start).line;
      if (b > a) ranges.push({ startLine: a, endLine: b - 1 });
    }
  }
  // comments
  let run = null;
  for (const t of analysis.tokens) {
    if (t.type !== "comment") {
      run = null;
      continue;
    }
    const a = lines.positionAt(t.start).line;
    const b = lines.positionAt(t.end).line;
    if (t.kind === "block" && b > a) ranges.push({ startLine: a, endLine: b, kind: "comment" });
    else if (t.kind === "line") {
      if (run && a === run.end + 1) run.end = a;
      else {
        run = { start: a, end: a };
        const r = run;
        ranges.push({ startLine: a, endLine: a, kind: "comment", _run: r });
      }
    }
  }
  return ranges
    .map((r) => {
      if (r._run) return { startLine: r._run.start, endLine: r._run.end, kind: "comment" };
      return r;
    })
    .filter((r) => r.endLine > r.startLine);
}

module.exports = {
  definition,
  references,
  documentHighlights,
  prepareRename,
  rename,
  documentSymbols,
  flattenSymbols,
  documentLinks,
  foldingRanges,
  resolveImportFile,
  symbolAt,
  SymKind,
};
