import * as fs from "node:fs";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { CollaborationClient } from "./collaborationClient";
import { bindCollaborativeDocuments, type DocumentsBinding } from "./documentBinding";
import { getAccessToken, initAuth, saveSession } from "./auth";
import {
  collabWsUrl, configuredServer, normalizeServer, acceptShare, createProject, createShare,
  extractSnapshot, fetchSnapshot, listMembers, listProjects, login, previewInvite,
  publishRelease, readWorkspaceMeta, writeWorkspaceMeta, type ProjectInfo, type WorkspaceMeta,
} from "./projectClient";
import { atomicWrite, hash, localPath } from "./localState";
import { initializeState, loadState, scanLocal, same, snapshotEntries } from "./reconciliation";
import { openPreview } from "./preview";
import { SyncController } from "./syncController";
import { YjsPersistence } from "./yjsPersistence";

let client: CollaborationClient | undefined;
let binding: DocumentsBinding | undefined;
let sync: SyncController | undefined;
let persistence: YjsPersistence | undefined;
let statusItem: vscode.StatusBarItem;
let connecting = false;

function setStatus(status: string): void {
  statusItem.text = `$(radio-tower) Presentation: ${status}`;
  statusItem.show();
}

async function signIn(server: string): Promise<boolean> {
  const username = await vscode.window.showInputBox({ title: "Presentation: Sign In", prompt: `Username · ${server}`, ignoreFocusOut: true });
  if (!username) return false;
  const password = await vscode.window.showInputBox({ title: "Presentation: Sign In", prompt: "Password", password: true, ignoreFocusOut: true });
  if (!password) return false;
  const session = await login(server, username.trim(), password);
  await saveSession(server, { access_token: session.access_token, refresh_token: session.refresh_token, username: session.user.username });
  return true;
}
async function requireSession(server: string): Promise<boolean> {
  return !!(await getAccessToken(server)) || await signIn(server);
}

async function connect(interactive = true): Promise<void> {
  if (connecting) return;
  const meta = await readWorkspaceMeta();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!meta || !folder) throw new Error("Open a presentation workspace first");
  if (client) {
    if (interactive && !(await requireSession(meta.server))) return;
    await client.connect(); return;
  }
  connecting = true;
  try {
    if (interactive && !(await requireSession(meta.server))) return;
    if (!loadState(folder, meta)) {
      // Migration preserves every local file. Differing text is kept in recovery, not treated as server-wins.
      const snap = await fetchSnapshot(meta.server, meta.projectId);
      const local = scanLocal(folder);
      const bases = Object.fromEntries(snap.files.map((file) => [file.path, file.content]));
      for (const [rel, entry] of Object.entries(local)) {
        if (entry.kind === "text" && hash(bases[rel] ?? "") !== entry.hash) {
          atomicWrite(localPath(folder, `.presentation/recovery/migration/${rel}`, true), entry.content ?? "");
        }
      }
      atomicWrite(localPath(folder, ".presentation/text-bases.json", true), JSON.stringify(bases));
      // Seed CRDT identity from the server before applying differences in the local replica.
      const yjsPath = localPath(folder, ".presentation/yjs-state.bin", true);
      if (!fs.existsSync(yjsPath)) atomicWrite(yjsPath, Buffer.from(snap.yjs_state, "base64"));
      initializeState(folder, meta, snap);
      const remote = snapshotEntries(snap);
      const conflicts = [...new Set([...Object.keys(local), ...Object.keys(remote)])]
        .filter((rel) => !same(local[rel], remote[rel]));
      atomicWrite(localPath(folder, ".presentation/conflicts.json", true), JSON.stringify(conflicts));
      if (conflicts.length) void vscode.window.showWarningMessage("Existing local differences were preserved. Use Presentation: Resolve Conflict before synchronizing them.");
    }
    client = new CollaborationClient(`vscode-${randomUUID()}`, () => collabWsUrl(meta.server, meta.projectId), meta.lastKnownStructureRevision);
    persistence = new YjsPersistence(folder, client.doc);
    sync = new SyncController(client, folder, meta, setStatus);
    binding = await bindCollaborativeDocuments(client, folder, sync.markConflict, (rel) => sync?.hasConflict(rel) ?? true);
    await sync.start(binding);
    await client.connect();
  } catch (error) {
    dispose();
    setStatus("Offline");
    throw error;
  } finally { connecting = false; }
}

function disconnect(): void {
  // Keep document bindings and persistence active during an intentional offline period.
  client?.disconnect();
  setStatus("Offline · Local changes saved");
}
function dispose(): void {
  sync?.dispose(); sync = undefined;
  binding?.dispose(); binding = undefined;
  persistence?.dispose(); persistence = undefined;
  client?.dispose(); client = undefined;
}

async function reserveFolder(name: string): Promise<vscode.Uri | undefined> {
  const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Select parent folder" });
  if (!parents?.[0]) return undefined;
  const suggested = name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "") || "presentation";
  const child = await vscode.window.showInputBox({ title: "Presentation folder", value: suggested,
    prompt: "Create a new child folder inside the selected parent",
    validateInput: (value) => /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value) ? undefined : "Enter a folder name without path separators" });
  if (!child) return undefined;
  const folder = vscode.Uri.joinPath(parents[0], child);
  // mkdir without recursive/exists-ok is the exclusive reservation; existing directories are never overwritten.
  fs.mkdirSync(folder.fsPath);
  return folder;
}

