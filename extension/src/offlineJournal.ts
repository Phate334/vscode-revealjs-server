import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { atomicWrite, localPath, readJson } from "./localState";
import type { FsOperation } from "./collaborationClient";

export type JournalEntry = {
  id: string;
  kind: "fs" | "asset";
  operation?: FsOperation;
  path?: string;
  data?: string;
  baseRevision: number;
  assetRevision?: number;
  expected?: Record<string, string | null>;
  queuedAt: number;
};

/** Entries are removed only after a committed HTTP receipt or an explicit conflict choice. */
export class OfflineJournal {
  private readonly filename: string;
  entries: JournalEntry[];

  constructor(folder: vscode.Uri) {
    this.filename = localPath(folder, ".presentation/offline-journal.json", true);
    const entries = readJson<JournalEntry[]>(this.filename, []);
    if (!Array.isArray(entries) || entries.some((e) => !e || !["fs", "asset"].includes(e.kind))) {
      throw new Error("Offline journal is invalid; preserve it for recovery");
    }
    this.entries = entries.map((entry) => {
      const id = entry.id || randomUUID();
      return { ...entry, id, baseRevision: entry.baseRevision ?? -1,
        operation: entry.operation ? { ...entry.operation, id } : undefined };
    });
    this.save();
  }

  save(): void { atomicWrite(this.filename, JSON.stringify(this.entries, null, 2) + "\n"); }

  append(entries: JournalEntry[]): void {
    this.entries.push(...entries);
    this.save();
  }

  acknowledge(ids: Set<string>): void {
    this.entries = this.entries.filter((entry) => !ids.has(entry.id));
    this.save();
  }

  protectedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const e of this.entries) {
      for (const p of [e.path, e.operation?.path, e.operation?.from, e.operation?.to]) if (p) paths.add(p);
    }
    return paths;
  }
}
