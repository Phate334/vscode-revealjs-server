# RevealJS Collaboration

VS Code client for the collaborative presentation server. You edit a real local folder; text merges through Yjs and stays on disk across restarts.

Set `presentation.serverUrl` (default `http://127.0.0.1:8000`). **Presentation: Register** creates an account with a username and a masked password. With no session, **Sign In**, **Create Presentation**, and **Open Presentation** offer Register or Sign in, then the same two boxes.

Create and Open always make a new child folder under the parent you pick. Open lists presentations you own and ones shared with you. **Share Presentation** copies an invite link. **Accept Invitation** pastes that link; if you are not signed in, the same boxes register a new username or sign in an existing one, then join and open. **Project Members** lists who has access.

**Disconnect** keeps local editing and saving. **Open Preview** is a private ten-minute session. **Publish** copies a public release link. The status bar shows Synced, Syncing, Offline, or Conflict.

Keep `.presentation/`. Git metadata, VS Code preferences, and `node_modules/` are not synchronized. Server and extension both need protocol v2 (stable release `0.1.2`).
