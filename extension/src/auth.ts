import * as vscode from "vscode";

export type Session = { access_token: string; refresh_token: string; username: string };
let secrets: vscode.SecretStorage;
const refreshes = new Map<string, Promise<string | undefined>>();
/** Bumped on sign-out so an in-flight refresh cannot write the session back. */
const epoch = new Map<string, number>();
export function initAuth(context: vscode.ExtensionContext): void { secrets = context.secrets; }
function key(server: string): string { return `presentation.session:${new URL(server).origin}`; }

export async function clearSession(server: string): Promise<void> {
  const origin = new URL(server).origin;
  epoch.set(origin, (epoch.get(origin) ?? 0) + 1);
  refreshes.delete(origin);
  await secrets.delete(key(origin));
}

export async function saveSession(server: string, session: Session): Promise<void> {
  await secrets.store(key(server), JSON.stringify(session));
}

/** Sessions and refreshes are isolated by origin; never send one server's token to another. */
export async function getAccessToken(server: string, forceRefresh = false): Promise<string | undefined> {
  const raw = await secrets.get(key(server));
  if (!raw) return undefined;
  const session = JSON.parse(raw) as Session;
  let expiry = 0;
  try { expiry = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()).exp; } catch { /* refresh */ }
  if (!forceRefresh && expiry > Date.now() / 1000 + 30) return session.access_token;
  const origin = new URL(server).origin;
  const existing = refreshes.get(origin);
  if (existing) return existing;
  const gen = epoch.get(origin) ?? 0;
  const refresh = (async () => {
    const response = await fetch(`${origin}/api/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if ((epoch.get(origin) ?? 0) !== gen) return undefined;
    if (response.status === 401) { await secrets.delete(key(origin)); return undefined; }
    if (!response.ok) throw new Error(`Sign-in refresh failed (${response.status})`);
    const next = await response.json() as Session;
    if ((epoch.get(origin) ?? 0) !== gen) return undefined;
    await saveSession(origin, { ...next, username: session.username });
    return next.access_token;
  })();
  refreshes.set(origin, refresh);
  try { return await refresh; } finally { refreshes.delete(origin); }
}
