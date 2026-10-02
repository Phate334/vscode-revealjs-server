import * as fs from "node:fs";
import * as vscode from "vscode";
import { atomicWrite, hash, ignoredPath, localPath, readJson } from "./localState";
import { getAsset, type Snapshot, type WorkspaceMeta } from "./projectClient";
import { isBinaryPath, isCollaborativeTextPath } from "./textPaths";

export type Entry = { kind: "directory" | "text" | "asset"; hash?: string; revision?: number };
export type DiskEntry = Entry & { content?: string; data?: Uint8Array };
export type LocalState = {
  projectId: string;
  server: string;
  structureRevision: number;
  disk: Record<string, Entry>;
  remote: Record<string, Entry>;
};

export function statePath(folder: vscode.Uri): string { return localPath(folder, ".presentation/sync-state.json", true); }
export function saveState(folder: vscode.Uri, state: LocalState): void {
  atomicWrite(statePath(folder), JSON.stringify(state, null, 2) + "\n");
}
export function loadState(folder: vscode.Uri, meta: WorkspaceMeta): LocalState | undefined {
  const state = readJson<LocalState | undefined>(statePath(folder), undefined);
  if (state && (state.projectId !== meta.projectId || state.server !== meta.server)) throw new Error("Workspace state belongs to a different presentation");
  if (state) {
    state.disk = Object.assign(Object.create(null), state.disk);
    state.remote = Object.assign(Object.create(null), state.remote);
  }
  return state;
}
export function snapshotEntries(snap: Snapshot): Record<string, Entry> {
  const out: Record<string, Entry> = Object.create(null);
  for (const p of snap.directories) out[p] = { kind: "directory" };
  for (const f of snap.files) out[f.path] = { kind: "text", hash: hash(f.content) };
  for (const a of snap.assets) out[a.path] = { kind: "asset", hash: a.content_hash, revision: a.revision };
  return out;
}
export function descriptors(entries: Record<string, DiskEntry>): Record<string, Entry> {
  return Object.fromEntries(Object.entries(entries).map(([p, e]) => [p, { kind: e.kind, hash: e.hash }]));
}
export function readEntry(folder: vscode.Uri, rel: string): DiskEntry | undefined {
  const filename = localPath(folder, rel);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  if (stat.isDirectory()) return { kind: "directory" };
  if (!stat.isFile()) throw new Error(`Unsupported file type: ${rel}`);
  const data = fs.readFileSync(filename);
  if (isBinaryPath(rel)) return { kind: "asset", hash: hash(data), data };
  return { kind: "text", hash: hash(data), content: new TextDecoder("utf-8", { fatal: true }).decode(data) };
}
export function scanLocal(folder: vscode.Uri): Record<string, DiskEntry> {
  const out: Record<string, DiskEntry> = Object.create(null);
  const walk = (dir: string, prefix = "") => {
    for (const name of fs.readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (ignoredPath(rel)) continue;
      // Unsupported user files are preserved and surfaced, never quietly deleted.
      if (!/^(?:[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)?|runtime(?:\/[\p{L}\p{N}_.-]+)+)$/u.test(rel)) {
        throw new Error(`Unsupported workspace path; move it into an ignored local folder: ${rel}`);
      }
      const entry = readEntry(folder, rel);
      if (!entry) continue;
      out[rel] = entry;
      if (entry.kind === "directory") walk(localPath(folder, rel), rel);
    }
  };
  walk(folder.fsPath);
  return out;
}
export function same(a?: Entry, b?: Entry): boolean {
  return a?.kind === b?.kind && a?.hash === b?.hash;
}

/** Topology preconditions allow concurrent CRDT typing, but protect binary/non-CRDT content. */
export function signature(entries: Record<string, Entry>, rel: string): string | null {
  const entry = entries[rel];
  if (!entry) return null;
  if (entry.kind === "directory") {
    return hash(Object.keys(entries).filter((p) => p.startsWith(rel + "/")).sort()
      .map((p) => `${p}:${signature(entries, p)}`).join("\n"));
  }
  return entry.kind === "text" && isCollaborativeTextPath(rel) ? "collaborative-text" : `${entry.kind}:${entry.hash}`;
}

export function initializeState(folder: vscode.Uri, meta: WorkspaceMeta, snap: Snapshot): void {
  const remote = snapshotEntries(snap);
  saveState(folder, { server: meta.server, projectId: meta.projectId, structureRevision: snap.structure_revision,
    remote, disk: descriptors(scanLocal(folder)) });
}

/** Remote projection only touches previously managed, unchanged paths outside pending intent. */
export async function applyRemoteSnapshot(
  folder: vscode.Uri, server: string, snap: Snapshot, state: LocalState,
  protectedPaths: Set<string>, text: (rel: string) => string | undefined,
): Promise<string[]> {
  const conflicts: string[] = [];
  const target = snapshotEntries(snap);
  const protectedByIntent = (rel: string) => [...protectedPaths].some((p) => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"));
  const dirty = (rel: string) => vscode.workspace.textDocuments.some((d) => d.uri.fsPath === localPath(folder, rel) && d.isDirty);
  const previous = { ...state.disk };
  const remove = Object.keys(state.remote).filter((rel) => !target[rel]).sort((a, b) => b.length - a.length);
  for (const rel of remove) {
    if (protectedByIntent(rel)) continue;
    const local = readEntry(folder, rel);
    if (!local) { delete state.disk[rel]; continue; }
    if (!same(local, previous[rel]) || dirty(rel)) { conflicts.push(rel); continue; }
    try {
      const filename = localPath(folder, rel);
      // Never recursively delete a folder: unknown/ignored child files must survive.
      if (local.kind === "directory") fs.rmdirSync(filename); else fs.unlinkSync(filename);
      delete state.disk[rel];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") conflicts.push(rel);
    }
  }
  for (const rel of snap.directories) {
    if (protectedByIntent(rel)) continue;
    const current = readEntry(folder, rel);
    if (current && current.kind !== "directory") { conflicts.push(rel); continue; }
    fs.mkdirSync(localPath(folder, rel), { recursive: true });
    state.disk[rel] = { kind: "directory" };
  }
  for (const file of [...snap.files, ...snap.assets]) {
    const rel = file.path;
    if (protectedByIntent(rel)) continue;
    const collaborative = isCollaborativeTextPath(rel);
    if (collaborative && dirty(rel)) continue;
    let current = readEntry(folder, rel);
    const expected = previous[rel];
    if (current && !same(current, expected) && !same(current, target[rel])) { conflicts.push(rel); continue; }
    if (!current && expected) { conflicts.push(rel); continue; }
    let data: Uint8Array;
    if ("content" in file) data = Buffer.from(collaborative ? text(rel) ?? file.content : file.content, "utf8");
    else data = await getAsset(server, snap.project_id, rel, file.content_hash);
    // Asset download awaited network; compare once more before the synchronous write.
    if (!same(readEntry(folder, rel), current) || (collaborative && dirty(rel))) { conflicts.push(rel); continue; }
    if (current?.hash !== hash(data)) atomicWrite(localPath(folder, rel), data);
    state.disk[rel] = { kind: target[rel].kind, hash: hash(data) };
  }
  state.remote = target;
  state.structureRevision = snap.structure_revision;
  saveState(folder, state);
  return conflicts;
}
