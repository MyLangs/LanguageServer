"use strict";
/**
 * Error-tolerant analyzer for MyLang2 source.
 *
 * It walks the token stream with a small recursive-descent parser that never throws:
 * on anything unexpected it skips a token and carries on, so every editor feature keeps
 * working while the user is typing. The result (see `Analysis`) contains
 *   - scopes and symbols (variables, functions, structs, enums, imports, parameters ...)
 *   - every identifier reference, resolved to its symbol
 *   - member accesses with the inferred owner type (for completion / hover)
 *   - call sites (for signature help), imports, exports
 *   - semantic issues (unresolved names, const reassignment, unknown module members ...)
 *
 * Syntax errors are NOT reported from here: the real compiler (compiler.js) is the
 * authority for those.
 */

const { tokenize, stringValue } = require("./lexer");
const M = require("./modules");
const lang = require("../data/language");
const { closest } = require("./util");
const { cleanComment, parseJSDoc, parameterDoc } = require("./jsdoc");

const ASSIGN_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&&=",
  "||=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
]);
const BIN_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "==",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "&&",
  "||",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);
const PREFIX_OPS = new Set(["+", "-", "!", "~", "++", "--"]);
const MODS = new Set(["const", "readonly", "lazy"]);
const HTTP_ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
  "use",
]);

/** A lexical scope in the editor model; nested scopes inherit parent symbols. */
class Scope {
  constructor(kind, start, parent) {
    this.kind = kind;
    this.start = start;
    this.end = Infinity;
    this.parent = parent;
    this.symbols = new Map();
    this.children = [];
    this.thisType = null;
    this.fn = null;
    if (parent) parent.children.push(this);
  }
}

/**
 * @typedef {Object} Analysis
 * @property {import("./text").LineIndex} lines
 * @property {Scope} root
 * @property {Object[]} symbols      every declared symbol (outline order)
 * @property {Object[]} refs         identifier references
 * @property {Object[]} memberRefs   property accesses (`a.b`)
 * @property {Object[]} occurrences  decls + refs + member refs sorted by offset
 * @property {Object[]} dots         every `.` with the owner type
 * @property {Object[]} calls        call sites
 * @property {Object[]} imports
 * @property {Object[]} exports
 * @property {Object[]} issues       semantic issues
 */

/**
 * One tolerant parsing pass for a document. An Analyzer instance is not reused
 * after edits: the LSP server creates a fresh model for each new text version.
 */
class Analyzer {
  constructor(text, tokens, options = {}) {
    this.text = text;
    this.allTokens = tokens;
    this.options = options;
    this.toks = tokens.filter((t) => t.type !== "comment");
    this.p = 0;

    // doc comments: attach comment groups to the following significant token
    this.leading = new Map();
    let pending = [];
    for (const t of tokens) {
      if (t.type === "comment") pending.push(t);
      else {
        if (pending.length) this.leading.set(t, pending);
        pending = [];
      }
    }

    this.idc = 0;
    this.root = new Scope("global", 0, null);
    this.root.end = text.length;
    this.scope = this.root;
    this.symbols = [];
    this.refs = [];
    this.memberRefs = [];
    this.dots = [];
    this.calls = [];
    this.imports = [];
    this.exports = [];
    this.issues = [];
    this.mutations = [];
    this.fieldAssignments = [];
    this.fnStack = [];
    this.declCtx = null;
    this.argHint = null;
    this.thisHint = null;
    this.interpDepth = 0;
  }

  // ───────────────────────── token helpers ─────────────────────────

  peek(k = 0) {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }
  next() {
    const t = this.toks[this.p];
    if (this.p < this.toks.length - 1) this.p++;
    return t;
  }
  get eof() {
    return this.peek().type === "eof";
  }
  isPunct(v, k = 0) {
    const t = this.peek(k);
    return t.type === "punct" && t.value === v;
  }
  isOp(v, k = 0) {
    const t = this.peek(k);
    return t.type === "op" && t.value === v;
  }
  isKw(v, k = 0) {
    const t = this.peek(k);
    return t.type === "keyword" && t.value === v;
  }
  eatPunct(v) {
    if (this.isPunct(v)) {
      this.next();
      return true;
    }
    return false;
  }
  lastEnd() {
    return this.toks[Math.max(0, this.p - 1)].end;
  }
  isWordToken(t) {
    return (
      t.type === "ident" ||
      t.type === "keyword" ||
      t.type === "bool" ||
      t.type === "nil" ||
      t.type === "reflect"
    );
  }
  lineOf(offset) {
    // line number via counting newlines is O(n); only used for same-line checks on short spans
    return this.text.slice(0, offset).split("\n").length;
  }
  sameLine(a, b) {
    return !this.text.slice(a, b).includes("\n");
  }

  /**
   * Collect comments directly above a declaration.
   *
   * Stop at a blank line and never treat a trailing comment from the previous
   * statement as documentation for the next declaration. The JSDoc parser
   * interprets tags later, when the symbol is actually declared.
   */
  docFor(tok) {
    const group = this.leading.get(tok);
    if (!group) return "";

    const comments = [];
    let nextStart = tok.start;

    for (let i = group.length - 1; i >= 0; i--) {
      const comment = group[i];
      const gap = this.text.slice(comment.end, nextStart);
      if ((gap.match(/\n/g) || []).length > 1) break;
      if (gap.trim()) break;

      const lineStart = this.text.lastIndexOf("\n", comment.start - 1) + 1;
      if (this.text.slice(lineStart, comment.start).trim()) break;

      const value =
        comment.kind === "block"
          ? cleanComment(comment.value)
          : comment.value.replace(/^\/\/\/?\s?/, "").trimEnd();
      comments.unshift(value);
      nextStart = comment.start;
    }

    return comments.join("\n").trim();
  }

  // ───────────────────────── scopes & symbols ─────────────────────────

  pushScope(kind, start) {
    const s = new Scope(kind, start, this.scope);
    this.scope = s;
    return s;
  }
  popScope() {
    this.scope = this.scope.parent || this.root;
  }

  /**
   * Register a symbol and report duplicates without aborting analysis.
   * Struct/enum members deliberately live in their owner's member map.
   */
  declare(scope, props) {
    const documentation = parseJSDoc(props.doc || "");
    const sym = {
      id: ++this.idc,
      name: props.name,
      kind: props.kind,
      nameStart: props.nameTok ? props.nameTok.start : props.start,
      nameEnd: props.nameTok ? props.nameTok.end : props.start,
      start: props.start,
      end: props.end ?? props.start,
      scope,
      parent: props.parent || null,
      members: props.members || null,
      mods: props.mods || {},
      params: props.params || null,
      doc: documentation.description,
      jsdoc: documentation,
      type: props.type || null,
      returnType: null,
      refs: [],
      reads: 0,
      isMember: !!props.isMember,
      importSource: props.importSource || null,
    };
    if (!sym.isMember && scope) {
      const existing = scope.symbols.get(sym.name);
      if (existing) {
        this.issues.push({
          code: "duplicate",
          start: sym.nameStart,
          end: sym.nameEnd,
          data: {
            name: sym.name,
            kind: sym.kind,
            first: existing,
            isImport: sym.kind === "import" && existing.kind === "import",
          },
        });
      } else {
        scope.symbols.set(sym.name, sym);
      }
    }
    this.symbols.push(sym);
    return sym;
  }

  lookup(scope, name) {
    for (let s = scope; s; s = s.parent) {
      const sym = s.symbols.get(name);
      if (sym) return sym;
    }
    return null;
  }

  thisTypeAt(scope) {
    for (let s = scope; s; s = s.parent) if (s.thisType) return s.thisType;
    return null;
  }

  currentFn() {
    return this.fnStack.length ? this.fnStack[this.fnStack.length - 1] : null;
  }

  addRef(tok, extra) {
    const ref = {
      name: tok.value,
      start: tok.start,
      end: tok.end,
      scope: this.scope,
      symbol: null,
      write: false,
      read: true,
      ...extra,
    };
    this.refs.push(ref);
    return ref;
  }

  // ───────────────────────── program / statements ─────────────────────────

  run() {
    while (!this.eof) {
      const before = this.p;
      this.parseStatement();
      if (this.p === before) this.next();
    }
    this.root.end = this.text.length;
    this.resolve();
    return this.finish();
  }

  parseStatementsUntilClose() {
    while (!this.eof && !this.isPunct("}")) {
      const before = this.p;
      this.parseStatement();
      if (this.p === before) this.next();
    }
  }

  /** `{ ... }` creating its own scope (unless `preScope` is given). */
  parseBlock(kind = "block", preScope = null) {
    if (!this.isPunct("{")) return false;
    const open = this.next();
    const scope = preScope || this.pushScope(kind, open.start);
    this.parseStatementsUntilClose();
    const close = this.isPunct("}") ? this.next() : null;
    scope.end = close ? close.end : this.text.length;
    if (!preScope) this.popScope();
    return true;
  }

