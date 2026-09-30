import * as vscode from "vscode";

export const DEFAULT_SERVER = "http://127.0.0.1:8000";

export type WorkspaceMeta = {
  version: number;
  server: string;
  projectId: string;
  lastKnownRevision: number;
};

export type ProjectInfo = {
  id: string;
  name: string;
  created_at: string;
  revision: number;
  role?: string;
  slug?: string;
};

export type Snapshot = {
  project_id: string;
  name: string;
  revision: number;
  /** Workspace content fingerprint (B4); optional for older servers. */
  content_hash?: string;
  directories: string[];
  files: { path: string; content: string }[];
  assets: { path: string; content_hash: string; size: number }[];
};

let accessTokenGetter: () => Promise<string | undefined> = async () => undefined;

/** Extension wires this to SecretStorage. HTTP and WS attach the token when set. */
export function setAccessTokenGetter(fn: () => Promise<string | undefined>): void {
  accessTokenGetter = fn;
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  const token = await accessTokenGetter();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function collabWsUrl(server: string, projectId: string): Promise<string> {
  const base = server.replace(/\/$/, "");
  const ws = base.startsWith("https")
    ? base.replace(/^https/, "wss")
    : base.replace(/^http/, "ws");
  const token = await accessTokenGetter();
  const q = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return `${ws}/api/projects/${encodeURIComponent(projectId)}/collaboration${q}`;
}

export async function readWorkspaceMeta(
  folder?: vscode.Uri,
): Promise<WorkspaceMeta | undefined> {
  const root =
    folder ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;
  const uri = vscode.Uri.joinPath(root, ".presentation", "workspace.json");
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    const j = JSON.parse(raw) as Partial<WorkspaceMeta> & { projectId?: string };
    const projectId = j.projectId;
    if (!projectId || typeof projectId !== "string") return undefined;
    return {
      version: typeof j.version === "number" ? j.version : 1,
      server: typeof j.server === "string" && j.server ? j.server : DEFAULT_SERVER,
      projectId,
      lastKnownRevision:
        typeof j.lastKnownRevision === "number" ? j.lastKnownRevision : 0,
    };
  } catch {
    return undefined;
  }
}

export async function writeWorkspaceMeta(
  folder: vscode.Uri,
  meta: WorkspaceMeta,
): Promise<void> {
  const dir = vscode.Uri.joinPath(folder, ".presentation");
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, "workspace.json");
  const body = Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8");
  await vscode.workspace.fs.writeFile(uri, body);
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders(init?.headers as Record<string, string> | undefined);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}


export { isBinaryPath, isCollaborativeTextPath } from "./textPaths";

export type AssetPutResult = {
  path: string;
  content_hash: string;
  size: number;
  revision: number;
};

export async function putAsset(
  server: string,
  projectId: string,
  relPath: string,
  data: Uint8Array,
  clientId?: string,
): Promise<AssetPutResult> {
  const base = server.replace(/\/$/, "");
  const q = clientId ? `?client_id=${encodeURIComponent(clientId)}` : "";
  const url = `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${q}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: await authHeaders({ "Content-Type": "application/octet-stream" }),
    body: Buffer.from(data),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} PUT asset: ${detail || res.statusText}`);
  }
  return (await res.json()) as AssetPutResult;
}

export async function getAsset(
  server: string,
  projectId: string,
  relPath: string,
): Promise<Uint8Array> {
  const base = server.replace(/\/$/, "");
  const url = `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} GET asset: ${detail || res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function createProject(
  server: string,
  name: string,
): Promise<ProjectInfo> {
  const base = server.replace(/\/$/, "");
  return httpJson<ProjectInfo>(`${base}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function listProjects(
  server: string,
  scope?: "owned" | "shared",
): Promise<ProjectInfo[]> {
  const base = server.replace(/\/$/, "");
  const q = scope ? `?scope=${scope}` : "";
  return httpJson<ProjectInfo[]>(`${base}/api/projects${q}`);
}

export type LoginResult = {
  access_token: string;
  refresh_token: string;
  user: { id: string; username: string };
};

export async function login(
  server: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const base = server.replace(/\/$/, "");
  return httpJson<LoginResult>(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export type ShareInvite = {
  id: string;
  token: string;
  role: string;
  project_id: string;
};

export async function createShare(
  server: string,
  projectId: string,
  role: "editor" | "viewer",
): Promise<ShareInvite> {
  const base = server.replace(/\/$/, "");
  return httpJson<ShareInvite>(
    `${base}/api/projects/${encodeURIComponent(projectId)}/shares`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}

export async function acceptShare(
  server: string,
  token: string,
): Promise<{ project: ProjectInfo; already_member: boolean }> {
  const base = server.replace(/\/$/, "");
  return httpJson(`${base}/api/shares/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export type MemberInfo = { user_id: string; username: string; role: string };

export async function listMembers(server: string, projectId: string): Promise<MemberInfo[]> {
  const base = server.replace(/\/$/, "");
  return httpJson<MemberInfo[]>(
    `${base}/api/projects/${encodeURIComponent(projectId)}/members`,
  );
}

export type ReleaseInfo = {
  id: string;
  public_path: string;
  release_path: string;
  current: boolean;
  revision: number;
  slug?: string;
};

export async function publishRelease(server: string, projectId: string): Promise<ReleaseInfo> {
  const base = server.replace(/\/$/, "");
  return httpJson<ReleaseInfo>(
    `${base}/api/projects/${encodeURIComponent(projectId)}/releases`,
    { method: "POST" },
  );
}

export async function fetchSnapshot(
  server: string,
  projectId: string,
): Promise<Snapshot> {
  const base = server.replace(/\/$/, "");
  return httpJson<Snapshot>(
    `${base}/api/projects/${encodeURIComponent(projectId)}/snapshot`,
  );
}

/** Write snapshot files into folder (overwrites listed paths). */
export async function extractSnapshot(
  folder: vscode.Uri,
  snap: Snapshot,
  server?: string,
): Promise<void> {
  for (const dir of snap.directories) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, dir));
  }
  for (const f of snap.files) {
    const uri = vscode.Uri.joinPath(folder, f.path);
    const parent = vscode.Uri.joinPath(uri, "..");
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(f.content, "utf8"));
  }
  // Asset bodies are refs only in JSON snapshot; pull via GET when server known.
  const base = server ?? DEFAULT_SERVER;
  for (const a of snap.assets ?? []) {
    if (!a?.path) continue;
    const bytes = await getAsset(base, snap.project_id, a.path);
    const uri = vscode.Uri.joinPath(folder, a.path);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
}
