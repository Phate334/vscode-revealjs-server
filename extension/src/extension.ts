import * as fs from "node:fs";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { CollaborationClient } from "./collaborationClient";
import { bindCollaborativeDocuments, type DocumentsBinding } from "./documentBinding";
import { clearSession, getAccessToken, initAuth, saveSession } from "./auth";
import {
  collabWsUrl, configuredServer, createAccountInvite, createProject, parseInviteInput,
  parsePresentationLink, previewAccountInvite, registerWithInvite, acceptProjectInvite, createProjectInvite,
  extractSnapshot, fetchSnapshot, listMembers, listProjects, login, register,
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

async function promptCredentials(title: string, server: string, minPassword = 1): Promise<{ username: string; password: string } | undefined> {
  const username = await vscode.window.showInputBox({ title, prompt: `Username · ${server}`, ignoreFocusOut: true });
  if (!username?.trim()) return undefined;
  const password = await vscode.window.showInputBox({
    title, prompt: minPassword > 1 ? `Password (at least ${minPassword} characters)` : "Password",
    password: true, ignoreFocusOut: true,
    validateInput: (value) => value.length >= minPassword ? undefined : `Password must be at least ${minPassword} characters`,
  });
  if (!password) return undefined;
  return { username: username.trim(), password };
}

async function storeLogin(server: string, session: { access_token: string; refresh_token: string; user: { username: string } }): Promise<void> {
  await saveSession(server, { access_token: session.access_token, refresh_token: session.refresh_token, username: session.user.username });
}

async function signIn(server: string): Promise<boolean> {
  const creds = await promptCredentials("Presentation: Sign In", server);
  if (!creds) return false;
  await storeLogin(server, await login(server, creds.username, creds.password));
  return true;
}

async function registerAccount(server: string): Promise<boolean> {
  const creds = await promptCredentials("Presentation: Register", server, 8);
  if (!creds) return false;
  await storeLogin(server, await register(server, creds.username, creds.password));
  return true;
}

/** No session yet: Sign In offers Register, then the same username and masked-password boxes. */
async function signInOrRegister(server: string): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Sign in", description: "Existing account" },
      { label: "Register", description: "Create an account" },
    ],
    { title: "Presentation: Sign In", ignoreFocusOut: true },
  );
  if (!choice) return false;
  return choice.label === "Register" ? registerAccount(server) : signIn(server);
}

async function requireSession(server: string): Promise<boolean> {
  return !!(await getAccessToken(server)) || await signInOrRegister(server);
}

async function connect(interactive = true): Promise<void> {
  if (connecting) return;
  const meta = await readWorkspaceMeta();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!meta || !folder) throw new Error("Open a presentation workspace first");
  if (!(await getAccessToken(meta.server))) {
    setStatus("Sign in required");
    if (!interactive || !(await signInOrRegister(meta.server))) return;
  }
  if (client) { await client.connect(); return; }
  connecting = true;
  try {
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
  type Pick = vscode.QuickPickItem & { project?: ProjectInfo; fromLink?: boolean };
  const picks: Pick[] = [{ label: "Open from link…", fromLink: true }];
  for (const [title, owned] of [["My Presentations", true], ["Shared with Me", false]] as const) {
    picks.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
    picks.push(...projects.filter((project) => (project.role === "owner") === owned)
      .map((project) => ({ label: project.name, description: project.role, project })));
  }
  const chosen = await vscode.window.showQuickPick(picks, { title: "Presentation: Open Presentation" });
  if (chosen?.fromLink) await openFromLink(server);
  else if (chosen?.project) await downloadProject(server, chosen.project);
}

async function openFromLink(server = configuredServer()): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Presentation: Open Presentation",
    prompt: "Paste presentation link",
    placeHolder: "http://host/open#…",
    ignoreFocusOut: true,
  });
  if (!input) return;
  const parsed = parsePresentationLink(input, server);
  if (!(await requireSession(parsed.server))) return;
  const project = await acceptProjectInvite(parsed.server, parsed.token);
  await downloadProject(parsed.server, project);
}

async function acceptInvitation(server = configuredServer()): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Presentation: Accept Invitation",
    prompt: "Paste account invite link",
    placeHolder: "http://host/join#token",
    ignoreFocusOut: true,
  });
  if (!input) return;
  const parsed = parseInviteInput(input, server);
  server = parsed.server;
  await previewAccountInvite(server, parsed.token);
  if (await getAccessToken(server)) {
    void vscode.window.showInformationMessage("This link only creates an account. You are already signed in.");
    return;
  }
  const creds = await promptCredentials("Presentation: Accept Invitation", server, 8);
  if (!creds) return;
  await storeLogin(server, await registerWithInvite(server, parsed.token, creds.username, creds.password));
  void vscode.window.showInformationMessage("Account created and signed in.");
}

async function createInviteLink(): Promise<void> {
  const server = configuredServer();
  if (!(await requireSession(server))) return;
  const invite = await createAccountInvite(server);
  const link = invite.url ?? `${server.replace(/\/$/, "")}/join#${encodeURIComponent(invite.token)}`;
  await vscode.env.clipboard.writeText(link);
  void vscode.window.showInformationMessage("Account invite link copied. They run Accept Invitation, paste the link, then choose a username and password.");
}


async function signOut(): Promise<void> {
  const meta = await readWorkspaceMeta();
  const server = meta?.server ?? configuredServer();
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Yes", description: "Clear the saved session and disconnect" },
      { label: "No" },
    ],
    { title: "Presentation: Sign Out", ignoreFocusOut: true },
  );
  if (choice?.label !== "Yes") return;
  await clearSession(server);
  dispose();
  setStatus("Signed out");
  void vscode.window.showInformationMessage("Signed out.");
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
      const server = meta?.server ?? configuredServer();
      const ok = (await getAccessToken(server)) ? await signIn(server) : await signInOrRegister(server);
      if (ok && meta) await connect(false);
    }),
    command("presentation.register", async () => {
      const meta = await readWorkspaceMeta();
      const server = meta?.server ?? configuredServer();
      if (await registerAccount(server) && meta) await connect(false);
    }),
    command("presentation.signOut", () => signOut()),
    command("presentation.createProject", create), command("presentation.openProject", open),
    command("presentation.acceptInvitation", () => acceptInvitation()),
    command("presentation.shareProject", () => createInviteLink()),
    command("presentation.copyLink", () => workspaceAction(async (meta) => {
      const invite = await createProjectInvite(meta.server, meta.projectId);
      await vscode.env.clipboard.writeText(invite.url);
      void vscode.window.showInformationMessage("Presentation link copied. They sign in, then Open from link… to join as an editor.");
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
