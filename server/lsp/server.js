"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const { Transport } = require("./transport");
const { LineIndex } = require("../core/text");
const { analyze } = require("../core/analyzer");
const { loadCompiler, compilerStatus } = require("../core/compiler");
const M = require("../core/modules");
const { resolvePackage } = require("../core/packages");

const completion = require("../features/completion");
const { hover, signatureHelp } = require("../features/hover");
const nav = require("../features/navigation");
const { computeDiagnostics } = require("../features/diagnostics");
const { semanticTokens, legend } = require("../features/semantic");
const { codeActions } = require("../features/codeActions");
const { formatDocument } = require("../features/formatting");
const { formatterStatus, loadFormatter } = require("../core/formatter");

const DEFAULT_SETTINGS = {
  compiler: { path: "" },
  diagnostics: {
    enable: true,
    unresolved: "warning",
    unknownMembers: "warning",
    unknownModules: "warning",
    deprecated: "warning",
    unused: "hint",
    maxProblems: 200,
  },
  completion: { autoImport: true, coreNamespace: true },
  format: { enable: true, configFile: "", options: {} },
  globals: [],
  trace: "off",
};

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "out", ".vscode"]);

/** Editor type of a value read from an imported JSON document. */
function jsonType(value) {
  if (value === null) return { kind: "primitive", name: "nil" };
  if (Array.isArray(value)) {
    const elements = value.map(jsonType);
    return { kind: "array", element: elements.length ? M.unifyTypes(elements) : null };
  }
  switch (typeof value) {
    case "string":
      return { kind: "primitive", name: "string" };
    case "number":
      return { kind: "primitive", name: Number.isInteger(value) ? "int" : "float" };
    case "boolean":
      return { kind: "primitive", name: "bool" };
    case "object": {
      const members = new Map();
      for (const [key, inner] of Object.entries(value)) {
        members.set(key, {
          name: key,
          kind: "property",
          mods: {},
          refs: [],
          members: null,
          params: null,
          doc: "",
          type: jsonType(inner),
          json: true,
        });
      }
      return { kind: "object", members, symbol: null };
    }
    default:
      return null;
  }
}

/** Coordinates documents, workspace indexes and requests over JSON-RPC/LSP. */
class Server {
  constructor() {
    this.transport = new Transport();
    this.transport.onMessage = (m) => this.handle(m);
    this.docs = new Map(); // uri -> {uri, version, text, lines, analysis}
    this.disk = new Map(); // uri -> {mtime, doc}  (closed workspace files)
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.workspaceFolders = [];
    this.nextId = 1;
    this.pending = new Map();
    this.timers = new Map();
    this.shutdownRequested = false;
    this.clientSupportsConfig = false;
  }

  log(msg) {
    process.stderr.write(`[mylang-server] ${msg}\n`);
  }

  // ───────────────────────── messaging ─────────────────────────

