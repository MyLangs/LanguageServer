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
    assert.ok(item.additionalTextEdits[0].newText.includes('import "coreio";'));
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
      s2 && /strings\.split\(str, separator, limit\)/.test(s2.signatures[0].label),
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

  await c.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
