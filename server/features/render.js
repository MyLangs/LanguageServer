"use strict";

const lang = require("../data/language");
const M = require("../core/modules");
const { formatParams } = require("../core/util");
const { parseJSDoc, renderJSDoc } = require("../core/jsdoc");

const fence = (code, language = "mylang") => "```" + language + "\n" + code + "\n```";

/**
 * A type as it is shown in Hover. Object shapes and array elements are spelled out
 * one level deep, which is what makes nested values readable:
 *   `{ host: string, port: int }`, `array<{ name: string }>`
 */
function typeText(type, depth = 0) {
  if (!type) return "";
  if (type.kind === "array") {
    const element = typeText(type.element, depth + 1);
    return element ? `array<${element}>` : "array";
  }
  if (type.kind === "object" || type.kind === "std") {
    const entries = objectShape(type, depth);
    if (entries) return entries;
  }
  if (type.kind === "instance") return type.symbol.name;
  if (type.kind === "enumValue") return type.symbol.name;
  return M.describeType(type);
}

/** The first `count` paragraphs of a long documentation block (indented code kept). */
function firstParagraphs(text, count) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .filter((p) => p.trim());
  if (paragraphs.length <= count) return paragraphs.join("\n\n");
  return paragraphs.slice(0, count).join("\n\n") + "\n\n…";
}

/** `{ a: string, b: int }` for object-like types; "" when the shape is unknown. */
function objectShape(type, depth) {
  if (depth > 1) return "object";
  const members = M.membersOf(type);
  if (!members.length) return "";
  const shown = members.slice(0, 6).map((m) => {
    const memberType = M.memberType(type, m);
    const text =
      m.kind === "function" || m.kind === "method" ? "func" : typeText(memberType, depth + 1);
    return text ? `${m.name}: ${text}` : m.name;
  });
  return `{ ${shown.join(", ")}${members.length > shown.length ? ", …" : ""} }`;
}

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
/** `private ` / `static ` on a struct member (MyLang2 2.2), as it is written. */
function memberModifiers(sym) {
  const mods = sym.mods || {};
  return (mods.private ? "private " : "") + (mods.static ? "static " : "");
}

