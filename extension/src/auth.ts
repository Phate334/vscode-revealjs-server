import * as vscode from "vscode";

/** SecretStorage session. ponytail: no refresh rotation yet; sign in again when access expires. */

const ACCESS = "presentation.accessToken";
const REFRESH = "presentation.refreshToken";
const USER = "presentation.username";

let secrets: vscode.SecretStorage | undefined;

export function initAuth(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

export async function getAccessToken(): Promise<string | undefined> {
  const token = await secrets?.get(ACCESS);
  return token || undefined;
}

export async function getSignedInUsername(): Promise<string | undefined> {
  const name = await secrets?.get(USER);
  return name || undefined;
}

export async function saveSession(session: {
  access_token: string;
  refresh_token: string;
  username: string;
}): Promise<void> {
  if (!secrets) {
    throw new Error("auth not initialized");
  }
  await secrets.store(ACCESS, session.access_token);
  await secrets.store(REFRESH, session.refresh_token);
  await secrets.store(USER, session.username);
}
