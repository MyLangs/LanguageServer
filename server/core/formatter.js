"use strict";
/**
 * Bridge to the real MyLang formatter (`mylang prettier`, new in MyLang2 2.3).
 *
 * The formatter ships inside the language package, next to the compiler front end, and
 * exposes `formatText(text, options)` — synchronous, and the exact code the command line
 * runs, so "Format Document" in the editor and `mylang prettier --write` on the terminal
 * can never disagree.
 *
 * Lookup order mirrors compiler.js, one folder across:
 *   1. the `mylang.compiler.path` setting (package folder, its `dist`, or `dist/src/index.js`)
 *   2. <workspace>/dist/prettier/index.js            (the language repository itself)
 *   3. <workspace>/node_modules/mylang2/dist/prettier/index.js
 *   4. <workspace>/node_modules/mylang/dist/prettier/index.js
 *   5. `mylang2` resolvable from the extension
 *
 * Without it there is no formatting: a hand-written approximation would reindent files
 * differently from the command line, which is worse than no formatter at all.
 */

const fs = require("fs");
const path = require("path");

let loaded = null; // { formatText, options, source }
let loadedKey = null;
let lastError = null;

/** `.../dist/src/index.js` or `.../dist` or a package folder -> the package folder. */
function packageRootOf(configured) {
  const normalized = configured.replace(/[\\/]+$/, "");
  if (/dist[\\/]src[\\/]index\.js$/.test(normalized))
    return path.resolve(path.dirname(normalized), "..", "..");
  if (/[\\/]dist$/.test(normalized)) return path.resolve(path.dirname(normalized));
  return normalized;
}

function candidates(workspaceFolders, configured) {
  const list = [];
  const fromRoot = (root) => path.join(root, "dist", "prettier", "index.js");
  if (configured) {
    list.push(fromRoot(packageRootOf(configured)));
    // a path that already points inside `dist`
    list.push(path.join(configured, "prettier", "index.js"));
  }
  for (const folder of workspaceFolders) {
    list.push(path.join(folder, "dist", "prettier", "index.js"));
    list.push(fromRoot(path.join(folder, "node_modules", "mylang2")));
    list.push(fromRoot(path.join(folder, "node_modules", "mylang")));
  }
  list.push("mylang2/dist/prettier/index.js");
  return list;
}

/**
 * @returns {{formatText: Function, options: object, source: string} | null}
 */
function loadFormatter(workspaceFolders = [], configured = "") {
  const key = JSON.stringify([workspaceFolders, configured]);
  if (loadedKey === key) return loaded;
  loadedKey = key;
  loaded = null;
  lastError = null;

  for (const candidate of candidates(workspaceFolders, configured)) {
    try {
      const abs = path.isAbsolute(candidate) ? candidate : null;
      if (abs && !fs.existsSync(abs)) continue;
      const resolved =
        abs || require.resolve(candidate, { paths: [__dirname, ...workspaceFolders] });
      const mod = require(resolved);
      if (typeof mod.formatText !== "function") {
        lastError = `${candidate}: no formatText export`;
        continue;
      }
      // options.js sits next to index.js: DEFAULT_OPTIONS and the option validator
      let options = {};
      try {
        options = require(path.join(path.dirname(resolved), "options.js"));
      } catch (err) {
        lastError = `${candidate}: options.js not loadable (${err && err.message})`;
      }
      loaded = { formatText: mod.formatText, options, source: resolved };
      return loaded;
    } catch (err) {
      lastError = `${candidate}: ${err && err.message}`;
    }
  }
  return null;
}

function formatterStatus() {
  if (loaded) return { available: true, source: loaded.source };
  return { available: false, error: lastError };
}

/** The options every formatter build understands, with the defaults of the CLI. */
const FALLBACK_DEFAULTS = {
  indent: 2,
  useTabs: false,
  printWidth: 100,
  quote: "double",
  bracketSpacing: true,
  maxBlankLines: 1,
  endOfLine: "lf",
  finalNewline: true,
};

const OPTION_NAMES = Object.keys(FALLBACK_DEFAULTS);

/** Nearest `mylang.json` at or above `dir`. */
function findConfigFile(dir) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const candidate = path.join(at, "mylang.json");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(at) === at) return null;
  }
}

/**
 * The `"prettier"` section of a project's `mylang.json`, validated by the formatter's own
 * option reader so a misspelt or impossible setting is reported here exactly as
 * `mylang prettier` would report it, instead of quietly doing nothing.
 *
 * @returns {{options: object, file: string|null, error: string|null}}
 */
function projectOptions(mod, startDir, explicitFile) {
  const file = explicitFile ? path.resolve(explicitFile) : findConfigFile(startDir);
  if (!file) return { options: {}, file: null, error: null };
  if (!fs.existsSync(file))
    return { options: {}, file: null, error: `config file not found: ${file}` };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { options: {}, file, error: `cannot read ${path.basename(file)}: ${err.message}` };
  }

  const isConfigItself = path.basename(file) !== "mylang.json";
  const section =
    parsed && typeof parsed === "object" && "prettier" in parsed
      ? parsed.prettier
      : isConfigItself
        ? parsed
        : {};
  if (section === null || typeof section !== "object" || Array.isArray(section))
    return { options: {}, file, error: `"prettier" in ${path.basename(file)} must be an object` };

  // readOptions keeps only the names it knows and throws on a bad value
  if (mod.options && typeof mod.options.readOptions === "function") {
    try {
      const read = mod.options.readOptions(section, path.basename(file));
      const picked = {};
      for (const name of OPTION_NAMES)
        if (Object.prototype.hasOwnProperty.call(read, name)) picked[name] = read[name];
      return { options: picked, file, error: null };
    } catch (err) {
      return { options: {}, file, error: err.message };
    }
  }
  const picked = {};
  for (const name of OPTION_NAMES)
    if (Object.prototype.hasOwnProperty.call(section, name)) picked[name] = section[name];
  return { options: picked, file, error: null };
}

/**
 * The options a document is formatted with, and where each one came from.
 *
 * Lowest to highest: the formatter's own defaults, what the editor says about this file
 * (`tabSize` / `insertSpaces`), the project's `mylang.json`, and finally
 * `mylang.format.options`, which is the editor's equivalent of a command-line flag.
 *
 * @param {object} mod        the loaded formatter
 * @param {string} dir        folder of the document being formatted
 * @param {object} settings   the server's `mylang` settings
 * @param {object} lspOptions LSP FormattingOptions, may be empty
 */
function resolveOptions(mod, dir, settings, lspOptions = {}) {
  const defaults = (mod.options && mod.options.DEFAULT_OPTIONS) || FALLBACK_DEFAULTS;
  const format = settings.format || {};
  const project = projectOptions(mod, dir, format.configFile || "");

  const editor = {};
  if (typeof lspOptions.tabSize === "number" && lspOptions.tabSize > 0)
    editor.indent = lspOptions.tabSize;
  if (typeof lspOptions.insertSpaces === "boolean") editor.useTabs = !lspOptions.insertSpaces;
  if (lspOptions.insertFinalNewline !== undefined)
    editor.finalNewline = !!lspOptions.insertFinalNewline;

  const override = {};
  for (const name of OPTION_NAMES)
    if (format.options && format.options[name] !== undefined) override[name] = format.options[name];

  const options = { ...defaults, ...editor, ...project.options, ...override };
  return { options, configFile: project.file, error: project.error };
}

module.exports = {
  loadFormatter,
  formatterStatus,
  resolveOptions,
  findConfigFile,
  OPTION_NAMES,
  FALLBACK_DEFAULTS,
};
