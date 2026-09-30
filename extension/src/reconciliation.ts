import * as vscode from "vscode";
import {
  extractSnapshot,
  fetchSnapshot,
  type Snapshot,
  writeWorkspaceMeta,
  type WorkspaceMeta,
} from "./projectClient";
import type { OriginTracker } from "./originTracker";

/**
 * Apply server snapshot onto local folder under remote/reconcile origin.
 * Text CRDT-bound paths (slide.md) are skipped so Yjs merge stays authoritative;
 * disk for those is left for Document Binding / FS_RECONCILE after.
 *
 * ponytail: open-decision #10 — JSON manifest + per-asset GET (no archive).
 * Ceiling: large asset fan-out. Upgrade: tar/zip bundle (M3).
 */
export async function pullAndApplySnapshot(
  folder: vscode.Uri,
  server: string,
  projectId: string,
  origin: OriginTracker,
  suppressPaths: Set<string>,
  meta?: WorkspaceMeta,
): Promise<Snapshot> {
  const snap = await fetchSnapshot(server, projectId);
  const touched: string[] = [];
  for (const d of snap.directories) touched.push(d);
  for (const f of snap.files) touched.push(f.path);
  for (const a of snap.assets ?? []) if (a?.path) touched.push(a.path);
  for (const p of touched) suppressPaths.add(p);

  try {
    await origin.markRemote(async () => {
      // Skip collaborative slide.md content — CRDT owns text; avoid UndoManager pollution.
      const filtered: Snapshot = {
        ...snap,
        files: snap.files.filter((f) => !isCrdtBoundPath(f.path)),
      };
      await extractSnapshot(folder, filtered, server);
    });
    // Hold suppress — VS Code may emit create/change after writes.
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

/** Bound collaborative text paths (root or chapter slide.md). */
export function isCrdtBoundPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  return n === "slide.md" || n.endsWith("/slide.md");
}

/**
 * ponytail: open-decision #5 — temporary bulk-change detection.
 * ≥ BULK_EVENT_THRESHOLD local topology events inside BULK_WINDOW_MS → reconcile
 * (Git checkout / merge / mass rewrite). Not LOCAL_EDITOR — use FS_RECONCILE path.
 */
export const BULK_EVENT_THRESHOLD = 8;
export const BULK_WINDOW_MS = 2000;
