/** Collaborative text path helpers (mirrors server is_collaborative_text_rel). */

const COLLAB_TEXT_EXT = new Set([".md", ".css", ".html", ".yaml", ".yml", ".json"]);
const IGNORE_PREFIXES = [".presentation/", ".git/", "node_modules/", ".vscode/", "runtime/"];

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp4",
  ".webm",
  ".pdf",
  ".woff",
  ".woff2",
]);

function suffix(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i < 0 ? "" : rel.slice(i).toLowerCase();
}

export function isBinaryPath(rel: string): boolean {
  return BINARY_EXT.has(suffix(rel));
}

/** True when path should bind to Y.Text in the documents map. */
export function isCollaborativeTextPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (IGNORE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p))) {
    return false;
  }
  if (isBinaryPath(rel)) return false;
  return COLLAB_TEXT_EXT.has(suffix(rel));
}

/** Glob for FileSystemWatcher / findFiles covering collab text extensions. */
export const COLLAB_TEXT_GLOB = "**/*.{md,css,html,yaml,yml,json}";
