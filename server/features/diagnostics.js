"use strict";

const { checkSyntax } = require("../core/compiler");
const { closest } = require("../core/util");

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
    case "unknown-core-module":
      return (
        `'core:' names a built-in module, and '${d.name}' is not one` +
        (d.suggestion ? `. Did you mean 'core:${d.suggestion}'?` : "")
      );
    case "unknown-member":
      return (
        `Module '${d.module}' has no member '${d.name}'` +
        (d.suggestion ? `. Did you mean '${d.suggestion}'?` : "")
      );
    case "duplicate-modifier":
      return `Duplicate '${d.modifier}' modifier`;
    case "enum-member-assign":
      return `Cannot assign to '${d.owner ? d.owner + "." : ""}${d.name}' because an enum member is a constant`;
    case "symbol-member-modifier":
      return (
        `A symbol member cannot be '${d.modifier}'. ` +
        (d.modifier === "private"
          ? "A symbol is not a name 'private' could hide"
          : "A protocol belongs to the instance, not to the type")
      );
    case "symbol-member-field":
      return `'[${d.source}]' must be a method, not a field: write 'func [${d.source}]() { … }'`;
    case "symbol-member-unknown":
      return (
        `'${d.source}' is not a protocol symbol. ` +
        "A bracketed member has to name 'symbol.dispose' or 'symbol.iterator'"
      );
    case "symbol-member-duplicate":
      return `'symbol.${d.protocol}' is already declared in this struct`;
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

/** `@deprecated` text of a member, whether it comes from user code or the stdlib. */
function deprecationOf(member) {
  if (!member) return null;
  if (member.origin === "user") {
    const note = member.symbol && member.symbol.jsdoc && member.symbol.jsdoc.deprecated;
    return note == null ? null : note;
  }
  const doc = member.doc || "";
  const match = /@deprecated\s*([^\n]*)/.exec(doc);
  return match ? match[1].trim() || "This API is deprecated." : null;
}

function packageMessage(source, r) {
  switch (r.status) {
    case "not-declared":
      return `Package '${source}' is not listed in "dependencies" of mylang.json`;
    case "not-installed":
      return `Package '${source}' is not installed. Run 'mylang install'`;
    case "no-main":
      return `Package '${source}' has no entry file '${require("path").basename(r.pkg.main)}'`;
    default:
      return source;
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
    "unknown-core-module": level("unknownModules", "warning"),
    unused: level("unused", "hint"),
    duplicate: Severity.Error,
    "const-assign": Severity.Error,
    "readonly-modify": Severity.Error,
    "enum-member-assign": Severity.Error,
    "duplicate-modifier": Severity.Error,
    // every one of these is refused by the parser or at instantiation (MyLang2 2.3)
    "symbol-member-modifier": Severity.Error,
    "symbol-member-field": Severity.Error,
    "symbol-member-unknown": Severity.Error,
    "symbol-member-duplicate": Severity.Error,
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

  // 3. imports resolved against the file system: packages, files, JSON, and the names
  //    a destructuring import takes out of them
  const moduleSeverity = level("unknownModules", "warning");
  const memberSeverity = level("unknownMembers", "warning");
  if (!(syntax && syntax.length)) {
    for (const imp of analysis.imports) {
      if (moduleSeverity != null && imp.kind === "package") {
        const r = imp.resolution;
        if (r && r.status !== "ok")
          out.push({
            range: lines.range(imp.tok.start, imp.tok.end),
            severity: moduleSeverity,
            source: "mylang",
            code: `package-${r.status}`,
            message: packageMessage(imp.source, r),
          });
      }

      // `import "./helpers.ml"` / `import "./data.json"` that points at nothing
      if (
        moduleSeverity != null &&
        imp.lookedUp &&
        !imp.resolvedPath &&
        (imp.kind === "file" || imp.kind === "json")
      ) {
        out.push({
          range: lines.range(imp.tok.start, imp.tok.end),
          severity: moduleSeverity,
          source: "mylang",
          code: "module-not-found",
          message: `Cannot find '${imp.source}' relative to this file`,
        });
      }

      // `import "./math.ml" as { add }` - is `add` really exported?
      if (memberSeverity != null && imp.destructured && imp.members && imp.members.size) {
        const available = [...imp.members.keys()];
        for (const name of imp.destructured) {
          if (imp.members.has(name.name)) continue;
          const suggestion = closest(name.name, available);
          out.push({
            range: lines.range(name.start, name.end),
            severity: memberSeverity,
            source: "mylang",
            code: "import-member-missing",
            message:
              `'${imp.source}' does not export '${name.name}'` +
              (suggestion ? `. Did you mean '${suggestion}'?` : ""),
            data: suggestion ? { suggestion, name: name.name } : undefined,
          });
        }
      }
    }
  }

  // 4. uses of APIs marked `@deprecated`, in user code and in the standard library
  const deprecatedSeverity = level("deprecated", "warning");
  if (deprecatedSeverity != null) {
    const report = (ref, note) =>
      out.push({
        range: lines.range(ref.start, ref.end),
        severity: deprecatedSeverity,
        source: "mylang",
        code: "deprecated",
        message: `'${ref.name}' is deprecated. ${note}`.trim(),
        tags: [2], // LSP DiagnosticTag.Deprecated
      });

    for (const ref of analysis.memberRefs) {
      const note = deprecationOf(ref.member);
      if (note) report(ref, note);
    }
    for (const ref of analysis.refs) {
      if (ref.exported || !ref.symbol) continue;
      const note = ref.symbol.jsdoc && ref.symbol.jsdoc.deprecated;
      if (note != null) report(ref, note);
    }
  }

  const max = Number(cfg.maxProblems) > 0 ? Number(cfg.maxProblems) : 200;
  return { diagnostics: out.slice(0, max), syntax };
}

module.exports = { computeDiagnostics, Severity };
