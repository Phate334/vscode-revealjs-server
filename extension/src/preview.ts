import * as vscode from "vscode";
import { readWorkspaceMeta } from "./projectClient";

/** Open Server Preview URL from local project metadata (§25 / §26). */
export async function openPreview(): Promise<void> {
  const meta = await readWorkspaceMeta();
  if (!meta) {
    void vscode.window.showErrorMessage(
      "Open Preview: missing .presentation/workspace.json (Create or Open Project first)",
    );
    return;
  }
  const base = meta.server.replace(/\/$/, "");
  const url = `${base}/p/${encodeURIComponent(meta.projectId)}/preview/`;
  const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
  if (!ok) {
    void vscode.window.showWarningMessage(`Open Preview: could not open ${url}`);
    return;
  }
  void vscode.window.showInformationMessage(`Preview: ${url}`);
}
