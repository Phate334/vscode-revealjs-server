import * as fs from "node:fs";
import * as vscode from "vscode";
import * as Y from "yjs";
import { atomicWrite, localPath } from "./localState";
import { REMOTE_SYNC } from "./origins";

/** A merged update preserves Yjs identities and unsaved edits across extension restarts. */
export class YjsPersistence {
  private readonly filename: string;
  private readonly persist = () => atomicWrite(this.filename, Y.encodeStateAsUpdate(this.doc));

  constructor(folder: vscode.Uri, private readonly doc: Y.Doc) {
    this.filename = localPath(folder, ".presentation/yjs-state.bin", true);
    try { Y.applyUpdate(doc, fs.readFileSync(this.filename), REMOTE_SYNC); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // ponytail: synchronous full-state write per update; ceiling is large documents.
    // Upgrade to a durable append log + compaction, not a lossy debounce.
    doc.on("update", this.persist);
  }

  dispose(): void {
    this.persist();
    this.doc.off("update", this.persist);
  }
}
