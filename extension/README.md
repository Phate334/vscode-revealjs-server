# RevealJS Collaboration

VS Code client for the collaborative presentation server. You edit a real local folder; text merges through Yjs and stays on disk across restarts.

Set `presentation.serverUrl` (default `http://127.0.0.1:8000`). **Presentation: Register** creates an account with a username and a masked password. With no session, **Sign In**, **Create Presentation**, and **Open Presentation** offer Register or Sign in, then the same two boxes.

**Create Account Invite** copies a link and does not need a presentation open. **Accept Invitation** pastes that link and registers a new account. **Copy Presentation Link** copies `{server}/open#{id}`. **Open Presentation → Open from link…** opens it; any signed-in user can edit, without being added as a member.

Create and Open always make a new child folder under the parent you pick. **Disconnect** keeps local editing and saving. **Open Preview** is a private ten-minute session. **Publish** copies a public release link. The status bar shows Synced, Syncing, Offline, or Conflict.

Keep `.presentation/`. Git metadata, VS Code preferences, and `node_modules/` are not synchronized. Server and extension both need protocol v2 (stable release `0.1.2`).
