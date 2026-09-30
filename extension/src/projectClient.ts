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
};

export type Snapshot = {
  project_id: string;
  name: string;
  revision: number;
  directories: string[];
  files: { path: string; content: string }[];
  assets: unknown[];
};

export function collabWsUrl(server: string, projectId: string): string {
  const base = server.replace(/\/$/, "");
  const ws = base.startsWith("https")
    ? base.replace(/^https/, "wss")
    : base.replace(/^http/, "ws");
  return `${ws}/api/projects/${encodeURIComponent(projectId)}/collaboration`;
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
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
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

export async function listProjects(server: string): Promise<ProjectInfo[]> {
  const base = server.replace(/\/$/, "");
  return httpJson<ProjectInfo[]>(`${base}/api/projects`);
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
}
