import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAccessToken } from "./auth";
import { atomicWrite, hash, localPath } from "./localState";
import type { FsOperation, OperationsResult } from "./collaborationClient";

export const DEFAULT_SERVER = "http://127.0.0.1:8000";
export function normalizeServer(server: string): string {
  const url = new URL(server);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Server URL must be an HTTP(S) origin");
  return url.origin;
}
export function configuredServer(): string {
  return normalizeServer(vscode.workspace.getConfiguration("presentation").get<string>("serverUrl", DEFAULT_SERVER));
}

export type WorkspaceMeta = {
  version: number;
  server: string;
  projectId: string;
  lastKnownStructureRevision: number;
};

export type ProjectInfo = {
  id: string;
  name: string;
  created_at: string;
  structure_revision: number;
  role?: string;
  slug?: string;
};

export type Snapshot = {
  project_id: string;
  name: string;
  structure_revision: number;
  yjs_state: string;
  /** Workspace content fingerprint (B4); optional for older servers. */
  content_hash?: string;
  directories: string[];
  files: { path: string; content: string }[];
  assets: { path: string; content_hash: string; size: number; revision?: number }[];
};

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const server = new URL(url).origin;
  const send = async (forceRefresh: boolean) => {
    const token = await getAccessToken(server, forceRefresh);
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
  const response = await send(false);
  return response.status === 401 ? send(true) : response;
}

export async function collabWsUrl(server: string, projectId: string): Promise<string> {
  const base = server.replace(/\/$/, "");
  const ws = base.startsWith("https")
    ? base.replace(/^https/, "wss")
    : base.replace(/^http/, "ws");
  const token = await getAccessToken(server);
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
    const j = JSON.parse(raw) as Partial<WorkspaceMeta> & { lastKnownRevision?: number };
    const projectId = j.projectId;
    if (!projectId || typeof projectId !== "string") return undefined;
    return {
      version: typeof j.version === "number" ? j.version : 1,
      server: normalizeServer(typeof j.server === "string" && j.server ? j.server : DEFAULT_SERVER),
      projectId,
      lastKnownStructureRevision: j.lastKnownStructureRevision ?? j.lastKnownRevision ?? 0,
    };
  } catch {
    return undefined;
  }
}

export async function writeWorkspaceMeta(
  folder: vscode.Uri,
  meta: WorkspaceMeta,
): Promise<void> {
  atomicWrite(localPath(folder, ".presentation/workspace.json", true), JSON.stringify(meta, null, 2) + "\n");
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
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
  structure_revision: number;
};

/** Server 409 AssetConflict payload (#9). */
export class AssetConflictError extends Error {
  readonly path: string;
  readonly contentHash: string;
  readonly revision: number;
  readonly size: number;

  constructor(detail: {
    path: string;
    content_hash: string;
    revision: number;
    size: number;
  }) {
    super(`AssetConflict: ${detail.path} revision=${detail.revision}`);
    this.name = "AssetConflictError";
    this.path = detail.path;
    this.contentHash = detail.content_hash;
    this.revision = detail.revision;
    this.size = detail.size;
  }
}

export async function putAsset(
  server: string,
  projectId: string,
  relPath: string,
  data: Uint8Array,
  clientId?: string,
  baseRevision?: number,
  force?: boolean,
): Promise<AssetPutResult> {
  const base = server.replace(/\/$/, "");
  const params = new URLSearchParams();
  if (clientId) params.set("client_id", clientId);
  if (typeof baseRevision === "number") params.set("base_revision", String(baseRevision));
  if (force) params.set("force", "true");
  const q = params.toString() ? `?${params.toString()}` : "";
  const url = `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${q}`;
  const res = await authFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(data),
  });
  if (res.status === 409) {
    const raw = await res.text().catch(() => "");
    let detail: { error?: string; path?: string; content_hash?: string; revision?: number; size?: number } = {};
    try {
      const parsed = JSON.parse(raw) as { detail?: typeof detail } & typeof detail;
      detail = (parsed.detail && typeof parsed.detail === "object" ? parsed.detail : parsed) as typeof detail;
    } catch {
      /* plain text */
    }
    if (detail.error === "AssetConflict" || typeof detail.revision === "number") {
      throw new AssetConflictError({
        path: detail.path || relPath,
        content_hash: detail.content_hash || "",
        revision: Number(detail.revision) || 0,
        size: Number(detail.size) || 0,
      });
    }
    throw new Error(`HTTP 409 PUT asset: ${raw || res.statusText}`);
  }
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
  expectedHash?: string,
): Promise<Uint8Array> {
  const base = server.replace(/\/$/, "");
  const url = `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${expectedHash ? `?content_hash=${encodeURIComponent(expectedHash)}` : ""}`;
  const res = await authFetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} GET asset: ${detail || res.statusText}`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (expectedHash && hash(data) !== expectedHash) throw new Error("Asset changed since snapshot");
  return data;
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

async function postCredentials(
  server: string,
  path: string,
  username: string,
  password: string,
  failed: string,
): Promise<LoginResult> {
  const base = server.replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch { /* status is enough */ }
    if (response.status === 403 && path === "/api/auth/register") {
      throw new Error("Registration is closed. Use an account invite (Presentation: Accept Invitation).");
    }
    throw new Error(detail ? `${failed} (${response.status}): ${detail}` : `${failed} (${response.status})`);
  }
  return await response.json() as LoginResult;
}

export async function login(server: string, username: string, password: string): Promise<LoginResult> {
  return postCredentials(server, "/api/auth/login", username, password, "Sign In failed");
}

export async function register(server: string, username: string, password: string): Promise<LoginResult> {
  return postCredentials(server, "/api/auth/register", username, password, "Register failed");
}

export type AccountInvite = {
  id: string;
  token: string;
  created_at: string;
  /** `{origin}/join#{token}` when the server built it. */
  url: string;
};

