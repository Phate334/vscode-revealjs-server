import * as fs from "node:fs";
import * as vscode from "vscode";
import * as Y from "yjs";
import type { CollaborationClient } from "./collaborationClient";
import { FS_RECONCILE, LOCAL_EDITOR } from "./origins";
import { isCollaborativeTextPath } from "./textPaths";
import { atomicWrite, hash, localPath, readJson } from "./localState";

const CONTEXT_KEY = "presentation.collaborativeEditor";
export type DocumentsBinding = {
  refresh: () => Promise<void>;
  ingestDisk: (rel: string, content: string) => Promise<boolean>;
  acceptLocal: (rel: string, content: string) => Promise<void>;
  dispose: () => void;
  undo: () => void;
  redo: () => void;
};

function span(before: string, after: string): { start: number; end: number; text: string } | undefined {
  if (before === after) return undefined;
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, end, text: after.slice(start, nextEnd) };
}
function patch(client: CollaborationClient, text: Y.Text, next: string, origin: unknown): void {
  const edit = span(text.toString(), next);
  if (!edit) return;
  client.doc.transact(() => {
    if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start);
    if (edit.text) text.insert(edit.start, edit.text);
  }, origin);
}

/** Bind to restored Yjs before connecting, with durable saved-disk baselines independent of Auto Save. */
export async function bindCollaborativeDocuments(
  client: CollaborationClient, folder: vscode.Uri, onConflict: (path: string) => void, isBlocked: (path: string) => boolean,
): Promise<DocumentsBinding> {
  const basesPath = localPath(folder, ".presentation/text-bases.json", true);
  const bases: Record<string, string> = Object.assign(Object.create(null), readJson<Record<string, string>>(basesPath, {}));
  const saveBases = () => atomicWrite(basesPath, JSON.stringify(bases));
  const bindings = new Map<string, { doc: vscode.TextDocument; text: Y.Text; undo: Y.UndoManager; apply: () => void; dispose: () => void }>();
  const output = vscode.window.createOutputChannel("Presentation Text Sync");
  const preserve = (rel: string, content: string) => {
    atomicWrite(localPath(folder, `.presentation/recovery/${hash(content)}/${rel}`, true), content);
    onConflict(rel);
  };
  let disposed = false;
  let refreshChain: Promise<void> = Promise.resolve();

  const bind = async (rel: string): Promise<void> => {
    if (disposed || isBlocked(rel) || !isCollaborativeTextPath(rel)) return;
    const filename = localPath(folder, rel);
    if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) return;
    const existing = bindings.get(rel);
    const text = client.documents.get(rel);
    if (!text) return; // Topology owns path creation; never reseed an intentionally empty remote Y.Text.
    if (existing?.text === text) { existing.apply(); return; }
    if (existing) {
      if (existing.doc.isDirty && existing.doc.getText() !== text.toString()) preserve(rel, existing.doc.getText());
      existing.dispose(); bindings.delete(rel);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    if (disposed) return;
    const undo = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL_EDITOR]), captureTimeout: 500 });
    let expectedRemote: string | undefined;
    let applyChain: Promise<void> = Promise.resolve();
    const apply = () => {
      applyChain = applyChain.then(async () => {
        if (disposed || isBlocked(rel) || doc.isClosed || client.documents.get(rel) !== text) return;
        const next = text.toString();
        const edit = span(doc.getText(), next);
        if (!edit) return;
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
        expectedRemote = next;
        const applied = await vscode.workspace.applyEdit(wsEdit);
        expectedRemote = undefined;
        if (!applied) { preserve(rel, doc.getText()); throw new Error(`Editor update interrupted: ${rel}`); }
        // Ordinary Save is intentionally not invoked (formatters/save hooks are user preferences).
      }).catch((error) => { output.appendLine(String(error)); onConflict(rel); });
    };
    const observer = () => apply();
    text.observe(observer);
    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== doc.uri.toString() || !event.contentChanges.length) return;
      if (expectedRemote !== undefined && doc.getText() === expectedRemote) return;
      if (client.documents.get(rel) !== text) { preserve(rel, doc.getText()); return; }
      if (expectedRemote !== undefined) {
        // A user edit raced the remote WorkspaceEdit: preserve both states instead of whole-file overwrite.
        preserve(rel, doc.getText()); return;
      }
      if (event.reason === vscode.TextDocumentChangeReason.Undo) { undo.undo(); apply(); return; }
      if (event.reason === vscode.TextDocumentChangeReason.Redo) { undo.redo(); apply(); return; }
      client.doc.transact(() => {
        for (const change of [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
          if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
          if (change.text) text.insert(change.rangeOffset, change.text);
        }
      }, LOCAL_EDITOR);
    });
    bindings.set(rel, { doc, text, undo, apply, dispose: () => { text.unobserve(observer); changes.dispose(); undo.destroy(); } });
    if (doc.isDirty && doc.getText() !== text.toString()) {
      // Hot-exit buffer may be ahead of the last persisted transaction. Keep a recoverable copy.
      preserve(rel, doc.getText());
    }
    apply();
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY,
      [...bindings.values()].some((b) => b.doc.uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()));
  };

  const refresh = (): Promise<void> => {
    refreshChain = refreshChain.then(async () => {
      for (const [rel, binding] of bindings) {
        if (!client.documents.has(rel) || binding.doc.isClosed) {
          if (binding.doc.isDirty) preserve(rel, binding.doc.getText());
          binding.dispose(); bindings.delete(rel);
        }
      }
      for (const rel of client.documents.keys()) await bind(rel);
    }).catch((error) => { output.appendLine(String(error)); onConflict("document binding"); });
    return refreshChain;
  };

  const ingestDisk = async (rel: string, content: string): Promise<boolean> => {
    if (!isCollaborativeTextPath(rel)) return true;
    if (isBlocked(rel)) return false;
    let text = client.documents.get(rel);
    const base = bases[rel];
    if (!text) {
      text = client.getText(rel);
      patch(client, text, content, FS_RECONCILE);
    } else if (base !== undefined && base !== content && text.toString() !== content) {
      if (text.toString() !== base) {
        // Independent unsaved/remote changes exist: do not diff a stale disk against current Yjs.
        preserve(rel, content);
        return false;
      }
      patch(client, text, content, FS_RECONCILE);
    } else if (base === undefined && text.toString() !== content) {
      // Fresh clones have a matching initial disk; legacy workspaces require explicit recovery.
      preserve(rel, content);
      return false;
    }
    bases[rel] = content;
    saveBases();
    await bind(rel);
    return true;
  };

  const mapChanged = () => { void refresh(); };
  client.documents.observe(mapChanged);
  const active = () => {
    const filename = vscode.window.activeTextEditor?.document.uri.fsPath;
    return [...bindings.values()].find((binding) => binding.doc.uri.fsPath === filename);
  };
  const updateContext = () => { void vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!active()); };
  const editorSub = vscode.window.onDidChangeActiveTextEditor(updateContext);
  const openSub = vscode.workspace.onDidOpenTextDocument(() => { void refresh().then(updateContext); });

  return {
    refresh,
    ingestDisk,
    acceptLocal: async (rel, content) => {
      if (!isCollaborativeTextPath(rel)) return;
      patch(client, client.getText(rel), content, LOCAL_EDITOR);
      const filename = localPath(folder, rel);
      if (fs.existsSync(filename)) bases[rel] = fs.readFileSync(filename, "utf8");
      saveBases();
      await bind(rel);
    },
    undo: () => active()?.undo.undo(),
    redo: () => active()?.undo.redo(),
    dispose: () => {
      disposed = true;
      client.documents.unobserve(mapChanged);
      for (const binding of bindings.values()) binding.dispose();
      bindings.clear(); editorSub.dispose(); openSub.dispose(); output.dispose();
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
    },
  };
}
