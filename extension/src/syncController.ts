import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { CollaborationClient, type FsOperation } from "./collaborationClient";
import type { DocumentsBinding } from "./documentBinding";
import { OfflineJournal, type JournalEntry } from "./offlineJournal";
import { atomicWrite, hash, ignoredPath, localPath, readJson } from "./localState";
import { AssetConflictError, fetchSnapshot, getAsset, putAsset, sendOperations, writeWorkspaceMeta, type WorkspaceMeta } from "./projectClient";
import { applyRemoteSnapshot, descriptors, loadState, readEntry, same, saveState, scanLocal, signature, snapshotEntries, type Entry, type LocalState } from "./reconciliation";
import { isCollaborativeTextPath } from "./textPaths";

function affected(operation: FsOperation): string[] {
  return [operation.path, operation.from, operation.to].filter((p): p is string => !!p);
}
function projectOperation(entries: Record<string, Entry>, op: FsOperation): void {
  if (op.kind === "mkdir" && op.path) entries[op.path] = { kind: "directory" };
  if ((op.kind === "create" || op.kind === "write") && op.path) entries[op.path] = { kind: "text", hash: hash(op.content ?? "") };
  if (op.kind === "delete" && op.path) {
    for (const key of Object.keys(entries)) if (key === op.path || key.startsWith(op.path + "/")) delete entries[key];
  }
  if ((op.kind === "rename" || op.kind === "move") && op.from && op.to) {
    for (const key of Object.keys(entries)) if (key === op.from || key.startsWith(op.from + "/")) {
      entries[op.to + key.slice(op.from.length)] = entries[key]; delete entries[key];
    }
  }
}

/** Local scans push durable intent; remote scans project only safely managed paths. */
export class SyncController {
  private readonly journal: OfflineJournal;
  private readonly state: LocalState;
  private readonly output = vscode.window.createOutputChannel("Presentation Sync");
  private readonly disposables: vscode.Disposable[] = [];
  private readonly conflicts: Set<string>;
  private readonly conflictPath: string;
  private binding?: DocumentsBinding;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private remoteQueued = false;
  private online = false;

  constructor(private readonly client: CollaborationClient, private readonly folder: vscode.Uri,
    private readonly meta: WorkspaceMeta, private readonly status: (state: string) => void) {
    const state = loadState(folder, meta);
    if (!state) throw new Error("This workspace needs an initial snapshot before synchronization");
    this.state = state;
    this.journal = new OfflineJournal(folder);
    this.conflictPath = localPath(folder, ".presentation/conflicts.json", true);
    this.conflicts = new Set(readJson<string[]>(this.conflictPath, []));
    client.onReady = () => { this.online = true; this.reconcileFromServer("connected"); };
    client.onRemoteStructure = () => this.reconcileFromServer("remote change");
    client.onStatus = (value) => {
      this.online = value === "connected";
      const label = value === "auth-required" ? "Sign in required"
        : value === "forbidden" ? "No access"
        : value === "connected" ? "Syncing…"
        : value === "offline" ? "Offline · Local changes saved"
        : "Syncing…";
      this.showStatus(label);
    };
    client.onError = (error) => this.report(error);
    client.onReplacedText = (rel, content) => {
      const rename = this.journal.entries.find((entry) => entry.operation?.from && entry.operation.to &&
        (rel === entry.operation.to || rel.startsWith(entry.operation.to + "/")))?.operation;
      const source = rename?.from && rename.to ? rename.from + rel.slice(rename.to.length) : rel;
      if (this.state.remote[source]?.hash !== hash(content)) {
        atomicWrite(localPath(this.folder, `.presentation/recovery/${hash(content)}/${rel}`, true), content);
        this.markConflict(rel);
      }
    };
  }

