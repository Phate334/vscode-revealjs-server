import * as vscode from "vscode";
import { CollaborationClient } from "./collaborationClient";
import { bindSlideDocument, type SlideBinding } from "./documentBinding";
import {
  DEFAULT_SERVER,
  collabWsUrl,
  createProject,
  extractSnapshot,
  fetchSnapshot,
  listProjects,
  readWorkspaceMeta,
  writeWorkspaceMeta,
} from "./projectClient";
import { SyncController } from "./syncController";

let client: CollaborationClient | undefined;
let binding: SlideBinding | undefined;
let sync: SyncController | undefined;
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
  const meta = await readWorkspaceMeta();
  if (!meta) {
    void vscode.window.showErrorMessage(
      "Collab: missing .presentation/workspace.json (Create or Open Project first)",
    );
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showErrorMessage("Collab: no workspace folder open");
    return;
  }
  const id = `vscode-${vscode.env.sessionId.slice(0, 8)}`;
  const url = collabWsUrl(meta.server, meta.projectId);
  client = new CollaborationClient(id, url);
  client.onStatus = setStatus;
  binding = await bindSlideDocument(client);
  sync = new SyncController(client, folder, meta.server, meta.projectId, meta.lastKnownRevision);
  sync.start();
  try {
    await client.connect();
    // Persist workspace revision from ready if advanced.
    if (client.workspaceRevision !== meta.lastKnownRevision) {
      await writeWorkspaceMeta(folder, {
        ...meta,
        lastKnownRevision: client.workspaceRevision,
      });
    }
    void vscode.window.showInformationMessage(
      `Collab connected as ${id} → ${meta.projectId}`,
    );
  } catch (err) {
    sync?.dispose();
    sync = undefined;
    binding?.dispose();
    binding = undefined;
    client.disconnect();
    client = undefined;
    setStatus("offline");
    void vscode.window.showErrorMessage(`Collab connect failed: ${String(err)}`);
  }
}

function disconnect(): void {
  sync?.dispose();
  sync = undefined;
  binding?.dispose();
  binding = undefined;
  client?.disconnect();
  client = undefined;
  setStatus("offline");
}

async function cmdCreateProject(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Presentation: Create Project",
    prompt: "Project name",
    validateInput: (v) => (v.trim() ? undefined : "Name required"),
  });
  if (!name) return;

  const parent = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select parent folder",
  });
  if (!parent?.[0]) return;

  const server = DEFAULT_SERVER;
  try {
    const project = await createProject(server, name.trim());
    const snap = await fetchSnapshot(server, project.id);
    const folderName = name.trim().replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "") || project.id;
    const folder = vscode.Uri.joinPath(parent[0], folderName);
    await vscode.workspace.fs.createDirectory(folder);
    await extractSnapshot(folder, snap, server);
    await writeWorkspaceMeta(folder, {
      version: 1,
      server,
      projectId: project.id,
      lastKnownRevision: snap.revision,
    });
    await vscode.commands.executeCommand("vscode.openFolder", folder, {
      forceNewWindow: false,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Create Project failed: ${String(err)}`);
  }
}

async function cmdOpenProject(): Promise<void> {
  const server = DEFAULT_SERVER;
  let projects;
  try {
    projects = await listProjects(server);
  } catch (err) {
    void vscode.window.showErrorMessage(`List projects failed: ${String(err)}`);
    return;
  }
  if (projects.length === 0) {
    void vscode.window.showInformationMessage("No projects on server — Create Project first");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: p.name,
      description: p.id,
      detail: `rev ${p.revision} · ${p.created_at}`,
      project: p,
    })),
    { title: "Presentation: Open Project" },
  );
  if (!picked) return;

  const parent = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select local folder for snapshot",
  });
  if (!parent?.[0]) return;

  try {
    const snap = await fetchSnapshot(server, picked.project.id);
    // Use selected folder as workspace root (extract into it).
    await extractSnapshot(parent[0], snap, server);
    await writeWorkspaceMeta(parent[0], {
      version: 1,
      server,
      projectId: picked.project.id,
      lastKnownRevision: snap.revision,
    });
    await vscode.commands.executeCommand("vscode.openFolder", parent[0], {
      forceNewWindow: false,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Open Project failed: ${String(err)}`);
  }
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
    vscode.commands.registerCommand("presentation.undo", () => binding?.undo()),
    vscode.commands.registerCommand("presentation.redo", () => binding?.redo()),
    vscode.commands.registerCommand("presentation.createProject", () => cmdCreateProject()),
    vscode.commands.registerCommand("presentation.openProject", () => cmdOpenProject()),
  );

  void readWorkspaceMeta().then((meta) => {
    if (meta) void connect();
  });
}

export function deactivate(): void {
  disconnect();
}
