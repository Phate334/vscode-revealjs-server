import * as vscode from "vscode";
import { CollaborationClient } from "./collaborationClient";
import { bindSlideDocument, type SlideBinding } from "./documentBinding";
import { getAccessToken, initAuth, saveSession } from "./auth";
import {
  DEFAULT_SERVER,
  collabWsUrl,
  acceptShare,
  createProject,
  createShare,
  extractSnapshot,
  fetchSnapshot,
  listMembers,
  listProjects,
  login,
  publishRelease,
  readWorkspaceMeta,
  setAccessTokenGetter,
  writeWorkspaceMeta,
  type ProjectInfo,
} from "./projectClient";
import { openPreview } from "./preview";
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

/**
 * H2 init order:
 * 1. create client + SyncController remote handlers (catch reconcile_required)
 * 2. connect → ready/snapshot barrier
 * 3. bind documents (seed after barrier)
 * 4. start local FS watchers
 */
async function connect(): Promise<void> {
  if (client) {
    void vscode.window.showInformationMessage("Collab already connected");
    return;
  }
  if (!(await getAccessToken())) {
    void vscode.window.showErrorMessage("Sign in first (Presentation: Sign In)");
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
  const url = await collabWsUrl(meta.server, meta.projectId);
  client = new CollaborationClient(id, url, meta.lastKnownRevision);
  client.onStatus = setStatus;
  sync = new SyncController(
    client,
    folder,
    meta.server,
    meta.projectId,
    meta.lastKnownRevision,
    meta,
  );
  sync.startRemoteHandlers();
  try {
    await client.connect();
    binding = await bindSlideDocument(client);
    sync.startLocalWatchers();
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

async function pickLocalFolder(openLabel: string): Promise<vscode.Uri | undefined> {
  const current = vscode.workspace.workspaceFolders?.[0]?.uri;
  const items: { label: string; description?: string; uri?: vscode.Uri; pick?: "dialog" }[] = [];
  if (current) {
    items.push({
      label: "Use current folder",
      description: current.fsPath,
      uri: current,
    });
  }
  items.push({ label: "Choose folder…", pick: "dialog" });
  const chosen = await vscode.window.showQuickPick(items, {
    title: openLabel,
    placeHolder: "Where should local files go?",
  });
  if (!chosen) return undefined;
  if (chosen.uri) return chosen.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel,
  });
  return picked?.[0];
}

async function cmdCreateProject(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Presentation: Create Project",
    prompt: "Project name",
    validateInput: (v) => (v.trim() ? undefined : "Name required"),
  });
  if (!name) return;

  const parentUri = await pickLocalFolder("Select parent folder");
  if (!parentUri) return;
  const parent = [parentUri];

  if (!(await requireAccess())) return;
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

async function requireAccess(): Promise<boolean> {
  if (await getAccessToken()) return true;
  void vscode.window.showErrorMessage("Sign in first (Presentation: Sign In)");
  return false;
}

async function cmdSignIn(): Promise<void> {
  const username = await vscode.window.showInputBox({
    title: "Presentation: Sign In",
    prompt: "Username (demo users: demo / alice)",
    ignoreFocusOut: true,
  });
  if (!username) return;
  const password = await vscode.window.showInputBox({
    title: "Presentation: Sign In",
    prompt: "Password",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;
  try {
    const session = await login(DEFAULT_SERVER, username.trim(), password);
    await saveSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      username: session.user.username,
    });
    void vscode.window.showInformationMessage(`Signed in as ${session.user.username}`);
    if (!client && (await readWorkspaceMeta())) await connect();
  } catch (err) {
    void vscode.window.showErrorMessage(`Sign In failed: ${String(err)}`);
  }
}

