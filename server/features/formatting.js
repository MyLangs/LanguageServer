"use strict";
/**
 * Document and range formatting, run through the language's own formatter
 * (`mylang prettier`, MyLang2 2.3) so the editor and the command line always agree.
 *
 * A document is always formatted whole — indentation comes from the brackets a line is
 * inside, so a selection formatted on its own would be indented from nothing. "Format
 * Selection" therefore formats the whole text and then keeps only the changes that fall
 * inside the selection.
 *
 * The result is returned as the smallest set of line edits that turns the document into
 * the formatted text, rather than one edit replacing everything: the editor can then keep
 * the cursor, the selection and the folded regions where they were.
 */

const path = require("path");
const { fileURLToPath } = require("url");
const { loadFormatter, resolveOptions } = require("../core/formatter");

/** Lines of `text`, each keeping its own line terminator. */
function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** A line reduced to what it says, so two lines can be aligned across a reformat. */
function contentOf(line) {
  return line.replace(/\r?\n$/, "").trim();
}

/** How far ahead to look for a line that matches again after a difference. */
const RESYNC_WINDOW = 80;

/**
 * The differences between two line arrays, as hunks `{ start, end, text }` where `start`
 * and `end` are line indexes into `before` (end exclusive) and `text` replaces them.
 *
 * The two texts are whitespace variants of the same program — the formatter never adds,
 * removes or reorders a token — so aligning on the content of a line re-syncs reliably
 * after the places where the formatter dropped a blank line or broke a long one.
 */
function diffLines(before, after) {
  const hunks = [];
  const keyBefore = before.map(contentOf);
  const keyAfter = after.map(contentOf);
  let pending = null;

  const flush = () => {
    if (pending) hunks.push(pending);
    pending = null;
  };
  const mark = (start, end, text) => {
    if (pending && pending.end === start) {
      pending.end = end;
      pending.text += text;
    } else {
      flush();
      pending = { start, end, text };
    }
  };

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    if (keyBefore[i] === keyAfter[j]) {
      // the same line, respaced
      mark(i, i + 1, after[j]);
      i++;
      j++;
      continue;
    }
    // out of step: the nearest pair of non-empty lines that say the same thing again
    let found = null;
    for (let d = 1; d <= RESYNC_WINDOW && !found; d++) {
      for (let di = 0; di <= d && !found; di++) {
        const dj = d - di;
        if (i + di >= before.length || j + dj >= after.length) continue;
        if (!keyBefore[i + di]) continue;
        if (keyBefore[i + di] === keyAfter[j + dj]) found = { di, dj };
      }
    }
    if (!found) break;
    mark(i, i + found.di, after.slice(j, j + found.dj).join(""));
    i += found.di;
    j += found.dj;
  }
  if (i < before.length || j < after.length) {
    mark(i, before.length, after.slice(j).join(""));
  }
  flush();
  return hunks;
}

/**
 * A hunk cut into one piece per line, where that says the same thing.
 *
 * `diffLines` joins neighbouring differences into one hunk, which is what a whole-document
 * format wants — but "Format Selection" has to decide line by line what the user chose, and
 * a hunk that starts one line above the selection would otherwise be dropped whole. When a
 * hunk replaces N lines with N lines, each line stands on its own and can be filtered.
 */
function splitHunk(hunk) {
  const lines = splitLines(hunk.text);
  if (lines.length !== hunk.end - hunk.start) return [hunk];
  return lines.map((text, i) => ({ start: hunk.start + i, end: hunk.start + i + 1, text }));
}

/** Offset of the first character of every line, plus the end of the text. */
function lineStarts(lines) {
  const starts = [0];
  let at = 0;
  for (const line of lines) {
    at += line.length;
    starts.push(at);
  }
  return starts;
}

/**
 * Format a document.
 *
 * @param {object} doc        {uri, text, lines}
 * @param {object} settings   the server's `mylang` settings
 * @param {object} env        {workspaceFolders}
 * @param {object} [opts]     {lspOptions, range} — `range` keeps only the edits inside it
 * @returns {{edits: object[]|null, error: string|null, configFile: string|null}}
 */
function formatDocument(doc, settings, env, opts = {}) {
  const format = settings.format || {};
  if (format.enable === false) return { edits: null, error: null, configFile: null };

  const mod = loadFormatter(env.workspaceFolders, settings.compiler && settings.compiler.path);
  if (!mod) {
    return {
      edits: null,
      configFile: null,
      error:
        "No MyLang formatter found. It ships with MyLang2 2.3 and later; " +
        "point `mylang.compiler.path` at the language package to enable formatting.",
    };
  }

  let dir = env.workspaceFolders[0] || process.cwd();
  try {
    dir = path.dirname(fileURLToPath(doc.uri));
  } catch {
    /* an unsaved or non-file document: the workspace folder is the best guess */
  }

  const resolved = resolveOptions(mod, dir, settings, opts.lspOptions || {});
  if (resolved.error) {
    // `mylang prettier` refuses a run whose settings it cannot read (exit code 2); the
    // editor does the same rather than quietly formatting to settings nobody asked for.
    return { edits: null, configFile: resolved.configFile, error: resolved.error };
  }

  let formatted;
  try {
    formatted = mod.formatText(doc.text, resolved.options);
  } catch (err) {
    // the formatter refuses a file it cannot tokenize; the diagnostics already say where,
    // so this one belongs in the log rather than in a message box on every save
    return {
      edits: null,
      configFile: resolved.configFile,
      error: `Cannot format: ${err && err.message ? err.message : err}`,
      syntax: true,
    };
  }
  if (formatted === doc.text)
    return { edits: [], error: resolved.error, configFile: resolved.configFile };

  const before = splitLines(doc.text);
  const after = splitLines(formatted);
  const starts = lineStarts(before);
  let hunks = diffLines(before, after);

  if (opts.range) {
    // "Format Selection": whole lines of the selection, and nothing outside it
    const first = opts.range.start.line;
    const last = opts.range.end.character > 0 ? opts.range.end.line : opts.range.end.line - 1;
    const limit = Math.max(first, last + 1);
    hunks = hunks.flatMap(splitHunk);
    // a hunk reaching past the selection would rewrite lines the user did not choose
    hunks = hunks.filter((h) => h.start >= first && h.end <= limit);
  }

  const edits = hunks.map((h) => ({
    range: doc.lines.range(starts[h.start], starts[h.end]),
    newText: h.text,
  }));
  return { edits, error: resolved.error, configFile: resolved.configFile };
}

module.exports = { formatDocument, diffLines, splitLines, splitHunk };
