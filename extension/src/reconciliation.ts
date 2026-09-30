import * as vscode from "vscode";
import {
  extractSnapshot,
  fetchSnapshot,
  type Snapshot,
  writeWorkspaceMeta,
  type WorkspaceMeta,
} from "./projectClient";
import type { OriginTracker } from "./originTracker";

const IGNORE_PREFIXES = [".presentation/", ".git/", "node_modules/", ".vscode/"];

function shouldIgnore(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  return IGNORE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p));
}

/**
 * Apply server snapshot as authoritative workspace-diff (B3):
 * - write/update all snapshot files + assets (including chapter slide.md)
 * - delete local files/dirs not present on server (except ignore prefixes)
 * - CRDT-bound text converges via disk watcher → FS_RECONCILE (not LOCAL_EDITOR)
 *
 * #10: JSON manifest + per-asset GET; publish uses content-addressed blobs + shared runtime (no tar/zip).
 */
export async function pullAndApplySnapshot(
  folder: vscode.Uri,
  server: string,
  projectId: string,
  origin: OriginTracker,
  suppressPaths: Set<string>,
  meta?: WorkspaceMeta,
  /** Optional: currently bound CRDT path — content still written; binding picks up via FS_RECONCILE. */
  _boundCrdtPath?: string,
): Promise<Snapshot> {
  let snap = await fetchSnapshot(server, projectId);
  // B4 client side: if server revision moved between fetches, take the newer full snap once.
  const again = await fetchSnapshot(server, projectId);
  if (
    again.revision !== snap.revision ||
    (again.content_hash && snap.content_hash && again.content_hash !== snap.content_hash)
  ) {
    snap = again;
  }

  const serverFiles = new Set(snap.files.map((f) => f.path.replace(/\\/g, "/")));
  const serverAssets = new Set((snap.assets ?? []).map((a) => a.path.replace(/\\/g, "/")));
  const serverDirs = new Set(snap.directories.map((d) => d.replace(/\\/g, "/")));
  const serverPaths = new Set<string>([...serverFiles, ...serverAssets, ...serverDirs]);

  const localEntries = await listLocalRelPaths(folder);
  const toDelete = localEntries
    .filter((rel) => !shouldIgnore(rel) && !serverPaths.has(rel))
    // Delete files before parent dirs: longer paths first.
    .sort((a, b) => b.length - a.length);

  const touched = new Set<string>([
    ...serverPaths,
    ...toDelete,
  ]);
  for (const p of touched) suppressPaths.add(p);

  try {
    await origin.markRemote(async () => {
      // Deletes first so rename-as-delete+create and orphan cleanup stick.
      for (const rel of toDelete) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, rel), {
            recursive: true,
            useTrash: false,
          });
        } catch {
          // already gone
        }
      }
      // Full extract including all slide.md (no blanket CRDT skip — B3).
      await extractSnapshot(folder, snap, server);
    });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    for (const p of touched) suppressPaths.delete(p);
  }

  if (meta) {
    await writeWorkspaceMeta(folder, {
      ...meta,
      lastKnownRevision: snap.revision,
    });
  }
  return snap;
}

/** Bound collaborative text paths (root or chapter slide.md). Kept for callers. */
export function isCrdtBoundPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  return n === "slide.md" || n.endsWith("/slide.md");
}

async function listLocalRelPaths(folder: vscode.Uri): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: vscode.Uri, prefix: string): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (shouldIgnore(rel)) continue;
      if (type & vscode.FileType.Directory) {
        out.push(rel);
        await walk(vscode.Uri.joinPath(dir, name), rel);
      } else if (type & vscode.FileType.File) {
        out.push(rel);
      }
    }
  }
  await walk(folder, "");
  return out;
}

/**
 * Sync Controller heuristic only (#5) — NOT architecture/spec.
 * ≥ BULK_EVENT_THRESHOLD unique-path events inside BULK_WINDOW_MS → reconcile
 * (Git checkout / merge / mass rewrite). Not LOCAL_EDITOR — use FS_RECONCILE path.
 */
export const BULK_EVENT_THRESHOLD = 8;
export const BULK_WINDOW_MS = 1000;