async function openListedProject(title: string, scope: "owned" | "shared"): Promise<void> {
  if (!(await requireAccess())) return;
  const server = DEFAULT_SERVER;
  let projects: ProjectInfo[];
  try {
    projects = await listProjects(server, scope);
  } catch (err) {
    void vscode.window.showErrorMessage(`List projects failed: ${String(err)}`);
    return;
  }
  if (projects.length === 0) {
    const hint = scope === "shared" ? "No shared projects — accept a share token first" : "No projects — Create Project first";
    void vscode.window.showInformationMessage(hint);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((proj) => ({
      label: proj.name,
      description: proj.id,
      detail: `rev ${proj.revision} · ${proj.created_at}`,
      project: proj,
    })),
    { title },
  );
  if (!picked) return;
  const folder = await pickLocalFolder("Select local folder for snapshot");
  if (!folder) return;
  try {
    const snap = await fetchSnapshot(server, picked.project.id);
    await extractSnapshot(folder, snap, server);
    await writeWorkspaceMeta(folder, {
      version: 1,
      server,
      projectId: picked.project.id,
      lastKnownRevision: snap.revision,
    });
    await vscode.commands.executeCommand("vscode.openFolder", folder, {
      forceNewWindow: false,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Open Project failed: ${String(err)}`);
  }
}

async function cmdShareProject(): Promise<void> {
  if (!(await requireAccess())) return;
  const meta = await readWorkspaceMeta();
  if (!meta) {
    void vscode.window.showErrorMessage("Share: open a presentation workspace first");
    return;
  }
  const rolePick = await vscode.window.showQuickPick(
    [
      { label: "viewer", description: "Can open and preview" },
      { label: "editor", description: "Can edit and publish" },
    ],
    { title: "Presentation: Share Project" },
  );
  if (!rolePick) return;
  const role = rolePick.label === "editor" ? "editor" : "viewer";
  try {
    const invite = await createShare(meta.server, meta.projectId, role);
    await vscode.env.clipboard.writeText(invite.token);
    void vscode.window.showInformationMessage(
      `Share token copied (${role}). Open Shared Project on the other window and paste it.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Share Project failed: ${String(err)}`);
  }
}

async function cmdOpenShared(): Promise<void> {
  // Join via token, then pick from shared list (same snapshot flow as Open).
  if (!(await requireAccess())) return;
  const token = await vscode.window.showInputBox({
    title: "Presentation: Open Shared Project",
    prompt: "Paste share token (empty to skip and pick an already-accepted project)",
    ignoreFocusOut: true,
  });
  if (token === undefined) return;
  if (token.trim()) {
    try {
      const joined = await acceptShare(DEFAULT_SERVER, token.trim());
      void vscode.window.showInformationMessage(
        joined.already_member
          ? `Already a member of ${joined.project.name}`
          : `Joined ${joined.project.name} as ${joined.project.role ?? "member"}`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Accept share failed: ${String(err)}`);
      return;
    }
  }
  await openListedProject("Presentation: Open Shared Project", "shared");
}

async function cmdPublish(): Promise<void> {
  if (!(await requireAccess())) return;
  const meta = await readWorkspaceMeta();
  if (!meta) {
    void vscode.window.showErrorMessage("Publish: open a presentation workspace first");
    return;
  }
  try {
    const rel = await publishRelease(meta.server, meta.projectId);
    const origin = meta.server.replace(/\/$/, "");
    const msg = `Published ${rel.id}\n${origin}${rel.public_path}\n${origin}${rel.release_path}`;
    await vscode.env.clipboard.writeText(`${origin}${rel.public_path}`);
    void vscode.window.showInformationMessage(msg);
  } catch (err) {
    void vscode.window.showErrorMessage(`Publish failed: ${String(err)}`);
  }
}

async function cmdMembers(): Promise<void> {
  if (!(await requireAccess())) return;
  const meta = await readWorkspaceMeta();
  if (!meta) {
    void vscode.window.showErrorMessage("Members: open a presentation workspace first");
    return;
  }
  try {
    const members = await listMembers(meta.server, meta.projectId);
    await vscode.window.showQuickPick(
      members.map((m) => ({ label: m.username, description: m.role, detail: m.user_id })),
      { title: "Presentation: Project Members" },
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Project Members failed: ${String(err)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  initAuth(context);
  setAccessTokenGetter(getAccessToken);
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
    vscode.commands.registerCommand("presentation.signIn", () => cmdSignIn()),
    vscode.commands.registerCommand("presentation.createProject", () => cmdCreateProject()),
    vscode.commands.registerCommand("presentation.openProject", () => openListedProject("Presentation: Open Project", "owned")),
    vscode.commands.registerCommand("presentation.openSharedProject", () => cmdOpenShared()),
    vscode.commands.registerCommand("presentation.shareProject", () => cmdShareProject()),
    vscode.commands.registerCommand("presentation.projectMembers", () => cmdMembers()),
    vscode.commands.registerCommand("presentation.publish", () => cmdPublish()),
    vscode.commands.registerCommand("presentation.openPreview", () => openPreview()),
  );

  void readWorkspaceMeta().then(async (meta) => {
    if (meta && (await getAccessToken())) void connect();
  });
}

export function deactivate(): void {
  disconnect();
}
