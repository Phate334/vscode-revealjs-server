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

/** Shared prefix/suffix span for minimal text replace (disk→Y and Y→editor). */
function diffSpan(
  oldText: string,
  newText: string,
): { start: number; oldEnd: number; newEnd: number } | undefined {
  if (oldText === newText) return undefined;
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
  return { start, oldEnd, newEnd };
}

/**
 * Apply external file text onto Y.Text via prefix/suffix diff (keeps CRDT merge on unchanged spans).
 * Do not replace the whole string in one shot — that bypasses concurrent merge.
 */
function applyTextDiff(doc: Y.Doc, ytext: Y.Text, oldText: string, newText: string): void {
  const span = diffSpan(oldText, newText);
  if (!span) return;
  // FS_RECONCILE: not tracked by UndoManager (git/shell/agent rewrites stay out of local undo).
  doc.transact(() => {
    const del = span.oldEnd - span.start;
    if (del > 0) ytext.delete(span.start, del);
    if (span.newEnd > span.start) ytext.insert(span.start, newText.slice(span.start, span.newEnd));
  }, FS_RECONCILE);
}

/** Find collaborative slide.md: prefer nested chapter path, else root, else first match. */
async function findSlideUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  const folder = folders[0];
  // Nested chapter first (Create Project template: 01-introduction/slide.md).
  const nested = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `*/${SLIDE_NAME}`),
    "**/node_modules/**",
    1,
  );
  if (nested[0]) return nested[0];
  const root = vscode.Uri.joinPath(folder.uri, SLIDE_NAME);
  try {
    await vscode.workspace.fs.stat(root);
    return root;
  } catch {
    // not at root
  }
  const hits = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/${SLIDE_NAME}`),
    "**/node_modules/**",
    1,
  );
  return hits[0];
}

/**
 * Bind one slide.md to client.ytext.
 * Init assumes ready/snapshot barrier already passed (H2) — seedOrPull runs immediately,
 * and onReady re-seeds after reconnect.
 *
 * Local edits → Y.Text (LOCAL_EDITOR); remote Y→editor = minimal diff (H4), serialized (H3);
 * OriginTracker only wraps the WorkspaceEdit — genuine concurrent local edits are recovered.
 * Nested slide.md watcher (H5).
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
  const undoManager = new Y.UndoManager(ytext, {
    trackedOrigins: new Set([LOCAL_EDITOR]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });

  /** Serialize Y→editor / native-undo reconcile (H3). */
  let applyChain: Promise<void> = Promise.resolve();
  /** After remote markRemote ends, push any genuine local text that arrived during apply. */
  let recoverLocalAfterRemote = false;

  const enqueueApply = (fn: () => Promise<void>): Promise<void> => {
    applyChain = applyChain.then(fn, fn);
    return applyChain;
  };

  /** Core Y→editor apply (must run on applyChain). */
  const applyYToEditorCore = async (): Promise<void> => {
    const next = ytext.toString();
    const prev = doc.getText();
    if (prev === next) return;
    const span = diffSpan(prev, next);
    if (!span) return;
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.oldEnd));
    edit.replace(uri, range, next.slice(span.start, span.newEnd));
    recoverLocalAfterRemote = false;
    await origin.markRemote(() => vscode.workspace.applyEdit(edit));
    // If a local keystroke landed while markRemote was set, recover it into Y.
    if (recoverLocalAfterRemote) {
      recoverLocalAfterRemote = false;
      const editorNow = doc.getText();
      const crdtNow = ytext.toString();
      if (editorNow !== crdtNow) {
        applyTextDiffAsLocal(client.doc, ytext, crdtNow, editorNow);
      }
    }
  };

  /** Y.Text → editor via prefix/suffix WorkspaceEdit (H4 — no whole-doc replace). */
  const applyYToEditor = (): Promise<void> => enqueueApply(() => applyYToEditorCore());

  /** Genuine local text that arrived during remote apply → LOCAL_EDITOR (not discarded). */
  function applyTextDiffAsLocal(ydoc: Y.Doc, yt: Y.Text, oldText: string, newText: string): void {
    const span = diffSpan(oldText, newText);
    if (!span) return;
    ydoc.transact(() => {
      const del = span.oldEnd - span.start;
      if (del > 0) yt.delete(span.start, del);
      if (span.newEnd > span.start) yt.insert(span.start, newText.slice(span.start, span.newEnd));
    }, LOCAL_EDITOR);
  }

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

  // H2: bind after ready barrier — seed immediately; keep onReady for reconnect.
  const prevReady = client.onReady;
  client.onReady = () => {
    prevReady?.();
    void seedOrPull();
  };
  if (client.getStatus() === "connected") {
    await seedOrPull();
  }

  const yObserver = () => {
    void applyYToEditor();
  };
  ytext.observe(yObserver);

  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) return;

    if (origin.isRemote()) {
      // H3: do not swallow genuine local edits during remote apply.
      // Echo of our WorkspaceEdit leaves editor == ytext; concurrent typing diverges.
      recoverLocalAfterRemote = true;
      return;
    }

    // Safety: native Undo/Redo must not push VS Code state into Yjs.
    if (e.reason === vscode.TextDocumentChangeReason.Undo) {
      void enqueueApply(async () => {
        undoManager.undo();
        await applyYToEditorCore();
      });
      return;
    }
    if (e.reason === vscode.TextDocumentChangeReason.Redo) {
      void enqueueApply(async () => {
        undoManager.redo();
        await applyYToEditorCore();
      });
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
  // H5: watch all nested slide.md under the workspace folder (bound uri filtered below).
  const pattern = folder
    ? new vscode.RelativePattern(folder, `**/${SLIDE_NAME}`)
    : new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), SLIDE_NAME);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const onDiskEvent = (eventUri: vscode.Uri) => {
    if (eventUri.toString() !== uri.toString()) return;
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
      void enqueueApply(async () => {
        undoManager.undo();
        await applyYToEditorCore();
      });
    },
    redo: () => {
      void enqueueApply(async () => {
        undoManager.redo();
        await applyYToEditorCore();
      });
    },
  };
}
