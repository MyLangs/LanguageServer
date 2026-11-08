"use strict";

/** Converts between character offsets and LSP {line, character} positions. */
class LineIndex {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) this.starts.push(i + 1);
      else if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
  }

  get lineCount() {
    return this.starts.length;
  }

  /** @returns {{line:number, character:number}} */
  positionAt(offset) {
    offset = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }

  offsetAt(pos) {
    if (pos.line >= this.starts.length) return this.text.length;
    if (pos.line < 0) return 0;
    const lineStart = this.starts[pos.line];
    const lineEnd =
      pos.line + 1 < this.starts.length ? this.starts[pos.line + 1] : this.text.length;
    return Math.min(lineStart + Math.max(0, pos.character), lineEnd);
  }

  /** @returns {{start:{line:number,character:number}, end:{line:number,character:number}}} */
  range(start, end) {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }

  /** Text of the line that contains `offset`, up to `offset`. */
  linePrefix(offset) {
    const p = this.positionAt(offset);
    return this.text.slice(this.starts[p.line], offset);
  }
}

module.exports = { LineIndex };
