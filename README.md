# vscode-revealjs-server

Collaborative Reveal.js presentations. The FastAPI server holds the shared workspace. The VS Code extension edits a real local folder and stays in sync.

## Requirements

- Docker (Compose v2)
- VS Code 1.139+
- This repo’s [Releases](https://github.com/Phate334/vscode-revealjs-server/releases) and GHCR image (private packages need `docker login ghcr.io`)

## Start the server

Compose starts with no accounts. Register the first user from VS Code. Optional `AUTH_DEMO_USER` (`username:password`, comma-separated) only seeds users that do not exist yet; passwords are stored as hashes.

```bash
docker login ghcr.io   # if the package is private
docker compose pull
docker compose up -d
```

Health check: `http://127.0.0.1:8000/health`

The image is `ghcr.io/phate334/vscode-revealjs-server:<version>` (stable tags also include `:latest`). The Compose tag matches `pyproject.toml` (currently `0.1.4rc1`). The VS Code manifest version is `0.1.4`. Optional: `AUTH_JWT_SECRET`, `AUTH_ACCESS_TTL_SEC`, `AUTH_REFRESH_TTL_SEC`. If `ENV` or `ENVIRONMENT` is `production` or `prod`, `AUTH_JWT_SECRET` must be set and must not be the dev default. Local Compose leaves those unset.

## Install the extension

Download `vscode-revealjs-collaboration-*.vsix` from the [latest release](https://github.com/Phate334/vscode-revealjs-server/releases), then install it:

```bash
code --install-extension path/to/vscode-revealjs-collaboration-0.1.4rc1.vsix
```

Or in VS Code: **Extensions → … → Install from VSIX…**

## Use it

1. Set **presentation.serverUrl** (default `http://127.0.0.1:8000`).
2. **Presentation: Register** creates the first account (password at least 8 characters). After that, `POST /api/auth/register` returns 403; new accounts use an account invite. **Sign In** offers Register or Sign in when there is no session. **Create Presentation** or **Open Presentation** asks the same way. Open lists presentations you own and ones shared with you, or **Open from link…**.
3. Pick a parent directory and a new child-folder name. Existing folders are not overwritten.
4. Edit local files. Text synchronizes through Yjs and is saved locally even with Auto Save off. **Disconnect** keeps local editing and saving.
5. **Open Preview** opens a private, short-lived preview session.
6. **Create Account Invite** copies `{server}/join#{token}` without a presentation open. **Accept Invitation** pastes it and registers a new account; it does not join a presentation. **Copy Presentation Link** (owner) copies `{server}/open#{token}`. **Open from link…** signs in if needed, joins as an editor, then opens the workspace. The owner can read, write, share, and publish. An editor can read, write, and preview. Anyone else gets 403. Knowing a project id is not enough to edit. Details: [account and invites](docs/account-invite.md).
7. **Publish** freezes a public, immutable release and copies its link.
8. **Resolve Conflict**, **Synchronization Details**, and **Retry Synchronization** cover preserved differences and queued work.

Keep `.presentation/`: it holds durable text state and the offline journal. Git metadata, VS Code preferences, and `node_modules/` are not synchronized.

## URLs

| URL | Meaning |
|-----|---------|
| `/preview/{project_id}/` | Private mutable preview; requires a preview session |
| `/releases/{release_id}/` | Immutable self-contained release |
| `/presentations/{slug}/` | The project’s current release |

API calls and the collaboration WebSocket need an access token (`Authorization: Bearer …`; the socket also accepts `?access_token=`). The extension does not open that socket without a session. Close codes 4401 and 4403 do not reconnect. `POST /api/projects/{id}/preview-session` issues a ten-minute preview URL. Published pages stay public.

See [workspace architecture](docs/workspace-architecture.md).
