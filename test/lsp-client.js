"use strict";
const { spawn } = require("child_process");
const path = require("path");

class Client {
  constructor() {
    this.proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "main.js")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = Buffer.alloc(0);
    this.id = 1;
    this.waiters = new Map();
    this.notifications = [];
    this.handlers = {};
    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.proc.stdout.on("data", (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        const he = this.buf.indexOf("\r\n\r\n");
        if (he < 0) return;
        const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, he).toString())[1]);
        if (this.buf.length < he + 4 + len) return;
        const msg = JSON.parse(this.buf.slice(he + 4, he + 4 + len).toString());
        this.buf = this.buf.slice(he + 4 + len);
        this.onMsg(msg);
      }
    });
  }

  onMsg(m) {
    if (m.method !== undefined && m.id !== undefined) {
      // server -> client request
      const h = this.handlers[m.method];
      this.write({ id: m.id, result: h ? h(m.params) : null });
    } else if (m.method !== undefined) this.notifications.push(m);
    else if (this.waiters.has(m.id)) {
      const w = this.waiters.get(m.id);
      this.waiters.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    }
  }

  write(obj) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...obj }));
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async waitDiagnostics(uri, timeout = 3000) {
    const start = Date.now();
    for (;;) {
      const idx = this.notifications.findIndex(
        (n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === uri,
      );
      if (idx >= 0) return this.notifications.splice(idx, 1)[0].params.diagnostics;
      if (Date.now() - start > timeout) throw new Error("timeout waiting for diagnostics");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async init(rootPath, options) {
    const res = await this.request("initialize", {
      processId: process.pid,
      rootUri: rootPath ? "file://" + rootPath : null,
      capabilities: {},
      initializationOptions: options || {},
    });

    this.notify("initialized", {});

    return res;
  }

  async open(uri, text) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "mylang", version: 1, text },
    });
    return this.waitDiagnostics(uri);
  }

  async stop() {
    await this.request("shutdown", null);
    this.notify("exit", null);
  }
}
module.exports = { Client };
