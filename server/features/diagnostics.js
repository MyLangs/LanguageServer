"use strict";

const { checkSyntax } = require("../core/compiler");

const Severity = { Error: 1, Warning: 2, Information: 3, Hint: 4 };
const SEVERITY_BY_NAME = {
  error: Severity.Error,
  warning: Severity.Warning,
  info: Severity.Information,
  hint: Severity.Hint,
};

function messageFor(issue) {
  const d = issue.data;
  switch (issue.code) {
    case "unresolved":
      return `'${d.name}' is not defined`;
    case "duplicate":
      return d.isImport
        ? `'${d.name}' is already imported`
        : `'${d.name}' has already been declared in this scope`;
    case "const-assign":
      return d.readonly
        ? `Cannot assign to '${d.name}' because it is declared 'as readonly'`
        : `Cannot assign to '${d.name}' because it is declared 'as const'`;
    case "readonly-modify":
      return `Cannot modify the contents of '${d.name}' because it is declared 'as readonly'`;
    case "unknown-module":
      return (
        `Unknown module '${d.source}'` + (d.suggestion ? `. Did you mean '${d.suggestion}'?` : "")
      );
    case "unknown-member":
      return (
        `Module '${d.module}' has no member '${d.name}'` +
        (d.suggestion ? `. Did you mean '${d.suggestion}'?` : "")
      );
    case "unused":
      return d.writeOnly
        ? `'${d.name}' is assigned but never read`
        : d.kind === "import"
          ? `'${d.name}' is imported but never used`
          : `'${d.name}' is declared but never used`;
    default:
      return issue.code;
  }
}

/**
 * Builds the LSP diagnostics of a document.
 * @param {object} doc  {text, lines, analysis}
 * @param {object} settings
 * @param {{workspaceFolders:string[]}} env
 */
function computeDiagnostics(doc, settings, env) {
  const cfg = settings.diagnostics || {};
  if (cfg.enable === false) return { diagnostics: [], syntax: null };
  const out = [];
  const { analysis, lines, text } = doc;

  // 1. syntax errors — authoritative from the real compiler when it can be loaded
  const syntax = checkSyntax(text, analysis.tokens, lines, {
    workspaceFolders: env.workspaceFolders,
    compilerPath: settings.compiler && settings.compiler.path,
  });
  if (syntax) {
    for (const e of syntax) {
      out.push({
        range: lines.range(e.start, e.end),
        severity: Severity.Error,
        source: "mylang",
        code: e.code || "syntax",
        message: e.message,
      });
    }
  } else {
    // fallback without the compiler: lexical problems the tolerant lexer can see
    for (const t of analysis.tokens) {
      if (t.type === "error")
        out.push({
          range: lines.range(t.start, t.end),
          severity: Severity.Error,
          source: "mylang",
          code: "lex",
          message: t.message,
        });
      else if (t.type === "string" && !t.terminated)
        out.push({
          range: lines.range(t.start, t.end),
          severity: Severity.Error,
          source: "mylang",
          code: "unterminated-string",
          message: "Unterminated string literal",
        });
      else if (t.type === "comment" && t.kind === "block" && !t.terminated)
        out.push({
          range: lines.range(t.start, t.end),
          severity: Severity.Error,
          source: "mylang",
          code: "unterminated-comment",
          message: "Unterminated comment",
        });
    }
    const stack = [];
    const pairs = { "{": "}", "(": ")", "[": "]" };
    for (const t of analysis.tokens) {
      if (t.type !== "punct") continue;
      if (pairs[t.value]) stack.push(t);
      else if (t.value === "}" || t.value === ")" || t.value === "]") {
        const open = stack.pop();
        if (!open || pairs[open.value] !== t.value)
          out.push({
            range: lines.range(t.start, t.end),
            severity: Severity.Error,
            source: "mylang",
            code: "bracket",
            message: `Unexpected '${t.value}'`,
          });
      }
    }
    for (const open of stack)
      out.push({
        range: lines.range(open.start, open.end),
        severity: Severity.Error,
        source: "mylang",
        code: "bracket",
        message: `'${open.value}' is never closed`,
      });
  }

  // 2. semantic issues from the analyzer
  const level = (name, dflt) => {
    const v = (cfg[name] || dflt).toLowerCase();
    return v === "off" ? null : SEVERITY_BY_NAME[v] || null;
  };
  const sev = {
    unresolved: level("unresolved", "warning"),
    "unknown-member": level("unknownMembers", "warning"),
    "unknown-module": level("unknownModules", "warning"),
    unused: level("unused", "hint"),
    duplicate: Severity.Error,
    "const-assign": Severity.Error,
    "readonly-modify": Severity.Error,
  };
  for (const issue of analysis.issues) {
    let s = sev[issue.code];
    if (s == null) continue;
    if (issue.code === "duplicate" && issue.data.isImport) s = Severity.Warning;
    // while the code is syntactically broken the resolver output is mostly noise
    if (syntax && syntax.length && (issue.code === "unresolved" || issue.code === "unused"))
      continue;
    const diag = {
      range: lines.range(issue.start, issue.end),
      severity: s,
      source: "mylang",
      code: issue.code,
      message: messageFor(issue),
    };
    if (issue.code === "unused") diag.tags = [1]; // Unnecessary
    const data = {};
    if (issue.data.suggestion) data.suggestion = issue.data.suggestion;
    if (issue.data.name) data.name = issue.data.name;
    if (Object.keys(data).length) diag.data = data;
    out.push(diag);
  }

  const max = Number(cfg.maxProblems) > 0 ? Number(cfg.maxProblems) : 200;
  return { diagnostics: out.slice(0, max), syntax };
}

module.exports = { computeDiagnostics, Severity };
