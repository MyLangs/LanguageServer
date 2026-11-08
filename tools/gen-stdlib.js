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
 *   - doc         (the JSDoc comment before the class or before call())
 *   - members     (keys of the object returned from call(), e.g. http.Server().get)
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
  const m = /\/\*\*[\s\S]*?\*\/\s*$/.exec(before);
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

/** Description + params + returned-object members for a class body. */
function describeBody(body, depth) {
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
  if (params) info.params = params;
  if (depth < 3) {
    const members = returnedMembers(callBody, depth + 1);
    if (members && Object.keys(members).length) info.members = members;
  }
  return info;
}

/** Keys of the last top-level `return { ... }` in a function body. */
function returnedMembers(fnBody, depth) {
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
        Object.assign(member, describeBody(body2, depth));
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
      } else {
        member.kind = "value";
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

function readModuleFiles(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"));
  // index.ts first so its own classes win name clashes
  entries.sort((a, b) =>
    a.name === "index.ts" ? -1 : b.name === "index.ts" ? 1 : a.name.localeCompare(b.name),
  );
  return entries.map((e) => ({
    file: e.name,
    src: fs.readFileSync(path.join(dir, e.name), "utf8"),
  }));
}

function parseExports(indexSrc) {
  let m = /module\.exports\s*=\s*\{/.exec(indexSrc);
  if (m) {
    const open = m.index + m[0].length - 1;
    const body = indexSrc.slice(open + 1, matchClose(indexSrc, open));
    return splitTop(body)
      .map((entry) => {
        const clean = entry.replace(/^(?:\s*\/\/[^\n]*\n)+/, "").trim();
        const em = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(clean);
        if (!em) return null;
        return { name: em[1], value: (em[2] || em[1]).trim() };
      })
      .filter(Boolean);
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
const moduleNames = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const result = { generatedFrom: `${pkg.name}@${pkg.version}`, modules: {} };
let callable = 0;

for (const name of moduleNames) {
  const dir = path.join(root, "library", name);
  const alias = name.includes("/") ? name.split("/")[1] : name;
  const mod = { alias, members: {} };
  result.modules[name] = mod;

  if (!fs.existsSync(path.join(dir, "index.ts"))) continue;
  const files = readModuleFiles(dir);
  const indexSrc = files[0].src;

  if (/module\.exports\s*=\s*process\b/.test(indexSrc)) {
    mod.aliasOf = "process";
    continue;
  }

  for (const { name: key, value } of parseExports(indexSrc)) {
    const member = { kind: "value" };

    if (/^[A-Za-z_$][\w$]*$/.test(value)) {
      const cls = findClass(files, value);
      if (cls) {
        const info = describeBody(cls.body, 0);
        const classDoc = docBefore(cls.src, cls.declStart);
        Object.assign(member, info);
        member.kind = info.members ? "class" : "function";
        if (classDoc && !member.doc) member.doc = classDoc;
      }
    } else if (/^class\b/.test(value)) {
      const open = value.indexOf("{");
      Object.assign(member, describeBody(value.slice(open + 1, matchClose(value, open)), 0));
      member.kind = member.members ? "class" : "function";
    } else if (value.startsWith("{")) {
      member.kind = "object";
      const props = {};
      for (const e of splitTop(value.slice(1, matchClose(value, 0)))) {
        const pm = /^([A-Za-z_$][\w$]*)/.exec(e.trim());
        if (pm) props[pm[1]] = { kind: "value" };
      }
      member.members = props;
    }

    if (member.kind === "function" || member.kind === "class") callable++;
    mod.members[key] = member;
  }
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
      const members = returnedMembers(`return ${src.slice(open, close + 1)}`, 1);
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

fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");
const total = Object.values(result.modules).reduce((n, m) => n + Object.keys(m.members).length, 0);
console.log(
  `stdlib.json: ${Object.keys(result.modules).length} modules, ${total} members (${callable} callable) from ${result.generatedFrom}`,
);
