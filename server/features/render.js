"use strict";

const lang = require("../data/language");
const M = require("../core/modules");
const { formatParams } = require("../core/util");
const { parseJSDoc, renderJSDoc } = require("../core/jsdoc");

const fence = (code, language = "mylang") => "```" + language + "\n" + code + "\n```";

/** Renders an entry of docs.js (keyword / global / module / member docs). */
function renderDoc(title, doc) {
  const parts = [];
  parts.push(`**${title}**` + (doc.category ? `  ·  _${doc.category}_` : ""));
  if (doc.syntax) parts.push(fence(doc.syntax));
  if (doc.description) parts.push(doc.description);
  if (doc.example) parts.push("**Example**\n" + fence(doc.example));
  if (doc.output) parts.push("**Output**\n" + fence(doc.output, "text"));
  if (doc.tip) parts.push(`💡 **Tip:** ${doc.tip}`);
  if (doc.warning) parts.push(`⚠️ **Heads up:** ${doc.warning}`);
  if (doc.related && doc.related.length)
    parts.push("_See also:_ " + doc.related.map((r) => "`" + r + "`").join(", "));
  return parts.join("\n\n");
}

/** One-line signature of a user symbol. */
function symbolSignature(sym) {
  switch (sym.kind) {
    case "function":
    case "method":
      return `func ${sym.name}(${formatParams(sym.params || [])})`;
    case "struct":
      return `struct ${sym.name}`;
    case "enum":
      return `enum ${sym.name}`;
    case "enumMember":
      return `${sym.parent ? sym.parent.name + "." : ""}${sym.name}`;
    case "parameter":
      return `(parameter) ${sym.name}`;
    case "field":
      return `${sym.parent ? sym.parent.name + "." : ""}${sym.name}  (field)`;
    case "property":
      return `${sym.name}  (property)`;
    case "catch":
      return `(error) ${sym.name}`;
    case "import":
      return sym.importSource
        ? `import "${sym.importSource}"` +
            (sym.destructured ? ` as { ${sym.name} }` : sym.implicitName ? "" : ` as ${sym.name}`)
        : `import ${sym.name}`;
    default: {
      const mods = sym.mods.readonly
        ? " as readonly"
        : sym.mods.lazy
          ? " as lazy"
          : sym.mods.const
            ? " as const"
            : "";
      return `var ${sym.name}${mods}`;
    }
  }
}

function typeLine(type) {
  const d = M.describeType(type);
  return d ? `_${d}_` : "";
}

/** Hover for a user symbol. */
function renderSymbol(sym) {
  const parts = [fence(symbolSignature(sym))];
  const hasValueType = ["variable", "parameter", "property", "field"].includes(sym.kind);
  const t = hasValueType ? typeLine(sym.type) : "";
  if (t) parts.push(t);
  // Keep descriptions and structured @tags together in every Hover surface.
  const documentation = sym.jsdoc ? renderJSDoc(sym.jsdoc) : sym.doc;
  if (documentation) parts.push(documentation);
  if (sym.kind === "import" && sym.importSource) {
    const lib = lang.LIB_DOCS[sym.name] || lang.LIB_DOCS[sym.importSource];
    if (lib && lib.description) parts.push(lib.description);
  }
  if (sym.kind === "struct" && sym.members) {
    const fields = [...sym.members.values()].filter((m) => m.kind === "field").map((m) => m.name);
    const methods = [...sym.members.values()]
      .filter((m) => m.kind === "method")
      .map((m) => m.name + "()");
    if (fields.length) parts.push("**Fields:** " + fields.map((f) => "`" + f + "`").join(", "));
    if (methods.length) parts.push("**Methods:** " + methods.map((f) => "`" + f + "`").join(", "));
  }
  if (sym.kind === "enum" && sym.members) {
    const values = [...sym.members.values()]
      .filter((m) => m.kind === "enumMember")
      .map((m) => m.name);
    if (values.length) parts.push("**Values:** " + values.map((f) => "`" + f + "`").join(", "));
  }
  return parts.join("\n\n");
}

/** Hover for a standard-library member (`strings.split`). */
function renderStdMember(member, ownerName) {
  const curated = lang.MEMBER_DOCS[member.path];
  if (curated) return renderDoc(member.path, curated);
  const isCallable = member.kind === "function" || member.kind === "class";
  const sig = isCallable ? `${member.path}(${formatParams(member.params)})` : member.path;
  const parts = [fence(sig)];
  if (member.doc) parts.push(renderJSDoc(parseJSDoc(member.doc)));
  if (member.kind === "class" && member.desc && member.desc.members) {
    const names = Object.keys(member.desc.members);
    if (names.length)
      parts.push("**Members of the result:** " + names.map((n) => "`" + n + "`").join(", "));
  }
  void ownerName;
  return parts.join("\n\n");
}

/** Hover for a module namespace (`import "strings"` / `strings`). */
function renderModule(moduleName) {
  const mod = M.moduleDescriptor(moduleName);
  const alias = mod ? mod.alias : moduleName;
  const curated = lang.LIB_DOCS[alias];
  if (curated) return renderDoc(`module ${moduleName}`, curated);
  const parts = [fence(`import "${moduleName}";`)];
  if (mod) {
    const names = Object.keys(mod.members);
    parts.push(
      `Built-in module with ${names.length} member${names.length === 1 ? "" : "s"}: ` +
        names
          .slice(0, 12)
          .map((n) => "`" + n + "`")
          .join(", ") +
        (names.length > 12 ? ", …" : ""),
    );
  }
  return parts.join("\n\n");
}

module.exports = { renderDoc, renderSymbol, renderStdMember, renderModule, symbolSignature, fence };
