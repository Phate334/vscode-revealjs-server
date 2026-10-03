# RevealJS Collaboration

VS Code client for the collaborative presentation server. You edit a real local folder; text merges through Yjs and stays on disk across restarts.

Set `presentation.serverUrl` (default `http://127.0.0.1:8000`). **Create Presentation** and **Open Presentation** sign you in when needed. The server has no built-in accounts: use a username and password from the server’s `AUTH_DEMO_USER`. How to start the server is in the repository README.

Create and Open always make a new child folder under the parent you pick. Open lists presentations you own and ones shared with you. **Share Presentation** copies an invitation; **Accept Invitation** joins and opens that presentation. **Project Members** lists who has access.

**Disconnect** keeps local editing and saving. **Open Preview** is a private ten-minute session. **Publish** copies a public release link. The status bar shows Synced, Syncing, Offline, or Conflict.

Keep `.presentation/`. Git metadata, VS Code preferences, and `node_modules/` are not synchronized. Server and extension both need protocol v2 (stable release `0.1.2`).
