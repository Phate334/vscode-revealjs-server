import * as vscode from "vscode";
import * as Y from "yjs";
import type { CollaborationClient } from "./collaborationClient";
import { OriginTracker } from "./originTracker";
import { FS_RECONCILE, LOCAL_EDITOR } from "./origins";

const SLIDE_NAME = "slide.md";
const CONTEXT_KEY = "presentation.collaborativeEditor";
// ponytail: single-file PoC debounce; raise / coalesce if bulk rewrite loops (open decision #4).
const WATCHER_DEBOUNCE_MS = 150;
// ponytail: ~500ms groups keystrokes into one undo step; tune if users want finer/coarser undo.
const UNDO_CAPTURE_TIMEOUT_MS = 500;

export type SlideBinding = {
  dispose: () => void;
  undo: () => void;
  redo: () => void;
};

/** Find slide.md at workspace root (or first match). */
async function findSlideUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const f of folders) {
      const uri = vscode.Uri.joinPath(f.uri, SLIDE_NAME);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // not at root
      }
    }
  }
  const hits = await vscode.workspace.findFiles(`**/${SLIDE_NAME}`, "**/node_modules/**", 1);
  return hits[0];
}

/**
 * Apply external file text onto Y.Text via prefix/suffix diff (keeps CRDT merge on unchanged spans).
 * Do not replace the whole string in one shot — that bypasses concurrent merge.
 */
function applyTextDiff(doc: Y.Doc, ytext: Y.Text, oldText: string, newText: string): void {
  if (oldText === newText) return;
  let start = 0;
  const oldLen = oldText.length;
  const newLen = newText.length;
  while (start < oldLen && start < newLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  // FS_RECONCILE: not tracked by UndoManager (git/shell/agent rewrites stay out of local undo).
  doc.transact(() => {
    const del = oldEnd - start;
    if (del > 0) ytext.delete(start, del);
    if (newEnd > start) ytext.insert(start, newText.slice(start, newEnd));
  }, FS_RECONCILE);
}

/**
 * Bind one slide.md to client.ytext.
 * Local edits → Y.Text (LOCAL_EDITOR, tracked by UndoManager);
 * remote Y.Text → WorkspaceEdit (OriginTracker skips echo);
 * FileSystemWatcher → FS_RECONCILE (not undo-tracked).
 * Ctrl/Cmd+Z routed via presentation.undo → Y.UndoManager (native stack not authoritative).
 */
export async function bindSlideDocument(client: CollaborationClient): Promise<SlideBinding> {
  const uri = await findSlideUri();
  if (!uri) {
    void vscode.window.showWarningMessage(`Collab: no ${SLIDE_NAME} in workspace`);
    return {
      dispose: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
    };
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const origin = new OriginTracker();
  const ytext = client.ytext;
  // Selective undo: only LOCAL_EDITOR transactions; remote/FS stay out of the stack.
  const undoManager = new Y.UndoManager(ytext, {
    trackedOrigins: new Set([LOCAL_EDITOR]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });

  const applyYToEditor = async () => {
    const next = ytext.toString();
    if (doc.getText() === next) return;
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, next);
    await origin.markRemote(() => vscode.workspace.applyEdit(edit));
  };

  const seedOrPull = async () => {
    const fileText = doc.getText();
    const remote = ytext.toString();
    if (remote.length === 0 && fileText.length > 0) {
      // Seed empty CRDT from local file (null origin → not undo-tracked).
      ytext.insert(0, fileText);
      return;
    }
    if (remote !== fileText) {
      await applyYToEditor();
    }
  };

  // After ready (snapshot may already be applied), sync file ↔ CRDT once.
  if (client.getStatus() === "connected") {
    await seedOrPull();
  } else {
    const prev = client.onReady;
    client.onReady = () => {
      prev?.();
      void seedOrPull();
    };
  }

  const yObserver = () => {
    void applyYToEditor();
  };
  ytext.observe(yObserver);

  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) return;
    if (origin.isRemote()) return;

    // Safety: native Undo/Redo must not push VS Code state into Yjs.
    // Treat as undo/redo intent → UndoManager, then reconcile editor to ytext.
    if (e.reason === vscode.TextDocumentChangeReason.Undo) {
      undoManager.undo();
      void applyYToEditor();
      return;
    }
    if (e.reason === vscode.TextDocumentChangeReason.Redo) {
      undoManager.redo();
      void applyYToEditor();
      return;
    }

    // Apply VS Code deltas onto Y.Text (reverse order keeps offsets valid).
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    client.doc.transact(() => {
      for (const c of changes) {
        if (c.rangeLength > 0) ytext.delete(c.rangeOffset, c.rangeLength);
        if (c.text.length > 0) ytext.insert(c.rangeOffset, c.text);
      }
    }, LOCAL_EDITOR);
  });

  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    const on = !!(ed && ed.document.uri.toString() === uri.toString());
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, on);
  };
  updateContext();
  const ctxSub = vscode.window.onDidChangeActiveTextEditor(updateContext);

  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const pattern = folder
    ? new vscode.RelativePattern(folder, SLIDE_NAME)
    : new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), SLIDE_NAME);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const onDiskEvent = () => {
    // Skip while our remote WorkspaceEdit is in flight (echo / save churn).
    if (origin.isRemote()) return;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      void (async () => {
        if (origin.isRemote()) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const diskText = Buffer.from(bytes).toString("utf8");
          const crdtText = ytext.toString();
          if (diskText === crdtText) return;
          applyTextDiff(client.doc, ytext, crdtText, diskText);
        } catch {
          // deleted / unreadable — PoC ignores
        }
      })();
    }, WATCHER_DEBOUNCE_MS);
  };

  const wChange = watcher.onDidChange(onDiskEvent);
  const wCreate = watcher.onDidCreate(onDiskEvent);

  return {
    dispose: () => {
      ytext.unobserve(yObserver);
      undoManager.destroy();
      changeSub.dispose();
      ctxSub.dispose();
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
      if (watchTimer) clearTimeout(watchTimer);
      wChange.dispose();
      wCreate.dispose();
      watcher.dispose();
    },
    undo: () => {
      undoManager.undo();
      // yObserver → applyYToEditor; explicit reconcile covers empty-stack no-op after native undo.
      void applyYToEditor();
    },
    redo: () => {
      undoManager.redo();
      void applyYToEditor();
    },
  };
}
