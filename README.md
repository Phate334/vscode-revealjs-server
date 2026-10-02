# vscode-revealjs-server

Collaborative Reveal.js presentations: a FastAPI server as the shared workspace, plus a VS Code extension that edits a real local folder and stays in sync.

## Requirements

- Docker (Compose v2)
- VS Code 1.139+
- Access to this repo’s [Releases](https://github.com/Phate334/vscode-revealjs-server/releases) and GHCR image (private packages need `docker login ghcr.io`)

## Start the server

`compose.yaml` pulls the published image:

```bash
docker login ghcr.io   # if the package is private
docker compose pull
docker compose up -d
```

Health check: `http://127.0.0.1:8000/health`

Image: `ghcr.io/phate334/vscode-revealjs-server:<version>` (also `:latest`). The Compose tag matches the release version in `pyproject.toml`.

## Install the extension

1. Download `vscode-revealjs-collaboration-*.vsix` from the [latest release](https://github.com/Phate334/vscode-revealjs-server/releases).
2. Install it:

```bash
code --install-extension path/to/vscode-revealjs-collaboration-0.1.2.vsix
```

Or in VS Code: **Extensions → … → Install from VSIX…**

## Use in VS Code

1. Set **presentation.serverUrl** for your server (default `http://127.0.0.1:8000`).
2. **Presentation: Create Presentation** or **Open Presentation**. Sign-in runs inline when needed. Open lists both your own and shared presentations.
3. Select a parent directory and a new child-folder name. Existing folders are never overwritten.
4. Edit local files. Text synchronizes through Yjs and is persisted locally even with Auto Save off. Disconnect keeps local editing and persistence active.
5. **Presentation: Open Preview** opens a private, short-lived preview session. **Share Presentation** creates an invitation; accepting it opens that presentation directly.
6. **Presentation: Publish** freezes a public, immutable release and copies its link.
7. **Presentation: Resolve Conflict** handles preserved local/remote differences. **Synchronization Details** shows diagnostic information; **Retry Synchronization** retries queued work.

Local filesystem changes from Git, shell commands and external editors are synchronized to the server. Reconciliation preserves pending intent and ignores `.git/`, `.presentation/`, `.vscode/` and `node_modules/`. Do not delete `.presentation/`: it contains durable text state and the offline journal.

## Demo accounts

| user  | password |
|-------|----------|
| demo  | demo     |
| alice | alice    |

Optional env on the server:

| variable | purpose |
|----------|---------|
| `AUTH_JWT_SECRET` | JWT signing secret (change in production) |
| `AUTH_DEMO_USER` | Extra `username:password` |
| `AUTH_ACCESS_TTL_SEC` / `AUTH_REFRESH_TTL_SEC` | Token lifetimes |

## Presentation URLs

| URL | Meaning |
|-----|---------|
| `/preview/{project_id}/` | Private mutable preview; requires a preview session |
| `/releases/{release_id}/` | Immutable self-contained release |
| `/presentations/{slug}/` | Alias to the project's current release |

Publish is `POST /api/projects/{project_id}/publish` (creates a release). Each project vendors Reveal under `runtime/`; releases copy the full tree (no shared `/runtimes`, no `blobs/`).

API and collaboration WebSocket require a signed-in access token (`Authorization: Bearer …`; WS also accepts `?access_token=`). `POST /api/projects/{id}/preview-session` issues a ten-minute preview URL; its scoped cookie protects HTML and all assets. Published release pages remain public.

## Releases

Canonical version is `pyproject.toml`. Release tags must match it exactly (including `rcN`). RC builds use a derived numeric VS Code manifest version with `--pre-release`, are marked prerelease on GitHub, and do not update the stable `latest` image tag.

**0.1.2 is the stable release.** The maintainer has completed validation before promoting this version from RC. Existing 0.1.1 clients must be upgraded together with the server because synchronization now uses protocol v2. Tag `v0.1.2` publishes the stable VSIX and versioned image, and updates the image's `latest` tag.

See [workspace architecture and recovery behavior](docs/workspace-architecture.md) and `AGENTS.md`.
