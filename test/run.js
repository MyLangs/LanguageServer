"use strict";
/**
 * End-to-end tests: starts the real language server and talks LSP to it.
 *   node test/run.js [path-to-compiled-compiler/dist/src/index.js]
 * Without a compiler argument the built-in fallback checker is tested.
 */
const assert = require("assert");
const path = require("path");
const { Client } = require("./lsp-client");
const { parseJSDoc } = require("../server/core/jsdoc");

const compilerPath = process.argv[2] || process.env.MYLANG_COMPILER || "";
const fixtures = path.join(__dirname, "fixtures");
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(
      `  ✗ ${name}\n      ${((err && err.stack) || err).toString().split("\n").slice(0, 4).join("\n      ")}`,
    );
  }
}

(async () => {
  const c = new Client();
  await c.init(fixtures, compilerPath ? { compiler: { path: compilerPath } } : {});
  let n = 0;
  const open = async (text) => {
    const uri = `file://${fixtures}/doc${++n}.ml`;
    const diags = await c.open(uri, text);
    return {
      uri,
      diags,
      at: (line, character) => ({ textDocument: { uri }, position: { line, character } }),
    };
  };
  const labels = (items) => items.map((i) => i.label);

  console.log(
    `MyLang language server tests (compiler: ${compilerPath || "none - fallback checker"})`,
  );

  await test("clean file has no problems", async () => {
    const d = await open('import "coreio";\ncoreio.print("hi");\n');
    assert.deepStrictEqual(d.diags, []);
  });

  await test("syntax error is reported", async () => {
    if (!compilerPath) return; // needs the real parser
    const d = await open("var x = ;\n");
    assert.ok(
      d.diags.some((x) => x.severity === 1),
      JSON.stringify(d.diags),
    );
  });

  await test("unterminated string is reported", async () => {
    const d = await open('var s = "abc\n');
    assert.ok(d.diags.some((x) => x.severity === 1));
  });

  await test("undefined name / const assignment / unknown member", async () => {
    const d = await open(
      'import "strings";\nvar k = 1 as const;\nk = 2;\nstrings.splitt("a");\nprint(nope);\n',
    );
    const codes = d.diags.map((x) => x.code);
    assert.ok(codes.includes("const-assign"), codes.join());
    assert.ok(codes.includes("unknown-member"));
    assert.ok(codes.includes("unresolved"));
  });

  await test("readonly element assignment", async () => {
    const d = await open("var xs = [1, 2] as readonly;\nxs[0] = 5;\n");
    assert.ok(d.diags.some((x) => x.code === "readonly-modify"));
  });

  await test("duplicate declaration", async () => {
    const d = await open("var a = 1;\nvar a = 2;\n");
    assert.ok(d.diags.some((x) => x.code === "duplicate"));
  });

  await test("import names follow the interpreter rules (net/http -> http)", async () => {
    const d = await open('import "net/http";\nvar s = http.Server();\n');
    assert.ok(!d.diags.some((x) => x.code === "unresolved"), JSON.stringify(d.diags));
  });

  await test("member completion: module", async () => {
    const d = await open('import "strings";\nstrings.\n');
    const items = await c.request("textDocument/completion", d.at(1, 8));
    assert.ok(labels(items).includes("split") && labels(items).includes("trim"));
    assert.ok(!labels(items).includes("var"));
  });

  await test("member completion: struct instance, this, enum", async () => {
    const d = await open(
      "struct User {\n  var name;\n  func greet() { return this.\n}\n}\nvar u = User();\nu.\nenum Color { Red; Green; }\nColor.\n",
    );
    const inThis = await c.request("textDocument/completion", d.at(2, 29));
    assert.deepStrictEqual(labels(inThis).sort(), ["greet", "name"]);
    const onU = await c.request("textDocument/completion", d.at(6, 2));
    assert.deepStrictEqual(labels(onU).sort(), ["greet", "name"]);
    const onEnum = await c.request("textDocument/completion", d.at(8, 6));
    assert.deepStrictEqual(labels(onEnum).sort(), ["Green", "Red"]);
  });

  await test("member completion: instance returned by a stdlib class (http.Server)", async () => {
    const d = await open('import "net/http";\nvar s = http.Server();\ns.\n');
    const items = await c.request("textDocument/completion", d.at(2, 2));
    assert.ok(labels(items).includes("listen") && labels(items).includes("get"));
  });

  await test("keyword snippets and auto-import", async () => {
    const d = await open("fu\ncore\n");
    const kw = await c.request("textDocument/completion", d.at(0, 2));
    assert.ok(kw.find((i) => i.label === "func" && i.insertTextFormat === 2));
    const ai = await c.request("textDocument/completion", d.at(1, 4));
    const item = ai.find((i) => i.label === "coreio");
    assert.ok(item && item.additionalTextEdits.length === 1);
    // built-ins are imported through the `core:` namespace by default
    assert.ok(item.additionalTextEdits[0].newText.includes('import "core:coreio";'));
  });

  await test("import path completion (built-ins and relative files)", async () => {
    const d = await open('import "');
    const mods = await c.request("textDocument/completion", d.at(0, 8));
    assert.ok(labels(mods).includes("net/http") && labels(mods).includes("coreio"));
    const d2 = await open('import "./');
    const files = await c.request("textDocument/completion", d2.at(0, 10));
    assert.ok(labels(files).includes("utils.ml"), labels(files).join());
  });

  await test("hover: keyword, stdlib member, user symbol", async () => {
    const d = await open(
      'import "coreio";\n// adds numbers\nfunc add(a, b) { return a + b; }\ncoreio.print(add(1, 2));\n',
    );
    const kw = await c.request("textDocument/hover", d.at(2, 1));
    assert.ok(kw && /func/.test(kw.contents.value));
    const std = await c.request("textDocument/hover", d.at(3, 9));
    assert.ok(std && /print/.test(std.contents.value));
    const user = await c.request("textDocument/hover", d.at(3, 15));
    assert.ok(
      user &&
        /func add\(a, b\)/.test(user.contents.value) &&
        /adds numbers/.test(user.contents.value),
    );
  });

  await test("signature help with active parameter", async () => {
    const d = await open("func add(a, b) { return a + b; }\nadd(1, \n");
    const s = await c.request("textDocument/signatureHelp", d.at(1, 7));
    assert.ok(
      s && s.signatures[0].label === "add(a, b)" && s.activeParameter === 1,
      JSON.stringify(s),
    );
    const d2 = await open('import "strings";\nstrings.split(');
    const s2 = await c.request("textDocument/signatureHelp", d2.at(1, 14));
    assert.ok(
      s2 && /strings\.split\(str: string, separator, limit\)/.test(s2.signatures[0].label),
      JSON.stringify(s2),
    );
  });

  await test("go to definition, references, rename", async () => {
    const d = await open("var total = 1;\ntotal = total + 1;\nvar x = total;\n");
    const def = await c.request("textDocument/definition", d.at(2, 9));
    assert.strictEqual(def[0].range.start.line, 0);
    const refs = await c.request("textDocument/references", {
      ...d.at(0, 5),
      context: { includeDeclaration: true },
    });
    assert.strictEqual(refs.length, 4);
    const prep = await c.request("textDocument/prepareRename", d.at(0, 5));
    assert.strictEqual(prep.placeholder, "total");
    const edit = await c.request("textDocument/rename", { ...d.at(0, 5), newName: "sum" });
    assert.strictEqual(edit.changes[d.uri].length, 4);
    await assert.rejects(c.request("textDocument/rename", { ...d.at(0, 5), newName: "var" }));
  });

  await test("cross-file: import ./utils.ml members + definition", async () => {
    const d = await open('import "./utils.ml";\nutils.\nutils.add(1, 2);\n');
    const items = await c.request("textDocument/completion", d.at(1, 6));
    assert.deepStrictEqual(labels(items).sort(), ["PI", "add"]);
    const def = await c.request("textDocument/definition", d.at(2, 7));
    assert.ok(def[0].uri.endsWith("utils.ml"), JSON.stringify(def));
    const link = await c.request("textDocument/documentLink", { textDocument: { uri: d.uri } });
    assert.ok(link[0].target.endsWith("utils.ml"));
  });

  await test("package import: members, definition, hover, link (.module)", async () => {
    const d = await open('import "SempaI-07:console";\nconsole.\nconsole.log("x");\n');
    assert.deepStrictEqual(d.diags, [], JSON.stringify(d.diags));
    const items = await c.request("textDocument/completion", d.at(1, 8));
    assert.deepStrictEqual(labels(items).sort(), ["VERSION", "log"]);
    const def = await c.request("textDocument/definition", d.at(2, 9));
    assert.ok(def[0].uri.endsWith("console/src/index.ml"), JSON.stringify(def));
    const onString = await c.request("textDocument/definition", d.at(0, 12));
    assert.ok(onString[0].uri.endsWith("console/src/index.ml"), JSON.stringify(onString));
    const hv = await c.request("textDocument/hover", d.at(0, 12));
    assert.ok(hv && /1\.2\.3/.test(hv.contents.value) && /Console helpers/.test(hv.contents.value));
    const link = await c.request("textDocument/documentLink", { textDocument: { uri: d.uri } });
    assert.ok(link[0].target.endsWith("console/src/index.ml"));
  });

  await test("package import resolves from sub-folders (searched upwards)", async () => {
    const uri = `file://${fixtures}/sub/deep.ml`;
    const diags = await c.open(uri, 'import "SempaI-07:console";\nconsole.log("x");\n');
    assert.deepStrictEqual(diags, [], JSON.stringify(diags));
  });

  await test("package import problems: not declared / not installed", async () => {
    const d = await open(
      'import "Other:lib";\nimport "X:ghost";\nimport "Nope:nothing";\nlib.helper();\n',
    );
    const byLine = (n) =>
      d.diags.find((x) => x.range.start.line === n && x.code.startsWith("package-"));
    assert.strictEqual(byLine(0).code, "package-not-declared", JSON.stringify(d.diags));
    assert.strictEqual(byLine(1).code, "package-not-installed", JSON.stringify(d.diags));
    assert.strictEqual(byLine(2).code, "package-not-declared", JSON.stringify(d.diags));
    assert.ok(/mylang install/.test(byLine(1).message));
  });

  await test("package completion: import path and auto-import", async () => {
    const d = await open('import "');
    const mods = await c.request("textDocument/completion", d.at(0, 8));
    const pkg = mods.find((i) => i.label === "SempaI-07:console");
    assert.ok(pkg && /1\.2\.3/.test(pkg.detail), labels(mods).join());
    const d2 = await open("conso\n");
    const ai = await c.request("textDocument/completion", d2.at(0, 5));
    const item = ai.find((i) => i.label === "console");
    assert.ok(item && item.additionalTextEdits[0].newText.includes('import "SempaI-07:console";'));
  });

  await test("document symbols (hierarchical) + workspace symbols", async () => {
    const d = await open(
      "struct P { var x; func len() { return 1; } }\nenum E { A; B; }\nfunc f() {}\n",
    );
    const syms = await c.request("textDocument/documentSymbol", { textDocument: { uri: d.uri } });
    assert.deepStrictEqual(
      syms.map((s) => s.name),
      ["P", "E", "f"],
    );
    assert.deepStrictEqual(
      syms[0].children.map((s) => s.name),
      ["x", "len"],
    );
    const ws = await c.request("workspace/symbol", { query: "add" });
    assert.ok(ws.some((s) => s.name === "add"));
  });

  await test("quick fixes: add import, did-you-mean", async () => {
    const d = await open(
      'strings.split("a");\nimport "strings";\nvar q = 1;\nstrings.splitt("b");\nvar r = qq;\n',
    );
    const diags = d.diags;
    const un = diags.find((x) => x.code === "unknown-member");
    const acts = await c.request("textDocument/codeAction", {
      textDocument: { uri: d.uri },
      range: un.range,
      context: { diagnostics: [un] },
    });
    assert.ok(acts.some((a) => a.title === "Change to 'split'"));
    const d2 = await open('coreio.print("x");\n');
    const un2 = d2.diags.find((x) => x.code === "unresolved");
    const acts2 = await c.request("textDocument/codeAction", {
      textDocument: { uri: d2.uri },
      range: un2.range,
      context: { diagnostics: [un2] },
    });
    assert.ok(acts2.some((a) => a.title === 'Add import "coreio"'));
  });

  await test("semantic tokens and folding ranges", async () => {
    const d = await open('import "coreio";\nfunc f(a) {\n  coreio.print(a);\n}\n');
    const t = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: d.uri } });
    assert.ok(t.data.length > 0 && t.data.length % 5 === 0);
    const f = await c.request("textDocument/foldingRange", { textDocument: { uri: d.uri } });
    assert.ok(f.some((r) => r.startLine === 1));
  });

  await test("interpolated strings: references inside {…}", async () => {
    const d = await open('var name = 1;\nvar s = $"hi {name} {missing}";\n');
    assert.ok(d.diags.some((x) => x.code === "unresolved" && /missing/.test(x.message)));
    assert.ok(!d.diags.some((x) => x.code === "unresolved" && /'name'/.test(x.message)));
  });

  await test("protocol survives stray console output of the compiler", async () => {
    const d = await open("var v = try 1 catch (e) { };\nvar w = 2;\n");
    assert.ok(Array.isArray(d.diags));
    const h = await c.request("textDocument/hover", d.at(1, 4));
    assert.ok(h);
  });

  await test("JSDoc parser handles multiline types, optional parameters and tags", async () => {
    const parsed = parseJSDoc(`/**
     * Adds two numbers.
     * @param {number} first - First value
     *   that can span multiple lines.
     * @param {{ value: number }} [second=2] - Optional value
     * @returns {number} Result
     * @throws {Error} Bad input
     * @deprecated Use sum instead.
     * @example
     * add(1, 2)
     * @see sum
     * @since 1.0
     */`);

    assert.strictEqual(parsed.description, "Adds two numbers.");
    assert.strictEqual(parsed.params[0].type, "number");
    assert.match(parsed.params[0].description, /multiple lines/);
    assert.deepStrictEqual(
      [parsed.params[1].name, parsed.params[1].type, parsed.params[1].default],
      ["second", "{ value: number }", "2"],
    );
    assert.strictEqual(parsed.returns.description, "Result");
    assert.strictEqual(parsed.throws[0].type, "Error");
    assert.strictEqual(parsed.deprecated, "Use sum instead.");
    assert.strictEqual(parsed.examples[0], "add(1, 2)");
    assert.strictEqual(parsed.see[0], "sum");
    assert.ok(parsed.tags.some((tag) => tag.name === "since"));
  });

  await test("JSDoc descriptions and tags appear in function Hover and completion", async () => {
    const d = await open(
      [
        "/**",
        " * Adds two numbers.",
        " * @param {number} a - The first number",
        " * @param {number} b - The second number",
        " * @returns {number} The calculated sum",
        " * @example",
        " * add(1, 2)",
        " */",
        "func add(a, b) { return a + b; }",
        "var sum = add(1, 2);",
        "",
      ].join("\n"),
    );
    const result = await c.request("textDocument/hover", d.at(9, 12));
    assert.ok(result);
    assert.match(result.contents.value, /Adds two numbers/);
    assert.match(result.contents.value, /The first number/);
    assert.match(result.contents.value, /The calculated sum/);
    assert.match(result.contents.value, /\*\*Example\*\*/);
    const items = await c.request("textDocument/completion", d.at(9, 10));
    const add = items.find((item) => item.label === "add");
    assert.ok(add?.documentation?.value.includes("The second number"));
  });

  await test("JSDoc parameter Hover and signature help include per-argument types", async () => {
    const d = await open(
      [
        "/**",
        " * @param {string} message - Message to print",
        " * @param {number} [times=2] - Number of repetitions",
        " * @returns {string} Formatted result",
        " */",
        "func repeat(message, times = 2) { return message; }",
        'repeat("hi", ',
      ].join("\n"),
    );
    const parameterHover = await c.request("textDocument/hover", d.at(5, 13));
    assert.ok(parameterHover);
    assert.match(parameterHover.contents.value, /Message to print/);
    assert.match(parameterHover.contents.value, /string/);
    const signature = await c.request("textDocument/signatureHelp", d.at(6, 13));
    assert.ok(signature);
    assert.strictEqual(signature.activeParameter, 1);
    assert.match(signature.signatures[0].documentation.value, /Formatted result/);
    assert.match(
      signature.signatures[0].parameters[1].documentation.value,
      /Number of repetitions/,
    );
    assert.match(signature.signatures[0].parameters[1].documentation.value, /number/);
  });

  await test("JSDoc tags are completed in doc blocks, without affecting normal comments", async () => {
    const d = await open("/**\n * @\n */\nfunc add(a, b) {}\n");
    const items = await c.request("textDocument/completion", d.at(1, 4));
    assert.ok(labels(items).includes("@param a"), JSON.stringify(labels(items)));
    assert.ok(labels(items).includes("@param b"));
    assert.ok(labels(items).includes("@returns"));
    const param = items.find((item) => item.label === "@param a");
    assert.match(param.textEdit.newText, /@param.*a/);
    assert.strictEqual(param.insertTextFormat, 2);
    const normal = await open("// @\nfunc plain() {}\n");
    const noTags = await c.request("textDocument/completion", normal.at(0, 4));
    assert.deepStrictEqual(noTags, []);
  });

  await test("JSDoc comments do not attach across blank lines or trailing comments", async () => {
    const d = await open(
      [
        "/** A remote description. */",
        "",
        "func separate() {}",
        "var x = 1; // This belongs to x, not to next().",
        "func next() {}",
        "/** A nearby description. */",
        "func nearby() {}",
      ].join("\n"),
    );
    const separate = await c.request("textDocument/hover", d.at(2, 7));
    const next = await c.request("textDocument/hover", d.at(4, 6));
    const nearby = await c.request("textDocument/hover", d.at(6, 7));
    assert.ok(!separate.contents.value.includes("remote description"));
    assert.ok(!next.contents.value.includes("This belongs to x"));
    assert.ok(nearby.contents.value.includes("A nearby description"));
  });

  // ───────────────────────── MyLang 2.2: the `core:` namespace ─────────────────────────

  await test("core: imports bind the same modules as the bare names", async () => {
    const d = await open(
      [
        'import "core:coreio";',
        'import "core:net/http" as httpCore;',
        'import "core:numbers/bigint";',
        'import ("core:arrays", "core:path");',
        'coreio.print(arrays.join([1, 2], "-"));',
        "var server = httpCore.Server();",
        "var big = bigint.add(1, 2);",
        'var p = path.join("a", "b");',
      ].join("\n"),
    );
    assert.ok(!d.diags.some((x) => x.severity <= 2), JSON.stringify(d.diags));
    const items = await c.request("textDocument/completion", d.at(5, 24));
    assert.ok(labels(items).includes("Server"), labels(items).join());
  });

  await test("every module added in 2.2 is known", async () => {
    const added = [
      "test",
      "binary",
      "validation",
      "compress",
      "archive",
      "dns",
      "tcp",
      "udp",
      "ws",
      "workers",
      "process",
    ];
    const d = await open(added.map((m) => `import "core:${m}";`).join("\n") + "\n");
    assert.ok(
      !d.diags.some((x) => x.code === "unknown-module" || x.code === "unknown-core-module"),
      JSON.stringify(d.diags),
    );
  });

  await test("an unknown core: module is reported and can be fixed", async () => {
    const d = await open('import "core:fss";\n');
    const diag = d.diags.find((x) => x.code === "unknown-core-module");
    assert.ok(diag, JSON.stringify(d.diags));
    const fixes = await c.request("textDocument/codeAction", {
      textDocument: { uri: d.uri },
      range: diag.range,
      context: { diagnostics: [diag] },
    });
    assert.ok(
      fixes.some((f) => f.title === 'Change to "core:fs"'),
      JSON.stringify(fixes.map((f) => f.title)),
    );
  });

  await test("a bare built-in can be rewritten through the namespace", async () => {
    const d = await open('import "coreio";\ncoreio.print("hi");\n');
    assert.deepStrictEqual(d.diags, []);
    const hover = await c.request("textDocument/hover", d.at(0, 10));
    assert.match(hover.contents.value, /import "core:coreio"/);
  });

  await test("import path completion offers the core: spelling first", async () => {
    const d = await open('import "');
    const items = await c.request("textDocument/completion", d.at(0, 8));
    const core = items.find((i) => i.label === "core:net/http");
    const bare = items.find((i) => i.label === "net/http");
    assert.ok(core && bare, labels(items).slice(0, 10).join());
    assert.ok(core.sortText < bare.sortText);
    const typed = await open('import "core:');
    const onlyCore = await c.request("textDocument/completion", typed.at(0, 13));
    assert.ok(labels(onlyCore).includes("core:fs"));
    assert.ok(!labels(onlyCore).includes("fs"));
  });

  await test("destructuring imports: members are completed and checked", async () => {
    const d = await open(
      'import "core:test" as { describe, test, assert, finish };\nfinish("x");\n',
    );
    assert.ok(!d.diags.some((x) => x.code === "unknown-member"), JSON.stringify(d.diags));
    const items = await c.request("textDocument/completion", d.at(0, 33));
    assert.ok(labels(items).includes("beforeEach"), labels(items).join());
    assert.ok(!labels(items).includes("describe"), "already destructured");

    const bad = await open('import "core:test" as { describ };\n');
    assert.ok(
      bad.diags.some((x) => x.code === "unknown-member" && /describe/.test(x.message)),
      JSON.stringify(bad.diags),
    );
  });

  await test("imports of files: missing target and missing export", async () => {
    const missing = await open('import "./not-here.ml";\n');
    assert.ok(
      missing.diags.some((x) => x.code === "module-not-found"),
      JSON.stringify(missing.diags),
    );

    const d = await open('import "./utils.ml" as { add, PI, nope };\nvar s = add(PI, 1);\n');
    const diag = d.diags.find((x) => x.code === "import-member-missing");
    assert.ok(diag && /nope/.test(diag.message), JSON.stringify(d.diags));
    const items = await c.request("textDocument/completion", d.at(0, 38));
    assert.ok(labels(items).includes("nope") === false, "a wrong name is not offered");
    assert.ok(labels(items).length === 0 || labels(items).includes("add"), labels(items).join());
  });

  await test("JSON imports expose their keys", async () => {
    const d = await open('import "./data.json" as config;\nvar n = config.\n');
    const items = await c.request("textDocument/completion", d.at(1, 15));
    assert.ok(
      labels(items).includes("name") && labels(items).includes("count"),
      labels(items).join(),
    );
    const hover = await c.request("textDocument/hover", d.at(0, 12));
    assert.match(hover.contents.value, /Exports:/);
  });

  // ───────────────────────── types: arrays, nesting, results ─────────────────────────

  await test("arrays carry their element type", async () => {
    const d = await open(
      [
        'import "core:coreio";',
        'var names = ["ann", "bob"];',
        "var first = names[0];",
        "var size = names.length;",
        "for (var who in names) { coreio.print(who); }",
        'var mixed = [1, "a"];',
      ].join("\n"),
    );
    const names = await c.request("textDocument/hover", d.at(1, 6));
    assert.match(names.contents.value, /array<string>/);
    const first = await c.request("textDocument/hover", d.at(2, 6));
    assert.match(first.contents.value, /_string_/);
    const size = await c.request("textDocument/hover", d.at(3, 6));
    assert.match(size.contents.value, /_int_/);
    const who = await c.request("textDocument/hover", d.at(4, 10));
    assert.match(who.contents.value, /_string_/);
    const mixed = await c.request("textDocument/hover", d.at(5, 6));
    assert.match(mixed.contents.value, /_array_/);
    const members = await c.request("textDocument/completion", d.at(3, 17));
    assert.ok(labels(members).includes("length"), labels(members).join());
  });

  await test("nested objects are followed and shown in hover", async () => {
    const d = await open(
      [
        'var cfg = { db: { host: "localhost", port: 5432 }, tags: ["a"] };',
        "var host = cfg.db.host;",
        "var tag = cfg.tags[0];",
        'var users = [{ name: "ann" }];',
        "var who = users[0].name;",
      ].join("\n"),
    );
    const host = await c.request("textDocument/hover", d.at(1, 6));
    assert.match(host.contents.value, /_string_/);
    const tag = await c.request("textDocument/hover", d.at(2, 6));
    assert.match(tag.contents.value, /_string_/);
    const who = await c.request("textDocument/hover", d.at(4, 6));
    assert.match(who.contents.value, /_string_/);
    const cfg = await c.request("textDocument/hover", d.at(0, 5));
    assert.match(cfg.contents.value, /db: \{ host: string, port: int \}/);
    const inner = await c.request("textDocument/completion", d.at(1, 18));
    assert.ok(labels(inner).includes("host") && labels(inner).includes("port"));
  });

  await test("results of standard-library calls are typed", async () => {
    const d = await open(
      [
        'import "core:strings";',
        'var parts = strings.split("a,b", ",");',
        'var upper = strings.toUpperCase("a");',
        "var n = parts.length;",
      ].join("\n"),
    );
    const parts = await c.request("textDocument/hover", d.at(1, 6));
    assert.match(parts.contents.value, /_array_/);
    const upper = await c.request("textDocument/hover", d.at(2, 6));
    assert.match(upper.contents.value, /_string_/);
    const n = await c.request("textDocument/hover", d.at(3, 4));
    assert.match(n.contents.value, /_int_/);
  });

  await test("results of standard-library classes expose their members", async () => {
    const d = await open('import "core:tcp";\nvar socket = tcp.connect("h", 80);\nsocket.\n');
    const items = await c.request("textDocument/completion", d.at(2, 7));
    assert.ok(
      labels(items).includes("read") && labels(items).includes("close"),
      labels(items).join(),
    );
    const hover = await c.request("textDocument/hover", d.at(1, 18));
    assert.match(hover.contents.value, /host: string/);
  });

  await test("user functions: inferred and documented result types", async () => {
    const d = await open(
      [
        "struct User { var name; }",
        "/** @returns {User} */",
        "func make() { return User(); }",
        "var u = make();",
        "/**",
        " * @param {string} who",
        " * @returns {string[]}",
        " */",
        "func greet(who) { return [who]; }",
        'var greeting = greet("x");',
        "func plain() { return 42; }",
        "var answer = plain();",
      ].join("\n"),
    );
    const u = await c.request("textDocument/hover", d.at(3, 5));
    assert.match(u.contents.value, /User/);
    const greeting = await c.request("textDocument/hover", d.at(9, 6));
    assert.match(greeting.contents.value, /array<string>/);
    const answer = await c.request("textDocument/hover", d.at(11, 6));
    assert.match(answer.contents.value, /_int_/);
    const onU = await c.request("textDocument/completion", d.at(3, 5));
    void onU;
  });

  await test("fields filled in by a constructor get their type", async () => {
    const d = await open(
      [
        "struct Basket {",
        "  var items;",
        "  func init() { this.items = []; }",
        "}",
        "var b = Basket();",
        "var all = b.items;",
      ].join("\n"),
    );
    const all = await c.request("textDocument/hover", d.at(5, 6));
    assert.match(all.contents.value, /_array_/);
  });

  await test("deprecated APIs are reported where they are used", async () => {
    const d = await open(
      ["/** @deprecated use sum */", "func add(a, b) { return a + b; }", "var x = add(1, 2);"].join(
        "\n",
      ),
    );
    const diag = d.diags.find((x) => x.code === "deprecated");
    assert.ok(diag && /use sum/.test(diag.message), JSON.stringify(d.diags));
    assert.deepStrictEqual(diag.tags, [2]);
  });

  await test("the standard-library data is generated from MyLang 2.3", async () => {
    const stdlib = require("../server/data/stdlib.json");
    assert.match(stdlib.generatedFrom, /@2\.3\./);
    assert.ok(stdlib.modules.test && stdlib.modules.tcp && stdlib.modules.workers);
    assert.strictEqual(stdlib.modules.test.since, "2.2");
    // parameter types and result kinds feed the editor hints
    assert.strictEqual(stdlib.modules.strings.members.split.returns, "array");
    assert.strictEqual(stdlib.modules.strings.members.split.params[0].type, "string");
    assert.ok(stdlib.modules.tcp.members.connect.members.read, "socket members");
    assert.ok(stdlib.modules["os/system"].members.getpid, "os/system members");
    assert.ok(stdlib.modules.test.members.assert.members.equal, "nested assert members");
  });

  await test("2.3 standard library: iter, tls and the streaming functions", async () => {
    const stdlib = require("../server/data/stdlib.json");
    const iter = stdlib.modules.iter.members;
    for (const name of ["map", "filter", "take", "skip", "toArray", "forEach"])
      assert.ok(iter[name], `iter.${name} is missing`);
    assert.ok(iter.map.doc, "iter.map is documented");
    assert.ok(stdlib.modules.tls, "the tls module");
    // data larger than memory (2.2) and the colour functions the 2.3 build rebuilt
    assert.ok(stdlib.modules.compress.members.stream && stdlib.modules.compress.members.file);
    assert.ok(stdlib.modules.archive.members.extractFile && stdlib.modules.workers.members.pool);
    assert.ok(stdlib.modules.process.members.pipeline);
    const colors = stdlib.modules["utils/colors"].members;
    assert.ok(colors.red && colors.hex && colors.enabled, Object.keys(colors).join());
  });

  await test("iter: the 2.3 functions complete and hover", async () => {
    const d = await open('import "core:iter";\niter.\n');
    const items = await c.request("textDocument/completion", d.at(1, 5));
    for (const name of ["map", "filter", "take", "skip", "toArray", "forEach"])
      assert.ok(labels(items).includes(name), `iter.${name}: ${labels(items).join()}`);
    const d2 = await open('import "core:iter";\niter.map([1], func(x) { return x; });\n');
    const hover = await c.request("textDocument/hover", d2.at(1, 6));
    assert.match(hover.contents.value, /iter\.map/);
  });

  await test("symbol members: a struct declares its protocols in its body", async () => {
    const d = await open(
      [
        "struct Report {",
        "  var path;",
        "  func here() {}",
        "  func [symbol.dispose]() { coreio.print(this.path); }",
        "  func [symbol.iterator]() {}",
        "}",
        'import "core:coreio";',
        "",
      ].join("\n"),
    );
    assert.ok(!d.diags.some((x) => x.severity === 1), JSON.stringify(d.diags));
    // the body is a method body: `this` reaches the struct's own members
    const typing = await open(
      "struct Report {\n  var path;\n  func here() {}\n  func [symbol.dispose]() { this. }\n}\n",
    );
    const inside = await c.request("textDocument/completion", typing.at(3, 33));
    assert.deepStrictEqual(labels(inside).sort(), ["here", "path"]);
    // and the outline shows which protocols the struct joins
    const outline = await c.request("textDocument/documentSymbol", {
      textDocument: { uri: d.uri },
    });
    const children = outline[0].children.map((x) => x.name);
    assert.ok(
      children.includes("[symbol.dispose]") && children.includes("[symbol.iterator]"),
      children.join(),
    );
    const hover = await c.request("textDocument/hover", d.at(3, 10));
    assert.match(hover.contents.value, /releases the instance/);
  });

  await test("symbol members: completion inside the brackets, and never on an instance", async () => {
    const d = await open("struct R {\n  func [\n}\n");
    const items = await c.request("textDocument/completion", d.at(1, 8));
    assert.deepStrictEqual(labels(items).sort(), ["symbol.dispose", "symbol.iterator"]);
    const d2 = await open(
      "struct R {\n  var p;\n  func [symbol.dispose]() {}\n}\nvar r = R();\nr.\n",
    );
    const onR = await c.request("textDocument/completion", d2.at(5, 2));
    assert.deepStrictEqual(labels(onR), ["p"]);
  });

  await test("symbol members: every refusal is reported", async () => {
    const d = await open(
      [
        "struct A {",
        "  private func [symbol.dispose]() {}",
        "  func [symbol.close]() {}",
        "  var [symbol.iterator] = 1;",
        "}",
        "struct B {",
        "  func [symbol.dispose]() {}",
        "  func [symbol.dispose]() {}",
        "}",
        "",
      ].join("\n"),
    );
    const codes = d.diags.map((x) => x.code);
    for (const code of [
      "symbol-member-modifier",
      "symbol-member-unknown",
      "symbol-member-field",
      "symbol-member-duplicate",
    ])
      assert.ok(codes.includes(code), `${code} missing: ${JSON.stringify(d.diags)}`);
    assert.ok(
      d.diags.every((x) => x.severity === 1),
      "all of them are errors",
    );
  });

  await test("private struct members are offered inside the struct only", async () => {
    const d = await open(
      [
        "struct Counter {",
        "  static var created = 0;",
        "  private var secret;",
        "  var count;",
        "  private func bump() { this. }",
        "  func show() {}",
        "}",
        "var k = Counter();",
        "k.",
        "",
      ].join("\n"),
    );
    const inside = await c.request("textDocument/completion", d.at(4, 29));
    assert.ok(labels(inside).includes("secret"), labels(inside).join());
    const outside = await c.request("textDocument/completion", d.at(8, 2));
    assert.deepStrictEqual(labels(outside).sort(), ["count", "created", "show"]);
    const hover = await c.request("textDocument/hover", d.at(4, 15));
    assert.match(hover.contents.value, /private func bump/);
    // the parser refuses the same modifier twice, and so does the editor
    const twice = await open("struct S {\n  private private func f() {}\n}\n");
    assert.ok(
      twice.diags.some((x) => x.code === "duplicate-modifier" && x.severity === 1),
      JSON.stringify(twice.diags),
    );
  });

  await test("++ and -- on a member, an index and a static", async () => {
    const d = await open(
      [
        "struct Counter {",
        "  static var created = 0;",
        "  var count;",
        "  func bump() { this.count++; Counter.created++; }",
        "}",
        "var o = { n: 1 };",
        "o.n++;",
        "var items = [1, 2];",
        "items[0]--;",
        "",
      ].join("\n"),
    );
    assert.ok(!d.diags.some((x) => x.severity === 1), JSON.stringify(d.diags));
    // postfix: the value is the one before the step, so it keeps the member's type
    const d2 = await open("var o = { n: 1 };\nvar prev = o.n++;\n");
    const hover = await c.request("textDocument/hover", d2.at(1, 5));
    assert.match(hover.contents.value, /_int_/);
    // a stepped member is a use of it, so rename and references see the step
    const refs = await c.request("textDocument/references", {
      textDocument: { uri: d2.uri },
      position: { line: 1, character: 13 },
      context: { includeDeclaration: true },
    });
    assert.strictEqual(refs.length, 2, JSON.stringify(refs));
  });

  await test("++ obeys the rules an assignment obeys", async () => {
    const readonly = await open("var a = [1, 2] as readonly;\na[0]--;\n");
    assert.ok(
      readonly.diags.some((x) => x.code === "readonly-modify"),
      JSON.stringify(readonly.diags),
    );
    const enumStep = await open("enum Color { Red; Green; }\nColor.Red++;\n");
    assert.ok(
      enumStep.diags.some((x) => x.code === "enum-member-assign" && x.severity === 1),
      JSON.stringify(enumStep.diags),
    );
    const assigned = await open("enum Color { Red; Green; }\nColor.Red = 5;\n");
    assert.ok(
      assigned.diags.some((x) => x.code === "enum-member-assign"),
      JSON.stringify(assigned.diags),
    );
  });

  await test("option keys of http.Server, including the 2.3 error reporting", async () => {
    const d = await open('import "core:net/http";\nvar s = http.Server({\n  \n});\n');
    const items = await c.request("textDocument/completion", d.at(2, 2));
    for (const name of ["port", "onError", "logErrors", "static", "bodyLimit"])
      assert.ok(labels(items).includes(name), `${name}: ${labels(items).join()}`);
    const onError = items.find((i) => i.label === "onError");
    assert.match(onError.documentation.value, /its own task/);
    assert.match(onError.detail, /2\.3/);
    // a key already written is not offered again
    const d2 = await open('import "core:net/http";\nvar s = http.Server({ port: 80, o });\n');
    const after = await c.request("textDocument/completion", d2.at(1, 33));
    assert.ok(!labels(after).includes("port"), labels(after).join());
    // a nested object is not the call's own option list
    const d3 = await open('import "core:net/http";\nvar s = http.Server({ cors: {  } });\n');
    const nested = await c.request("textDocument/completion", d3.at(1, 29));
    assert.ok(!labels(nested).includes("bodyLimit"), labels(nested).join());
  });

  // ─────────── the formatter (needs the real language package, MyLang2 2.3) ───────────

  const formatterReady = async () => {
    const status = await c.request("mylang/status", {});
    return !!(status.formatter && status.formatter.available);
  };

  /** Apply LSP text edits to `text`, back to front, the way an editor does. */
  const applyEdits = (text, edits) => {
    const lines = text.split(/(?<=\n)/);
    const offsetAt = (p) => {
      let at = 0;
      for (let i = 0; i < p.line; i++) at += (lines[i] || "").length;
      return at + p.character;
    };
    return [...edits]
      .sort((a, b) => offsetAt(b.range.start) - offsetAt(a.range.start))
      .reduce(
        (out, e) =>
          out.slice(0, offsetAt(e.range.start)) + e.newText + out.slice(offsetAt(e.range.end)),
        text,
      );
  };

  await test("formatting goes through the language's own formatter", async () => {
    if (!compilerPath || !(await formatterReady())) return;
    const text = 'var x=1;\nif(x){coreio.print( "hi" );}\n\n\n\nvar y   =   [1,2,3];\n';
    const d = await open(text);
    const edits = await c.request("textDocument/formatting", {
      textDocument: { uri: d.uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    const formatted = applyEdits(text, edits);
    assert.strictEqual(
      formatted,
      'var x = 1;\nif (x) { coreio.print("hi"); }\n\nvar y = [1, 2, 3];\n',
      JSON.stringify(formatted),
    );
    // only what changed is replaced, so the editor keeps cursor and folds
    assert.ok(edits.length < 4, `${edits.length} edits`);
    // an already formatted document asks for nothing
    const clean = await open(formatted);
    const none = await c.request("textDocument/formatting", {
      textDocument: { uri: clean.uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.deepStrictEqual(none, []);
  });

  await test("Format Selection changes only the lines of the selection", async () => {
    if (!compilerPath || !(await formatterReady())) return;
    const text = "var x=1;\nif(x){\ncoreio.print( x );\n}\n";
    const d = await open(text);
    const edits = await c.request("textDocument/rangeFormatting", {
      textDocument: { uri: d.uri },
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 18 } },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.ok(edits.length > 0, "the selected line is reformatted");
    assert.ok(
      edits.every((e) => e.range.start.line >= 2 && e.range.end.line <= 3),
      JSON.stringify(edits),
    );
    assert.match(applyEdits(text, edits), /^var x=1;\n/, "line 1 is left alone");
  });

  await test("the formatter reads the project's settings, and refuses bad ones", async () => {
    if (!compilerPath || !(await formatterReady())) return;
    const fs = require("fs");
    const dir = path.join(fixtures, "fmt");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mylang.json"),
      JSON.stringify({ prettier: { indent: 4, quote: "single" } }),
    );
    const text = 'if(x){\ncoreio.print( "hi" );\n}\n';
    const uri = `file://${dir}/a.ml`;
    await c.open(uri, text);
    const edits = await c.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    const out = applyEdits(text, edits);
    assert.match(out, /'hi'/, `quote: ${JSON.stringify(out)}`);
    assert.match(out, /\n {4}coreio/, `indent: ${JSON.stringify(out)}`);

    // an option the formatter refuses stops the run, exactly as on the command line
    fs.writeFileSync(
      path.join(dir, "mylang.json"),
      JSON.stringify({ prettier: { indent: "wide" } }),
    );
    const uri2 = `file://${dir}/b.ml`;
    await c.open(uri2, "var z=1;\n");
    const refused = await c.request("textDocument/formatting", {
      textDocument: { uri: uri2 },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.strictEqual(refused, null, JSON.stringify(refused));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("formatting can be switched off", async () => {
    if (!compilerPath || !(await formatterReady())) return;
    const off = new Client();
    await off.init(fixtures, {
      compiler: { path: compilerPath },
      format: { enable: false },
    });
    const uri = `file://${fixtures}/nofmt.ml`;
    await off.open(uri, "var x=1;\n");
    const edits = await off.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.strictEqual(edits, null);
    await off.stop();
  });

  await test("diffLines turns a reformat into the edits that changed", async () => {
    const { diffLines, splitLines, splitHunk } = require("../server/features/formatting");
    const before = splitLines("a\nb\nc\nd\n");
    const after = splitLines("a\nB\nc\nd\n");
    assert.deepStrictEqual(diffLines(before, after), [{ start: 1, end: 2, text: "B\n" }]);
    // a hunk of equal line counts is splittable, which is what Format Selection filters on
    const joined = { start: 0, end: 2, text: "A\nB\n" };
    assert.deepStrictEqual(splitHunk(joined), [
      { start: 0, end: 1, text: "A\n" },
      { start: 1, end: 2, text: "B\n" },
    ]);
  });

  await c.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
