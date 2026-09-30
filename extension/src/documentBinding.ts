import * as vscode from "vscode";
import * as Y from "yjs";
import type { CollaborationClient } from "./collaborationClient";
import { OriginTracker } from "./originTracker";
import { FS_RECONCILE, LOCAL_EDITOR } from "./origins";
import { COLLAB_TEXT_GLOB, isCollaborativeTextPath } from "./textPaths";

const CONTEXT_KEY = "presentation.collaborativeEditor";
// ponytail: single-file PoC debounce; raise / coalesce if bulk rewrite loops (open decision #4).
const WATCHER_DEBOUNCE_MS = 150;
// ponytail: ~500ms groups keystrokes into one undo step; tune if users want finer/coarser undo.
const UNDO_CAPTURE_TIMEOUT_MS = 500;

export type DocumentsBinding = {
  dispose: () => void;
  undo: () => void;
  redo: () => void;
};

type FileBinding = {
  uri: vscode.Uri;
  rel: string;
  doc: vscode.TextDocument;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  origin: OriginTracker;
  onDiskEvent: () => void;
  seedOrPull: () => Promise<void>;
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
  doc.transact(() => {
    const del = span.oldEnd - span.start;
    if (del > 0) ytext.delete(span.start, del);
    if (span.newEnd > span.start) ytext.insert(span.start, newText.slice(span.start, span.newEnd));
  }, FS_RECONCILE);
}

function applyTextDiffAsLocal(ydoc: Y.Doc, yt: Y.Text, oldText: string, newText: string): void {
  const span = diffSpan(oldText, newText);
  if (!span) return;
  ydoc.transact(() => {
    const del = span.oldEnd - span.start;
    if (del > 0) yt.delete(span.start, del);
    if (span.newEnd > span.start) yt.insert(span.start, newText.slice(span.start, span.newEnd));
  }, LOCAL_EDITOR);
}

function relPath(folder: vscode.Uri, uri: vscode.Uri): string | undefined {
  const root = folder.fsPath.replace(/[/\\]+$/, "");
  const full = uri.fsPath;
  if (!full.startsWith(root)) return undefined;
  const rel = full.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return rel || undefined;
}

async function findCollaborativeUris(folder: vscode.Uri): Promise<vscode.Uri[]> {
  const hits = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, COLLAB_TEXT_GLOB),
    "{**/node_modules/**,**/.git/**,**/.presentation/**,**/.vscode/**}",
    200,
  );
  return hits.filter((uri) => {
    const rel = relPath(folder, uri);
    return !!rel && isCollaborativeTextPath(rel);
  });
}

/** Prefer nested chapter slide.md, else root slide.md, else first markdown. */
function pickPrimaryUri(folder: vscode.Uri, uris: vscode.Uri[]): vscode.Uri | undefined {
  const rels = uris.map((u) => ({ uri: u, rel: relPath(folder, u) || "" }));
  const nested = rels.find((r) => /^[^/]+\/slide\.md$/.test(r.rel));
  if (nested) return nested.uri;
  const root = rels.find((r) => r.rel === "slide.md");
  if (root) return root.uri;
  return uris[0];
}

