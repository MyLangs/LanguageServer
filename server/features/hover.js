"use strict";

const lang = require("../data/language");
const M = require("../core/modules");
const { occurrenceAt } = require("../core/analyzer");
const { renderDoc, renderSymbol, renderStdMember, renderModule, fence } = require("./render");
const { formatParams } = require("../core/util");
const { parseJSDoc, parameterDoc, renderJSDoc } = require("../core/jsdoc");

/**
 * Build a Markdown Hover for the occurrence under the cursor.
 * User symbols take priority over keyword and literal documentation.
 */
function hover(doc, offset) {
  const { analysis, lines } = doc;
  const toRange = (s, e) => lines.range(s, e);

  // identifiers / members / declarations
  const occ = occurrenceAt(analysis, offset);
  if (occ) {
    if (occ.kind === "member") {
      const m = occ.member;
      const member = m.ownerType ? M.memberOf(m.ownerType, m.name) : null;
      if (member) {
        const value =
          member.origin === "std" ? renderStdMember(member) : renderSymbol(member.symbol);
        return { contents: { kind: "markdown", value }, range: toRange(occ.start, occ.end) };
      }
      return null;
    }
    const sym = occ.symbol;
    if (sym) {
      let value;
      if (sym.kind === "import" && sym.type && sym.type.kind === "module" && !sym.destructured) {
        value = renderModule(sym.type.module);
      } else {
        value = renderSymbol(sym);
      }
      return { contents: { kind: "markdown", value }, range: toRange(occ.start, occ.end) };
    }
    if (occ.ref && (occ.ref.builtin || occ.ref.keywordGlobal)) {
      const name = occ.ref.name;
      const curated = lang.GLOBAL_DOCS[name];
      if (curated)
        return {
          contents: { kind: "markdown", value: renderDoc(name, curated) },
          range: toRange(occ.start, occ.end),
        };
      const g = lang.GLOBALS[name];
      if (g)
        return {
          contents: {
            kind: "markdown",
            value:
              fence(g.kind === "function" ? `${name}(${formatParams(g.params)})` : name) +
              "\n\n" +
              (g.doc || ""),
          },
          range: toRange(occ.start, occ.end),
        };
    }
  }

  // tokens: keywords, literals, import strings
  const tok = analysis.tokens.find(
    (t) => t.type !== "comment" && offset >= t.start && offset <= t.end && t.type !== "eof",
  );
  if (!tok) return null;

  if (
    tok.type === "keyword" ||
    tok.type === "reflect" ||
    tok.type === "bool" ||
    tok.type === "nil"
  ) {
    const doc2 = lang.KEYWORD_DOCS[tok.value];
    if (doc2)
      return {
        contents: { kind: "markdown", value: renderDoc(tok.value, doc2) },
        range: toRange(tok.start, tok.end),
      };
  }
  if (tok.type === "string") {
    const entry = analysis.imports.find((i) => i.tok.start === tok.start);
    if (entry && entry.builtin) {
      return {
        contents: { kind: "markdown", value: renderModule(entry.source) },
        range: toRange(tok.start, tok.end),
      };
    }
  }
  return null;
}

// ───────────────────────── signature help ─────────────────────────

/** Convert an inferred callable type to a display signature and its JSDoc. */
function signatureFor(type, name) {
  if (!type) return null;
  switch (type.kind) {
    case "function": {
      const s = type.symbol;
      return {
        label: `${s.name === "(anonymous)" ? name || "func" : s.name}(${formatParams(s.params || [])})`,
        params: s.params || [],
        jsdoc: s.jsdoc || parseJSDoc(s.doc),
      };
    }
    case "struct": {
      const init = type.symbol.members && type.symbol.members.get("init");
      const params = init ? init.params || [] : [];
      return {
        label: `${type.symbol.name}(${formatParams(params)})`,
        params,
        jsdoc: init?.jsdoc || type.symbol.jsdoc,
      };
    }
    case "std": {
      if (type.desc.kind !== "function" && type.desc.kind !== "class") return null;
      const params = type.desc.params;
      return {
        label: `${type.path}(${formatParams(params)})`,
        params: params || [],
        jsdoc: parseJSDoc(type.desc.doc || ""),
      };
    }
    default:
      return null;
  }
}

/**
 * Pick the innermost call that contains the cursor. Comma offsets identify
 * which argument is active, including while the user is still typing.
 */
function signatureHelp(doc, offset) {
  const { analysis } = doc;
  let call = null;
  for (const c of analysis.calls) {
    if (offset > c.open && offset <= c.close) {
      if (!call || c.open > call.open) call = c;
    }
  }
  if (!call) return null;
  const sig = signatureFor(call.calleeType, call.calleeName);
  if (!sig) return null;

  const active = call.commas.filter((c) => c < offset).length;
  // Parameter descriptions come from @param rather than the whole function doc.
  const parameters = (sig.params || []).map((param) => {
    const documented = parameterDoc(sig.jsdoc, param.name);
    const parts = [];
    if (documented?.type) parts.push("`" + documented.type + "`");
    if (documented?.description) parts.push(documented.description);
    if (param.default !== undefined) parts.push("Default: `" + param.default + "`");
    else if (documented?.default !== undefined) parts.push("Default: `" + documented.default + "`");

    return {
      label: (param.rest ? "..." : "") + param.name + (param.optional ? "?" : ""),
      documentation: parts.length ? { kind: "markdown", value: parts.join(" — ") } : undefined,
    };
  });
  // compute label offsets so the editor can highlight the active parameter
  const open = sig.label.indexOf("(");
  let cursor = open + 1;
  for (const p of parameters) {
    const at = sig.label.indexOf(p.label, cursor);
    if (at >= 0) {
      p.label = [at, at + p.label.length];
      cursor = at + p.label[1] - p.label[0];
    }
  }
  const last = Math.max(0, parameters.length - 1);
  const rest = (sig.params || []).some((p) => p.rest);
  return {
    signatures: [
      {
        label: sig.label,
        documentation: sig.jsdoc ? { kind: "markdown", value: renderJSDoc(sig.jsdoc) } : undefined,
        parameters,
      },
    ],
    activeSignature: 0,
    activeParameter: rest
      ? Math.min(active, last)
      : Math.min(active, parameters.length ? parameters.length : 0),
  };
}

module.exports = { hover, signatureHelp };
