"use strict";
/**
 * Standard-library knowledge and the tiny type system used for member completion.
 *
 * A "type" is a plain object:
 *   {kind:"module",    module}            namespace of a built-in module (e.g. `strings`)
 *   {kind:"std",       desc, path}        std function/class/object described by stdlib.json
 *   {kind:"struct",    symbol}            a struct type (callable -> instance)
 *   {kind:"instance",  symbol}            an instance of a struct
 *   {kind:"enum",      symbol}            an enum type
 *   {kind:"enumValue", symbol}            a value of an enum (symbol = the enum)
 *   {kind:"object",    members, symbol?}  object literal; members: Map<string, Symbol>
 *   {kind:"function",  symbol}            user function
 *   {kind:"file",      path, members?}    user module imported by path
 *   {kind:"primitive", name}              string | number | bool | array | nil
 */

const path = require("path");
const stdlib = require("../data/stdlib.json");
const lang = require("../data/language");

const BUILTIN_MODULES = new Set(Object.keys(stdlib.modules));

/**
 * Mirrors ImportDeclaration.evaluateSinglePackage / evaluateMultiplePackages:
 * which variable name does `import "<source>"` introduce?
 * @returns {{name:string, kind:"builtin"|"file"|"json"|"url"|"package"|"other"}}
 */
function importInfo(source, multi = false) {
  const parsed = path.posix.parse(source.replace(/\\/g, "/"));
  const ext = parsed.ext;

  if (/^https?:\/\//.test(source)) return { name: parsed.name, kind: "url" };
  if (ext === ".json") return { name: parsed.name, kind: "json" };
  if (ext === "" && BUILTIN_MODULES.has(source)) {
    return { name: source.includes("/") ? source.split("/")[1] : source, kind: "builtin" };
  }
  if (ext === ".ml" || ext === ".js") return { name: parsed.name, kind: "file" };
  if (source.split(":")[1]) return { name: source.split(":")[1], kind: "package" };
  if (multi && source.includes("/")) return { name: source.split("/").at(-1), kind: "other" };
  return { name: parsed.name || source, kind: "other" };
}

function moduleDescriptor(name) {
  return stdlib.modules[name] || null;
}

/** Type of a bare built-in module namespace. */
function moduleType(name) {
  const mod = stdlib.modules[name];
  if (mod && mod.aliasOf === "process") return stdType(lang.GLOBALS.process, "process");
  return { kind: "module", module: name };
}

function stdType(desc, p) {
  return { kind: "std", desc, path: p };
}

/** Global implicit objects (`import`, `wait`, `symbol`, `process`, `length`) as types. */
function globalType(name) {
  const desc = lang.GLOBALS[name];
  return desc ? stdType(desc, name) : null;
}

function stdMember(name, desc, ownerPath) {
  return {
    origin: "std",
    name,
    kind: desc.kind || "value",
    params: desc.params,
    doc: desc.doc,
    desc,
    path: ownerPath ? `${ownerPath}.${name}` : name,
  };
}

function symbolMember(sym) {
  return {
    origin: "user",
    name: sym.name,
    kind: sym.kind,
    params: sym.params,
    doc: sym.doc,
    symbol: sym,
  };
}

/** @returns {Array<object>} members of a type (for completion and hover). */
function membersOf(type) {
  if (!type) return [];
  switch (type.kind) {
    case "module": {
      const mod = stdlib.modules[type.module];
      if (!mod) return [];
      return Object.entries(mod.members).map(([n, d]) => stdMember(n, d, mod.alias));
    }
    case "std": {
      const members = type.desc && type.desc.members;
      if (!members) return [];
      return Object.entries(members).map(([n, d]) => stdMember(n, d, type.path));
    }
    case "instance":
      return type.symbol.members ? [...type.symbol.members.values()].map(symbolMember) : [];
    case "enum":
      return type.symbol.members
        ? [...type.symbol.members.values()].filter((m) => m.kind === "enumMember").map(symbolMember)
        : [];
    case "enumValue":
      return type.symbol.members
        ? [...type.symbol.members.values()].filter((m) => m.kind === "method").map(symbolMember)
        : [];
    case "object":
      return type.members ? [...type.members.values()].map(symbolMember) : [];
    case "file":
      return type.members ? [...type.members.values()].map(symbolMember) : [];
    default:
      return [];
  }
}

function memberOf(type, name) {
  if (!type) return null;
  switch (type.kind) {
    case "module": {
      const mod = stdlib.modules[type.module];
      const d =
        mod && Object.prototype.hasOwnProperty.call(mod.members, name) ? mod.members[name] : null;
      return d ? stdMember(name, d, mod.alias) : null;
    }
    case "std": {
      const members = type.desc && type.desc.members;
      const d =
        members && Object.prototype.hasOwnProperty.call(members, name) ? members[name] : null;
      return d ? stdMember(name, d, type.path) : null;
    }
    case "instance":
    case "enumValue": {
      const s = type.symbol.members && type.symbol.members.get(name);
      if (!s) return null;
      if (type.kind === "enumValue" && s.kind !== "method") return null;
      return symbolMember(s);
    }
    case "enum": {
      const s = type.symbol.members && type.symbol.members.get(name);
      return s && s.kind === "enumMember" ? symbolMember(s) : null;
    }
    case "object":
    case "file": {
      const s = type.members && type.members.get(name);
      return s ? symbolMember(s) : null;
    }
    default:
      return null;
  }
}

/** Type of `owner.member`. */
function memberType(owner, member) {
  if (!member) return null;
  if (member.origin === "std") {
    const d = member.desc;
    if (d.kind === "class" || d.kind === "function" || d.kind === "object")
      return stdType(d, member.path);
    return null;
  }
  const s = member.symbol;
  if (s.kind === "enumMember") return { kind: "enumValue", symbol: s.parent };
  if (s.kind === "method" || s.kind === "function") return { kind: "function", symbol: s };
  return s.type || null;
}

/** Type produced by calling a value of type `type`. */
function callResult(type) {
  if (!type) return null;
  switch (type.kind) {
    case "std":
      if (type.desc.kind === "class" && type.desc.members) {
        return stdType(
          { kind: "object", doc: type.desc.doc, members: type.desc.members },
          `${type.path}()`,
        );
      }
      return null;
    case "struct":
      return { kind: "instance", symbol: type.symbol };
    case "function":
      return type.symbol.returnType || null;
    default:
      return null;
  }
}

/** Human-readable name of a type (hover). */
function describeType(type) {
  if (!type) return "";
  switch (type.kind) {
    case "module":
      return `module "${type.module}"`;
    case "std":
      return type.desc.kind === "class" ? "class" : type.desc.kind;
    case "struct":
      return `struct ${type.symbol.name}`;
    case "instance":
      return `${type.symbol.name} (struct instance)`;
    case "enum":
      return `enum ${type.symbol.name}`;
    case "enumValue":
      return `${type.symbol.name} (enum value)`;
    case "object":
      return "object";
    case "function":
      return "func";
    case "file":
      return `module "${type.path}"`;
    case "primitive":
      return type.name;
    default:
      return "";
  }
}

module.exports = {
  BUILTIN_MODULES,
  importInfo,
  moduleDescriptor,
  moduleType,
  stdType,
  globalType,
  membersOf,
  memberOf,
  memberType,
  callResult,
  describeType,
  stdlib,
};