function bindOneFile(
  client: CollaborationClient,
  folder: vscode.Uri,
  uri: vscode.Uri,
  doc: vscode.TextDocument,
): FileBinding {
  const rel = relPath(folder, uri);
  if (!rel) {
    throw new Error(`Collab: uri outside workspace: ${uri.fsPath}`);
  }
  const origin = new OriginTracker();
  const ytext = client.getText(rel);
  const undoManager = new Y.UndoManager(ytext, {
    trackedOrigins: new Set([LOCAL_EDITOR]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });

  let applyChain: Promise<void> = Promise.resolve();
  let recoverLocalAfterRemote = false;

  const enqueueApply = (fn: () => Promise<void>): Promise<void> => {
    applyChain = applyChain.then(fn, fn);
    return applyChain;
  };

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
    if (recoverLocalAfterRemote) {
      recoverLocalAfterRemote = false;
      const editorNow = doc.getText();
      const crdtNow = ytext.toString();
      if (editorNow !== crdtNow) {
        applyTextDiffAsLocal(client.doc, ytext, crdtNow, editorNow);
      }
    }
  };

  const applyYToEditor = (): Promise<void> => enqueueApply(() => applyYToEditorCore());

  const seedOrPull = async () => {
    const fileText = doc.getText();
    const remote = ytext.toString();
    if (remote.length === 0 && fileText.length > 0) {
      ytext.insert(0, fileText);
      return;
    }
    if (remote !== fileText) {
      await applyYToEditor();
    }
  };

  const yObserver = () => {
    void applyYToEditor();
  };
  ytext.observe(yObserver);

  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) return;

    if (origin.isRemote()) {
      recoverLocalAfterRemote = true;
      return;
    }

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

    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    client.doc.transact(() => {
      for (const c of changes) {
        if (c.rangeLength > 0) ytext.delete(c.rangeOffset, c.rangeLength);
        if (c.text.length > 0) ytext.insert(c.rangeOffset, c.text);
      }
    }, LOCAL_EDITOR);
  });

  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const onDiskEvent = () => {
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
          // deleted / unreadable
        }
      })();
    }, WATCHER_DEBOUNCE_MS);
  };

  return {
    uri,
    rel,
    doc,
    ytext,
    undoManager,
    origin,
    onDiskEvent,
    seedOrPull,
    dispose: () => {
      ytext.unobserve(yObserver);
      undoManager.destroy();
      changeSub.dispose();
      if (watchTimer) clearTimeout(watchTimer);
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

/**
 * Bind all collaborative text files (path → Y.Text) with per-file UndoManager.
 * Init assumes ready/snapshot barrier already passed (H2).
 */
export async function bindCollaborativeDocuments(
  client: CollaborationClient,
): Promise<DocumentsBinding> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showWarningMessage("Collab: no workspace folder");
    return { dispose: () => undefined, undo: () => undefined, redo: () => undefined };
  }

  const bindings = new Map<string, FileBinding>();

  const bindUri = async (uri: vscode.Uri, show = false): Promise<void> => {
    const rel = relPath(folder, uri);
    if (!rel || !isCollaborativeTextPath(rel)) return;
    if (bindings.has(rel)) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (show) {
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    const binding = bindOneFile(client, folder, uri, doc);
    bindings.set(rel, binding);
    if (client.getStatus() === "connected") {
      await binding.seedOrPull();
    }
  };

  const uris = await findCollaborativeUris(folder);
  const primary = pickPrimaryUri(folder, uris);
  for (const uri of uris) {
    await bindUri(uri, primary !== undefined && uri.toString() === primary.toString());
  }
  if (uris.length === 0) {
    void vscode.window.showWarningMessage("Collab: no collaborative text files in workspace");
  }

  // H2: seed after ready; keep onReady for reconnect.
  const prevReady = client.onReady;
  client.onReady = () => {
    prevReady?.();
    for (const b of bindings.values()) {
      void b.seedOrPull();
    }
  };
  if (client.getStatus() === "connected") {
    for (const b of bindings.values()) {
      void b.seedOrPull();
    }
  }

  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    let on = false;
    if (ed) {
      const rel = relPath(folder, ed.document.uri);
      on = !!(rel && bindings.has(rel));
    }
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, on);
  };
  updateContext();
  const ctxSub = vscode.window.onDidChangeActiveTextEditor(updateContext);

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, COLLAB_TEXT_GLOB),
  );

  const onDisk = (eventUri: vscode.Uri) => {
    const rel = relPath(folder, eventUri);
    if (!rel || !isCollaborativeTextPath(rel)) return;
    const b = bindings.get(rel);
    if (b) {
      b.onDiskEvent();
      return;
    }
    void bindUri(eventUri, false);
  };

  const wChange = watcher.onDidChange(onDisk);
  const wCreate = watcher.onDidCreate(onDisk);

  // Observe documents map for remote-created paths (server fs→CRDT).
  const mapObserver = (event: Y.YMapEvent<Y.Text>) => {
    event.keysChanged.forEach((key) => {
      if (bindings.has(key)) return;
      if (!isCollaborativeTextPath(key)) return;
      const uri = vscode.Uri.joinPath(folder, key);
      void bindUri(uri, false);
    });
  };
  client.documents.observe(mapObserver);

  const activeBinding = (): FileBinding | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return undefined;
    const rel = relPath(folder, ed.document.uri);
    return rel ? bindings.get(rel) : undefined;
  };

  return {
    dispose: () => {
      client.documents.unobserve(mapObserver);
      client.onReady = prevReady;
      for (const b of bindings.values()) b.dispose();
      bindings.clear();
      ctxSub.dispose();
      void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
      wChange.dispose();
      wCreate.dispose();
      watcher.dispose();
    },
    undo: () => activeBinding()?.undo(),
    redo: () => activeBinding()?.redo(),
  };
}

/** @deprecated alias — prefer bindCollaborativeDocuments */
export const bindSlideDocument = bindCollaborativeDocuments;
export type SlideBinding = DocumentsBinding;
