# RevealJS Collaboration

VS Code client for the collaborative presentation server. You edit a real local folder; text merges through Yjs and stays on disk across restarts.

Set `presentation.serverUrl` (default `http://127.0.0.1:8000`). **Presentation: Register** creates the first account (password at least 8 characters). Once an account exists, Register is closed and shows that an account invite is required. With no session, **Sign In**, **Create Presentation**, and **Open Presentation** offer Register or Sign in, then the same two boxes.

**Create Account Invite** copies `{server}/join#{token}` and does not need a presentation open. **Accept Invitation** pastes that link and registers a new account; it does not join a presentation. **Copy Presentation Link** (owner) copies `{server}/open#{token}`. **Open Presentation → Open from link…** signs in if needed, joins as an editor, then opens the workspace. The token is not the project id. Owners can share and publish; editors can edit and preview; anyone else gets 403. The collaboration socket stays closed without a session, and close codes 4401 and 4403 do not reconnect.

Create and Open always make a new child folder under the parent you pick. **Disconnect** keeps local editing and saving. **Open Preview** is a private ten-minute session. **Publish** copies a public release link. The status bar shows Synced, Syncing, Offline, or Conflict.

Keep `.presentation/`. Git metadata, VS Code preferences, and `node_modules/` are not synchronized. Server and extension both need protocol v2 (release `0.1.4rc1`).