export async function createAccountInvite(server: string): Promise<AccountInvite> {
  const base = server.replace(/\/$/, "");
  return httpJson<AccountInvite>(`${base}/api/account-invites`, { method: "POST" });
}

/** Invite token creates a new account only. Existing usernames are rejected. */
export async function registerWithInvite(server: string, token: string, username: string, password: string): Promise<LoginResult> {
  const base = server.replace(/\/$/, "");
  return postCredentials(
    base,
    `/api/account-invites/${encodeURIComponent(token)}/register`,
    username,
    password,
    "Register failed",
  );
}

export async function previewAccountInvite(server: string, token: string): Promise<{ valid: boolean }> {
  return httpJson(`${server.replace(/\/$/, "")}/api/account-invites/${encodeURIComponent(token)}`);
}

export type ProjectInvite = { project_id: string; name: string; role: string; url: string };

/** Owner-only. URL is `{origin}/open#{token}` and adds an editor when accepted. */
export async function createProjectInvite(server: string, projectId: string): Promise<ProjectInvite> {
  const base = server.replace(/\/$/, "");
  return httpJson<ProjectInvite>(`${base}/api/projects/${encodeURIComponent(projectId)}/invites`, { method: "POST" });
}

/** Idempotent. Returns the project, including when the caller is already owner or editor. */
export async function acceptProjectInvite(server: string, token: string): Promise<ProjectInfo> {
  const base = server.replace(/\/$/, "");
  return httpJson<ProjectInfo>(`${base}/api/project-invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
}

/** Invite link, legacy JSON `{server, token}`, or a bare token (uses fallbackServer). */
export function parseInviteInput(input: string, fallbackServer: string): { server: string; token: string } {
  const raw = input.trim();
  if (!raw) throw new Error("Invitation link required");
  if (raw.startsWith("{")) {
    const invite = JSON.parse(raw) as { server?: string; token?: string };
    if (!invite.server || !invite.token) throw new Error("Invitation must include a server and token");
    return { server: normalizeServer(invite.server), token: invite.token.trim() };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    const fromHash = url.hash.length > 1 ? decodeURIComponent(url.hash.slice(1)) : "";
    const token = (fromHash || url.searchParams.get("token") || "").trim();
    if (!token) throw new Error("Invitation link is missing a token");
    return { server: normalizeServer(url.origin), token };
  }
  return { server: normalizeServer(fallbackServer), token: raw };
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
  structure_revision: number;
  slug?: string;
};

export async function publishRelease(server: string, projectId: string): Promise<ReleaseInfo> {
  const base = server.replace(/\/$/, "");
  return httpJson<ReleaseInfo>(
    `${base}/api/projects/${encodeURIComponent(projectId)}/publish`,
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

/** Extract only into a newly reserved child folder; every path is validated. */
export async function extractSnapshot(folder: vscode.Uri, snap: Snapshot, server: string): Promise<void> {
  for (const dir of snap.directories) fs.mkdirSync(localPath(folder, dir), { recursive: true });
  for (const file of snap.files) {
    const dest = localPath(folder, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content, { flag: "wx" });
  }
  for (const asset of snap.assets) {
    const data = await getAsset(server, snap.project_id, asset.path, asset.content_hash);
    const dest = localPath(folder, asset.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data, { flag: "wx" });
  }
  atomicWrite(localPath(folder, ".presentation/yjs-state.bin", true), Buffer.from(snap.yjs_state, "base64"));
}

export async function sendOperations(server: string, projectId: string, base: number, operations: FsOperation[]): Promise<OperationsResult> {
  const response = await authFetch(`${server}/api/projects/${encodeURIComponent(projectId)}/workspace/operations`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_revision: base, operations }),
  });
  const body = await response.json() as OperationsResult & { detail?: OperationsResult };
  if (response.status === 409 && body.detail?.results) return body.detail;
  if (!response.ok) throw new Error(`Workspace command failed (${response.status})`);
  return body;
}

/** `{origin}/open#{token}`, `?token=`, or a bare invite token (uses fallbackServer). */
export function parsePresentationLink(input: string, fallbackServer: string): { server: string; token: string } {
  const raw = input.trim();
  if (!raw) throw new Error("Presentation link required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    const fromHash = url.hash.length > 1 ? decodeURIComponent(url.hash.slice(1)) : "";
    const token = (fromHash || url.searchParams.get("token") || "").trim();
    if (!token) throw new Error("Presentation link is missing a token");
    return { server: normalizeServer(url.origin), token };
  }
  return { server: normalizeServer(fallbackServer), token: raw };
}

export async function previewSession(server: string, projectId: string): Promise<{ url: string; expires_at: number }> {
  return httpJson(`${server}/api/projects/${encodeURIComponent(projectId)}/preview-session`, { method: "POST" });
}
