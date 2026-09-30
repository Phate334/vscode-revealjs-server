import * as vscode from "vscode";
import type {
  AssetChangedEvent,
  CollaborationClient,
  FsOperation,
  ReconcileRequiredEvent,
} from "./collaborationClient";
import { OriginTracker } from "./originTracker";
import { getAsset, isBinaryPath, putAsset, type WorkspaceMeta } from "./projectClient";
import {
  BULK_EVENT_THRESHOLD,
  BULK_WINDOW_MS,
  pullAndApplySnapshot,
} from "./reconciliation";

const IGNORE_PREFIXES = [".presentation/", ".git/", "node_modules/", ".vscode/"];

const BINARY_GLOB = "**/*.{png,jpg,jpeg,gif,webp,svg,mp4,webm,pdf,woff,woff2}";

function shouldIgnore(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  return IGNORE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p));
}

function relPath(folder: vscode.Uri, uri: vscode.Uri): string | undefined {
  const root = folder.fsPath.replace(/[/\\]+$/, "");
  const full = uri.fsPath;
  if (!full.startsWith(root)) return undefined;
  const rel = full.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return rel || undefined;
}

/**
 * Sync Controller (M1): local FS topology → fs.operation; binary → Asset PUT;
 * remote fs.operation / asset.changed → apply with origin mark (echo suppress);
 * revision gap / bulk local change → snapshot reconcile (FS_RECONCILE, not UndoManager).
 *
 * H2: startRemoteHandlers before connect; startLocalWatchers after ready + document bind.
 */
export class SyncController {
  private readonly origin = new OriginTracker();
  /** Paths suppressed while / shortly after remote apply (async FS event echo). */
  private readonly suppressPaths = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private workspaceRevision: number;
  private disposed = false;
  /** Pause local→server emission during snapshot reconcile. */
  private reconciling = false;
  private reconcileQueued = false;
  /** Timestamps of recent local topology events for bulk detection (#5). */
  private bulkTimestamps: number[] = [];
  private meta: WorkspaceMeta | undefined;
  private localStarted = false;

  constructor(
    private readonly client: CollaborationClient,
    private readonly folder: vscode.Uri,
    private readonly server: string,
    private readonly projectId: string,
    initialRevision: number,
    meta?: WorkspaceMeta,
  ) {
    this.workspaceRevision = initialRevision;
    this.meta = meta;
  }

  /** Register WS handlers before connect so reconcile_required is not missed. */
  startRemoteHandlers(): void {
    this.client.onFsOperation = (msg) => {
      if (this.reconciling) return;
      void this.applyRemote(msg.operation, msg.revision);
    };
    this.client.onWorkspaceRevision = (rev) => {
      this.workspaceRevision = rev;
      this.client.lastKnownRevision = rev;
    };
    this.client.onAssetChanged = (msg) => {
      if (this.reconciling) return;
      void this.applyRemoteAsset(msg);
    };
    this.client.onReconcileRequired = (msg) => {
      void this.onReconcileRequired(msg);
    };
  }

  /** Local create/delete/rename/asset watchers — after ready barrier + document bind. */
  startLocalWatchers(): void {
    if (this.localStarted || this.disposed) return;
    this.localStarted = true;
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((e) => {
        if (this.origin.isRemote() || this.reconciling) return;
        for (const uri of e.files) void this.onLocalCreate(uri);
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (this.origin.isRemote() || this.reconciling) return;
        for (const uri of e.files) void this.onLocalDelete(uri);
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (this.origin.isRemote() || this.reconciling) return;
        for (const f of e.files) void this.onLocalRename(f.oldUri, f.newUri);
      }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, BINARY_GLOB),
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => {
        if (this.origin.isRemote() || this.reconciling) return;
        void this.onLocalAssetWrite(uri);
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    if (this.client.onFsOperation) this.client.onFsOperation = undefined;
    if (this.client.onWorkspaceRevision) this.client.onWorkspaceRevision = undefined;
    if (this.client.onAssetChanged) this.client.onAssetChanged = undefined;
    if (this.client.onReconcileRequired) this.client.onReconcileRequired = undefined;
  }

  /** Server or bulk-change triggered: pause → snapshot → resume. */
  async runReconcile(reason: string): Promise<void> {
    if (this.disposed) return;
    if (this.reconciling) {
      this.reconcileQueued = true;
      return;
    }
    this.reconciling = true;
    this.reconcileQueued = false;
    try {
      void vscode.window.setStatusBarMessage(`Collab: reconciling (${reason})…`, 5000);
      const snap = await pullAndApplySnapshot(
        this.folder,
        this.server,
        this.projectId,
        this.origin,
        this.suppressPaths,
        this.meta,
      );
      this.workspaceRevision = snap.revision;
      this.client.lastKnownRevision = snap.revision;
      this.client.workspaceRevision = snap.revision;
      if (this.meta) {
        this.meta = { ...this.meta, lastKnownRevision: snap.revision };
      }
      void vscode.window.showInformationMessage(
        `Collab reconciled @ rev ${snap.revision} (${reason})`,
      );
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab reconcile failed: ${String(err)}`);
    } finally {
      this.reconciling = false;
      if (this.reconcileQueued && !this.disposed) {
        this.reconcileQueued = false;
        void this.runReconcile("queued");
      }
    }
  }

  private onReconcileRequired(msg: ReconcileRequiredEvent): void {
    void this.runReconcile(msg.reason || "reconcile_required");
  }

  /** Record a local topology event; trigger reconcile on bulk burst. */
  private noteLocalTopologyEvent(): void {
    const now = Date.now();
    this.bulkTimestamps.push(now);
    this.bulkTimestamps = this.bulkTimestamps.filter((t) => now - t <= BULK_WINDOW_MS);
    if (this.bulkTimestamps.length >= BULK_EVENT_THRESHOLD) {
      this.bulkTimestamps = [];
      void this.runReconcile("bulk_local_change");
    }
  }

  private async onLocalCreate(uri: vscode.Uri): Promise<void> {
    const rel = relPath(this.folder, uri);
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
    this.noteLocalTopologyEvent();
    if (this.reconciling) return;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        await this.send({ kind: "mkdir", path: rel });
        return;
      }
      if (isBinaryPath(rel)) {
        await this.uploadAsset(uri, rel);
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      await this.send({ kind: "create", path: rel, content });
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab fs create failed: ${String(err)}`);
    }
  }