async function downloadProject(server: string, project: ProjectInfo, folder?: vscode.Uri): Promise<void> {
  folder ??= await reserveFolder(project.name);
  if (!folder) return;
  const snap = await fetchSnapshot(server, project.id);
  await extractSnapshot(folder, snap, server);
  const meta: WorkspaceMeta = { version: 2, server, projectId: project.id, lastKnownStructureRevision: snap.structure_revision };
  atomicWrite(localPath(folder, ".presentation/text-bases.json", true), JSON.stringify(Object.fromEntries(snap.files.map((f) => [f.path, f.content]))));
  initializeState(folder, meta, snap);
  // Metadata is written last: a failed download cannot auto-connect as a completed workspace.
  await writeWorkspaceMeta(folder, meta);
  await vscode.commands.executeCommand("vscode.openFolder", folder, { forceNewWindow: false });
}

async function create(): Promise<void> {
  const server = configuredServer();
  if (!(await requireSession(server))) return;
  const name = await vscode.window.showInputBox({ title: "Presentation: Create Presentation", prompt: "Presentation name", validateInput: (s) => s.trim() ? undefined : "Name required" });
  if (!name) return;
  const folder = await reserveFolder(name);
  if (!folder) return;
  await downloadProject(server, await createProject(server, name.trim()), folder);
}

async function open(): Promise<void> {
  const server = configuredServer();
  if (!(await requireSession(server))) return;
  const projects = await listProjects(server);
  type Pick = vscode.QuickPickItem & { project?: ProjectInfo; invite?: boolean };
  const picks: Pick[] = [{ label: "Accept invitation…", invite: true }];
  for (const [title, owned] of [["My Presentations", true], ["Shared with Me", false]] as const) {
    picks.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
    picks.push(...projects.filter((project) => (project.role === "owner") === owned)
      .map((project) => ({ label: project.name, description: project.role, project })));
  }
  const chosen = await vscode.window.showQuickPick(picks, { title: "Presentation: Open Presentation" });
  if (chosen?.invite) await acceptInvitation(server);
  else if (chosen?.project) await downloadProject(server, chosen.project);
}

async function acceptInvitation(server = configuredServer()): Promise<void> {
  const input = await vscode.window.showInputBox({ title: "Presentation: Accept Invitation", prompt: "Paste invitation", ignoreFocusOut: true });
  if (!input) return;
  let token = input.trim();
  if (token.startsWith("{")) {
    const invite = JSON.parse(token) as { server: string; token: string };
    server = normalizeServer(invite.server); token = invite.token;
  }
  if (!(await requireSession(server))) return;
  const info = await previewInvite(server, token);
  const choice = await vscode.window.showInformationMessage(`${info.project_name} · ${info.role}`, { modal: true }, "Accept and Open");
  if (choice !== "Accept and Open") return;
  const result = await acceptShare(server, token);
  await downloadProject(server, result.project);
}

async function workspaceAction(action: (meta: WorkspaceMeta) => Promise<void>): Promise<void> {
  const meta = await readWorkspaceMeta();
  if (!meta) throw new Error("Open a presentation workspace first");
  if (await requireSession(meta.server)) await action(meta);
}

export function activate(context: vscode.ExtensionContext): void {
  initAuth(context);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "presentation.syncDetails";
  setStatus("Offline");
  const command = (name: string, action: () => unknown) => vscode.commands.registerCommand(name, async () => {
    try { await action(); } catch (error) { void vscode.window.showErrorMessage(String(error)); }
  });
  context.subscriptions.push(statusItem,
    command("revealjsCollab.connect", () => connect()),
    command("revealjsCollab.disconnect", () => disconnect()),
    command("presentation.undo", () => binding?.undo()), command("presentation.redo", () => binding?.redo()),
    command("presentation.syncDetails", () => sync?.showDetails()),
    command("presentation.retrySync", () => sync?.reconcileFromLocal("retry")),
    command("presentation.resolveConflict", () => sync?.resolveConflict()),
    command("presentation.signIn", async () => {
      const meta = await readWorkspaceMeta();
      if (await signIn(meta?.server ?? configuredServer())) { if (meta) await connect(false); }
    }),
    command("presentation.createProject", create), command("presentation.openProject", open),
    command("presentation.acceptInvitation", () => acceptInvitation()),
    command("presentation.shareProject", () => workspaceAction(async (meta) => {
      const role = await vscode.window.showQuickPick(["viewer", "editor"], { title: "Presentation: Share Presentation" });
      if (!role) return;
      const invite = await createShare(meta.server, meta.projectId, role as "viewer" | "editor");
      await vscode.env.clipboard.writeText(JSON.stringify({ server: meta.server, token: invite.token }));
      void vscode.window.showInformationMessage("Invitation copied. Use Open Presentation → Accept invitation on the other computer.");
    })),
    command("presentation.projectMembers", () => workspaceAction(async (meta) => {
      const members = await listMembers(meta.server, meta.projectId);
      await vscode.window.showQuickPick(members.map((member) => ({ label: member.username, description: member.role })), { title: "Presentation: Members" });
    })),
    command("presentation.publish", () => workspaceAction(async (meta) => {
      if (sync) await sync.flush();
      const release = await publishRelease(meta.server, meta.projectId);
      await vscode.env.clipboard.writeText(`${meta.server}${release.public_path}`);
      void vscode.window.showInformationMessage(`Published. Link copied: ${meta.server}${release.public_path}`);
    })),
    command("presentation.openPreview", () => workspaceAction(async (meta) => {
      if (sync) await sync.flush();
      await openPreview(meta);
    })),
  );
  void readWorkspaceMeta().then((meta) => { if (meta) return connect(false); }).catch((error) => {
    setStatus("Offline"); void vscode.window.showWarningMessage(`Local files preserved: ${String(error)}`);
  });
}

export function deactivate(): void { dispose(); }
