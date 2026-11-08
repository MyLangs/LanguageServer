"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

/** @type {LanguageClient | undefined} */
let client;
let output;

/** Run the bundled language server as a separate Node.js process. */
function serverOptions(context) {
  const module = context.asAbsolutePath(path.join("server", "main.js"));
  return {
    run: { module, transport: TransportKind.stdio },
    debug: {
      module,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };
}

/** Serialise VS Code settings for the JSON-RPC initialization payload. */
function settingsSnapshot() {
  // WorkspaceConfiguration is a proxy: serialise it to plain data
  return JSON.parse(JSON.stringify(vscode.workspace.getConfiguration("mylang")));
}

/** Connect the editor features to .ml documents and sync file changes. */
async function startClient(context) {
  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "mylang" },
      { scheme: "untitled", language: "mylang" },
    ],
    initializationOptions: settingsSnapshot(),
    outputChannel: output,
    synchronize: {
      configurationSection: "mylang",
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{ml,json}"),
    },
  };
  client = new LanguageClient(
    "mylang",
    "MyLang Language Server",
    serverOptions(context),
    clientOptions,
  );
  await client.start();
  reportCompiler();
}

async function reportCompiler() {
  try {
    const status = await client.sendRequest("mylang/status");
    if (!status.compiler.available && !context_noticeShown) {
      context_noticeShown = true;
      const pick = await vscode.window.showInformationMessage(
        "MyLang: no compiler found, using the built-in syntax checker. Point 'mylang.compiler.path' to your MyLang2 build for exact syntax errors.",
        "Set compiler path",
        "Dismiss",
      );
      if (pick === "Set compiler path")
        vscode.commands.executeCommand("workbench.action.openSettings", "mylang.compiler.path");
    }
  } catch {
    /* server is restarting */
  }
}
let context_noticeShown = false;

async function stopClient() {
  if (client) {
    const c = client;
    client = undefined;
    await c.stop();
  }
}

/** Run the active MyLang script in a reusable VS Code terminal. */
function runFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "mylang") {
    vscode.window.showWarningMessage("Open a MyLang (.ml) file first.");
    return;
  }
  const doc = editor.document;
  const run = async () => {
    const exe = vscode.workspace.getConfiguration("mylang").get("executable") || "mylang";
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const cwd = folder ? folder.uri.fsPath : path.dirname(doc.uri.fsPath);
    const rel = path.relative(cwd, doc.uri.fsPath);
    let terminal = vscode.window.terminals.find((t) => t.name === "MyLang");
    if (!terminal || terminal.exitStatus)
      terminal = vscode.window.createTerminal({ name: "MyLang", cwd });
    terminal.show(true);
    terminal.sendText(`${exe} "${rel}"`);
  };
  (doc.isDirty ? doc.save() : Promise.resolve(true)).then(run);
}

async function activate(context) {
  output = vscode.window.createOutputChannel("MyLang Language Server");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("mylang.runFile", runFile),
    vscode.commands.registerCommand("mylang.restartServer", async () => {
      await stopClient();
      await startClient(context);
      vscode.window.showInformationMessage("MyLang language server restarted.");
    }),
    vscode.commands.registerCommand("mylang.showStatus", async () => {
      if (!client)
        return vscode.window.showWarningMessage("MyLang language server is not running.");
      const s = await client.sendRequest("mylang/status");
      output.appendLine(JSON.stringify(s, null, 2));
      output.show(true);
    }),
  );
  await startClient(context);
}

function deactivate() {
  return stopClient();
}

module.exports = { activate, deactivate };
