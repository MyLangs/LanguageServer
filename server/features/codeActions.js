"use strict";

const M = require("../core/modules");
const { visibleSymbols, scopeAt } = require("../core/analyzer");
const { importEdit, aliasIndex } = require("./completion");
const { closest } = require("../core/util");

function rangeEq(a, b) {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

/** Quick fixes for the diagnostics the server produced. */
function codeActions(doc, range, context) {
  const { analysis, lines, text, uri } = doc;
  const actions = [];

  const replace = (title, diag, newText, preferred) => ({
    title,
    kind: "quickfix",
    diagnostics: [diag],
    isPreferred: !!preferred,
    edit: { changes: { [uri]: [{ range: diag.range, newText }] } },
  });

  for (const diag of context.diagnostics || []) {
    if (diag.source !== "mylang") continue;
    const start = lines.offsetAt(diag.range.start);
    const data = diag.data || {};

    switch (diag.code) {
      case "unresolved": {
        const name = data.name || text.slice(start, lines.offsetAt(diag.range.end));
        const mods = aliasIndex().get(name);
        if (mods) {
          for (const m of mods) {
            actions.push({
              title: `Add import "${m}"`,
              kind: "quickfix",
              diagnostics: [diag],
              isPreferred: mods.length === 1,
              edit: { changes: { [uri]: [importEdit(analysis, lines, m)] } },
            });
          }
        } else {
          const names = visibleSymbols(scopeAt(analysis, start)).map((s) => s.name);
          const best = closest(name, names);
          if (best) actions.push(replace(`Change to '${best}'`, diag, best, true));
        }
        break;
      }
      case "unknown-member":
        if (data.suggestion)
          actions.push(replace(`Change to '${data.suggestion}'`, diag, data.suggestion, true));
        break;
      case "unknown-module":
        if (data.suggestion) {
          const imp = analysis.imports.find((i) => i.tok.start <= start && i.tok.end >= start);
          if (imp) {
            const r = lines.range(imp.tok.start + 1, imp.tok.end - (imp.tok.terminated ? 1 : 0));
            actions.push({
              title: `Change to "${data.suggestion}"`,
              kind: "quickfix",
              diagnostics: [diag],
              isPreferred: true,
              edit: { changes: { [uri]: [{ range: r, newText: data.suggestion }] } },
            });
          }
        }
        break;
      case "unused": {
        const imp = analysis.imports.find(
          (i) =>
            i.symbols.length === 1 &&
            !i.symbols[0].destructured &&
            i.symbols[0].nameStart === start &&
            i.kind !== "dynamic",
        );
        const single = analysis.imports.find((i) => i.symbols.some((s) => s.nameStart === start));
        const cand = imp || (single && single.symbols.length === 1 ? single : null);
        if (cand && analysis.imports.filter((i) => i.stmtStart === cand.stmtStart).length === 1) {
          const target = cand;
          let end = target.stmtEnd;
          if (text[end] === "\r") end++;
          if (text[end] === "\n") end++;
          actions.push({
            title: "Remove unused import",
            kind: "quickfix",
            diagnostics: [diag],
            edit: {
              changes: { [uri]: [{ range: lines.range(target.stmtStart, end), newText: "" }] },
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }
  void range;
  void M;
  return actions;
}

module.exports = { codeActions };
