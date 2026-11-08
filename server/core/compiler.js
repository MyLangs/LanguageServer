"use strict";
/**
 * Bridge to the real MyLang2 compiler front end (Lexer + Parser).
 *
 * The language server uses it only to obtain authoritative syntax errors; every other
 * feature works with the built-in tolerant analyzer, so the server is fully usable even
 * when no compiler can be found.
 *
 * Lookup order for the compiler package:
 *   1. the `mylang.compiler.path` setting (package folder, or .../dist/src/index.js)
 *   2. <workspace>/dist/src/index.js            (the language repository itself)
 *   3. <workspace>/node_modules/mylang2
 *   4. <workspace>/node_modules/mylang          (older package name)
 *   5. `mylang2` resolvable from the extension
 */

const fs = require("fs");
const path = require("path");

let loaded = null; // { Lexer, Parser, source }
let loadedKey = null;
let lastError = null;

function candidates(workspaceFolders, configured) {
  const list = [];
  if (configured) {
    list.push(configured);
    list.push(path.join(configured, "dist", "src", "index.js"));
  }
  for (const folder of workspaceFolders) {
    list.push(path.join(folder, "dist", "src", "index.js"));
    list.push(path.join(folder, "node_modules", "mylang2"));
    list.push(path.join(folder, "node_modules", "mylang"));
  }
  list.push("mylang2");
  return list;
}

/**
 * @returns {{Lexer: Function, Parser: Function, source: string} | null}
 */
function loadCompiler(workspaceFolders = [], configured = "") {
  const key = JSON.stringify([workspaceFolders, configured]);
  if (loadedKey === key) return loaded;
  loadedKey = key;
  loaded = null;
  lastError = null;

  for (const candidate of candidates(workspaceFolders, configured)) {
    try {
      const abs = path.isAbsolute(candidate) ? candidate : null;
      if (abs && !fs.existsSync(abs)) continue;
      const mod = require(
        abs || require.resolve(candidate, { paths: [__dirname, ...workspaceFolders] }),
      );
      const Lexer = mod.Lexer;
      const Parser = mod.Parser;
      if (typeof Lexer === "function" && typeof Parser === "function") {
        loaded = { Lexer, Parser, source: candidate };
        return loaded;
      }
    } catch (err) {
      lastError = `${candidate}: ${err && err.message}`;
    }
  }
  return null;
}

function compilerStatus() {
  if (loaded) return { available: true, source: loaded.source };
  return { available: false, error: lastError };
}

/** Runs `fn` with stdout writes redirected to stderr (stdout carries the LSP stream). */
function withQuietStdout(fn) {
  const origWrite = process.stdout.write;
  const consoleMethods = ["log", "info", "debug", "table", "dir"];
  const saved = {};
  process.stdout.write = (...args) => process.stderr.write(...args);
  for (const m of consoleMethods) {
    saved[m] = console[m];
    console[m] = (...args) => console.error(...args);
  }
  try {
    return fn();
  } finally {
    process.stdout.write = origWrite;
    for (const m of consoleMethods) console[m] = saved[m];
  }
}

/**
 * Finds the offset the compiler means with a 1-based (line, column).
 * The compiler reports the END column for identifiers/numbers/strings and the START
 * column for operators and punctuation, so tokens are matched accordingly.
 */
function locate(tokens, lines, line, column) {
  const lineIdx = Math.max(0, line - 1);
  const offset = lines.offsetAt({ line: lineIdx, character: Math.max(0, column - 1) });
  const real = tokens.filter((t) => t.type !== "comment" && t.type !== "eof");
  const endsHere = real.find(
    (t) =>
      t.end === offset &&
      (t.type === "ident" ||
        t.type === "number" ||
        t.type === "string" ||
        t.type === "keyword" ||
        t.type === "bool" ||
        t.type === "nil" ||
        t.type === "reflect"),
  );
  if (endsHere) return { start: endsHere.start, end: endsHere.end };
  const startsHere = real.find((t) => t.start === offset);
  if (startsHere) return { start: startsHere.start, end: startsHere.end };
  const containing = real.find((t) => t.start < offset && t.end > offset);
  if (containing) return { start: containing.start, end: containing.end };
  const last = real.filter((t) => t.end <= offset).pop();
  if (last && column <= 1 && line > 1) return { start: last.start, end: last.end };
  return { start: offset, end: Math.min(offset + 1, lines.text.length) };
}

/**
 * Runs the real lexer and parser.
 * @returns {{start:number,end:number,message:string,code?:string,name?:string}[] | null}
 *          null when no compiler is available
 */
function checkSyntax(text, tokens, lines, ctx) {
  const compiler = loadCompiler(ctx.workspaceFolders, ctx.compilerPath);
  if (!compiler) return null;

  const errors = [];
  const fromError = (err) => {
    const line = Number(err.line);
    const column = Number(err.column);
    let message = String(err.message || err);
    let range;
    if (line > 0) range = locate(tokens, lines, line, column || 1);
    else {
      const m = /(\d+):(\d+)/.exec(message);
      range = m
        ? locate(tokens, lines, Number(m[1]), Number(m[2]))
        : { start: 0, end: Math.min(1, text.length) };
    }
    // the position is already shown by the editor
    message = message.replace(/\s+(?:at|from)\s+(?:position\s+)?\d+:\d+\s*$/, "");
    errors.push({ ...range, message, code: err.code, name: err.name });
  };

  withQuietStdout(() => {
    let lexed;
    try {
      lexed = new compiler.Lexer(text).analyze();
    } catch (err) {
      fromError(err);
      return;
    }
    if (lexed.errors && lexed.errors.length) {
      for (const e of lexed.errors) fromError(e);
      return; // the parser cannot run on a broken token stream
    }
    try {
      new compiler.Parser(lexed.tokens).parse();
    } catch (err) {
      fromError(err);
    }
  });
  return errors;
}

module.exports = { loadCompiler, compilerStatus, checkSyntax, locate };
