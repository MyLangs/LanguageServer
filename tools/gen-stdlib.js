#!/usr/bin/env node
/**
 * Generates server/data/stdlib.json from the MyLang2 sources.
 *
 *   node tools/gen-stdlib.js <path-to-mylang2-project>
 *
 * Reads the list of built-in modules from src/ast/declaration/ImportDeclaration.ts,
 * then for every module parses `module.exports = { ... }` / `export { ... }` in
 * library/<module>/index.ts and, for each exported class, extracts:
 *   - params      (from `const [a, b = 1, ...rest] = this.args;`)
 *   - paramTypes  (from `this.validateString(str)` / `isTypeArgs(x) !== "int"` guards)
 *   - returns     (value kind the `call()` body produces: array, string, bool, ...)
 *   - doc         (the JSDoc comment before the class or before call())
 *   - members     (keys of the object returned from call(), e.g. http.Server().get)
 *
 * The module itself also carries
 *   - doc         (the file-level JSDoc at the top of library/<module>/index.ts)
 *   - since       (from the `// added in <version>` markers of buildInModule)
 *
 * Re-run it whenever the standard library changes.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || process.env.MYLANG_PROJECT || ".");
const outFile = path.join(__dirname, "..", "server", "data", "stdlib.json");

if (!fs.existsSync(path.join(root, "library"))) {
  console.error(`Not a MyLang2 project (no library/ in ${root})`);
  process.exit(1);
}

// ───────────────────────── tiny TypeScript scanner ─────────────────────────

/** Index just after the string/template/comment starting at i, or i if none. */
function skipLiteral(s, i) {
  const c = s[i];
  if (c === "/" && s[i + 1] === "/") {
    const e = s.indexOf("\n", i);
    return e < 0 ? s.length : e;
  }
  if (c === "/" && s[i + 1] === "*") {
    const e = s.indexOf("*/", i + 2);
    return e < 0 ? s.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== "`") {
      if (s[j] === "\\") j += 2;
      else if (s[j] === "$" && s[j + 1] === "{") j = matchClose(s, j + 1) + 1;
      else j++;
    }
    return j + 1;
  }
  return i;
}