  private showStatus(value = "Synced"): void {
    this.status(this.conflicts.size ? "Conflict" : this.journal.entries.length ? (this.online ? "Syncing…" : "Offline · Local changes saved") : value);
  }
  markConflict = (rel: string): void => {
    if (!this.conflicts.has(rel)) {
      this.output.appendLine(`Preserved local changes for ${rel}. Resolve the conflict before retrying synchronization.`);
      this.conflicts.add(rel);
      atomicWrite(this.conflictPath, JSON.stringify([...this.conflicts]));
    }
    this.showStatus();
  };
  private clearConflict(rel: string): void {
    this.conflicts.delete(rel);
    atomicWrite(this.conflictPath, JSON.stringify([...this.conflicts]));
  }
  private report(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    this.output.appendLine(text);
    if (text === "Sign in required" || text === "You do not have access to this presentation") {
      this.showStatus(text === "Sign in required" ? "Sign in required" : "No access");
      void vscode.window.showWarningMessage(text);
      return;
    }
    this.showStatus(this.online ? "Sync interrupted" : "Offline · Local changes saved");
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => { if (!this.disposed) await action(); }).catch((error) => this.report(error));
    return this.queue;
  }

  async start(binding: DocumentsBinding): Promise<void> {
    this.binding = binding;
    // Capture changes made while VS Code was closed before the first remote Yjs merge.
    await this.captureLocal(true);
    await binding.refresh();
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, "**/*"));
    const schedule = (uri: vscode.Uri) => {
      const root = this.folder.fsPath.replace(/[/\\]+$/, "") + "/";
      const filename = uri.fsPath.replace(/\\/g, "/");
      if (!filename.startsWith(root) || ignoredPath(filename.slice(root.length))) return;
      if (this.timer) clearTimeout(this.timer);
      // Git/Shell/AI event bursts always rescan Local → Server; never pull a destructive snapshot.
      this.timer = setTimeout(() => { this.timer = undefined; void this.reconcileFromLocal("filesystem change"); }, 300);
    };
    this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    this.disposables.push(vscode.workspace.onDidRenameFiles((event) => {
      void this.enqueue(async () => {
        for (const file of event.files) {
          const root = this.folder.fsPath.replace(/[/\\]+$/, "") + "/";
          const fromPath = file.oldUri.fsPath.replace(/\\/g, "/");
          const toPath = file.newUri.fsPath.replace(/\\/g, "/");
          if (!fromPath.startsWith(root) || !toPath.startsWith(root)) continue;
          const from = fromPath.slice(root.length), to = toPath.slice(root.length);
          if (ignoredPath(from) || ignoredPath(to) || !this.state.disk[from] || this.state.disk[to]) continue;
          const op: FsOperation = { id: randomUUID(), kind: "rename", from, to };
          const predicted = this.predictedRemote();
          this.journal.append([this.fsEntry(op, predicted)]);
          projectOperation(this.state.disk, op);
          saveState(this.folder, this.state);
        }
        await this.captureLocal();
        await this.synchronize();
      });
    }));
    this.showStatus("Offline · Local changes saved");
  }

  private predictedRemote(): Record<string, Entry> {
    const entries = { ...this.state.remote };
    for (const entry of this.journal.entries) {
      if (entry.operation) projectOperation(entries, entry.operation);
      else if (entry.path && entry.data) entries[entry.path] = { kind: "asset", hash: hash(Buffer.from(entry.data, "base64")) };
    }
    return entries;
  }
  private fsEntry(operation: FsOperation, predicted: Record<string, Entry>): JournalEntry {
    return { id: operation.id, kind: "fs", operation, baseRevision: this.state.structureRevision, queuedAt: Date.now(),
      expected: Object.fromEntries(affected(operation).map((rel) => [rel, signature(predicted, rel)])) };
  }

  private async captureLocal(initial = false): Promise<void> {
    const local = scanLocal(this.folder);
    const predicted = this.predictedRemote();
    const entries: JournalEntry[] = [];
    const append = (op: FsOperation) => {
      entries.push(this.fsEntry(op, predicted));
      projectOperation(predicted, op);
    };
    const removed = Object.keys(this.state.disk).filter((rel) => !local[rel]);
    for (const rel of removed.sort((a, b) => a.length - b.length)) {
      if (removed.some((parent) => parent !== rel && rel.startsWith(parent + "/"))) continue;
      if (predicted[rel]) append({ id: randomUUID(), kind: "delete", path: rel });
    }
    for (const [rel, entry] of Object.entries(local).sort(([a], [b]) => a.length - b.length)) {
      const previous = this.state.disk[rel];
      if (isCollaborativeTextPath(rel) && entry.kind === "text" && (initial || !same(previous, entry))) {
        if (!(await this.binding?.ingestDisk(rel, entry.content ?? ""))) this.markConflict(rel);
      }
      if (same(previous, entry)) continue;
      if (previous && previous.kind !== entry.kind) {
        this.markConflict(rel); continue;
      }
      if (entry.kind === "directory") {
        if (!predicted[rel]) append({ id: randomUUID(), kind: "mkdir", path: rel });
      } else if (entry.kind === "asset") {
        if (predicted[rel]?.hash === entry.hash) continue;
        const id = randomUUID();
        entries.push({ id, kind: "asset", path: rel, data: Buffer.from(entry.data!).toString("base64"),
          baseRevision: this.state.structureRevision, assetRevision: predicted[rel]?.revision ?? 0,
          expected: { [rel]: signature(predicted, rel) }, queuedAt: Date.now() });
        predicted[rel] = { kind: "asset", hash: entry.hash };
      } else if (!previous) {
        if (predicted[rel]?.kind === "text" && predicted[rel]?.hash === entry.hash) continue;
        append({ id: randomUUID(), kind: "create", path: rel, content: entry.content ?? "" });
      } else if (!isCollaborativeTextPath(rel)) {
        if (predicted[rel]?.hash === entry.hash) continue;
        append({ id: randomUUID(), kind: "write", path: rel, content: entry.content ?? "" });
      }
    }
    // Write-ahead: if the process stops here, intent exists before the baseline can move.
    if (entries.length) this.journal.append(entries);
    this.state.disk = descriptors(local);
    saveState(this.folder, this.state);
  }

  reconcileFromLocal(reason: string): Promise<void> {
    return this.enqueue(async () => {
      this.output.appendLine(`Local scan: ${reason}`);
      await this.captureLocal();
      await this.synchronize();
    });
  }
  reconcileFromServer(reason: string): void {
    if (this.remoteQueued || this.disposed) return;
    this.remoteQueued = true;
    void this.enqueue(async () => {
      this.remoteQueued = false;
      this.output.appendLine(`Remote merge: ${reason}`);
      await this.captureLocal();
      await this.synchronize();
    });
  }

  private async replay(): Promise<void> {
    if (!this.online || !this.client.canWrite) return;
    let rebases = 0;
    const blocked = new Set<string>();
    const blockedPaths = new Set<string>();
    const block = (entry: JournalEntry) => {
      blocked.add(entry.id);
      for (const rel of entry.operation ? affected(entry.operation) : [entry.path ?? "legacy journal"]) {
        blockedPaths.add(rel); this.markConflict(rel);
      }
    };
    while (this.journal.entries.length && !this.disposed) {
      const available = this.journal.entries.filter((entry) => !blocked.has(entry.id) &&
        !(entry.operation ? affected(entry.operation) : [entry.path ?? ""]).some((rel) =>
          [...blockedPaths].some((p) => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"))));
      const first = available[0];
      if (!first) return;
      if (first.kind === "asset") {
        if (!first.path || first.data === undefined) { block(first); continue; }
        const data = Buffer.from(first.data, "base64");
        try {
          const result = await putAsset(this.meta.server, this.meta.projectId, first.path, data, this.client.clientId, first.assetRevision ?? 0);
          this.state.remote[first.path] = { kind: "asset", hash: result.content_hash, revision: result.revision };
          this.journal.acknowledge(new Set([first.id]));
          this.clearConflict(first.path);
          continue;
        } catch (error) {
          if (!(error instanceof AssetConflictError)) throw error;
          if (error.contentHash === hash(data)) { this.journal.acknowledge(new Set([first.id])); continue; }
          this.markConflict(first.path);
          const choice = await vscode.window.showWarningMessage(`資源衝突：${first.path}。本機修改已保存。`, { modal: true }, "使用我的", "保留遠端");
          if (choice === "使用我的") {
            first.assetRevision = error.contentHash ? error.revision : 0; this.journal.save(); continue;
          }
          if (choice === "保留遠端") {
            atomicWrite(localPath(this.folder, `.presentation/recovery/${first.id}/${first.path}`, true), data);
            this.journal.acknowledge(new Set([first.id])); this.clearConflict(first.path); continue;
          }
          block(first); continue;
        }
      }
      if (!first.operation || !first.expected || first.baseRevision < 0) {
        block(first); continue;
      }
      const batch: JournalEntry[] = [];
      for (const entry of available) {
        if (entry.kind !== "fs" || !entry.operation || entry.baseRevision !== first.baseRevision || batch.length >= 200) break;
        batch.push(entry);
      }
      const result = await sendOperations(this.meta.server, this.meta.projectId, first.baseRevision, batch.map((entry) => entry.operation!));
      for (const receipt of result.results) {
        projectOperation(this.state.remote, receipt.operation);
      }
      this.journal.acknowledge(new Set(result.results.map((receipt) => receipt.operation.id)));
      if (!result.failed) { rebases = 0; continue; }
      const pending = batch.find((entry) => !result.results.some((receipt) => receipt.operation.id === entry.id));
      if (!pending) continue;
      if (result.failed.message.includes("stale base_revision") && rebases++ < 3) {
        const snap = await fetchSnapshot(this.meta.server, this.meta.projectId);
        const remote = snapshotEntries(snap);
        const safe = pending.expected && Object.entries(pending.expected).every(([rel, expected]) => signature(remote, rel) === expected);
        if (safe) { pending.baseRevision = snap.structure_revision; this.journal.save(); continue; }
      }
      this.output.appendLine(result.failed.message);
      block(pending);
    }
  }

  private async synchronize(): Promise<void> {
    if (!this.online) { this.showStatus("Offline · Local changes saved"); return; }
    this.showStatus("Syncing…");
    await this.client.flushText();
    await this.replay();
    const snap = await fetchSnapshot(this.meta.server, this.meta.projectId);
    this.client.mergeRemote(Buffer.from(snap.yjs_state, "base64"));
    const protectedPaths = this.journal.protectedPaths();
    for (const rel of this.conflicts) protectedPaths.add(rel);
    for (const rel of await applyRemoteSnapshot(this.folder, this.meta.server, snap, this.state, protectedPaths,
      (rel) => this.client.documents.get(rel)?.toString())) this.markConflict(rel);
    await this.binding?.refresh();
    this.client.lastKnownStructureRevision = snap.structure_revision;
    this.meta.lastKnownStructureRevision = snap.structure_revision;
    await writeWorkspaceMeta(this.folder, this.meta);
    this.showStatus();
  }

  hasConflict(rel: string): boolean {
    return [...this.conflicts].some((p) => p === rel || rel.startsWith(p + "/"));
  }

  resolveConflict(): Promise<void> {
    return this.enqueue(async () => {
      const selected = await vscode.window.showQuickPick([...this.conflicts], { title: "Presentation: Resolve Conflict" });
      if (!selected) return;
      const roots = new Set([selected]);
      const overlaps = (rel: string) => [...roots].some((p) => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"));
      const related = this.journal.entries.filter((entry) =>
        (entry.operation ? affected(entry.operation) : [entry.path ?? ""]).some(overlaps));
      for (const entry of related) for (const rel of entry.operation ? affected(entry.operation) : [entry.path ?? selected]) roots.add(rel);
      const choice = await vscode.window.showWarningMessage(
        `Resolve ${[...roots].join(", ")}. A recovery copy will be retained.`, { modal: true }, "Keep Local", "Use Remote");
      if (!choice) return;
      const local = scanLocal(this.folder);
      const buffers = new Map<string, { text: string; version: number }>();
      for (const rel of Object.keys(local).filter(overlaps)) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath(this.folder, rel));
        if (doc?.isDirty) buffers.set(rel, { text: doc.getText(), version: doc.version });
      }
      const recovery = randomUUID();
      atomicWrite(localPath(this.folder, `.presentation/recovery/${recovery}/journal.json`, true), JSON.stringify(related));
      for (const [rel, entry] of Object.entries(local).filter(([rel]) => overlaps(rel))) {
        if (entry.kind !== "directory") atomicWrite(localPath(this.folder, `.presentation/recovery/${recovery}/${rel}`, true),
          buffers.get(rel)?.text ?? entry.data ?? entry.content ?? "");
      }
      const snap = await fetchSnapshot(this.meta.server, this.meta.projectId);
      const remote = snapshotEntries(snap);
      const bodies = new Map<string, Uint8Array>();
      if (choice === "Use Remote") {
        for (const file of snap.files.filter((f) => overlaps(f.path))) bodies.set(file.path, Buffer.from(file.content));
        for (const asset of snap.assets.filter((a) => overlaps(a.path))) {
          bodies.set(asset.path, await getAsset(this.meta.server, this.meta.projectId, asset.path, asset.content_hash));
        }
      }
      for (const rel of Object.keys(local).filter(overlaps)) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath(this.folder, rel));
        if (!same(readEntry(this.folder, rel), local[rel]) || (buffers.has(rel) && doc?.version !== buffers.get(rel)!.version)) {
          throw new Error("Local changes arrived while resolving the conflict; retry with the updated files");
        }
      }
      this.client.mergeRemote(Buffer.from(snap.yjs_state, "base64"));
      const protectedPaths = this.journal.protectedPaths();
      for (const rel of [...this.conflicts, ...roots]) protectedPaths.add(rel);
      for (const rel of await applyRemoteSnapshot(this.folder, this.meta.server, snap, this.state, protectedPaths,
        (rel) => this.client.documents.get(rel)?.toString())) this.markConflict(rel);
      this.journal.acknowledge(new Set(related.map((entry) => entry.id)));
      const resolving = [...this.conflicts].filter(overlaps);
      for (const rel of Object.keys(this.state.disk).filter(overlaps)) delete this.state.disk[rel];
      for (const [rel, entry] of Object.entries(remote)) if (overlaps(rel)) this.state.disk[rel] = entry;
      if (choice === "Use Remote") {
        for (const rel of Object.keys(local).filter(overlaps).sort((a, b) => b.length - a.length)) {
          if (remote[rel]?.kind === local[rel].kind) continue;
          if (local[rel].kind === "directory") fs.rmdirSync(localPath(this.folder, rel));
          else fs.unlinkSync(localPath(this.folder, rel));
        }
        for (const rel of snap.directories.filter(overlaps)) fs.mkdirSync(localPath(this.folder, rel), { recursive: true });
        for (const [rel, data] of bodies) {
          atomicWrite(localPath(this.folder, rel), data);
          if (isCollaborativeTextPath(rel)) await this.binding?.acceptLocal(rel, Buffer.from(data).toString("utf8"));
        }
      } else {
        for (const [rel, entry] of Object.entries(local)) {
          if (overlaps(rel) && entry.kind === "text" && isCollaborativeTextPath(rel)) {
            await this.binding?.acceptLocal(rel, buffers.get(rel)?.text ?? entry.content ?? "");
          }
        }
      }
      for (const rel of resolving) this.clearConflict(rel);
      await this.binding?.refresh();
      saveState(this.folder, this.state);
      await this.captureLocal();
      await this.synchronize();
    });
  }

  async flush(): Promise<void> {
    await this.reconcileFromLocal("user command");
    if (!this.online || this.journal.entries.length || this.conflicts.size) throw new Error("Resolve pending synchronization before continuing");
    await this.client.flushText();
  }
  showDetails(): void { this.output.show(); }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.output.dispose();
  }
}