function symbolSignature(sym) {
  switch (sym.kind) {
    case "function":
    case "method":
      return `${memberModifiers(sym)}func ${sym.name}(${formatParams(sym.params || [])})`;
    case "struct":
      return `struct ${sym.name}`;
    case "enum":
      return `enum ${sym.name}`;
    case "enumMember":
      return `${sym.parent ? sym.parent.name + "." : ""}${sym.name}`;
    case "parameter":
      return `(parameter) ${sym.name}`;
    case "field":
      return `${memberModifiers(sym)}${sym.parent ? sym.parent.name + "." : ""}${sym.name}  (field)`;
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
  const d = typeText(type);
  return d ? `_${d}_` : "";
}

/** Hover for a user symbol. */
function renderSymbol(sym) {
  const parts = [fence(symbolSignature(sym))];
  const hasValueType = ["variable", "parameter", "property", "field", "catch"].includes(sym.kind);
  const t = hasValueType ? typeLine(sym.type) : "";
  if (t) parts.push(t);
  if ((sym.kind === "function" || sym.kind === "method") && sym.returnType) {
    parts.push(`_returns_ \`${typeText(sym.returnType)}\``);
  }
  // Keep descriptions and structured @tags together in every Hover surface.
  const documentation = sym.jsdoc ? renderJSDoc(sym.jsdoc) : sym.doc;
  if (documentation) parts.push(documentation);
  // a member named after a protocol symbol explains the protocol it joins (MyLang2 2.3)
  if (sym.symbolKey) {
    const protocol = lang.PROTOCOL_SYMBOLS.find((p) => p.name === sym.symbolKey.protocol);
    parts.push(
      protocol
        ? protocol.doc
        : `\`${sym.symbolKey.source}\` is not a protocol symbol: a bracketed member has to ` +
            "name `symbol.dispose` or `symbol.iterator`.",
    );
  }
  if (sym.kind === "import" && sym.importSource) {
    const lib = lang.LIB_DOCS[sym.name] || lang.LIB_DOCS[sym.importSource];
    if (lib && lib.description) parts.push(lib.description);
    if (sym.type && sym.type.package && sym.type.info) {
      const p = sym.type.info;
      parts.push(
        `**${p.name}**` +
          (p.version ? ` v${p.version}` : "") +
          "  ·  _package_" +
          (p.description ? "\n\n" + p.description : ""),
      );
    }
  }
  if (sym.kind === "struct" && sym.members) {
    const fields = [...sym.members.values()].filter((m) => m.kind === "field").map((m) => m.name);
    const methods = [...sym.members.values()]
      .filter((m) => m.kind === "method")
      .map((m) => m.name + "()");
    if (fields.length) parts.push("**Fields:** " + fields.map((f) => "`" + f + "`").join(", "));
    if (methods.length) parts.push("**Methods:** " + methods.map((f) => "`" + f + "`").join(", "));
    if (sym.symbolMembers && sym.symbolMembers.size) {
      const joined = [...sym.symbolMembers.keys()].map((p) => `\`symbol.${p}\``);
      parts.push(
        "**Protocols:** " +
          joined.join(", ") +
          (sym.symbolMembers.has("dispose") ? " — released by `defer`" : "") +
          (sym.symbolMembers.has("iterator") ? " — walked by `for … in`" : ""),
      );
    }
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
  const isCallable = member.kind === "function" || member.kind === "class";
  const desc = member.desc || {};
  if (curated) {
    // the curated prose stays the body; the generated facts are appended to it
    const extra = [];
    if (isCallable && desc.returns) extra.push(`**Returns:** \`${desc.returns}\``);
    if (desc.suspends) extra.push("⏳ May suspend — usable with `spawn` / `wait`.");
    return [renderDoc(member.path, curated), ...extra].join("\n\n");
  }
  const sig = isCallable
    ? `${member.path}(${formatParams(member.params)})` + (desc.returns ? `: ${desc.returns}` : "")
    : member.path + (desc.type ? `: ${desc.type}` : "");
  const parts = [fence(sig)];
  if (member.doc) parts.push(renderJSDoc(parseJSDoc(member.doc)));
  if (isCallable && desc.returns && !/@returns?\b/.test(member.doc || "")) {
    parts.push(`**Returns:** \`${desc.returns}\``);
  }
  // 2.2 marks which library calls can park the task
  if (desc.suspends) parts.push("⏳ May suspend — usable with `spawn` / `wait`.");
  if (desc.members) {
    const names = Object.keys(desc.members);
    if (names.length)
      parts.push(
        (member.kind === "object" ? "**Members:** " : "**Members of the result:** ") +
          names
            .slice(0, 16)
            .map((n) => "`" + n + "`")
            .join(", ") +
          (names.length > 16 ? ", …" : ""),
      );
  }
  void ownerName;
  return parts.join("\n\n");
}

/**
 * Hover for a module namespace (`import "core:strings"` / `strings`).
 * The `core:` spelling is the one the interpreter recommends, so it is the one shown.
 */
function renderModule(moduleName) {
  const bare = M.stripCoreNamespace(moduleName);
  const mod = M.moduleDescriptor(bare);
  const alias = mod ? mod.alias : bare;
  const parts = [fence(`import "core:${bare}";`)];
  const curated = lang.LIB_DOCS[alias] || lang.LIB_DOCS[bare];

  if (mod && mod.since) parts.push(`_added in MyLang ${mod.since}_`);
  if (curated && curated.description) parts.push(curated.description);
  // the module's own documentation, from the top of library/<module>/index.ts
  if (mod && mod.doc) parts.push(firstParagraphs(renderJSDoc(parseJSDoc(mod.doc)), 2));

  if (mod) {
    const names = Object.keys(mod.members);
    if (names.length)
      parts.push(
        `**${names.length} member${names.length === 1 ? "" : "s"}:** ` +
          names
            .slice(0, 12)
            .map((n) => "`" + n + "`")
            .join(", ") +
          (names.length > 12 ? ", …" : ""),
      );
    if (mod.aliasOf === "process") parts.push("Same object as the predefined global `process`.");
  }
  // an "example" that is only the import line again says nothing
  const example = curated && curated.example ? curated.example.trim() : "";
  if (example && example.replace(/;$/, "") !== `import "core:${bare}"`)
    parts.push("**Example**\n" + fence(example));
  if (bare !== moduleName || !mod) return parts.join("\n\n");
  parts.push(`_The bare form \`import "${bare}"\` keeps working; \`core:\` cannot be shadowed._`);
  return parts.join("\n\n");
}

/** Hover / completion docs of an installed package (`import "Owner:repo"`). */
function renderPackage(source, resolution) {
  const parts = [fence(`import "${source}";`)];
  const r = resolution || { status: "not-installed", pkg: null };
  const pkg = r.pkg;
  if (pkg) {
    parts.push(`**${pkg.name}**` + (pkg.version ? ` v${pkg.version}` : "") + "  ·  _package_");
    if (pkg.description) parts.push(pkg.description);
    const rel = require("path").relative(pkg.root, pkg.main).replace(/\\/g, "/");
    parts.push(`Entry: \`${rel}\``);
  }
  if (r.status === "not-declared")
    parts.push('⚠️ Not listed in `"dependencies"` of `mylang.json`.');
  else if (r.status === "not-installed") parts.push("⚠️ Not installed. Run `mylang install`.");
  else if (r.status === "no-main") parts.push("⚠️ The entry file of the package is missing.");
  return parts.join("\n\n");
}

/**
 * Hover for an import string that is not a built-in module or a package: a `.ml` or
 * `.js` file, a `.json` file, an http(s) URL, or a `core:` name that does not exist.
 */
function renderImport(entry) {
  const parts = [fence(`import "${entry.source}";`)];
  switch (entry.kind) {
    case "core-unknown":
      parts.push(
        `⚠️ \`${entry.module}\` is not a module that ships with the interpreter, and ` +
          "`core:` never resolves to a project dependency.",
      );
      break;
    case "url":
      parts.push("Remote module, fetched and run at import time.");
      break;
    case "json":
      parts.push("JSON file, imported as a value.");
      break;
    case "file":
      parts.push(entry.source.endsWith(".js") ? "Host JavaScript module." : "MyLang source file.");
      break;
    default:
      break;
  }
  if (entry.resolvedPath) parts.push(`Resolves to \`${entry.resolvedPath}\``);
  else if (entry.kind === "file" || entry.kind === "json")
    parts.push("⚠️ The file was not found next to this one.");

  const exported = entry.symbols.map((s) => s.type).find((t) => t && t.members && t.members.size);
  if (exported) {
    const names = [...exported.members.keys()];
    parts.push(
      `**Exports:** ` +
        names
          .slice(0, 12)
          .map((n) => "`" + n + "`")
          .join(", ") +
        (names.length > 12 ? ", …" : ""),
    );
  }
  return parts.join("\n\n");
}

module.exports = {
  renderDoc,
  renderSymbol,
  renderStdMember,
  renderModule,
  renderPackage,
  renderImport,
  symbolSignature,
  typeText,
  fence,
};
