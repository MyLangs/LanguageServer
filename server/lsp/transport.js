"use strict";
/**
 * Minimal JSON-RPC 2.0 transport with LSP `Content-Length` framing over stdio.
 * No dependencies. The original stdout.write is captured so that code which later
 * redirects stdout (see compiler.js) can never corrupt the protocol stream.
 */

const writeStdout = process.stdout.write.bind(process.stdout);

class Transport {
  constructor(input = process.stdin) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = () => {};
    input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    input.on("end", () => process.exit(0));
  }

  drain() {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.slice(start, start + length).toString("utf8");
      this.buffer = this.buffer.slice(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch (err) {
        process.stderr.write(`[mylang-server] bad message: ${err && err.stack}\n`);
      }
    }
  }

  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    writeStdout(`Content-Length: ${body.length}\r\n\r\n`);
    writeStdout(body);
  }
}

module.exports = { Transport };