  send(msg) {
    this.transport.send(msg);
  }
  notify(method, params) {
    this.send({ method, params });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /** Route an incoming JSON-RPC message and isolate handler exceptions. */
  handle(msg) {
    if (msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    const isRequest = msg.id !== undefined;
    let result;
    try {
      if (this.shutdownRequested && msg.method !== "exit") {
        if (isRequest)
          this.send({ id: msg.id, error: { code: -32600, message: "Server is shutting down" } });
        return;
      }
      result = this.dispatch(msg.method, msg.params || {});
    } catch (err) {
      if (isRequest) {
        this.send({
          id: msg.id,
          error: { code: err.rpcCode || -32603, message: String((err && err.message) || err) },
        });
      } else this.log(`error in ${msg.method}: ${err && err.stack}`);
      return;
    }
    if (!isRequest) return;
    Promise.resolve(result).then(
      (r) => this.send({ id: msg.id, result: r === undefined ? null : r }),
      (err) =>
        this.send({
          id: msg.id,
          error: { code: err.rpcCode || -32603, message: String((err && err.message) || err) },
        }),
    );
  }

  // ───────────────────────── dispatch ─────────────────────────

  /** Translate LSP method names to the corresponding feature implementation. */
  dispatch(method, params) {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "initialized":
        return this.initialized();
      case "shutdown":
        this.shutdownRequested = true;
        return null;
      case "exit":
        process.exit(this.shutdownRequested ? 0 : 1);
        return;
      case "workspace/didChangeConfiguration":
        return this.pullConfiguration();
      case "workspace/didChangeWatchedFiles":
        return this.onWatchedFiles(params);
      case "workspace/didChangeWorkspaceFolders":
        return this.onFolders(params);
      case "workspace/symbol":
        return this.workspaceSymbols(params.query || "");

      case "textDocument/didOpen":
        return this.didOpen(params.textDocument);
      case "textDocument/didChange":
        return this.didChange(params);
      case "textDocument/didClose":
        return this.didClose(params.textDocument.uri);
      case "textDocument/didSave":
        return;

      case "textDocument/completion":
        return this.withDoc(params, (d, o) => completion.complete(d, o, this.settings));
      case "textDocument/hover":
        return this.withDoc(params, (d, o) => hover(d, o));
      case "textDocument/signatureHelp":
        return this.withDoc(params, (d, o) => signatureHelp(d, o));
      case "textDocument/definition":
      case "textDocument/declaration":
        return this.withDoc(params, (d, o) => nav.definition(d, o));
      case "textDocument/references":
        return this.withDoc(params, (d, o) =>
          nav.references(d, o, params.context ? params.context.includeDeclaration : true),
        );
      case "textDocument/documentHighlight":
        return this.withDoc(params, (d, o) => nav.documentHighlights(d, o));
      case "textDocument/prepareRename":
        return this.withDoc(params, (d, o) => nav.prepareRename(d, o));
      case "textDocument/rename":
        return this.withDoc(params, (d, o) => nav.rename(d, o, params.newName));
      case "textDocument/documentSymbol":
        return this.withDoc(params, (d) => nav.documentSymbols(d), true);
      case "textDocument/documentLink":
        return this.withDoc(params, (d) => nav.documentLinks(d), true);
      case "textDocument/foldingRange":
        return this.withDoc(params, (d) => nav.foldingRanges(d), true);
      case "textDocument/semanticTokens/full":
        return this.withDoc(params, (d) => semanticTokens(d), true);
      case "textDocument/formatting":
        return this.format(params, null);
      case "textDocument/rangeFormatting":
        return this.format(params, params.range);
      case "textDocument/codeAction": {
        const d = this.getDoc(params.textDocument.uri);
        return d ? codeActions(d, params.range, params.context, this.settings) : [];
      }
      case "mylang/status":
        return this.status();
      default:
        if (method.startsWith("$/")) return;
        const err = new Error(`Method not found: ${method}`);
        err.rpcCode = -32601;
        throw err;
    }
  }

  withDoc(params, fn, noPosition = false) {
    const d = this.getDoc(params.textDocument.uri);
    if (!d) return null;
    const offset = noPosition ? 0 : d.lines.offsetAt(params.position);
    return fn(d, offset);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  initialize(params) {
    const folders = (params.workspaceFolders || []).map((f) => f.uri);
    if (!folders.length && params.rootUri) folders.push(params.rootUri);
    this.workspaceFolders = folders.map((u) => this.uriToPath(u)).filter(Boolean);
    this.clientSupportsConfig = !!(
      params.capabilities &&
      params.capabilities.workspace &&
      params.capabilities.workspace.configuration
    );
    if (params.initializationOptions) this.applySettings(params.initializationOptions);

    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        completionProvider: {
          triggerCharacters: [".", '"', "/", "'", "@"],
          resolveProvider: false,
        },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        definitionProvider: true,
        declarationProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        renameProvider: { prepareProvider: true },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        documentLinkProvider: { resolveProvider: false },
        foldingRangeProvider: true,
        codeActionProvider: { codeActionKinds: ["quickfix"] },
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        semanticTokensProvider: { legend, full: true },
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      },
      serverInfo: {
        name: "mylang-language-server",
        version: require("../../package.json").version,
      },
    };
  }

  initialized() {
    if (this.clientSupportsConfig) {
      this.request("client/registerCapability", {
        registrations: [
          {
            id: "cfg",
            method: "workspace/didChangeConfiguration",
            registerOptions: { section: "mylang" },
          },
        ],
      }).catch(() => {});
    }
    this.pullConfiguration();
    this.indexWorkspace();
  }

  pullConfiguration() {
    if (!this.clientSupportsConfig) return;
    this.request("workspace/configuration", { items: [{ section: "mylang" }] })
      .then((res) => {
        if (res && res[0]) this.applySettings(res[0]);
        for (const d of this.docs.values()) this.scheduleDiagnostics(d.uri, 0);
      })
      .catch((e) => this.log(`configuration: ${e.message}`));
  }

