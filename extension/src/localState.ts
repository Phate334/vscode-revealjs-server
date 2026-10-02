import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";

export function hash(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function ignoredPath(rel: string): boolean {
  return rel.split("/").some((part) => [".git", ".presentation", ".vscode", "node_modules"].includes(part));
}

export function localPath(folder: vscode.Uri, rel: string, internal = false): string {
  if (folder.scheme !== "file" || !rel || rel.includes("\\") || rel.split("/").some((p) => !p || p === "." || p === "..")
      || path.isAbsolute(rel) || (!internal && ignoredPath(rel))) {
    throw new Error(`Unsupported workspace path: ${rel}`);
  }
  const dest = path.join(folder.fsPath, ...rel.split("/"));
  let current = folder.fsPath;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not synchronized: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return dest;
}

/** Same-directory atomic replace, fsync before rename; no acknowledged local write is buffered. */
export function atomicWrite(filename: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filename);
}

export function readJson<T>(filename: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")) as T; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Cannot restore local state at ${filename}: ${String(err)}`);
  }
}
