import * as vscode from "vscode";
import { previewSession, type WorkspaceMeta } from "./projectClient";

export async function openPreview(meta: WorkspaceMeta): Promise<void> {
  const session = await previewSession(meta.server, meta.projectId);
  const url = new URL(session.url, meta.server);
  if (url.origin !== new URL(meta.server).origin) throw new Error("Invalid preview origin");
  if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href)))) throw new Error("Could not open preview");
}