  applySettings(incoming) {
    const merge = (a, b) => {
      for (const k of Object.keys(b || {})) {
        if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]))
          a[k] = merge(a[k] && typeof a[k] === "object" ? a[k] : {}, b[k]);
        else a[k] = b[k];
      }
      return a;
    };
    this.settings = merge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), incoming);
    // settings changed: previously analysed documents may resolve differently
    for (const d of this.docs.values()) d.analysis = null;
    // a setting may be exactly what fixes a problem already reported
    this.warned = new Set();
    loadCompiler(this.workspaceFolders, this.settings.compiler.path);
    loadFormatter(this.workspaceFolders, this.settings.compiler.path);
  }

  uriToPath(uri) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }

  status() {
    loadCompiler(this.workspaceFolders, this.settings.compiler.path);
    loadFormatter(this.workspaceFolders, this.settings.compiler.path);
    return {
      compiler: compilerStatus(),
      formatter: formatterStatus(),
      documents: this.docs.size,
      indexedFiles: this.disk.size,
      stdlib: M.stdlib.generatedFrom,
    };
  }

  // ───────────────────────── formatting ─────────────────────────

  /**
   * "Format Document" and "Format Selection", both run through the language's own
   * formatter so the editor and `mylang prettier` can never disagree.
   *
   * A formatter that is missing, switched off or unable to read the project's settings
   * is reported once per reason rather than on every keystroke: format-on-save would
   * otherwise repeat the same message on every save.
   */
  format(params, range) {
    const d = this.getDoc(params.textDocument.uri);
    if (!d) return null;

    const result = formatDocument(
      d,
      this.settings,
      { workspaceFolders: this.workspaceFolders },
      {
        lspOptions: params.options || {},
        range,
      },
    );

    if (result.error) {
      if (result.syntax) this.log(result.error);
      else this.warnOnce(`format:${result.error}`, result.error);
    }
    return result.edits;
  }

  /** A warning the user sees once; the same text again is only logged. */
  warnOnce(key, message) {
    this.warned = this.warned || new Set();
    if (this.warned.has(key)) {
      this.log(message);
      return;
    }
    this.warned.add(key);
    this.notify("window/showMessage", { type: 2, message: `MyLang: ${message}` });
  }

  // ───────────────────────── documents ─────────────────────────

  makeDoc(uri, text, version = 0) {
    return { uri, version, text, lines: new LineIndex(text), analysis: null };
  }

  getDoc(uri) {
    const d = this.docs.get(uri) || this.diskDoc(uri);
    if (!d) return null;
    if (!d.analysis) this.analyzeDoc(d);
    return d;
  }

  /** Recompute symbols and attach document positions for cross-file jumps. */
  analyzeDoc(d) {
    d.analysis = analyze(d.text, { globals: new Set(this.settings.globals || []) });
    for (const s of d.analysis.symbols) {
      s.docUri = d.uri;
      s.docLines = d.lines;
    }
    this.enrichImports(d);
  }

  /**
   * Resolves every import of a document against the file system:
   *  - `import "./utils.ml"` namespaces get the exported members of the target file
   *  - `import "./data.json"` gets the keys of the JSON document
   *  - `import "Owner:repo"` gets its installation status and package info
   * The result is what hover, completion and the import diagnostics work from.
   */
  enrichImports(d) {
    let dir = null;
    try {
      dir = path.dirname(fileURLToPath(d.uri));
    } catch {
      dir = null;
    }

    for (const imp of d.analysis.imports) {
      if (imp.kind === "package") {
        // status + package info drive diagnostics, hover and completion
        imp.resolution = dir ? resolvePackage(dir, imp.source) : null;
      }
      if (imp.kind !== "file" && imp.kind !== "package" && imp.kind !== "json") continue;

      const file = nav.resolveImportFile(d.uri, imp.source);
      imp.lookedUp = !!dir;
      imp.resolvedPath = file && dir ? path.relative(dir, file).replace(/\\/g, "/") : file || null;
      const members = file ? this.exportedMembers(d, file) : null;
      if (members) imp.members = members;

      for (const sym of imp.symbols) {
        if (!sym.type || sym.type.kind !== "file") continue;
        if (imp.resolution && imp.resolution.pkg) sym.type.info = imp.resolution.pkg;
        if (members) sym.type.members = members;
      }
    }
  }

  /** Members a resolved import exposes: exports of a `.ml` file, keys of a `.json` file. */
  exportedMembers(from, file) {
    if (file.endsWith(".json")) return this.jsonMembers(file);
    if (!file.endsWith(".ml")) return null;
    const target = this.getDoc(pathToFileURL(file).toString());
    if (!target || target === from) return null;
    const members = new Map();
    for (const ex of target.analysis.exports) {
      const sym = ex.ref && ex.ref.symbol;
      if (sym) members.set(ex.name, sym);
    }
    return members;
  }

  /** Top-level keys of an imported JSON document, as symbols completion understands. */
  jsonMembers(file) {
    try {
      // a data file can be arbitrarily large; the editor only needs small ones
      if (fs.statSync(file).size > 512 * 1024) return null;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const members = new Map();
      for (const [key, value] of Object.entries(data)) {
        members.set(key, {
          name: key,
          kind: "property",
          mods: {},
          refs: [],
          members: null,
          params: null,
          doc: `\`${key}\` of ${path.basename(file)}`,
          type: jsonType(value),
          json: true,
        });
      }
      return members;
    } catch {
      return null;
    }
  }

  diskDoc(uri) {
    const p = this.uriToPath(uri);
    if (!p || !p.endsWith(".ml")) return null;
    try {
      const mtime = fs.statSync(p).mtimeMs;
      const cached = this.disk.get(uri);
      if (cached && cached.mtime === mtime) return cached.doc;
      const doc = this.makeDoc(uri, fs.readFileSync(p, "utf8"));
      this.disk.set(uri, { mtime, doc });
      return doc;
    } catch {
      return null;
    }
  }

  didOpen(td) {
    const d = this.makeDoc(td.uri, td.text, td.version);
    this.docs.set(td.uri, d);
    this.scheduleDiagnostics(td.uri, 0);
  }

  didChange(params) {
    const d = this.docs.get(params.textDocument.uri);
    if (!d) return;
    const change = params.contentChanges[params.contentChanges.length - 1];
    if (!change) return;
    d.text = change.text;
    d.version = params.textDocument.version;
    d.lines = new LineIndex(d.text);
    d.analysis = null;
    this.scheduleDiagnostics(d.uri, 200);
    // dependants: documents importing this file need fresh member lists
    for (const other of this.docs.values()) if (other !== d) other.analysis = null;
  }

  didClose(uri) {
    this.docs.delete(uri);
    const t = this.timers.get(uri);
    if (t) clearTimeout(t);
    this.timers.delete(uri);
    this.notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  }

  scheduleDiagnostics(uri, delay) {
    const old = this.timers.get(uri);
    if (old) clearTimeout(old);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        const d = this.docs.get(uri);
        if (!d) return;
        if (!d.analysis) this.analyzeDoc(d);
        let diagnostics = [];
        try {
          diagnostics = computeDiagnostics(d, this.settings, {
            workspaceFolders: this.workspaceFolders,
          }).diagnostics;
        } catch (err) {
          this.log(`diagnostics failed: ${err && err.stack}`);
        }
        this.notify("textDocument/publishDiagnostics", { uri, version: d.version, diagnostics });
      }, delay),
    );
  }

  // ───────────────────────── workspace ─────────────────────────

  /** Index unopened .ml files for workspace symbol search (with exclusions). */
  indexWorkspace() {
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 8 || files.length > 2000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) walk(full, depth + 1);
        } else if (e.name.endsWith(".ml")) files.push(full);
      }
    };
    for (const f of this.workspaceFolders) walk(f, 0);
    this.workspaceFiles = files;
  }

  onWatchedFiles(params) {
    for (const ch of params.changes || []) {
      this.disk.delete(ch.uri);
      // an edited mylang.json may be the fix for a formatter setting already complained about
      if (ch.uri.endsWith("/mylang.json")) this.warned = new Set();
    }
    this.indexWorkspace();
    // `mylang install` / edits of mylang.json or .module change what imports resolve to
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      for (const d of this.docs.values()) {
        d.analysis = null;
        this.scheduleDiagnostics(d.uri, 0);
      }
    }, 300);
  }

  onFolders(params) {
    const ev = params.event || {};
    for (const f of ev.removed || [])
      this.workspaceFolders = this.workspaceFolders.filter((p) => p !== this.uriToPath(f.uri));
    for (const f of ev.added || []) this.workspaceFolders.push(this.uriToPath(f.uri));
    this.indexWorkspace();
  }

  workspaceSymbols(query) {
    const out = [];
    const seen = new Set();
    for (const d of this.docs.values()) {
      if (!d.analysis) this.analyzeDoc(d);
      seen.add(d.uri);
      out.push(...nav.flattenSymbols(d, query));
    }
    for (const file of this.workspaceFiles || []) {
      const uri = pathToFileURL(file).toString();
      if (seen.has(uri)) continue;
      const d = this.getDoc(uri);
      if (d) out.push(...nav.flattenSymbols(d, query));
      if (out.length > 500) break;
    }
    return out.slice(0, 500);
  }
}

function start() {
  const server = new Server();
  process.on("uncaughtException", (e) => server.log(`uncaught: ${e && e.stack}`));
  process.on("unhandledRejection", (e) => server.log(`unhandled: ${e && e.stack}`));
  return server;
}

module.exports = { Server, start, DEFAULT_SETTINGS };