  /** A block or a single statement (bodies of if/for/while). */
  parseBody() {
    if (this.isPunct("{")) this.parseBlock("block");
    else {
      const before = this.p;
      this.parseStatement();
      if (this.p === before && !this.eof) this.next();
    }
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === "punct") {
      if (t.value === ";" || t.value === ",") return void this.next();
      if (t.value === "{") return void this.parseBlock("block");
    }
    if (t.type === "keyword") {
      switch (t.value) {
        case "var":
          return this.parseVar({ kind: "variable" });
        case "func":
          if (this.peek(1).type === "ident" && this.isPunct("(", 2))
            return void this.parseFunction({ declaration: true });
          break;
        case "struct":
          if (this.peek(1).type === "ident") return void this.parseStruct({ declaration: true });
          break;
        case "enum":
          if (this.peek(1).type === "ident") return void this.parseEnum({ declaration: true });
          break;
        case "import":
          if (!this.isPunct(".", 1) && !this.isOp("?", 1)) return void this.parseImportStatement();
          break;
        case "export":
          return void this.parseExport();
        case "if":
          return void this.parseIf();
        case "for":
          return void this.parseFor();
        case "while":
          return void this.parseWhile();
        case "match":
          return void this.parseMatch();
        case "try":
          if (this.isPunct("{", 1)) return void this.parseTryStatement();
          break;
        case "return":
          return void this.parseReturn();
        case "throw":
          this.next();
          this.parseExpr();
          return;
        case "break":
        case "continue":
          return void this.next();
        case "defer":
          this.next();
          return void this.parseStatement();
        case "else":
        case "catch":
        case "finally":
        case "case":
        case "default":
          return void this.next(); // stray keyword: skip
        default:
          break;
      }
    }
    // expression statement
    const before = this.p;
    this.parseExpr();
    if (this.p === before) this.next();
  }

  // ───────────────────────── variables ─────────────────────────

  /**
   * `var` declarations. ctx.kind is "variable" (statement) or "field" (struct body).
   * ctx.owner is the struct symbol for fields.
   */
  parseVar(ctx) {
    const varTok = this.next(); // var
    const doc = this.docFor(varTok);
    const declared = [];

    // `var [symbol.dispose] = ...`: a protocol belongs to a method, never to a field
    if (ctx.kind === "field" && this.isPunct("[")) {
      const key = this.parseSymbolKey();
      this.issues.push({
        code: "symbol-member-field",
        start: key.start,
        end: key.end,
        data: { source: key.source },
      });
      if (this.isOp("=")) {
        this.next();
        this.parseExpr();
      }
      return declared;
    }

    if (this.isPunct("(")) {
      this.next();
      while (!this.eof && !this.isPunct(")")) {
        if (this.eatPunct(",")) continue;
        const before = this.p;
        this.parseDeclarator(varTok, doc, ctx, declared);
        if (this.p === before) this.next();
      }
      if (this.isPunct(")")) this.next();
      // `var (a, b) = expr` (destructuring of multiple return values)
      if (this.isOp("=")) {
        this.next();
        this.parseExpr();
      } else if (
        this.isKw("as") &&
        this.peek(1).type === "keyword" &&
        MODS.has(this.peek(1).value)
      ) {
        this.next();
        const mod = this.next().value;
        for (const s of declared) this.applyMod(s, mod);
      }
    } else {
      this.parseDeclarator(varTok, doc, ctx, declared);
    }
    const end = this.lastEnd();
    for (const s of declared) s.end = end;
    return declared;
  }

  applyMod(sym, mod) {
    sym.mods.const = true;
    if (mod === "readonly") sym.mods.readonly = true;
    if (mod === "lazy") sym.mods.lazy = true;
  }

  /**
   * Parse a variable/field declaration, including destructuring and its value.
   * `declared` collects every created binding for later modifier processing.
   */
  parseDeclarator(varTok, doc, ctx, declared) {
    const t = this.peek();
    const made = [];
    const mk = (nameTok) => {
      const sym = this.declare(ctx.kind === "field" ? null : this.scope, {
        name: nameTok.value,
        kind: ctx.kind,
        nameTok,
        start: varTok.start,
        end: nameTok.end,
        doc,
        mods: { ...(ctx.mods || {}) },
        parent: ctx.owner || null,
        isMember: ctx.kind === "field",
      });
      if (ctx.kind === "field" && ctx.owner) {
        if (!ctx.owner.members.has(sym.name)) ctx.owner.members.set(sym.name, sym);
        else {
          this.issues.push({
            code: "duplicate",
            start: sym.nameStart,
            end: sym.nameEnd,
            data: { name: sym.name, kind: "field", first: ctx.owner.members.get(sym.name) },
          });
        }
      }
      made.push(sym);
      declared.push(sym);
      return sym;
    };

    if (
      t.type === "ident" ||
      (ctx.kind === "field" && this.isWordToken(t) && t.type !== "keyword")
    ) {
      this.next();
      mk(t);
    } else if (this.isPunct("[")) {
      this.parseArrayPattern(mk);
    } else if (this.isPunct("{")) {
      this.parseObjectPattern(mk);
    } else {
      return;
    }

    if (this.isOp("=")) {
      this.next();
      const savedCtx = this.declCtx;
      this.declCtx = made;
      const info = this.parseExpr();
      this.declCtx = savedCtx;
      if (made.length === 1 && info && info.type) {
        made[0].type = info.type;
        if (info.type.kind === "object" && !info.type.symbol) info.type.symbol = made[0];
      }
      if (made.length === 1 && info) {
        // `b` may be declared further down the file, and `a.b` may only get its type
        // once the owner's fields are known
        if (info._ref) made[0].deferRef = info._ref;
        if (info.memberRef) made[0].deferMemberRef = info.memberRef;
        if (info.calleeSymbol) made[0].deferCallee = info.calleeSymbol;
      }
    }
  }

  parseArrayPattern(mk) {
    this.next(); // [
    while (!this.eof && !this.isPunct("]")) {
      if (this.eatPunct(",")) continue;
      if (this.isOp("...")) this.next();
      const t = this.peek();
      if (t.type === "ident") {
        this.next();
        mk(t);
        if (this.isOp("=")) {
          this.next();
          this.parseExpr();
        }
      } else if (this.isPunct("[")) this.parseArrayPattern(mk);
      else if (this.isPunct("{")) this.parseObjectPattern(mk);
      else this.next();
    }
    if (this.isPunct("]")) this.next();
  }

  parseObjectPattern(mk) {
    this.next(); // {
    while (!this.eof && !this.isPunct("}")) {
      if (this.eatPunct(",")) continue;
      if (this.isOp("...")) this.next();
      const t = this.peek();
      if (this.isWordToken(t)) {
        this.next();
        if (this.isPunct(":")) {
          this.next();
          const target = this.peek();
          if (target.type === "ident") {
            this.next();
            mk(target);
          } else if (this.isPunct("[")) this.parseArrayPattern(mk);
          else if (this.isPunct("{")) this.parseObjectPattern(mk);
        } else if (t.type === "ident") {
          mk(t);
        }
        if (this.isOp("=")) {
          this.next();
          this.parseExpr();
        }
      } else this.next();
    }
    if (this.isPunct("}")) this.next();
  }

  // ───────────────────────── functions ─────────────────────────

  /**
   * func name(params) { body }   (declaration, method or expression)
   * opts: {declaration, owner (struct/enum symbol), thisType}
   */
  parseFunction(opts = {}) {
    const funcTok = this.next(); // func
    const doc = this.docFor(funcTok);
    let nameTok = null;
    // `func [symbol.dispose]() { ... }`: a member named after a protocol symbol
    const symbolKey = opts.owner && this.isPunct("[") ? this.parseSymbolKey() : null;
    if (symbolKey) {
      /* the brackets are the name */
    } else if (this.peek().type === "ident" && this.isPunct("(", 1)) nameTok = this.next();
    else if (opts.owner && this.isWordToken(this.peek()) && this.isPunct("(", 1))
      nameTok = this.next();

    const thisType = opts.thisType || this.thisHint || null;
    this.thisHint = null;
    const argHint = this.argHint;
    this.argHint = null;

    let sym = null;
    if (symbolKey) {
      sym = this.declare(null, {
        name: `[${symbolKey.source}]`,
        kind: "method",
        start: funcTok.start,
        end: symbolKey.end,
        doc,
        mods: opts.mods || {},
        parent: opts.owner,
        isMember: true,
      });
      sym.nameStart = symbolKey.start;
      sym.nameEnd = symbolKey.end;
      sym.symbolKey = symbolKey;
      this.registerSymbolMember(opts.owner, sym, symbolKey, opts.modTok);
    } else if (nameTok && (opts.declaration || opts.owner)) {
      const kind = opts.owner ? "method" : "function";
      sym = this.declare(opts.owner ? null : this.scope, {
        name: nameTok.value,
        kind,
        nameTok,
        start: funcTok.start,
        doc,
        mods: opts.mods || {},
        parent: opts.owner || null,
        isMember: !!opts.owner,
      });
      if (opts.owner) {
        if (!opts.owner.members.has(sym.name)) opts.owner.members.set(sym.name, sym);
        else {
          this.issues.push({
            code: "duplicate",
            start: sym.nameStart,
            end: sym.nameEnd,
            data: { name: sym.name, kind: "method", first: opts.owner.members.get(sym.name) },
          });
        }
      }
    } else if (nameTok) {
      sym = this.declare(null, {
        name: nameTok.value,
        kind: "function",
        nameTok,
        start: funcTok.start,
        doc,
        isMember: true,
      });
    }

    const scope = this.pushScope("function", this.peek().start);
    scope.fn = sym;
    if (thisType) scope.thisType = thisType;

    const savedDecl = this.declCtx;
    this.declCtx = null;
    this.fnStack.push(sym || { returnType: null, anonymous: true });

    const params = [];
    if (this.isPunct("(")) {
      this.next();
      while (!this.eof && !this.isPunct(")")) {
        if (this.eatPunct(",")) continue;
        const before = this.p;
        let rest = false;
        if (this.isOp("...")) {
          this.next();
          rest = true;
        }
        const pt = this.peek();
        if (pt.type === "ident") {
          this.next();
          const param = { name: pt.value, rest };
          const psym = this.declare(scope, {
            name: pt.value,
            kind: "parameter",
            nameTok: pt,
            start: pt.start,
            end: pt.end,
          });
          // Attach @param text/types for Hover without changing inferred types.
          const documentedParam = parameterDoc(sym?.jsdoc, pt.value);
          if (documentedParam) {
            psym.doc = documentedParam.description;
            psym.jsdoc = parseJSDoc(documentedParam.description);
            psym.jsdoc.type = documentedParam.type;
            // a documented type also belongs in the signature the editor shows
            if (documentedParam.type) param.type = documentedParam.type;
            if (documentedParam.optional) param.optional = true;
          }
          if (this.isOp("=")) {
            const eq = this.next();
            const defStart = this.peek().start;
            this.parseExpr();
            param.optional = true;
            param.default = this.text.slice(defStart, this.lastEnd()).trim();
            void eq;
          }
          // lambda parameter typing (e.g. `server.get("/", func(ctx) {...})`)
          if (params.length === 0 && argHint && argHint.paramType) psym.type = argHint.paramType;
          params.push(param);
        }
        if (this.p === before) this.next();
      }
      if (this.isPunct(")")) this.next();
    }
    if (sym) sym.params = params;

    if (this.isPunct("{")) this.parseBlock("function", scope);
    scope.end = Math.max(scope.end === Infinity ? 0 : scope.end, this.lastEnd());

    this.fnStack.pop();
    this.declCtx = savedDecl;
    this.popScope();
    if (sym) sym.end = this.lastEnd();
    return {
      type: sym
        ? { kind: "function", symbol: sym }
        : {
            kind: "function",
            symbol: {
              name: "(anonymous)",
              params,
              kind: "function",
              returnType: null,
              refs: [],
              members: null,
            },
          },
    };
  }

  // ───────────────────────── struct / enum ─────────────────────────

  /**
   * The `private` / `static` modifiers that open a struct member (MyLang2 2.2).
   *
   * Both are ordinary identifiers everywhere else in the language, so they only count
   * here, and only when a member declaration really follows: `private` on its own is a
   * name like any other, and reading it as a modifier would swallow the line.
   *
   * @returns {{mods: object, modTok: object|null}} the first modifier token, for the
   *   diagnostics that have to point at it.
   */
  structModifiers() {
    const mods = {};
    let modTok = null;
    for (;;) {
      const tok = this.peek();
      if (tok.type !== "ident" || (tok.value !== "private" && tok.value !== "static")) break;
      const next = this.peek(1);
      const opensMember =
        this.isKw("var", 1) ||
        this.isKw("func", 1) ||
        (next.type === "ident" && (next.value === "private" || next.value === "static"));
      if (!opensMember) break;
      if (mods[tok.value]) {
        this.issues.push({
          code: "duplicate-modifier",
          start: tok.start,
          end: tok.end,
          data: { modifier: tok.value },
        });
      }
      if (!modTok) modTok = tok;
      mods[tok.value] = true;
      this.next();
    }
    return { mods, modTok };
  }

  /**
   * `[<expression>]` naming a struct member after a language symbol, with the brackets
   * still ahead: `func [symbol.dispose]() { ... }` (MyLang2 2.3).
   *
   * The expression is analysed like any other, so `symbol` and `.dispose` get their
   * references, hover and highlighting for free. What the member is *called* is the
   * bracketed source, the way the interpreter names it in a stack trace; which protocol
   * it joins is decided by the expression, and only the two protocol symbols are allowed.
   */
  parseSymbolKey() {
    const open = this.next(); // [
    const from = this.peek().start;
    this.parseExpr();
    const to = this.lastEnd();
    const close = this.isPunct("]") ? this.next() : null;
    const source = this.text.slice(from, to).replace(/\s+/g, "");
    const protocol = /^symbol\.(dispose|iterator)$/.exec(source);
    return {
      source,
      protocol: protocol ? protocol[1] : null,
      start: open.start,
      end: close ? close.end : to,
      keyStart: from,
      keyEnd: to,
    };
  }

  /**
   * File a symbol member under the protocol it implements and report what the parser
   * would refuse: a modifier on it, an expression that is not a protocol symbol, and the
   * same protocol declared twice in one struct.
   */
  registerSymbolMember(owner, sym, key, modTok) {
    if (!owner.symbolMembers) owner.symbolMembers = new Map();
    // every one of them, in source order, for the outline; the map is the protocol index
    if (!owner.symbolMemberList) owner.symbolMemberList = [];
    owner.symbolMemberList.push(sym);

    if (modTok) {
      this.issues.push({
        code: "symbol-member-modifier",
        start: modTok.start,
        end: modTok.end,
        data: { modifier: modTok.value, member: sym.name },
      });
    }

    if (!key.protocol) {
      this.issues.push({
        code: "symbol-member-unknown",
        start: key.keyStart,
        end: key.keyEnd,
        data: { source: key.source },
      });
      return;
    }

    const first = owner.symbolMembers.get(key.protocol);
    if (first) {
      this.issues.push({
        code: "symbol-member-duplicate",
        start: key.start,
        end: key.end,
        data: { protocol: key.protocol, first },
      });
      return;
    }
    owner.symbolMembers.set(key.protocol, sym);
  }

  /** Track struct fields and methods for member completion/navigation. */
  parseStruct(opts) {
    const kw = this.next(); // struct
    const doc = this.docFor(kw);
    let nameTok = null;
    if (this.peek().type === "ident") nameTok = this.next();

    let sym;
    if (nameTok) {
      sym = this.declare(opts.declaration ? this.scope : null, {
        name: nameTok.value,
        kind: "struct",
        nameTok,
        start: kw.start,
        doc,
        members: new Map(),
        isMember: !opts.declaration,
      });
    } else {
      sym = this.declare(null, {
        name: "(anonymous struct)",
        kind: "struct",
        start: kw.start,
        members: new Map(),
        isMember: true,
      });
    }
    sym.type = { kind: "struct", symbol: sym };

    if (this.isPunct("{")) {
      const open = this.next();
      const scope = this.pushScope("struct", open.start);
      scope.thisType = { kind: "instance", symbol: sym };
      while (!this.eof && !this.isPunct("}")) {
        const before = this.p;
        const { mods, modTok } = this.structModifiers();
        if (this.isKw("var")) this.parseVar({ kind: "field", owner: sym, mods, modTok });
        else if (this.isKw("func"))
          this.parseFunction({ owner: sym, thisType: scope.thisType, mods, modTok });
        else if (this.isPunct(",") || this.isPunct(";")) this.next();
        if (this.p === before) this.next();
      }
      const close = this.isPunct("}") ? this.next() : null;
      scope.end = close ? close.end : this.text.length;
      this.popScope();
    }
    sym.end = this.lastEnd();
    return { type: { kind: "struct", symbol: sym } };
  }

  /** Track enum values and methods, keeping them distinct from local names. */
  parseEnum(opts) {
    const kw = this.next(); // enum
    const doc = this.docFor(kw);
    let nameTok = null;
    if (this.peek().type === "ident") nameTok = this.next();

    let sym;
    if (nameTok) {
      sym = this.declare(opts.declaration ? this.scope : null, {
        name: nameTok.value,
        kind: "enum",
        nameTok,
        start: kw.start,
        doc,
        members: new Map(),
        isMember: !opts.declaration,
      });
    } else {
      sym = this.declare(null, {
        name: "(anonymous enum)",
        kind: "enum",
        start: kw.start,
        members: new Map(),
        isMember: true,
      });
    }
    sym.type = { kind: "enum", symbol: sym };

    if (this.isPunct("{")) {
      const open = this.next();
      const scope = this.pushScope("enum", open.start);
      scope.thisType = { kind: "enumValue", symbol: sym };
      while (!this.eof && !this.isPunct("}")) {
        const before = this.p;
        const t = this.peek();
        if (this.isKw("func")) {
          this.parseFunction({ owner: sym, thisType: scope.thisType });
        } else if (t.type === "ident") {
          this.next();
          const member = this.declare(null, {
            name: t.value,
            kind: "enumMember",
            nameTok: t,
            start: t.start,
            end: t.end,
            doc: this.docFor(t),
            parent: sym,
            isMember: true,
          });
          if (!sym.members.has(member.name)) sym.members.set(member.name, member);
          else {
            this.issues.push({
              code: "duplicate",
              start: member.nameStart,
              end: member.nameEnd,
              data: { name: member.name, kind: "enumMember", first: sym.members.get(member.name) },
            });
          }
          if (this.isOp("=")) {
            this.next();
            this.parseExpr();
          }
          member.end = this.lastEnd();
        } else if (this.isPunct(",") || this.isPunct(";")) this.next();
        if (this.p === before) this.next();
      }
      const close = this.isPunct("}") ? this.next() : null;
      scope.end = close ? close.end : this.text.length;
      this.popScope();
    }
    sym.end = this.lastEnd();
    return { type: { kind: "enum", symbol: sym } };
  }

  // ───────────────────────── imports / exports ─────────────────────────

  /** Record static imports and aliases for module-aware diagnostics/navigation. */
  parseImportStatement() {
    const kw = this.next(); // import
    const entries = [];

    const addEntry = (strTok, aliasTok) => {
      const source = stringValue(strTok);
      const entry = {
        source,
        tok: strTok,
        kind: "other",
        symbols: [],
        stmtStart: kw.start,
        stmtEnd: kw.end,
        builtin: false,
      };
      entries.push({ entry, aliasTok });
      return entry;
    };

    if (this.isPunct("(")) {
      this.next();
      while (!this.eof && !this.isPunct(")")) {
        const before = this.p;
        const t = this.peek();
        if (t.type === "string") {
          this.next();
          addEntry(t, null);
        } else if (t.type === "ident" && this.isPunct(":", 1) && this.peek(2).type === "string") {
          this.next();
          this.next();
          addEntry(this.next(), t);
        } else if (t.type === "ident" && this.isPunct(":", 1)) {
          this.next();
          this.next();
        } else if (this.isPunct(",")) {
          this.next();
        }
        if (this.p === before) this.next();
      }
      if (this.isPunct(")")) this.next();
      for (const e of entries) this.bindImport(e.entry, e.aliasTok, true, null, null);
    } else if (this.peek().type === "string") {
      const strTok = this.next();
      const e = addEntry(strTok, null);
      let aliasTok = null;
      let destructured = null;
      if (this.isKw("as")) {
        this.next();
        if (this.peek().type === "ident") aliasTok = this.next();
        else if (this.isPunct("{")) {
          this.next();
          destructured = [];
          while (!this.eof && !this.isPunct("}")) {
            const before = this.p;
            const t = this.peek();
            if (t.type === "ident") destructured.push(this.next());
            else if (this.isPunct(",")) this.next();
            if (this.p === before) this.next();
          }
          if (this.isPunct("}")) this.next();
        }
      }
      this.bindImport(e, aliasTok, false, destructured, kw);
    }
    const end = this.lastEnd();
    for (const e of entries) {
      e.entry.stmtEnd = end;
      this.imports.push(e.entry);
    }
    if (this.isPunct(";")) this.next();
  }

  bindImport(entry, aliasTok, multi, destructured, kw) {
    const info = M.importInfo(entry.source, multi);
    entry.kind = info.kind;
    entry.builtin = info.kind === "builtin";
    entry.core = !!info.core;
    entry.module = info.module || null;
    if (info.kind === "other" && !/[./\\]/.test(entry.source) && !entry.source.includes(":")) {
      this.issues.push({
        code: "unknown-module",
        start: entry.tok.start,
        end: entry.tok.end,
        data: { source: entry.source, suggestion: closest(entry.source, M.BUILTIN_MODULES) },
      });
    } else if (info.kind === "core-unknown") {
      // `core:` names a module that ships with the interpreter and nothing else
      this.issues.push({
        code: "unknown-core-module",
        start: entry.tok.start,
        end: entry.tok.end,
        data: {
          source: entry.source,
          name: info.module,
          suggestion: closest(info.module, M.BUILTIN_MODULES),
        },
      });
    }

    let type = null;
    if (entry.builtin) type = M.moduleType(info.module);
    else if (info.kind === "file") type = { kind: "file", path: entry.source };
    else if (info.kind === "json") type = { kind: "file", path: entry.source, json: true };
    else if (info.kind === "package") type = { kind: "file", path: entry.source, package: true };

    if (destructured) {
      entry.destructured = destructured.map((t) => ({
        name: t.value,
        start: t.start,
        end: t.end,
      }));
      for (const nameTok of destructured) {
        let t = null;
        if (type) {
          const m = M.memberOf(type, nameTok.value);
          if (m) t = M.memberType(type, m);
          else if (entry.builtin) {
            this.issues.push({
              code: "unknown-member",
              start: nameTok.start,
              end: nameTok.end,
              data: {
                module: info.module || entry.source,
                name: nameTok.value,
                suggestion: closest(
                  nameTok.value,
                  M.membersOf(type).map((x) => x.name),
                ),
              },
            });
          }
        }
        const sym = this.declare(this.scope, {
          name: nameTok.value,
          kind: "import",
          nameTok,
          start: (kw || nameTok).start,
          end: nameTok.end,
          type: t,
          importSource: entry.source,
        });
        sym.destructured = true;
        entry.symbols.push(sym);
      }
      return;
    }

    const nameTok = aliasTok;
    const name = nameTok ? nameTok.value : info.name;
    if (!name) return;
    const sym = this.declare(this.scope, {
      name,
      kind: "import",
      nameTok: nameTok || entry.tok,
      start: (kw || entry.tok).start,
      end: entry.tok.end,
      type,
      importSource: entry.source,
    });
    // the name range of an implicit alias is the string token (hover/definition anchor)
    sym.implicitName = !nameTok;
    entry.symbols.push(sym);
  }

  parseExport() {
    const kw = this.next(); // export
    if (!this.isPunct("(")) return;
    this.next();
    while (!this.eof && !this.isPunct(")")) {
      const before = this.p;
      const t = this.peek();
      if (t.type === "ident" && !this.isPunct(":", 1)) {
        this.next();
        const ref = this.addRef(t, { exported: true });
        this.exports.push({ name: t.value, tok: t, ref });
      } else if ((t.type === "ident" || t.type === "string") && this.isPunct(":", 1)) {
        this.next();
        this.next();
        this.exports.push({
          name: t.type === "string" ? stringValue(t) : t.value,
          tok: t,
          ref: null,
        });
        this.parseExpr();
      } else if (this.isPunct(",")) this.next();
      if (this.p === before) this.next();
    }
    if (this.isPunct(")")) this.next();
    if (this.isPunct(";")) this.next();
    void kw;
  }

  // ───────────────────────── control flow ─────────────────────────

  parseParenExpr() {
    if (!this.isPunct("(")) return;
    this.next();
    this.parseExpr();
    if (this.isPunct(")")) this.next();
  }

  parseIf() {
    this.next(); // if
    this.parseParenExpr();
    this.parseBody();
    if (this.isKw("else")) {
      this.next();
      this.parseBody();
    }
  }

  parseWhile() {
    this.next();
    this.parseParenExpr();
    this.parseBody();
  }

  parseFor() {
    const kw = this.next(); // for
    if (this.isPunct("{")) return void this.parseBlock("block");
    const scope = this.pushScope("for", kw.start);
    if (this.isPunct("(")) {
      this.next();
      if (this.isKw("var")) {
        const varTok = this.next();
        const declared = [];
        if (this.isPunct("(")) {
          // for (var (k, v) in obj)
          this.next();
          while (!this.eof && !this.isPunct(")")) {
            const t = this.peek();
            if (t.type === "ident") {
              this.next();
              declared.push(
                this.declare(scope, {
                  name: t.value,
                  kind: "variable",
                  nameTok: t,
                  start: varTok.start,
                  end: t.end,
                }),
              );
            } else this.next();
          }
          if (this.isPunct(")")) this.next();
        } else {
          this.parseDeclarator(varTok, "", { kind: "variable" }, declared);
        }
        if (this.peek().type === "reflect" && this.peek().value === "in") {
          this.next();
          const iterable = this.parseExpr();
          // `for (var item in items)` gives `item` the element type of `items`
          if (declared.length === 1 && !declared[0].type) {
            const element = M.iterationType(iterable && iterable.type);
            if (element) declared[0].type = element;
            else if (iterable && iterable.deferType && iterable._ref)
              declared[0].deferIteration = iterable._ref;
          }
        }
      } else if (!this.isPunct(";")) {
        this.parseExpr();
        if (this.peek().type === "reflect" && this.peek().value === "in") {
          this.next();
          this.parseExpr();
        }
      }
      if (this.isPunct(";")) {
        this.next();
        if (!this.isPunct(";")) this.parseExpr();
        if (this.isPunct(";")) this.next();
        if (!this.isPunct(")")) this.parseExpr();
      }
      if (this.isPunct(")")) this.next();
    }
    this.parseBody();
    scope.end = this.lastEnd();
    this.popScope();
  }

  parseMatch() {
    this.next(); // match
    this.parseParenExpr();
    if (!this.isPunct("{")) return;
    const open = this.next();
    const scope = this.pushScope("block", open.start);
    while (!this.eof && !this.isPunct("}")) {
      const before = this.p;
      if (this.isKw("case")) {
        this.next();
        if (this.isPunct("(")) {
          this.next();
          if (this.isPunct(".")) {
            // case (.property)
            this.next();
            if (this.isWordToken(this.peek())) this.next();
            while (this.isPunct(".") || this.isPunct("[")) {
              if (this.isPunct(".")) {
                this.next();
                if (this.isWordToken(this.peek())) this.next();
              } else {
                this.next();
                this.parseExpr();
                if (this.isPunct("]")) this.next();
              }
            }
          } else {
            this.parseExpr();
          }
          if (this.isPunct(")")) this.next();
        } else {
          this.parseExpr(); // tolerated: `case value:`
        }
        if (this.isPunct(":")) this.next();
        this.parseCaseBody();
      } else if (this.isKw("default")) {
        this.next();
        if (this.isPunct(":")) this.next();
        this.parseCaseBody();
      }
      if (this.p === before) this.next();
    }
    const close = this.isPunct("}") ? this.next() : null;
    scope.end = close ? close.end : this.text.length;
    this.popScope();
  }

  parseCaseBody() {
    // stacked `case (x): case (y): {...}` is handled by the match loop
    if (this.isKw("case") || this.isKw("default") || this.isPunct("}")) return;
    this.parseBody();
  }

  parseTryStatement() {
    this.next(); // try
    this.parseBlock("block");
    if (this.isKw("catch")) this.parseCatchClause();
    if (this.isKw("finally")) {
      this.next();
      this.parseBlock("block");
    }
  }

  parseCatchClause() {
    const kw = this.next(); // catch
    const scope = this.pushScope("catch", kw.start);
    if (this.isPunct("(")) {
      this.next();
      const t = this.peek();
      if (t.type === "ident") {
        this.next();
        this.declare(scope, {
          name: t.value,
          kind: "catch",
          nameTok: t,
          start: t.start,
          end: t.end,
        });
      }
      if (this.isPunct(")")) this.next();
    }
    if (this.isPunct("{")) this.parseBlock("catch", scope);
    scope.end = this.lastEnd();
    this.popScope();
  }

  parseReturn() {
    this.next(); // return
    const t = this.peek();
    if (t.type === "eof" || (t.type === "punct" && (t.value === ";" || t.value === "}"))) return;
    // a `return` followed by a keyword that starts a new statement on the next line is bare
    const info = this.parseExpr();
    const fn = this.currentFn();
    if (!fn || !info) return;
    if (!fn.returnCandidates) fn.returnCandidates = [];
    fn.returnCandidates.push(
      info.type ||
        (info._ref ? { ref: info._ref } : info.memberRef ? { memberRef: info.memberRef } : null),
    );
    if (info.type && !fn.returnType) fn.returnType = info.type;
  }

  // ───────────────────────── expressions ─────────────────────────

  /** Parses an expression; returns {type, ref?, root?, ...} (never throws). */
  parseExpr() {
    let info = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === "op") {
        if (ASSIGN_OPS.has(t.value)) {
          this.markWrite(info, t.value !== "=");
          const op = t.value;
          this.next();
          const rhs = this.parseExpr();
          // `this.items = []` in a constructor is what tells us the field's type
          if (op === "=" && info && info.memberRef && rhs) {
            this.fieldAssignments.push({
              memberRef: info.memberRef,
              value:
                rhs.type ||
                (rhs._ref
                  ? { ref: rhs._ref }
                  : rhs.memberRef
                    ? { memberRef: rhs.memberRef }
                    : null),
            });
          }
          return rhs || info;
        }
        if (BIN_OPS.has(t.value)) {
          this.next();
          this.parseUnary();
          info = { type: null };
          continue;
        }
        if (t.value === "?") {
          this.next();
          this.parseExpr();
          if (this.isPunct(":")) this.next();
          this.parseExpr();
          info = { type: null };
          continue;
        }
        break;
      }
      if (t.type === "reflect" && t.value === "in") {
        this.next();
        this.parseUnary();
        info = { type: null };
        continue;
      }
      if (t.type === "keyword" && t.value === "as") {
        const n = this.peek(1);
        if (n.type === "keyword" && MODS.has(n.value)) {
          this.next();
          this.next();
          if (this.declCtx) for (const s of this.declCtx) this.applyMod(s, n.value);
          continue;
        }
        this.next();
        this.parseUnary(); // `throw "msg" as { ... }` / `as ErrorStruct(...)`
        continue;
      }
      break;
    }
    return info;
  }

  markWrite(info, compound) {
    if (!info) return;
    if (info.ref && !info.viaMember && !info.viaIndex) {
      info.ref.write = true;
      info.ref.read = !!compound;
    }
    if (info.root && (info.viaMember || info.viaIndex)) {
      this.mutations.push({ root: info.root, start: info.targetStart, end: info.targetEnd });
    }
    if (info.memberRef) {
      info.memberRef.write = true;
      // `Color.Red = 1` and `Color.Red++` alike: an enum member is a constant, and `++`
      // goes through the same path as `+= 1`, so the same rule applies (MyLang2 2.3)
      const member = info.memberRef.member;
      const symbol = member && member.origin === "user" ? member.symbol : null;
      if (symbol && symbol.kind === "enumMember") {
        this.issues.push({
          code: "enum-member-assign",
          start: info.memberRef.start,
          end: info.memberRef.end,
          data: {
            name: info.memberRef.name,
            owner: symbol.parent ? symbol.parent.name : "",
          },
        });
      }
    }
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === "op" && (PREFIX_OPS.has(t.value) || t.value === "...")) {
      this.next();
      const operand = this.parseUnary();
      if ((t.value === "++" || t.value === "--") && operand) this.markWrite(operand, true);
      return {
        type:
          t.value === "..." ? null : t.value === "!" ? { kind: "primitive", name: "bool" } : null,
      };
    }
    if (t.type === "reflect" && t.value === "typeof") {
      this.next();
      this.parseUnary();
      return { type: { kind: "primitive", name: "string" } };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  /** Resolve chained calls and member/index access while retaining partial code. */
  parsePostfix(info) {
    for (;;) {
      const t = this.peek();
      if (t.type === "punct" && t.value === ".") {
        info = this.parseMemberAccess(info, false);
        continue;
      }
      if (t.type === "op" && t.value === "?") {
        const n = this.peek(1);
        const adjacent = n.start === t.end;
        if (adjacent && n.type === "punct" && n.value === ".") {
          this.next(); // ?
          info = this.parseMemberAccess(info, true);
          continue;
        }
        if (adjacent && n.type === "punct" && n.value === "[") {
          this.next();
          info = this.parseIndex(info);
          continue;
        }
        break;
      }
      if (t.type === "punct" && t.value === "(") {
        info = this.parseCall(info);
        continue;
      }
      if (t.type === "punct" && t.value === "[") {
        info = this.parseIndex(info);
        continue;
      }
      if (t.type === "op" && (t.value === "++" || t.value === "--")) {
        this.next();
        this.markWrite(info, true);
        // postfix: the expression is the value *before* the step, so it keeps the type
        // the target had — `var prev = o.n++;` is as typed as `var prev = o.n;`
        info = { type: (info && info.type) || null };
        continue;
      }
      break;
    }
    return info || { type: null };
  }

  parseMemberAccess(info, optional) {
    const dot = this.next(); // .
    info = info || { type: null };
    const ownerType = info.type || null;
    this.dots.push({ dotStart: dot.start, dotEnd: dot.end, ownerType, optional });

    const t = this.peek();
    if (this.isWordToken(t) && this.sameLine(dot.end, t.start)) {
      this.next();
      const member = ownerType ? M.memberOf(ownerType, t.value) : null;
      const ref = {
        name: t.value,
        start: t.start,
        end: t.end,
        ownerType,
        member,
        write: false,
        kind: "member",
        ownerModule: ownerType && ownerType.kind === "module" ? ownerType.module : null,
      };
      this.memberRefs.push(ref);
      if (member && member.origin === "user" && member.symbol) member.symbol.refs.push(ref);
      return {
        type: member ? M.memberType(ownerType, member) : null,
        memberRef: ref,
        viaMember: true,
        root: info.root || null,
        targetStart: info.targetStart ?? t.start,
        targetEnd: t.end,
      };
    }
    return { type: null, viaMember: true, root: info.root || null };
  }

  parseIndex(info) {
    const open = this.next(); // [
    this.parseExpr();
    if (this.isPunct("]")) this.next();
    // `items[0]` is an element of `items`, `text[0]` a character of `text`
    return {
      type: M.indexType(info && info.type),
      viaIndex: true,
      root: info && info.root ? info.root : null,
      targetStart: info && info.targetStart != null ? info.targetStart : open.start,
      targetEnd: this.lastEnd(),
    };
  }

  /** Collect argument ranges and commas for signature help at the caret. */
  parseCall(calleeInfo) {
    const open = this.next(); // (
    const calleeType = calleeInfo ? calleeInfo.type : null;
    const record = {
      open: open.start,
      close: Infinity,
      calleeType,
      calleeName:
        calleeInfo &&
        (calleeInfo.memberRef
          ? calleeInfo.memberRef.name
          : calleeInfo.ref
            ? calleeInfo.ref.name
            : ""),
      commas: [],
    };
    this.calls.push(record);

    const isRoute =
      calleeInfo &&
      calleeInfo.memberRef &&
      HTTP_ROUTE_METHODS.has(calleeInfo.memberRef.name) &&
      calleeInfo.memberRef.ownerType &&
      calleeInfo.memberRef.ownerType.kind === "std" &&
      /^http\.Server\(\)$/.test(calleeInfo.memberRef.ownerType.path || "");

    let index = 0;
    while (!this.eof && !this.isPunct(")")) {
      if (this.isPunct(",")) {
        record.commas.push(this.next().start);
        index++;
        continue;
      }
      const before = this.p;
      if (this.isKw("func")) {
        const ctxType = isRoute
          ? M.stdType(
              M.stdlib.modules["net/http"].types && M.stdlib.modules["net/http"].types.Context,
              "http.Context",
            )
          : null;
        this.argHint = ctxType && ctxType.desc ? { paramType: ctxType } : null;
      }
      this.parseExpr();
      this.argHint = null;
      if (this.p === before) this.next();
      void index;
    }
    let close = null;
    if (this.isPunct(")")) close = this.next();
    record.close = close ? close.end : this.text.length;

    const result = M.callResult(calleeType);
    // a user function's result may still be refined after the whole file is parsed
    const callee =
      calleeType && calleeType.kind === "function" && calleeType.symbol ? calleeType.symbol : null;
    return { type: result, root: null, calleeSymbol: callee };
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.type) {
      case "number": {
        this.next();
        // the language tells `int`, `float` and `bigint` apart, and so does `typeof`
        const text = this.text.slice(t.start, t.end);
        const name = text.endsWith("n") ? "bigint" : /[.]|[eE][+-]?\d/.test(text) ? "float" : "int";
        return { type: { kind: "primitive", name } };
      }
      case "string":
        this.next();
        if (t.kind === "interp" && t.exprs) this.parseInterpolations(t);
        return { type: { kind: "primitive", name: "string" } };
      case "bool":
        this.next();
        return { type: { kind: "primitive", name: "bool" } };
      case "nil":
        this.next();
        return { type: { kind: "primitive", name: "nil" } };
      case "ident":
        return this.parseIdentifier();
      case "keyword":
        return this.parseKeywordExpr(t);
      case "punct":
        if (t.value === "(") return this.parseGroup();
        if (t.value === "[") return this.parseArray();
        if (t.value === "{") return this.parseObject();
        return { type: null };
      default:
        return { type: null };
    }
  }

  parseIdentifier() {
    const t = this.next();
    if (t.value === "this") {
      return { type: this.thisTypeAt(this.scope), isThis: true };
    }
    const ref = this.addRef(t);
    // eager lookup: gives member-chain types for names declared earlier in the file
    const sym = this.lookup(this.scope, t.value);
    let type = null;
    if (sym) type = this.typeOfSymbol(sym);
    else if (lang.IMPLICIT_NAMES.has(t.value)) type = M.globalType(t.value);
    return {
      ref,
      root: ref,
      type,
      deferType: true,
      targetStart: t.start,
      targetEnd: t.end,
      _ref: ref,
    };
  }

  parseKeywordExpr(t) {
    switch (t.value) {
      case "func":
        return this.parseFunction({ declaration: false });
      case "struct":
        return this.parseStruct({ declaration: false });
      case "enum":
        return this.parseEnum({ declaration: false });
      case "import": {
        if (this.isPunct("(", 1)) {
          // dynamic import("file") / import("core:strings")
          const kw = this.next();
          this.next();
          let type = null;
          if (this.peek().type === "string") {
            const strTok = this.next();
            const source = stringValue(strTok);
            const info = M.importInfo(source);
            this.imports.push({
              source,
              tok: strTok,
              kind: "dynamic",
              resolvedKind: info.kind,
              module: info.module || null,
              core: !!info.core,
              symbols: [],
              stmtStart: kw.start,
              stmtEnd: strTok.end,
              builtin: info.kind === "builtin",
            });
            // a dynamic import of a built-in is the module itself, so members resolve
            if (info.kind === "builtin") type = M.moduleType(info.module);
            else if (info.kind === "core-unknown") {
              this.issues.push({
                code: "unknown-core-module",
                start: strTok.start,
                end: strTok.end,
                data: {
                  source,
                  name: info.module,
                  suggestion: closest(info.module, M.BUILTIN_MODULES),
                },
              });
            }
          }
          if (this.isPunct(")")) this.next();
          return { type };
        }
        this.next();
        const ref = this.addRef(t, { keywordGlobal: true });
        return {
          ref,
          root: ref,
          type: M.globalType("import"),
          targetStart: t.start,
          targetEnd: t.end,
        };
      }
      case "wait": {
        if (this.isPunct(".", 1) || this.isOp("?", 1)) {
          this.next();
          const ref = this.addRef(t, { keywordGlobal: true });
          return {
            ref,
            root: ref,
            type: M.globalType("wait"),
            targetStart: t.start,
            targetEnd: t.end,
          };
        }
        this.next();
        this.parseUnary();
        return { type: null };
      }
      case "spawn": {
        this.next();
        if (this.isPunct("{")) this.parseBlock("function");
        else this.parseUnary();
        return { type: null };
      }
      case "defer": {
        this.next();
        this.parseUnary();
        return { type: null };
      }
      case "try": {
        this.next();
        this.parseExpr();
        if (this.isKw("catch")) this.parseCatchClause();
        else if (this.isKw("else")) {
          this.next();
          this.parseBlock("block");
        }
        return { type: null };
      }
      default:
        return { type: null };
    }
  }

  parseGroup() {
    this.next(); // (
    let last = null;
    let count = 0;
    while (!this.eof && !this.isPunct(")")) {
      if (this.isPunct(",")) {
        this.next();
        continue;
      }
      const before = this.p;
      last = this.parseExpr();
      count++;
      if (this.p === before) this.next();
    }
    if (this.isPunct(")")) this.next();
    return count === 1 && last
      ? { type: last.type, ref: undefined, root: last.root }
      : { type: null };
  }

  /** `[a, b, c]`; when every element has the same type the array is typed `array<T>`. */
  parseArray() {
    this.next(); // [
    const elements = [];
    let spread = false;
    while (!this.eof && !this.isPunct("]")) {
      if (this.isPunct(",")) {
        this.next();
        continue;
      }
      const before = this.p;
      if (this.isOp("...")) spread = true;
      const info = this.parseExpr();
      elements.push(info && info.type ? info.type : null);
      if (this.p === before) this.next();
    }
    if (this.isPunct("]")) this.next();
    const element = spread || !elements.length ? null : M.unifyTypes(elements);
    return { type: M.arrayOf(element) };
  }

  parseObject() {
    const open = this.next(); // {
    const members = new Map();
    const type = { kind: "object", members, symbol: null };
    void open;

    while (!this.eof && !this.isPunct("}")) {
      const before = this.p;
      if (this.isPunct(",") || this.isPunct(";")) {
        this.next();
        continue;
      }
      if (this.isOp("...")) {
        this.next();
        this.parseExpr();
      } else if (this.isPunct("[")) {
        this.next();
        this.parseExpr();
        if (this.isPunct("]")) this.next();
        if (this.isPunct(":")) {
          this.next();
          this.parseExpr();
        }
      } else {
        const key = this.peek();
        if (this.isWordToken(key) || key.type === "string" || key.type === "number") {
          this.next();
          const keyName = key.type === "string" ? stringValue(key) : key.value;
          const doc = this.docFor(key);
          const addMember = (kind, extra = {}) => {
            const sym = this.declare(null, {
              name: keyName,
              kind,
              nameTok: key,
              start: key.start,
              end: key.end,
              doc,
              isMember: true,
              ...extra,
            });
            if (!members.has(keyName)) members.set(keyName, sym);
            return sym;
          };

          if (this.isPunct("(")) {
            // method shorthand: name(params) { ... }
            const sym = addMember("method", { parent: null });
            this.parseMethodBody(sym, type);
            sym.end = this.lastEnd();
          } else if (this.isPunct(":")) {
            this.next();
            const sym = addMember("property");
            if (this.isKw("func")) this.thisHint = type;
            const info = this.parseExpr();
            this.thisHint = null;
            if (info && info.type) {
              sym.type = info.type;
              if (info.type.kind === "function") sym.kind = "method";
            }
            if (info && info.deferType && info._ref) sym.deferRef = info._ref;
            sym.end = this.lastEnd();
          } else if (key.type === "ident") {
            // shorthand `{ name }` -> reference + property
            const ref = this.addRef(key);
            const sym = addMember("property");
            sym.deferRef = ref;
          }
        }
      }
      if (this.p === before) this.next();
    }
    if (this.isPunct("}")) this.next();
    return { type };
  }

  /** `(params) { body }` of an object method shorthand; symbol already declared. */
  parseMethodBody(sym, thisType) {
    const scope = this.pushScope("function", this.peek().start);
    scope.fn = sym;
    scope.thisType = thisType;
    const savedDecl = this.declCtx;
    this.declCtx = null;
    this.fnStack.push(sym);
    const params = [];
    if (this.isPunct("(")) {
      this.next();
      while (!this.eof && !this.isPunct(")")) {
        if (this.eatPunct(",")) continue;
        const before = this.p;
        let rest = false;
        if (this.isOp("...")) {
          this.next();
          rest = true;
        }
        const pt = this.peek();
        if (pt.type === "ident") {
          this.next();
          const param = { name: pt.value, rest };
          const psym = this.declare(scope, {
            name: pt.value,
            kind: "parameter",
            nameTok: pt,
            start: pt.start,
            end: pt.end,
          });
          const documentedParam = parameterDoc(sym.jsdoc, pt.value);
          if (documentedParam) {
            psym.doc = documentedParam.description;
            psym.jsdoc = parseJSDoc(documentedParam.description);
            psym.jsdoc.type = documentedParam.type;
            if (documentedParam.type) param.type = documentedParam.type;
            if (documentedParam.optional) param.optional = true;
          }
          if (this.isOp("=")) {
            this.next();
            const defStart = this.peek().start;
            this.parseExpr();
            param.optional = true;
            param.default = this.text.slice(defStart, this.lastEnd()).trim();
          }
          params.push(param);
        }
        if (this.p === before) this.next();
      }
      if (this.isPunct(")")) this.next();
    }
    sym.params = params;
    if (this.isPunct("{")) this.parseBlock("function", scope);
    scope.end = Math.max(scope.end === Infinity ? 0 : scope.end, this.lastEnd());
    this.fnStack.pop();
    this.declCtx = savedDecl;
    this.popScope();
  }

  /** Analyzes the `{expr}` pieces of an interpolated string `$"..."`. */
  parseInterpolations(tok) {
    if (this.interpDepth > 3) return;
    for (const range of tok.exprs) {
      const slice = this.text.slice(range.start, range.end);
      if (!slice.trim()) continue;
      const sub = tokenize(slice).map((x) => ({
        ...x,
        start: x.start + range.start,
        end: x.end + range.start,
      }));
      const savedToks = this.toks;
      const savedP = this.p;
      this.toks = sub.filter((x) => x.type !== "comment");
      this.p = 0;
      this.interpDepth++;
      try {
        while (!this.eof) {
          const before = this.p;
          this.parseExpr();
          if (this.p === before) this.next();
        }
      } finally {
        this.interpDepth--;
        this.toks = savedToks;
        this.p = savedP;
      }
    }
  }

  // ───────────────────────── resolution ─────────────────────────

  /** Resolve identifier references after all declarations have been visited. */
  resolve() {
    const exportedNames = new Set(this.exports.map((e) => e.name));
    void exportedNames;

    for (const ref of this.refs) {
      const sym = this.lookup(ref.scope, ref.name);
      if (sym) {
        ref.symbol = sym;
        sym.refs.push(ref);
        if (ref.read) sym.reads++;
      } else if (this.isImplicitName(ref)) {
        ref.builtin = true;
      } else if (!ref.keywordGlobal) {
        this.issues.push({
          code: "unresolved",
          start: ref.start,
          end: ref.end,
          data: { name: ref.name },
        });
      }
    }

    // Types are settled in a loop: a field typed by `@type` gives a method its return
    // type, which in turn types the variable that holds the call's result.
    this.applyDocumentedTypes();
    for (let pass = 0; pass < 5; pass++) {
      const changed = this.settleTypes();
      this.applyDocumentedTypes();
      if (!changed) break;
    }
  }

  /**
   * Is this name resolvable without a declaration? Implicit globals always are;
   * `arguments` only inside a function body.
   */
  isImplicitName(ref) {
    if (this.options.globals?.has(ref.name)) return true;
    if (!lang.IMPLICIT_NAMES.has(ref.name)) return false;
    if (!lang.FUNCTION_SCOPED_NAMES.has(ref.name)) return true;
    for (let s = ref.scope; s; s = s.parent) if (s.kind === "function") return true;
    return false;
  }

  /** Type of a reference once every declaration is known. */
  typeOfResolvedRef(ref) {
    if (!ref) return null;
    if (ref.symbol) return this.typeOfSymbol(ref.symbol);
    if (ref.builtin || ref.keywordGlobal) return M.globalType(ref.name);
    return null;
  }

  /** Type of `owner.name` re-evaluated against the owner type as it stands now. */
  typeOfLateMember(memberRef) {
    if (!memberRef || !memberRef.ownerType) return null;
    const member = M.memberOf(memberRef.ownerType, memberRef.name);
    return member ? M.memberType(memberRef.ownerType, member) : null;
  }

  /** The type a deferred initialiser produces right now, or null. */
  lateTypeOf(source) {
    if (!source) return null;
    if (source.ref) return this.typeOfResolvedRef(source.ref);
    if (source.memberRef) return this.typeOfLateMember(source.memberRef);
    if (source.iterationRef) return M.iterationType(this.typeOfResolvedRef(source.iterationRef));
    if (source.kind) return source; // already a type
    return null;
  }

  /**
   * One round of the types that are only knowable after the whole file is parsed:
   * `var a = b` with `b` declared later, object shorthand (`{ name }`),
   * `for (var item in items)`, member access, and results of user functions.
   * @returns {boolean} whether anything became known
   */
  settleTypes() {
    let changed = false;
    const assign = (sym, type) => {
      if (!type || M.sameType(sym.type, type)) return;
      if (sym.type && !this.preferDocumented(sym.type, type)) return;
      sym.type = type;
      changed = true;
    };

    for (const sym of this.symbols) {
      if (sym.deferRef) assign(sym, this.typeOfResolvedRef(sym.deferRef));
      if (sym.deferMemberRef) assign(sym, this.typeOfLateMember(sym.deferMemberRef));
      if (sym.deferIteration)
        assign(sym, M.iterationType(this.typeOfResolvedRef(sym.deferIteration)));
    }

    // a function's result: the common type of its `return` statements
    for (const sym of this.symbols) {
      if (!sym.returnCandidates) continue;
      const types = sym.returnCandidates.map((c) => this.lateTypeOf(c));
      const unified = M.unifyTypes(types);
      const next = unified || (types.length === 1 ? types[0] : null);
      if (next && !M.sameType(sym.returnType, next)) {
        if (!sym.returnType || this.preferDocumented(sym.returnType, next)) {
          sym.returnType = next;
          changed = true;
        }
      }
    }

    // `var value = compute();` once `compute`'s result type is final
    for (const sym of this.symbols) {
      const callee = sym.deferCallee;
      if (callee && callee.returnType) assign(sym, callee.returnType);
    }

    // fields a constructor fills in: `this.items = []`
    for (const { memberRef, value } of this.fieldAssignments) {
      const owner = memberRef.ownerType;
      if (!owner || (owner.kind !== "instance" && owner.kind !== "object")) continue;
      const member = M.memberOf(owner, memberRef.name);
      const sym = member && member.origin === "user" ? member.symbol : null;
      if (sym && !sym.type) assign(sym, this.lateTypeOf(value));
    }
    return changed;
  }

  /**
   * JSDoc `@type` / `@param {T}` / `@returns {T}` as editor types. Inference always
   * wins: documentation only fills in what the analyzer could not work out itself.
   */
  applyDocumentedTypes() {
    for (const sym of this.symbols) {
      const jsdoc = sym.jsdoc;
      if (!jsdoc) continue;
      if (!sym.type && jsdoc.type) {
        const type = this.typeFromDoc(jsdoc.type, sym.scope);
        if (type) {
          sym.type = type;
          sym.documentedType = jsdoc.type;
        }
      }
      if (
        (sym.kind === "function" || sym.kind === "method") &&
        jsdoc.returns &&
        jsdoc.returns.type
      ) {
        const type = this.typeFromDoc(jsdoc.returns.type, sym.scope);
        if (type && this.preferDocumented(sym.returnType, type)) sym.returnType = type;
      }
    }
  }

  /**
   * Should a documented type replace an inferred one? Only when it adds information:
   * nothing was inferred, or the inference stopped at a bare `array` the documentation
   * describes in full (`@returns {string[]}`). Otherwise the code wins.
   */
  preferDocumented(inferred, documented) {
    if (!inferred) return true;
    if (inferred.kind === "array" && documented.kind === "array" && !inferred.element)
      return !!documented.element;
    return false;
  }

  /**
   * A documented type name as an editor type: primitives, `T[]` / `Array<T>` and the
   * structs and enums the file declares (`@returns {User}` -> a `User` instance).
   */
  typeFromDoc(text, scope) {
    const raw = String(text || "")
      .replace(/^\s*\(?\s*/, "")
      .replace(/\s*\)?\s*$/, "")
      .trim();
    if (!raw || raw === "*" || raw === "any" || raw === "unknown") return null;

    // `string?` / `?string` / `string|nil` describe an optional value of that type
    const optional = raw.replace(/\?/g, "").trim();
    const parts = optional
      .split("|")
      .map((p) => p.trim())
      .filter((p) => p && p !== "nil" && p !== "null" && p !== "undefined");
    if (parts.length !== 1) return null;
    const name = parts[0];

    const array = /^(?:Array|array)\s*<([\s\S]+)>$/.exec(name) || /^([\s\S]+?)\[\]$/.exec(name);
    if (array) return M.arrayOf(this.typeFromDoc(array[1], scope));

    const lower = name.toLowerCase();
    const DOC_PRIMITIVES = {
      string: "string",
      str: "string",
      int: "int",
      integer: "int",
      float: "float",
      number: "float",
      double: "float",
      bool: "bool",
      boolean: "bool",
      nil: "nil",
      null: "nil",
      void: "nil",
      object: "object",
      bytes: "bytes",
      buffer: "bytes",
      func: "func",
      function: "func",
      bigint: "bigint",
      map: "map",
      set: "set",
      iterable: "iterable",
    };
    if (lower === "array") return M.arrayOf(null);
    if (DOC_PRIMITIVES[lower]) return { kind: "primitive", name: DOC_PRIMITIVES[lower] };

    const declared = this.lookup(scope || this.root, name);
    if (declared) {
      if (declared.kind === "struct") return { kind: "instance", symbol: declared };
      if (declared.kind === "enum") return { kind: "enumValue", symbol: declared };
    }
    return null;
  }

  /** Best-effort type of a symbol (follows `var a = b` aliases, import namespaces ...). */
  typeOfSymbol(sym, depth = 0) {
    if (!sym || depth > 6) return null;
    if (sym.type) return sym.type;
    switch (sym.kind) {
      case "struct":
        return { kind: "struct", symbol: sym };
      case "enum":
        return { kind: "enum", symbol: sym };
      case "function":
      case "method":
        return { kind: "function", symbol: sym };
      default:
        return null;
    }
  }

  // ───────────────────────── final model ─────────────────────────

  /** Assemble the immutable-style analysis result and semantic issue list. */
  finish() {
    // assignments through const/readonly bindings
    for (const ref of this.refs) {
      if (ref.write && ref.symbol && ref.symbol.mods.const && ref.symbol.kind !== "import") {
        this.issues.push({
          code: "const-assign",
          start: ref.start,
          end: ref.end,
          data: { name: ref.name, readonly: !!ref.symbol.mods.readonly, symbol: ref.symbol },
        });
      }
    }
    for (const m of this.mutations) {
      const sym = m.root && m.root.symbol;
      if (sym && sym.mods.readonly) {
        this.issues.push({
          code: "readonly-modify",
          start: m.start ?? m.root.start,
          end: m.end ?? m.root.end,
          data: { name: sym.name },
        });
      }
    }
    // unknown members of built-in modules: `strings.splitt`
    for (const mr of this.memberRefs) {
      if (mr.ownerType && mr.ownerType.kind === "module" && !mr.member) {
        this.issues.push({
          code: "unknown-member",
          start: mr.start,
          end: mr.end,
          data: {
            module: mr.ownerType.module,
            name: mr.name,
            suggestion: closest(
              mr.name,
              M.membersOf(mr.ownerType).map((x) => x.name),
            ),
          },
        });
      }
    }
    // unused declarations
    for (const sym of this.symbols) {
      if (sym.isMember || sym.reads > 0 || (sym.refs.length > 0 && sym.kind !== "variable"))
        continue;
      const isGlobal = sym.scope === this.root;
      if (sym.kind === "variable" || sym.kind === "catch" || sym.kind === "import") {
        if (sym.kind === "variable" && sym.refs.length > 0 && sym.reads === 0) {
          this.issues.push({
            code: "unused",
            start: sym.nameStart,
            end: sym.nameEnd,
            data: { name: sym.name, kind: sym.kind, writeOnly: true },
          });
        } else if (sym.refs.length === 0) {
          this.issues.push({
            code: "unused",
            start: sym.nameStart,
            end: sym.nameEnd,
            data: { name: sym.name, kind: sym.kind, symbol: sym },
          });
        }
      } else if (
        !isGlobal &&
        (sym.kind === "function" || sym.kind === "struct" || sym.kind === "enum") &&
        sym.refs.length === 0
      ) {
        this.issues.push({
          code: "unused",
          start: sym.nameStart,
          end: sym.nameEnd,
          data: { name: sym.name, kind: sym.kind, symbol: sym },
        });
      }
    }

    // occurrences, sorted for position lookups
    const occ = [];
    for (const s of this.symbols) {
      if (s.name.startsWith("(")) continue;
      occ.push({ start: s.nameStart, end: s.nameEnd, symbol: s, kind: "decl" });
    }
    for (const r of this.refs)
      occ.push({ start: r.start, end: r.end, symbol: r.symbol, kind: "ref", ref: r });
    for (const m of this.memberRefs) {
      occ.push({
        start: m.start,
        end: m.end,
        symbol: m.member && m.member.symbol ? m.member.symbol : null,
        kind: "member",
        member: m,
        ref: m,
      });
    }
    occ.sort((a, b) => a.start - b.start || (a.kind === "decl" ? -1 : 1));

    return {
      root: this.root,
      symbols: this.symbols,
      refs: this.refs,
      memberRefs: this.memberRefs,
      occurrences: occ,
      dots: this.dots,
      calls: this.calls,
      imports: this.imports,
      exports: this.exports,
      issues: this.issues,
      tokens: this.allTokens,
      analyzer: this,
    };
  }
}