  private async onLocalAssetWrite(uri: vscode.Uri): Promise<void> {
    const rel = relPath(this.folder, uri);
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
    if (!isBinaryPath(rel)) return;
    try {
      await this.uploadAsset(uri, rel);
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab asset upload failed: ${String(err)}`);
    }
  }

  private async uploadAsset(uri: vscode.Uri, rel: string): Promise<void> {
    if (this.disposed || this.reconciling) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    this.suppressPaths.add(rel);
    try {
      const result = await putAsset(
        this.server,
        this.projectId,
        rel,
        bytes,
        this.client.clientId,
      );
      this.workspaceRevision = result.revision;
      this.client.lastKnownRevision = result.revision;
    } finally {
      await new Promise((r) => setTimeout(r, 250));
      this.suppressPaths.delete(rel);
    }
  }

  private async onLocalDelete(uri: vscode.Uri): Promise<void> {
    const rel = relPath(this.folder, uri);
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
    this.noteLocalTopologyEvent();
    if (this.reconciling) return;
    try {
      await this.send({ kind: "delete", path: rel });
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab fs delete failed: ${String(err)}`);
    }
  }

  private async onLocalRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const from = relPath(this.folder, oldUri);
    const to = relPath(this.folder, newUri);
    if (!from || !to || shouldIgnore(from) || shouldIgnore(to)) return;
    if (this.suppressPaths.has(from) || this.suppressPaths.has(to)) return;
    this.noteLocalTopologyEvent();
    if (this.reconciling) return;
    const kind =
      from.includes("/") !== to.includes("/") || from.split("/")[0] !== to.split("/")[0]
        ? "move"
        : "rename";
    try {
      await this.send({ kind, from, to });
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab fs rename failed: ${String(err)}`);
    }
  }

  private async send(operation: FsOperation): Promise<void> {
    if (this.disposed || this.reconciling) return;
    try {
      const ack = await this.client.sendFsOperation(operation, this.workspaceRevision);
      this.workspaceRevision = ack.revision;
      this.client.lastKnownRevision = ack.revision;
    } catch (err) {
      const msg = String(err);
      if (msg.includes("stale base_revision")) {
        void this.runReconcile("stale_base_revision");
        return;
      }
      throw err;
    }
  }

  private async applyRemoteAsset(msg: AssetChangedEvent): Promise<void> {
    if (this.disposed || this.reconciling) return;
    const rel = msg.path;
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
    this.suppressPaths.add(rel);
    try {
      await this.origin.markRemote(async () => {
        const bytes = await getAsset(this.server, this.projectId, rel);
        const uri = vscode.Uri.joinPath(this.folder, rel);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
        await vscode.workspace.fs.writeFile(uri, bytes);
      });
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      void vscode.window.showWarningMessage(`Collab asset download failed: ${String(err)}`);
    } finally {
      this.suppressPaths.delete(rel);
    }
    this.workspaceRevision = msg.revision;
    this.client.lastKnownRevision = msg.revision;
  }

  private async applyRemote(operation: FsOperation, revision: number): Promise<void> {
    if (this.disposed || this.reconciling) return;
    const paths: string[] = [];
    if (operation.path) paths.push(operation.path);
    if (operation.from) paths.push(operation.from);
    if (operation.to) paths.push(operation.to);
    for (const p of paths) this.suppressPaths.add(p);
    try {
      await this.origin.markRemote(async () => {
        switch (operation.kind) {
          case "mkdir": {
            const path = operation.path;
            if (!path) return;
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder, path));
            break;
          }
          case "create": {
            const path = operation.path;
            if (!path) return;
            const uri = vscode.Uri.joinPath(this.folder, path);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
            await vscode.workspace.fs.writeFile(
              uri,
              Buffer.from(operation.content ?? "", "utf8"),
            );
            break;
          }
          case "delete": {
            const path = operation.path;
            if (!path) return;
            try {
              await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.folder, path), {
                recursive: true,
                useTrash: false,
              });
            } catch {
              // already gone
            }
            break;
          }
          case "rename":
          case "move": {
            const from = operation.from;
            const to = operation.to;
            if (!from || !to) return;
            const src = vscode.Uri.joinPath(this.folder, from);
            const dst = vscode.Uri.joinPath(this.folder, to);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dst, ".."));
            await vscode.workspace.fs.rename(src, dst, { overwrite: false });
            break;
          }
        }
      });
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      for (const p of paths) this.suppressPaths.delete(p);
    }
    this.workspaceRevision = revision;
    this.client.lastKnownRevision = revision;
  }
}
