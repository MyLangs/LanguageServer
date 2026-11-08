"use strict";

const M = require("../core/modules");

const TYPES = [
  "namespace",
  "class",
  "enum",
  "enumMember",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
];
const MODIFIERS = ["declaration", "readonly", "defaultLibrary"];
const legend = { tokenTypes: TYPES, tokenModifiers: MODIFIERS };

const typeIndex = (n) => TYPES.indexOf(n);

function symbolType(sym) {
  switch (sym.kind) {
    case "import":
      return sym.type && sym.type.kind === "module" && !sym.destructured
        ? "namespace"
        : sym.type && sym.type.kind === "std"
          ? "function"
          : "namespace";
    case "struct":
      return "class";
    case "enum":
      return "enum";
    case "enumMember":
      return "enumMember";
    case "function":
      return "function";
    case "method":
      return "method";
    case "field":
    case "property":
      return sym.type && sym.type.kind === "function" ? "method" : "property";
    case "parameter":
      return "parameter";
    default:
      return "variable";
  }
}

/** Encodes semantic tokens (LSP relative encoding). */
function semanticTokens(doc) {
  const { analysis, lines } = doc;
  const items = [];

  for (const o of analysis.occurrences) {
    let type = null;
    let mods = 0;
    if (o.kind === "member") {
      const m = o.member;
      const member = m.ownerType ? M.memberOf(m.ownerType, m.name) : null;
      if (!member) continue;
      if (member.origin === "std") {
        type =
          member.kind === "function" || member.kind === "class"
            ? "function"
            : member.kind === "object"
              ? "namespace"
              : "property";
        mods |= 4;
      } else {
        type = symbolType(member.symbol);
        if (member.symbol.mods.const) mods |= 2;
      }
    } else if (o.symbol) {
      type = symbolType(o.symbol);
      if (o.kind === "decl") mods |= 1;
      if (o.symbol.mods.const) mods |= 2;
    } else if (o.ref && (o.ref.builtin || o.ref.keywordGlobal)) {
      type = o.ref.name === "length" ? "function" : "variable";
      mods |= 4;
    } else continue;
    if (o.kind === "decl" && o.symbol && o.symbol.implicitName) continue;
    if (o.kind === "decl" && o.symbol && o.symbol.isMember && o.symbol.kind === "property")
      type = "property";
    items.push({ start: o.start, end: o.end, type: typeIndex(type), mods });
  }

  items.sort((a, b) => a.start - b.start);
  const data = [];
  let prevLine = 0;
  let prevChar = 0;
  let lastEnd = -1;
  for (const it of items) {
    if (it.start < lastEnd) continue; // overlapping
    lastEnd = it.end;
    const pos = lines.positionAt(it.start);
    const endPos = lines.positionAt(it.end);
    if (endPos.line !== pos.line) continue;
    const dLine = pos.line - prevLine;
    const dChar = dLine === 0 ? pos.character - prevChar : pos.character;
    data.push(dLine, dChar, it.end - it.start, it.type, it.mods);
    prevLine = pos.line;
    prevChar = pos.character;
  }
  return { data };
}

module.exports = { semanticTokens, legend };