/** Index of the bracket that closes the one at `open`. */
function matchClose(s, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const stack = [];
  for (let i = open; i < s.length; i++) {
    const j = skipLiteral(s, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = s[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === "}" || c === ")" || c === "]") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return s.length - 1;
}

/** Splits `s` at top-level commas (ignores commas inside brackets/strings). */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const j = skipLiteral(s, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = s[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function cleanDoc(raw) {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** JSDoc comment that ends right before `index` (only modifiers/whitespace between). */
function docBefore(src, index) {
  const before = src
    .slice(0, index)
    .replace(/(?:(?:override|public|protected|private|static|abstract|export|async)\s+)+$/, "");
  // `(?:(?!\*\/)[\s\S])*` keeps the match inside a single comment, so the nearest
  // JSDoc block wins instead of everything from the first one in the file
  const m = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.exec(before);
  return m ? cleanDoc(m[0].trim()) : "";
}

function paramFrom(p, i) {
  const rest = p.startsWith("...");
  const [lhs, ...def] = p.replace(/^\.\.\./, "").split(/=(?!=)/);
  let name = lhs
    .replace(/\?$/, "")
    .replace(/:[\s\S]*$/, "")
    .trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) name = `arg${i + 1}`;
  const out = { name };
  if (rest) out.rest = true;
  if (def.length) {
    out.optional = true;
    out.default = def.join("=").trim();
  }
  return out;
}

/** `const [a, b = 1, ...rest] = this.args;` -> [{name, optional?, rest?}] */
function extractParams(body) {
  const m = /const\s*\[([^\]]*?)\]\s*=\s*this\.args\b/.exec(body);
  if (!m) return null;
  return splitTop(m[1]).map(paramFrom);
}

/** Parameters of `(a, b = 2, ...c)` signatures. */
function paramsFromSignature(sig) {
  return splitTop(sig).map(paramFrom);
}

// ───────────────────────── parameter types ─────────────────────────

/**
 * The language-level type each `this.validate<X>(arg)` / `this.assert<X>(arg)` helper of
 * library/ asserts. Names are the ones the language itself uses (`typeof` results), not
 * TypeScript's.
 */
const TYPE_BY_VALIDATOR = {
  Integer: "int",
  Port: "int",
  Binary: "bytes",
  Bool: "bool",
  Boolean: "bool",
  Endian: "string",
  String: "string",
  Number: "int",
  Positive: "int",
  Function: "func",
  Array: "array",
  Object: "object",
  Buffer: "bytes",
  Bytes: "bytes",
  Iterable: "iterable",
  Encoding: "string",
  UUID: "string",
  Path: "string",
  Set: "set",
  Map: "map",
  HexColor: "string",
  RgbValues: "int",
  HslValues: "int",
};

/** `isTypeArgs()` / `typeof` spellings normalised to the language's own type names. */
const TYPE_ALIASES = {
  function: "func",
  boolean: "bool",
  number: "float",
  integer: "int",
};

const normalizeType = (name) => TYPE_ALIASES[name] || name;

/**
 * Types asserted for the destructured `this.args` names inside a `call()` body:
 *   this.validateString(str)            -> str: string
 *   this.validateNumber(count, "count") -> count: int
 *   isTypeArgs(arr) !== "array"         -> arr: array
 * The first assertion for a name wins; later, weaker ones are ignored.
 */
function paramTypesFrom(callBody) {
  const types = new Map();
  const remember = (name, type) => {
    if (name && type && !types.has(name)) types.set(name, type);
  };

  for (const m of callBody.matchAll(
    /this\.(?:validate|assert)([A-Za-z]+)\s*\(\s*([A-Za-z_$][\w$]*)/g,
  )) {
    remember(m[2], TYPE_BY_VALIDATOR[m[1]]);
  }
  for (const m of callBody.matchAll(
    /isTypeArgs\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*[!=]==\s*"([a-z]+)"/g,
  )) {
    remember(m[1], normalizeType(m[2]));
  }
  return types;
}

/** Copies inferred types onto the parameter list produced by `extractParams`. */
function withParamTypes(params, types) {
  if (!params || !types.size) return params;
  for (const param of params) {
    const type = types.get(param.name);
    if (type) param.type = type;
  }
  return params;
}

// ───────────────────────── return kinds ─────────────────────────

/** Top-level `return <expr>;` expressions of a function body (nested bodies skipped). */
function topLevelReturns(fnBody) {
  const out = [];
  let level = 0;
  for (let i = 0; i < fnBody.length; i++) {
    const j = skipLiteral(fnBody, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = fnBody[i];
    if (c === "{" || c === "(" || c === "[") level++;
    else if (c === "}" || c === ")" || c === "]") level--;
    else if (
      level === 0 &&
      c === "r" &&
      fnBody.startsWith("return", i) &&
      !/[\w$]/.test(fnBody[i - 1] || " ") &&
      !/[\w$]/.test(fnBody[i + 6] || " ")
    ) {
      let end = i + 6;
      let depth = 0;
      for (let k = end; k < fnBody.length; k++) {
        const s = skipLiteral(fnBody, k);
        if (s !== k) {
          k = s - 1;
          end = Math.max(end, s);
          continue;
        }
        const ch = fnBody[k];
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") {
          if (depth === 0) break;
          depth--;
        } else if (ch === ";" && depth === 0) break;
        end = k + 1;
      }
      out.push(fnBody.slice(i + 6, end).trim());
      i = end;
    }
  }
  return out;
}

const STRING_CALLS =
  /\.(join|toUpperCase|toLowerCase|trim|trimStart|trimEnd|padStart|padEnd|repeat|replace|replaceAll|toString|charAt|normalize|toISOString|toFixed|toJSON|toLocaleString)\s*\(/;
const ARRAY_CALLS =
  /(\.(split|map|filter|concat|flat|flatMap|sort|reverse|fill)\s*\(|Object\.(keys|values|entries)\s*\(|Array\.(from|of)\s*\()/;
const BOOL_CALLS = /\.(includes|startsWith|endsWith|some|every|has|test|isPrototypeOf)\s*\(/;
const NUMBER_CALLS = /(\.(indexOf|lastIndexOf|charCodeAt|codePointAt|search|compare)\s*\(|Math\.)/;

/** Language type of a single `return` expression, or "" when it cannot be told. */
function kindOfExpression(expr, fnBody) {
  const text = expr.trim();
  if (!text) return "nil";
  if (/^null\b/.test(text) || /^undefined\b/.test(text)) return "nil";
  if (/^(true|false)\b/.test(text) || text.startsWith("!")) return "bool";
  if (/^(===|!==)/.test(text)) return "bool";
  if (/^\[/.test(text)) return "array";
  if (/^["'`]/.test(text)) return "string";
  if (/^\{/.test(text)) return "object";
  if (/^String\s*\(/.test(text)) return "string";
  if (/^(Number|parseInt|parseFloat)\s*\(/.test(text)) return "float";
  if (/^BigInt\s*\(/.test(text)) return "bigint";
  if (/^Boolean\s*\(/.test(text)) return "bool";
  if (/^-?\d/.test(text)) return "float";
  if (/^(toBuffer|Buffer\.(from|alloc|concat))\s*\(/.test(text)) return "bytes";
  if (/\s(===|!==|<=|>=|<|>|&&|\|\|)\s/.test(text) && !/\?/.test(text)) return "bool";
  if (BOOL_CALLS.test(text)) return "bool";
  if (ARRAY_CALLS.test(text)) return "array";
  if (STRING_CALLS.test(text)) return "string";
  if (NUMBER_CALLS.test(text) || /\.(length|size|byteLength)$/.test(text)) return "float";

  // `return result;` where the body declares `const result = []` / `= ""` / `= 0`
  const local = /^[A-Za-z_$][\w$]*$/.exec(text);
  if (local && fnBody) {
    const decl = new RegExp(
      `(?:const|let|var)\\s+${text}\\s*(?::[^=]+)?=\\s*(\\[|""|''|\`\`|\\{|0\\b|new Map|new Set)`,
    ).exec(fnBody);
    if (decl) {
      if (decl[1] === "[") return "array";
      if (decl[1] === "{") return "object";
      if (decl[1] === "new Map") return "map";
      if (decl[1] === "new Set") return "set";
      if (decl[1].startsWith("0")) return "float";
      return "string";
    }
    if (new RegExp(`(?:const|let|var)\\s+${text}\\s*:\\s*(?:any|unknown)?\\[\\]`).test(fnBody))
      return "array";
  }
  return "";
}

/** Value kind a `call()` body returns, when every `return` agrees on it. */
function returnKind(fnBody) {
  const kinds = new Set();
  for (const expr of topLevelReturns(fnBody)) {
    const kind = kindOfExpression(expr, fnBody);
    if (!kind) return "";
    kinds.add(kind);
  }
  if (kinds.size === 0) return "";
  if (kinds.size === 1) return [...kinds][0];
  // `return null` next to a real value only means the value may be missing
  kinds.delete("nil");
  return kinds.size === 1 ? [...kinds][0] : "";
}

/**
 * `name(...)` where `name` is a local helper that produces a class, as in
 * `const number = (size, be, le) => class extends BinaryMethodBuilder { ... }`.
 * Such members are callable from the language, so they are functions, not values.
 */
function isClassFactoryCall(value, enclosingBody) {
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value.trim());
  if (!call || !enclosingBody) return false;
  const name = call[1];
  const arrow = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*class\\b`,
  );
  const fn = new RegExp(
    `function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{[\\s\\S]{0,400}?return\\s+class\\b`,
  );
  return arrow.test(enclosingBody) || fn.test(enclosingBody);
}

// ───────────────────────── README tables ─────────────────────────

/** Cells of a markdown table row, without the outer pipes. */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparatorRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Descriptions from the `| Method | Description |` tables of library/<module>/README.md.
 * A single row may document several spellings of the same thing
 * (`strings.trim(s)` / `trimStart` / `trimEnd`), so every name in the first cell gets it.
 *
 * @returns {Map<string, {doc:string, suspends?:string}>} keyed by member path (`assert.equal`)
 */
function readmeDocs(dir) {
  const found = new Map();
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  } catch {
    return found;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = tableCells(lines[i]);
    const next = i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
    if (!header || !next || !isSeparatorRow(next)) continue;

    const suspendsAt = header.findIndex((h) => /suspend/i.test(h));
    const descriptionAt = header.length - 1;
    i += 2;

    for (; i < lines.length; i++) {
      const cells = tableCells(lines[i]);
      if (!cells) break;
      const description = (cells[descriptionAt] || "").trim();
      if (!description) continue;
      const suspends = suspendsAt > 0 ? (cells[suspendsAt] || "").trim() : "";

      // `strings.split(s, separator)` / `join(parts, separator)` -> split, join
      for (const code of (cells[0] || "").matchAll(/`([^`]+)`/g)) {
        for (const ref of code[1].split("/")) {
          const m = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(\(|$)/.exec(ref);
          if (!m) continue;
          if (!found.has(m[1])) found.set(m[1], { doc: description, suspends });
        }
      }
    }
  }
  return found;
}

/**
 * Applies README descriptions to members that have no JSDoc of their own.
 *
 * A reference in a README is written the way code reads: `strings.split(s, sep)` names
 * a member of the module, `assert.equal(a, b)` a member of its `assert` object, and
 * `server.get(path, handler)` a member of whatever `http.Server()` returned. The
 * receiver decides where to look, so `http.get` never documents `server.get`.
 */
function applyReadmeDocs(mod, docs, alias) {
  /** Walks a dotted path through the generated members. */
  const walk = (parts) => {
    let holder = mod.members;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = holder[parts[i]];
      if (!next || !next.members) return null;
      holder = next.members;
    }
    return holder[parts.at(-1)] || null;
  };

  /** `server.get` -> the `get` member of the result of a class named like `server`. */
  const insideResult = (receiver, name) => {
    for (const [key, member] of Object.entries(mod.members)) {
      if (key.toLowerCase() !== receiver.toLowerCase() || !member.members) continue;
      return member.members[name] || null;
    }
    return null;
  };

  for (const [ref, { doc, suspends }] of docs) {
    const parts = ref.split(".");
    let member = walk(parts);
    if (!member && parts.length > 1) {
      const receiver = parts[0];
      const rest = parts.slice(1);
      // the module's own name, spelled out: `strings.split`, `core:net/http` -> `http.get`
      if (receiver === alias || receiver === mod.alias) member = walk(rest);
      if (!member && rest.length === 1) member = insideResult(receiver, rest[0]);
    }
    if (!member) continue;
    if (!member.doc) member.doc = doc;
    if (suspends && /^yes$/i.test(suspends)) member.suspends = true;
  }
}

/** File-level JSDoc block at the very top of a module's index.ts. */
function moduleDoc(src) {
  const m = /^\s*(?:#![^\n]*\n\s*)?(\/\*\*[\s\S]*?\*\/)/.exec(src);
  return m ? cleanDoc(m[1]) : "";
}

// ───────────────────────── class extraction ─────────────────────────

function findClass(files, name) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?(?:abstract\\s+)?class\\s+${name}\\b[^{]*\\{`,
  );
  for (const f of files) {
    const m = re.exec(f.src);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(f.src, open);
    const declStart = m.index + m[0].search(/\S/);
    return { src: f.src, declStart, body: f.src.slice(open + 1, close) };
  }
  return null;
}

/**
 * Body of a local factory the module uses to build its result object:
 *   `return makeSocket(socket, name);` -> the body of `function makeSocket(...)`.
 * Returns the body text, or "" when there is no such local function.
 */
function factoryBody(expr, files) {
  const call = /^(?:yield\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec((expr || "").trim());
  if (!call || !files) return "";
  const name = call[1];
  const patterns = [
    new RegExp(`function\\s+\\*?${name}\\s*\\([^)]*\\)[^{]*\\{`),
    new RegExp(
      `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?)?\\s*\\([^)]*\\)\\s*(?::[^=>{]+)?(?:=>)?\\s*\\{`,
    ),
  ];
  for (const file of files) {
    for (const re of patterns) {
      const m = re.exec(file.src);
      if (!m) continue;
      const open = m.index + m[0].length - 1;
      return file.src.slice(open + 1, matchClose(file.src, open));
    }
  }
  return "";
}

/**
 * `const <name> = { ... }` declared anywhere in the module's files, as the object
 * literal's text (`os/system` exports such an object, `test.assert` nests one).
 */
function findObjectLiteral(files, name) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*\\{`,
  );
  for (const f of files) {
    const m = re.exec(f.src);
    if (!m) continue;
    const open = f.src.indexOf("{", m.index + m[0].length - 1);
    return {
      src: f.src,
      declStart: m.index + m[0].search(/\S/),
      body: f.src.slice(open, matchClose(f.src, open) + 1),
    };
  }
  return null;
}

/**
 * Member descriptor for any exported value: a class, a local object literal, an inline
 * object, or a plain value. Used for `module.exports` entries and for nested objects.
 */
function describeValue(value, files, depth) {
  const member = { kind: "value" };
  const text = (value || "").trim();

  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const cls = findClass(files, text);
    if (cls) {
      const info = describeBody(cls.body, depth, files);
      const classDoc = docBefore(cls.src, cls.declStart);
      Object.assign(member, info);
      member.kind = info.members ? "class" : "function";
      if (classDoc && !member.doc) member.doc = classDoc;
      return member;
    }
    const obj = depth < 3 ? findObjectLiteral(files, text) : null;
    if (obj) {
      const doc = docBefore(obj.src, obj.declStart);
      member.kind = "object";
      member.members = returnedMembers(`return ${obj.body}`, depth + 1, files) || {};
      if (doc) member.doc = doc;
      return member;
    }
    return member;
  }

  if (/^class\b/.test(text)) {
    const open = text.indexOf("{");
    Object.assign(member, describeBody(text.slice(open + 1, matchClose(text, open)), depth, files));
    member.kind = member.members ? "class" : "function";
    return member;
  }

  if (text.startsWith("{") && depth < 3) {
    member.kind = "object";
    member.members = returnedMembers(`return ${text}`, depth + 1, files) || {};
    return member;
  }

  const kind = kindOfExpression(text, "");
  if (kind) member.type = kind;
  return member;
}

/**
 * Members of a resource built with `createResource({ ..., members: { ... } })`
 * (sockets, streams, workers, child processes). `close` and `closed` are added by
 * `kernel/resource.ts` to every resource, so they are added here too.
 */
function resourceMembers(body, depth, files) {
  const at = /createResource\s*\(\s*\{/.exec(body);
  if (!at) return null;
  const open = body.indexOf("{", at.index + at[0].length - 1);
  const close = matchClose(body, open);
  const options = body.slice(open + 1, close);
  let members = {};
  for (const entry of splitTop(options)) {
    const m = /^members\s*:\s*\{/.exec(entry.trim());
    if (!m) continue;
    const start = entry.indexOf("{", entry.indexOf("members"));
    members =
      returnedMembers(`return ${entry.slice(start, matchClose(entry, start) + 1)}`, depth, files) ||
      {};
    break;
  }
  members.close = members.close || {
    kind: "function",
    doc: "Releases the resource. Safe to call twice; `defer` calls it automatically.",
  };
  members.closed = members.closed || {
    kind: "value",
    type: "bool",
    doc: "`true` once the resource has been released.",
  };
  return members;
}

/** Description + params + returned-object members for a class body. */
function describeBody(body, depth, files) {
  const callRe = /(?:override\s+)?\*?\s*\bcall\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/;
  const cm = callRe.exec(body);
  const info = {};
  if (!cm) return info;
  const open = cm.index + cm[0].length - 1;
  const close = matchClose(body, open);
  const callBody = body.slice(open + 1, close);
  const doc = docBefore(body, cm.index);
  if (doc) info.doc = doc;
  const params = extractParams(callBody);
  if (params) info.params = withParamTypes(params, paramTypesFrom(callBody));
  const returns = returnKind(callBody);
  if (returns) info.returns = returns;
  if (depth < 3) {
    let members = returnedMembers(callBody, depth + 1, files);
    if (!members || !Object.keys(members).length) {
      // `return makeSocket(...)`: the shape lives in a local factory function,
      // and resources describe themselves through `createResource({ members })`
      const last = topLevelReturns(callBody).at(-1);
      const body2 = factoryBody(last, files) || callBody;
      members = returnedMembers(body2, depth + 1, files);
      if (!members || !Object.keys(members).length)
        members = resourceMembers(body2, depth + 1, files);
      if (members && Object.keys(members).length) info.returns = "object";
    }
    if (members && Object.keys(members).length) info.members = members;
  }
  return info;
}

/** Keys of the last top-level `return { ... }` in a function body. */
function returnedMembers(fnBody, depth, files) {
  let last = -1;
  let level = 0;
  for (let i = 0; i < fnBody.length; i++) {
    const j = skipLiteral(fnBody, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const c = fnBody[i];
    if (c === "{" || c === "(" || c === "[") level++;
    else if (c === "}" || c === ")" || c === "]") level--;
    else if (
      level === 0 &&
      c === "r" &&
      fnBody.startsWith("return", i) &&
      /^return\s*\{/.test(fnBody.slice(i, i + 24)) &&
      !/\w/.test(fnBody[i - 1] || " ")
    ) {
      last = i;
    }
  }
  if (last < 0) return null;
  const open = fnBody.indexOf("{", last);
  const close = matchClose(fnBody, open);
  // TypeScript generics contain commas that would split entries
  const objBody = fnBody.slice(open + 1, close).replace(/\bas\s+Record<[^>]*>/g, "");
  const members = {};

  for (const rawEntry of splitTop(objBody)) {
    // strip leading line comments, remember a leading JSDoc
    let entry = rawEntry.trim();
    let doc = "";
    for (;;) {
      if (entry.startsWith("//")) {
        const nl = entry.indexOf("\n");
        entry = nl < 0 ? "" : entry.slice(nl + 1).trim();
      } else if (entry.startsWith("/**")) {
        const end = entry.indexOf("*/");
        doc = cleanDoc(entry.slice(0, end + 2));
        entry = entry.slice(end + 2).trim();
      } else if (entry.startsWith("/*")) {
        entry = entry.slice(entry.indexOf("*/") + 2).trim();
      } else break;
    }
    if (entry.startsWith("[")) continue; // computed keys such as [Environment.SymbolX]
    const em = /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(entry);
    if (!em) continue;
    const key = em[1];
    if (key.startsWith("__")) continue; // protected by the language
    const rest = em[2].trim();
    const member = {};
    if (doc) member.doc = doc;

    if (rest.startsWith(":")) {
      const val = rest.slice(1).trim();
      if (/^class\b/.test(val)) {
        const open2 = val.indexOf("{");
        const body2 = val.slice(open2 + 1, matchClose(val, open2));
        Object.assign(member, describeBody(body2, depth, files));
        member.kind = member.members ? "class" : "function";
      } else if (
        /^(async\s*)?\(/.test(val) ||
        /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(val) ||
        /^function\b/.test(val)
      ) {
        const pm = /\(([^)]*)\)/.exec(val);
        member.kind = "function";
        if (pm) member.params = paramsFromSignature(pm[1]);
      } else if (/\.bind\(|=>/.test(val)) {
        member.kind = "function";
      } else if (isClassFactoryCall(val, fnBody)) {
        // `u16: number(2, "readUInt16BE", "readUInt16LE")` where `number` builds a class
        member.kind = "function";
      } else if (/^[A-Za-z_$][\w$]*$/.test(val) && depth < 3) {
        // `fail: Fail`, `assert: assertions` - a class or object declared elsewhere
        const described = describeValue(val, files, depth);
        Object.assign(member, described, doc ? { doc } : {});
      } else {
        member.kind = "value";
        const kind = kindOfExpression(val, fnBody);
        if (kind) member.type = kind;
      }
    } else if (rest.startsWith("(")) {
      member.kind = "function";
      member.params = paramsFromSignature(rest.slice(1, matchClose(rest, 0)));
    } else {
      member.kind = "value";
    }
    members[key] = member;
  }
  return members;
}

// ───────────────────────── module scan ─────────────────────────

/** The .ts file a relative import names, as a path, or "" if there is none. */
function resolveImport(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return "";
}

function readModuleFiles(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"));
  // index.ts first so its own classes win name clashes
  entries.sort((a, b) =>
    a.name === "index.ts" ? -1 : b.name === "index.ts" ? 1 : a.name.localeCompare(b.name),
  );
  const files = entries.map((e) => ({
    file: e.name,
    src: fs.readFileSync(path.join(dir, e.name), "utf8"),
  }));

  // Files the module imports from elsewhere in the library, one level out. `tcp`, `tls`,
  // `udp` and `ws` build their socket in `net/socket`, so without this the object their
  // functions hand back would have no members at all.
  const seen = new Set(files.map((f) => path.join(dir, f.file)));
  for (const { src } of [...files]) {
    for (const m of src.matchAll(/\bfrom\s+"(\.[^"]+)"/g)) {
      const file = resolveImport(dir, m[1]);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      files.push({ file: path.relative(dir, file), src: fs.readFileSync(file, "utf8") });
    }
  }
  return files;
}

/**
 * A spread inside `module.exports`, expanded to the entries it contributes:
 *
 *   ...Object.fromEntries(Object.entries(producers).map(([n, B]) => [n, wrap(B)]))
 *   ...producers
 *
 * Both name a `const producers = { red: Red, ... }` elsewhere in the module, and both
 * export one entry per key of it. `utils/colors` builds its colour functions this way
 * since 2.3.0, so without this every one of them would be missing from the data.
 */
function expandSpread(entry, files) {
  const inner =
    /^\.\.\.\s*(?:Object\.fromEntries\s*\(\s*Object\.entries\s*\(\s*)?([A-Za-z_$][\w$]*)/.exec(
      entry,
    );
  if (!inner) return [];
  const obj = findObjectLiteral(files, inner[1]);
  if (!obj) return [];
  return splitTop(obj.body.slice(1, -1))
    .map((item) => {
      const clean = item.replace(/^(?:\s*\/\/[^\n]*\n)+/, "").trim();
      const em = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(clean);
      if (!em) return null;
      return { name: em[1], value: (em[2] || em[1]).trim() };
    })
    .filter(Boolean);
}

function parseExports(indexSrc, files = [{ src: indexSrc }]) {
  let m = /module\.exports\s*=\s*\{/.exec(indexSrc);
  if (m) {
    const open = m.index + m[0].length - 1;
    const body = indexSrc.slice(open + 1, matchClose(indexSrc, open));
    const out = [];
    for (const entry of splitTop(body)) {
      const clean = entry.replace(/^(?:\s*\/\/[^\n]*\n)+/, "").trim();
      if (clean.startsWith("...")) {
        out.push(...expandSpread(clean, files));
        continue;
      }
      const em = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(clean);
      if (em) out.push({ name: em[1], value: (em[2] || em[1]).trim() });
    }
    return out;
  }
  m = /export\s*\{([^}]*)\}/.exec(indexSrc);
  if (m) return splitTop(m[1]).map((n) => ({ name: n.trim(), value: n.trim() }));
  return [];
}

const importSrc = fs.readFileSync(
  path.join(root, "src/ast/declaration/ImportDeclaration.ts"),
  "utf8",
);
const listMatch = /const buildInModule\s*=\s*\[([\s\S]*?)\]/.exec(importSrc);
if (!listMatch) {
  console.error("Could not find `buildInModule` in ImportDeclaration.ts");
  process.exit(1);
}
/**
 * Module names in declaration order, each with the `// added in <version>` marker that
 * precedes it in the list (the marker applies to every entry below it).
 */
function moduleEntries(listBody) {
  const entries = [];
  let since = "";
  for (const line of listBody.split("\n")) {
    const marker = /\/\/\s*added in\s*([\w.]+)/i.exec(line);
    if (marker) {
      since = marker[1];
      continue;
    }
    const name = /"([^"]+)"/.exec(line);
    if (name) entries.push({ name: name[1], since });
  }
  return entries;
}

const moduleList = moduleEntries(listMatch[1]);
const moduleNames = moduleList.map((e) => e.name);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const result = { generatedFrom: `${pkg.name}@${pkg.version}`, modules: {} };
let callable = 0;

for (const { name, since } of moduleList) {
  const dir = path.join(root, "library", name);
  const alias = name.includes("/") ? name.split("/")[1] : name;
  const mod = { alias, members: {} };
  if (since) mod.since = since;
  result.modules[name] = mod;

  if (!fs.existsSync(path.join(dir, "index.ts"))) continue;
  const files = readModuleFiles(dir);
  const indexSrc = files[0].src;

  const fileDoc = moduleDoc(indexSrc);
  if (fileDoc) mod.doc = fileDoc;

  // `os/system` re-exports the object the global `process` also refers to
  const reExport = /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(indexSrc);
  if (reExport && !/module\.exports\s*=\s*\{/.test(indexSrc)) {
    if (reExport[1] === "process") mod.aliasOf = "process";
    const described = describeValue(reExport[1], files, 0);
    if (described.members) {
      mod.members = described.members;
      for (const m of Object.values(mod.members))
        if (m.kind === "function" || m.kind === "class") callable++;
    }
    continue;
  }

  for (const { name: key, value } of parseExports(indexSrc, files)) {
    const member = describeValue(value, files, 0);
    if (member.kind === "function" || member.kind === "class") callable++;
    mod.members[key] = member;
  }

  // the module's README documents what the sources leave to prose
  applyReadmeDocs(mod, readmeDocs(dir), alias);
}

// ── request context of http route handlers (`server.get("/", func(ctx) { ... })`) ──
try {
  const serverFile = path.join(root, "library", "net", "http", "Server.ts");
  const src = fs.readFileSync(serverFile, "utf8");
  const at = src.indexOf("const ctx: RequestContext = {");
  if (at > 0) {
    const open = src.indexOf("{", at + "const ctx: RequestContext =".length);
    if (open >= 0) {
      const close = matchClose(src, open);
      const members = returnedMembers(`return ${src.slice(open, close + 1)}`, 1, [{ src }]);
      if (members && Object.keys(members).length) {
        result.modules["net/http"].types = {
          Context: { kind: "object", doc: "Request context passed to route handlers.", members },
        };
      }
    }
  }
} catch (err) {
  console.warn(`http context not extracted: ${err.message}`);
}

// `process` is also a predefined global, so the module list must stay in sync with it
if (result.modules.process && result.modules["os/system"]) {
  result.modules.process.alsoGlobal = true;
}

fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
const total = Object.values(result.modules).reduce((n, m) => n + Object.keys(m.members).length, 0);
console.log(
  `stdlib.json: ${Object.keys(result.modules).length} modules, ${total} members (${callable} callable) from ${result.generatedFrom}`,
);
