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
 *   {kind:"array",     element}           array; `element` is the type of its items or null
 *   {kind:"primitive", name}              string | int | float | bool | nil | bytes | ...
 */

const path = require("path");
const stdlib = require("../data/stdlib.json");
const lang = require("../data/language");

const BUILTIN_MODULES = new Set(Object.keys(stdlib.modules));

/** The namespace that makes an import unambiguously a built-in: `import "core:fs"`. */
const CORE_NAMESPACE = "core:";

/** `net/http` -> `http`: the variable a built-in binds to when no alias is given. */
function defaultBindingName(moduleName) {
  return moduleName.includes("/") ? moduleName.split("/").at(-1) : moduleName;
}

/** `core:fs` -> `fs`; anything else unchanged. */
function stripCoreNamespace(source) {
  return source.startsWith(CORE_NAMESPACE) ? source.slice(CORE_NAMESPACE.length) : source;
}

/**
 * Mirrors ImportDeclaration.evaluateSinglePackage / evaluateMultiplePackages:
 * which variable name does `import "<source>"` introduce, and what does it resolve to?
 *
 * `core:<name>` is checked first, exactly like the interpreter does, so it is never
 * mistaken for an `Owner:repo` package reference.
 *
 * @returns {{name:string, kind:"builtin"|"core-unknown"|"file"|"json"|"url"|"package"|"other",
 *   module?:string, core?:boolean}}
 */
function importInfo(source, multi = false) {
  if (source.startsWith(CORE_NAMESPACE)) {
    const bare = stripCoreNamespace(source);
    const known = BUILTIN_MODULES.has(bare);
    return {
      name: defaultBindingName(bare) || bare,
      kind: known ? "builtin" : "core-unknown",
      module: bare,
      core: true,
    };
  }

  const parsed = path.posix.parse(source.replace(/\\/g, "/"));
  const ext = parsed.ext;

  if (/^https?:\/\//.test(source)) return { name: parsed.name, kind: "url" };
  if (ext === ".json") return { name: parsed.name, kind: "json" };
  if (ext === "" && BUILTIN_MODULES.has(source)) {
    return { name: defaultBindingName(source), kind: "builtin", module: source };
  }
  if (ext === ".ml" || ext === ".js") return { name: parsed.name, kind: "file" };
  if (source.split(":")[1]) return { name: source.split(":")[1], kind: "package" };
  if (multi && source.includes("/")) return { name: source.split("/").at(-1), kind: "other" };
  return { name: parsed.name || source, kind: "other" };
}

function moduleDescriptor(name) {
  return stdlib.modules[stripCoreNamespace(name)] || null;
}

/** Type of a bare built-in module namespace (`core:` prefix allowed). */
function moduleType(name) {
  const bare = stripCoreNamespace(name);
  const mod = stdlib.modules[bare];
  if (mod && mod.aliasOf === "process" && !Object.keys(mod.members).length)
    return stdType(lang.GLOBALS.process, "process");
  return { kind: "module", module: bare };
}

function stdType(desc, p) {
  return { kind: "std", desc, path: p };
}

/** Global implicit objects (`import`, `wait`, `symbol`, `process`, `length`) as types. */
function globalType(name) {
  // the global `process` is the very object `os/system` exports
  if (name === "process") {
    const mod = stdlib.modules["os/system"];
    if (mod && Object.keys(mod.members).length) return { kind: "module", module: "os/system" };
  }
  const desc = lang.GLOBALS[name];
  if (!desc) return null;
  // a plain value global carries its own type (`arguments` is an array)
  if (desc.kind === "value" && desc.type) return scalarType(desc.type);
  return stdType(desc, name);
}

// ───────────────────────── value types ─────────────────────────

/** Type names stdlib.json uses in `returns` / `type`, as language type names. */
const SCALAR_NAMES = new Set([
  "string",
  "int",
  "float",
  "number",
  "bool",
  "nil",
  "bytes",
  "object",
  "map",
  "set",
  "iterable",
  "bigint",
  "func",
]);

/** `"array"` / `"string"` / ... -> a type object. */
function scalarType(name) {
  if (!name) return null;
  if (name === "array") return { kind: "array", element: null };
  if (SCALAR_NAMES.has(name)) return { kind: "primitive", name };
  return null;
}

const arrayOf = (element) => ({ kind: "array", element: element || null });

/** Virtual members every value of a built-in shape exposes (own properties only). */
const INTRINSIC_MEMBERS = {
  array: { length: { kind: "value", type: "int", doc: "Number of elements." } },
  string: { length: { kind: "value", type: "int", doc: "Number of characters." } },
  bytes: {
    length: { kind: "value", type: "int", doc: "Number of bytes." },
    byteLength: { kind: "value", type: "int", doc: "Number of bytes." },
  },
  map: { size: { kind: "value", type: "int", doc: "Number of entries." } },
  set: { size: { kind: "value", type: "int", doc: "Number of entries." } },
};

/** Intrinsic member table of a type, or null. */
function intrinsicsOf(type) {
  if (!type) return null;
  if (type.kind === "array") return INTRINSIC_MEMBERS.array;
  if (type.kind === "primitive") return INTRINSIC_MEMBERS[type.name] || null;
  return null;
}

/** Type of `value[i]`: the element type of an array, a character of a string. */
function indexType(type) {
  if (!type) return null;
  if (type.kind === "array") return type.element || null;
  if (type.kind === "primitive" && type.name === "string")
    return { kind: "primitive", name: "string" };
  if (type.kind === "primitive" && type.name === "bytes") return { kind: "primitive", name: "int" };
  return null;
}

/**
 * Type of the values produced by `for (var x in value)`.
 * Arrays and strings iterate their elements (ForInStatement uses `symbol.iterator`),
 * plain objects and struct instances iterate their member names.
 */
function iterationType(type) {
  if (!type) return null;
  if (type.kind === "array") return type.element || null;
  if (type.kind === "primitive" && (type.name === "string" || type.name === "object"))
    return { kind: "primitive", name: "string" };
  if (type.kind === "object" || type.kind === "instance" || type.kind === "module")
    return { kind: "primitive", name: "string" };
  return null;
}

/** `true` when two types describe the same shape (used to unify array elements). */
function sameType(a, b) {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "primitive":
      return a.name === b.name;
    case "array":
      return sameType(a.element, b.element);
    case "module":
      return a.module === b.module;
    case "std":
      return a.path === b.path;
    case "struct":
    case "instance":
    case "enum":
    case "enumValue":
    case "function":
      return a.symbol === b.symbol;
    case "object":
      return a.members === b.members;
    case "file":
      return a.path === b.path;
    default:
      return false;
  }
}

