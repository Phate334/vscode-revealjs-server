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
code --install-extension path/to/vscode-revealjs-collaboration-0.1.0.vsix
```

Or in VS Code: **Extensions → … → Install from VSIX…**

## Use in VS Code

1. **Presentation: Sign In** — against your server (default demo accounts below).
2. **Presentation: Create Project** or **Open Project** / **Open Shared Project** — links a local folder via `.presentation/workspace.json`.
3. Edit bound text files (e.g. `slide.md`, chapter markdown, CSS/HTML/YAML/JSON). Changes sync through the server; Open Project warns before overwriting existing files.
4. **Presentation: Open Preview** — static Reveal preview from the project site (no auth on preview URLs).
5. **Presentation: Share Project** — invite token for editors/viewers.
6. **Presentation: Members** — manage project members (owner).
7. **Presentation: Publish** — immutable public release under a slug URL.

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

## Public URLs

| URL | Meaning |
|-----|---------|
| `/preview/{project_id}/` | Live collaborative preview (mutable) |
| `/releases/{release_id}/` | Immutable self-contained release |
| `/presentations/{slug}/` | Alias to the project's current release |

Publish is `POST /api/projects/{project_id}/publish` (creates a release). Each project vendors Reveal under `runtime/`; releases copy the full tree (no shared `/runtimes`, no `blobs/`).

API and collaboration WebSocket require a signed-in access token (`Authorization: Bearer …`; WS also accepts `?access_token=`). Preview and published release pages stay public.

## Releases

Each git tag `vX.Y.Z` (must match `pyproject.toml`) publishes the VSIX on GitHub Releases and a multi-arch image to GHCR. See `AGENTS.md` for the release checklist.
