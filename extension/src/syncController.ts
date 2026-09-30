import * as vscode from "vscode";
import type {
  AssetChangedEvent,
  CollaborationClient,
  FsOperation,
} from "./collaborationClient";
import { OriginTracker } from "./originTracker";
import { getAsset, isBinaryPath, putAsset } from "./projectClient";

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
 * remote fs.operation / asset.changed → apply with origin mark (echo suppress).
 * UndoManager stays on Document Binding — not here.
 */
export class SyncController {
  private readonly origin = new OriginTracker();
  /** Paths suppressed while / shortly after remote apply (async FS event echo). */
  private readonly suppressPaths = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private workspaceRevision: number;
  private disposed = false;

  constructor(
    private readonly client: CollaborationClient,
    private readonly folder: vscode.Uri,
    private readonly server: string,
    private readonly projectId: string,
    initialRevision: number,
  ) {
    this.workspaceRevision = initialRevision;
  }

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((e) => {
        if (this.origin.isRemote()) return;
        for (const uri of e.files) void this.onLocalCreate(uri);
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (this.origin.isRemote()) return;
        for (const uri of e.files) void this.onLocalDelete(uri);
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (this.origin.isRemote()) return;
        for (const f of e.files) void this.onLocalRename(f.oldUri, f.newUri);
      }),
    );

    // Binary replacement (existing file overwrite) — create already covered above.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, BINARY_GLOB),
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => {
        if (this.origin.isRemote()) return;
        void this.onLocalAssetWrite(uri);
      }),
    );

    this.client.onFsOperation = (msg) => {
      void this.applyRemote(msg.operation, msg.revision);
    };
    this.client.onWorkspaceRevision = (rev) => {
      this.workspaceRevision = rev;
    };
    this.client.onAssetChanged = (msg) => {
      void this.applyRemoteAsset(msg);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    if (this.client.onFsOperation) this.client.onFsOperation = undefined;
    if (this.client.onWorkspaceRevision) this.client.onWorkspaceRevision = undefined;
    if (this.client.onAssetChanged) this.client.onAssetChanged = undefined;
  }

  private async onLocalCreate(uri: vscode.Uri): Promise<void> {
    const rel = relPath(this.folder, uri);
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
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
    if (this.disposed) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    // Suppress echo if server still broadcasts to us (client_id exclude may miss).
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
    } finally {
      await new Promise((r) => setTimeout(r, 250));
      this.suppressPaths.delete(rel);
    }
  }

  private async onLocalDelete(uri: vscode.Uri): Promise<void> {
    const rel = relPath(this.folder, uri);
    if (!rel || shouldIgnore(rel) || this.suppressPaths.has(rel)) return;
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
    if (this.disposed) return;
    const ack = await this.client.sendFsOperation(operation, this.workspaceRevision);
    this.workspaceRevision = ack.revision;
  }

  private async applyRemoteAsset(msg: AssetChangedEvent): Promise<void> {
    if (this.disposed) return;
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
  }

  private async applyRemote(operation: FsOperation, revision: number): Promise<void> {
    if (this.disposed) return;
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
      // Hold suppress briefly — VS Code may deliver create/delete events after await returns.
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      for (const p of paths) this.suppressPaths.delete(p);
    }
    this.workspaceRevision = revision;
  }
}