/** The common type of several values, or null when they disagree. */
function unifyTypes(types) {
  let result = null;
  for (const type of types) {
    if (!type) return null;
    if (type.kind === "primitive" && type.name === "nil") continue;
    if (!result) result = type;
    else if (!sameType(result, type)) return null;
  }
  return result;
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

/** Intrinsic members (`length`, `size`) presented like standard-library members. */
function intrinsicMember(name, desc, type) {
  return { ...stdMember(name, desc, describeType(type)), intrinsic: true };
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
    default: {
      const intrinsics = intrinsicsOf(type);
      if (!intrinsics) return [];
      return Object.entries(intrinsics).map(([n, d]) => intrinsicMember(n, d, type));
    }
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
    default: {
      const intrinsics = intrinsicsOf(type);
      const d =
        intrinsics && Object.prototype.hasOwnProperty.call(intrinsics, name)
          ? intrinsics[name]
          : null;
      return d ? intrinsicMember(name, d, type) : null;
    }
  }
}

/** Type of `owner.member`. */
function memberType(owner, member) {
  if (!member) return null;
  if (member.origin === "std") {
    const d = member.desc;
    if (d.kind === "class" || d.kind === "function" || d.kind === "object")
      return stdType(d, member.path);
    // value members carry their own type (`closed: bool`, `remotePort: int`)
    return scalarType(d.type);
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
      if ((type.desc.kind === "class" || type.desc.kind === "function") && type.desc.members) {
        return stdType(
          { kind: "object", doc: type.desc.doc, members: type.desc.members },
          `${type.path}()`,
        );
      }
      // the generator records what the library's `call()` body produces
      return scalarType(type.desc.returns);
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
    case "array": {
      const element = describeType(type.element);
      return element ? `array<${element}>` : "array";
    }
    case "primitive":
      return type.name;
    default:
      return "";
  }
}

module.exports = {
  BUILTIN_MODULES,
  CORE_NAMESPACE,
  stripCoreNamespace,
  defaultBindingName,
  importInfo,
  moduleDescriptor,
  moduleType,
  stdType,
  globalType,
  scalarType,
  arrayOf,
  indexType,
  iterationType,
  unifyTypes,
  sameType,
  membersOf,
  memberOf,
  memberType,
  callResult,
  describeType,
  stdlib,
};