/**
 * @param {string} text
 * @param {{globals?: Set<string>}} [options]
 * @returns {Analysis}
 */
function analyze(text, options = {}) {
  const tokens = tokenize(text);
  const analyzer = new Analyzer(text, tokens, options);
  const result = analyzer.run();
  result.text = text;
  return result;
}

/** Refreshes types of references after resolution (call once, lazily, by features). */
function typeOfRef(analysis, ref) {
  if (!ref) return null;
  if (ref.symbol) return analysis.analyzer.typeOfSymbol(ref.symbol);
  if (ref.builtin || ref.keywordGlobal) return M.globalType(ref.name);
  return null;
}

/** Finds the occurrence whose range contains `offset`. */
function occurrenceAt(analysis, offset) {
  const list = analysis.occurrences;
  let lo = 0;
  let hi = list.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = list[mid];
    if (offset < o.start) hi = mid - 1;
    else if (offset > o.end) lo = mid + 1;
    else {
      found = o;
      // prefer the declaration/ref that actually contains the offset; continue scanning neighbours
      break;
    }
  }
  if (!found) return null;
  // among equal-start occurrences prefer decl, then ref, then member
  let idx = list.indexOf(found);
  while (idx > 0 && list[idx - 1].start <= offset && list[idx - 1].end >= offset) idx--;
  return list[idx];
}

/** Innermost scope that contains `offset`. */
function scopeAt(analysis, offset) {
  let scope = analysis.root;
  for (;;) {
    let inner = null;
    for (const c of scope.children) {
      if (offset >= c.start && offset <= c.end) inner = c;
    }
    if (!inner) return scope;
    scope = inner;
  }
}

/** Symbols visible from `scope` (inner declarations shadow outer ones). */
function visibleSymbols(scope) {
  const seen = new Map();
  for (let s = scope; s; s = s.parent) {
    for (const [name, sym] of s.symbols) if (!seen.has(name)) seen.set(name, sym);
  }
  return [...seen.values()];
}

module.exports = { analyze, occurrenceAt, scopeAt, visibleSymbols, typeOfRef, Scope };
