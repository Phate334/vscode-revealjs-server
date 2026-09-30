import * as vscode from "vscode";
import type { FsOperation } from "./collaborationClient";

/** Durable offline topology/asset journal under .presentation/ (B2). */
export type JournalEntry =
  | { kind: "fs"; operation: FsOperation; queuedAt: number }
  | { kind: "asset"; path: string; queuedAt: number };

const JOURNAL_REL = ".presentation/offline-journal.json";

export async function loadJournal(folder: vscode.Uri): Promise<JournalEntry[]> {
  const uri = vscode.Uri.joinPath(folder, JOURNAL_REL);
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export async function saveJournal(folder: vscode.Uri, entries: JournalEntry[]): Promise<void> {
  const dir = vscode.Uri.joinPath(folder, ".presentation");
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(folder, JOURNAL_REL);
  const body = Buffer.from(JSON.stringify(entries, null, 2) + "\n", "utf8");
  await vscode.workspace.fs.writeFile(uri, body);
}

export async function clearJournal(folder: vscode.Uri): Promise<void> {
  await saveJournal(folder, []);
}

export async function appendJournal(
  folder: vscode.Uri,
  entry: JournalEntry,
): Promise<void> {
  const cur = await loadJournal(folder);
  // Coalesce: last asset write for same path wins; drop duplicate fs ops for same path/kind.
  if (entry.kind === "asset") {
    const filtered = cur.filter((e) => !(e.kind === "asset" && e.path === entry.path));
    filtered.push(entry);
    await saveJournal(folder, filtered);
    return;
  }
  const op = entry.operation;
  const pathKey = op.path ?? op.to ?? op.from;
  const filtered = cur.filter((e) => {
    if (e.kind !== "fs") return true;
    const p = e.operation.path ?? e.operation.to ?? e.operation.from;
    // Replace prior create/delete/mkdir for same path; keep rename/move distinct.
    if (op.kind === "rename" || op.kind === "move") {
      return JSON.stringify(e.operation) !== JSON.stringify(op);
    }
    return !(p === pathKey && e.operation.kind === op.kind);
  });
  filtered.push(entry);
  await saveJournal(folder, filtered);
}

function isEntry(x: unknown): x is JournalEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as JournalEntry;
  if (e.kind === "fs" && e.operation && typeof e.operation.kind === "string") return true;
  if (e.kind === "asset" && typeof e.path === "string") return true;
  return false;
}
