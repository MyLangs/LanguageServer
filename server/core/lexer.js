"use strict";
/**
 * Error-tolerant tokenizer used by the language server.
 *
 * It mirrors the lexical rules of the MyLang2 lexer (src/lexer/Lexer.ts) but, unlike
 * the compiler's lexer, it never stops at the first error and every token carries an
 * exact [start, end) offset range. That is what editor features (completion on half
 * written code, semantic highlighting, rename ...) need. Authoritative syntax errors
 * still come from the real compiler (see compiler.js).
 */

const KEYWORDS = new Set([
  "var",
  "as",
  "const",
  "readonly",
  "lazy",
  "func",
  "return",
  "import",
  "export",
  "if",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "wait",
  "spawn",
  "enum",
  "throw",
  "match",
  "case",
  "default",
  "defer",
  "struct",
]);
const REFLECT = new Set(["typeof", "in"]);

// Longest operators first (taken from OperatorType in src/lexer/token/TokenType.ts).
const OPERATORS = [
  ">>>=",
  "...",
  "**=",
  "&&=",
  "||=",
  "<<=",
  ">>=",
  ">>>",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "==",
  "!=",
  ">=",
  "<=",
  "&&",
  "||",
  "<<",
  ">>",
  "**",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "^",
  "~",
  ">",
  "<",
  "&",
  "|",
  "?",
  "!",
];
const PUNCT = new Set(["{", "}", "[", "]", "(", ")", ",", ".", ";", ":"]);

/**
 * @typedef {Object} Token
 * @property {string} type  keyword|reflect|ident|number|string|bool|nil|op|punct|comment|error|eof
 * @property {string} value raw source text of the token
 * @property {number} start offset (inclusive)
 * @property {number} end   offset (exclusive)
 * @property {string=} kind   strings: "single" | "triple" | "interp"; comments: "line" | "block"
 * @property {boolean=} terminated strings/block comments: whether the closing delimiter exists
 * @property {{start:number,end:number}[]=} exprs interpolated strings: ranges of `{expr}` bodies
 * @property {string=} message error tokens: description
 */

/**
 * @param {string} text
 * @returns {Token[]} tokens, always terminated by an `eof` token (comments included)
 */
function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;

  const push = (type, start, end, extra) => {
    const t = { type, value: text.slice(start, end), start, end };
    if (extra) Object.assign(t, extra);
    tokens.push(t);
    return t;
  };

  while (i < n) {
    const c = text[i];

    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || /\s/.test(c)) {
      i++;
      continue;
    }

    // comments
    if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < n && text[j] !== "\n") j++;
      push("comment", i, j, { kind: "line", terminated: true });
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      push("comment", i, end, { kind: "block", terminated: e >= 0 });
      i = end;
      continue;
    }

    // strings:  "..."  '...'  """..."""  $"...{expr}..."
    if (c === '"' || c === "'" || (c === "$" && text[i + 1] === '"')) {
      i = readString(text, i, tokens);
      continue;
    }

    // numbers
    if (c >= "0" && c <= "9") {
      const m =
        /^(?:0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?)/.exec(
          text.slice(i, i + 80),
        );
      const len = m ? m[0].length : 1;
      push("number", i, i + len);
      i += len;
      continue;
    }

    // identifiers / keywords
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) j++;
        else break;
      }
      const word = text.slice(i, j);
      let type = "ident";
      if (word === "nil") type = "nil";
      else if (word === "true" || word === "false") type = "bool";
      else if (KEYWORDS.has(word)) type = "keyword";
      else if (REFLECT.has(word)) type = "reflect";
      push(type, i, j);
      i = j;
      continue;
    }

    // operators (longest match)
    let matched = null;
    for (const op of OPERATORS) {
      if (text.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      push("op", i, i + matched.length);
      i += matched.length;
      continue;
    }

    if (PUNCT.has(c)) {
      push("punct", i, i + 1);
      i++;
      continue;
    }

    push("error", i, i + 1, { message: "Invalid or unexpected token" });
    i++;
  }

  push("eof", n, n);
  return tokens;
}

/** Reads a string literal starting at `i`; pushes the token and returns the new offset. */
function readString(text, i, tokens) {
  const n = text.length;
  const start = i;

  const finish = (end, kind, terminated, exprs) => {
    const tok = { type: "string", value: text.slice(start, end), start, end, kind, terminated };
    if (exprs) tok.exprs = exprs;
    tokens.push(tok);
    return end;
  };

  // interpolated string
  if (text[i] === "$") {
    let j = i + 2;
    const exprs = [];
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === '"') return finish(j + 1, "interp", true, exprs);
      if (ch === "{") {
        const bodyStart = j + 1;
        let depth = 1;
        let k = bodyStart;
        while (k < n && depth > 0) {
          const d = text[k];
          if (d === '"' || d === "'") {
            // nested string inside the expression
            k++;
            while (k < n && text[k] !== d && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
            k++;
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          if (depth > 0) k++;
        }
        exprs.push({ start: bodyStart, end: Math.min(k, n) });
        j = k + 1;
        continue;
      }
      j++;
    }
    return finish(n, "interp", false, exprs);
  }

  const quote = text[i];

  // triple-quoted block  """ ... """
  if (quote === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
    let j = i + 3;
    while (j < n) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === '"' && text[j + 1] === '"' && text[j + 2] === '"') {
        return finish(j + 3, "triple", true);
      }
      j++;
    }
    return finish(n, "triple", false);
  }

  // normal single-line string
  let j = i + 1;
  while (j < n) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) return finish(j + 1, "single", true);
    if (ch === "\n") return finish(j, "single", false); // unterminated: stops at EOL
    j++;
  }
  return finish(Math.min(j, n), "single", false);
}

/** Decodes the text of a string token (best effort, used for import paths). */
function stringValue(tok) {
  if (tok.type !== "string") return "";
  const raw = tok.value;
  let body;
  if (tok.kind === "triple") body = raw.slice(3, tok.terminated ? -3 : undefined);
  else if (tok.kind === "interp") body = raw.slice(2, tok.terminated ? -1 : undefined);
  else body = raw.slice(1, tok.terminated ? -1 : undefined);
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, g) => {
    if (g[0] === "u" && g.length === 5) return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g[0] === "x" && g.length === 3) return String.fromCharCode(parseInt(g.slice(1), 16));
    const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    return g in map ? map[g] : g;
  });
}

module.exports = { tokenize, stringValue, KEYWORDS, REFLECT, OPERATORS };
