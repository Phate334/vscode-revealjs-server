import * as vscode from "vscode";
import type * as Y from "yjs";
import type { CollaborationClient } from "./collaborationClient";
import { OriginTracker } from "./originTracker";

const SLIDE_NAME = "slide.md";
// ponytail: single-file PoC debounce; raise / coalesce if bulk rewrite loops (open decision #4).
const WATCHER_DEBOUNCE_MS = 150;

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
  doc.transact(() => {
    const del = oldEnd - start;
    if (del > 0) ytext.delete(start, del);
    if (newEnd > start) ytext.insert(start, newText.slice(start, newEnd));
  });
}

/**
 * Bind one slide.md to client.ytext.
 * Local edits → Y.Text; remote Y.Text → WorkspaceEdit (OriginTracker skips echo).
 * FileSystemWatcher: external disk rewrite → diff → local CRDT transaction.
 */
export async function bindSlideDocument(client: CollaborationClient): Promise<() => void> {
  const uri = await findSlideUri();
  if (!uri) {
    void vscode.window.showWarningMessage(`Collab: no ${SLIDE_NAME} in workspace`);
    return () => undefined;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const origin = new OriginTracker();
  const ytext = client.ytext;

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
      // Seed empty CRDT from local file (will broadcast as local update).
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
    // Apply VS Code deltas onto Y.Text (reverse order keeps offsets valid).
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    client.doc.transact(() => {
      for (const c of changes) {
        if (c.rangeLength > 0) ytext.delete(c.rangeOffset, c.rangeLength);
        if (c.text.length > 0) ytext.insert(c.rangeOffset, c.text);
      }
    });
  });

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

  return () => {
    ytext.unobserve(yObserver);
    changeSub.dispose();
    if (watchTimer) clearTimeout(watchTimer);
    wChange.dispose();
    wCreate.dispose();
    watcher.dispose();
  };
}
