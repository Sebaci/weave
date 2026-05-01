import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const root         = context.asAbsolutePath(path.join("..", ".."));
  const serverScript = path.join(root, "src", "lsp", "server.ts");
  const tsx          = path.join(root, "node_modules", ".bin", "tsx");

  const serverOptions: ServerOptions = {
    run:   { command: tsx, args: [serverScript] },
    debug: { command: tsx, args: [serverScript] },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "weave" }],
  };

  client = new LanguageClient(
    "weave",
    "Weave Language Server",
    serverOptions,
    clientOptions,
  );
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
