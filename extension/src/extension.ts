import * as vscode from "vscode";
import { CollaborationClient } from "./collaborationClient";
import { bindSlideDocument } from "./documentBinding";

let client: CollaborationClient | undefined;
let unbind: (() => void) | undefined;
let statusItem: vscode.StatusBarItem | undefined;

function setStatus(s: string): void {
  if (!statusItem) return;
  statusItem.text = `$(radio-tower) Collab: ${s}`;
  statusItem.show();
}

async function connect(): Promise<void> {
  if (client) {
    void vscode.window.showInformationMessage("Collab already connected");
    return;
  }
  const id = `vscode-${vscode.env.sessionId.slice(0, 8)}`;
  client = new CollaborationClient(id);
  client.onStatus = setStatus;
  unbind = await bindSlideDocument(client);
  try {
    await client.connect();
    void vscode.window.showInformationMessage(`Collab connected as ${id}`);
  } catch (err) {
    unbind?.();
    unbind = undefined;
    client.disconnect();
    client = undefined;
    setStatus("offline");
    void vscode.window.showErrorMessage(`Collab connect failed: ${String(err)}`);
  }
}

function disconnect(): void {
  unbind?.();
  unbind = undefined;
  client?.disconnect();
  client = undefined;
  setStatus("offline");
}

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = "$(radio-tower) Collab: offline";
  statusItem.command = "revealjsCollab.connect";
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("revealjsCollab.connect", () => connect()),
    vscode.commands.registerCommand("revealjsCollab.disconnect", () => disconnect()),
  );

  // Auto-connect when folder was opened because .presentation/workspace.json exists.
  void vscode.workspace.findFiles(".presentation/workspace.json", null, 1).then((files) => {
    if (files.length > 0) void connect();
  });
}

export function deactivate(): void {
  disconnect();
}
