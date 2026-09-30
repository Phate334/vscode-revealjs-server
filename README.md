# vscode-revealjs-server

FastAPI collaboration server (uv) + VS Code extension PoC.

## Server (Docker Compose)

```bash
docker compose pull
docker compose up -d
./scripts/compose-smoke.sh   # GET http://127.0.0.1:8000/health → {"status":"ok"}
```

Published port: `8000`. WS: `ws://127.0.0.1:8000/api/projects/{project_id}/collaboration?access_token=<jwt>`

Acceptance and live checks use the compose endpoint (`localhost:8000`), not host `uv run uvicorn`. Do not add a unit-test suite — verify with compose smoke + real VS Code Extension Development Host windows (see `AGENTS.md`).

## Extension

See `extension/README.md`. Connect URL comes from `.presentation/workspace.json` (`server` + `projectId`); fixtures already include that file.


## Install from a release (tag)

Tagged releases (`vX.Y.Z`, matching `pyproject.toml` version) publish:

1. **VS Code extension VSIX** on the [GitHub Release](https://github.com/Phate334/vscode-revealjs-server/releases) for that tag.
2. **Server image** to GHCR: `ghcr.io/phate334/vscode-revealjs-server:<version>` (also `:latest`).

### Extension (Install from VSIX)

Download the `.vsix` from the release assets, then:

```bash
code --install-extension path/to/vscode-revealjs-collaboration-0.1.0.vsix
```

Or in VS Code: **Extensions → … → Install from VSIX…**

### Server image (GHCR)

```bash
docker pull ghcr.io/phate334/vscode-revealjs-server:0.1.0
# or
docker pull ghcr.io/phate334/vscode-revealjs-server:latest
```

For a private package, authenticate first (`gh auth token | docker login ghcr.io -u USER --password-stdin`) and ensure you have package read access.

Compose pulls `ghcr.io/phate334/vscode-revealjs-server:<version>` (see `compose.yaml`). Private GHCR needs `docker login ghcr.io` first. To iterate on the Dockerfile locally, temporarily switch the service back to `build: .`.

## Collaborative text (multi-doc)

CRDT model: `path → Y.Text` inside a Yjs/pycrdt `documents` map (not a single slide blob). Bound extensions: `.md`, `.css`, `.html`, `.yaml`/`.yml`, `.json`. Each file has its own UndoManager. Preview/Publish prefer live CRDT text for those paths.

Open Project warns before overwriting existing files in the target folder (Create still uses a new subfolder under the parent you pick).

## Preview (M2)

Server Preview reads collaborative state (CRDT documents map + workspace assets), not client disks. **Preview stays open (no Bearer)** so browser Open Preview keeps working:

```text
GET /p/{project_id}/preview
GET /p/{project_id}/preview/{path}
GET /runtimes/reveal-v1/...   # shared reveal.js runtime (Publish will reuse)
```

In VS Code: **Presentation: Open Preview** opens the Server Preview URL from `.presentation/workspace.json`.

## Auth (M3)

Demo users (override / extend with `AUTH_DEMO_USER=name:pass`):

| user  | password | id        |
|-------|----------|-----------|
| demo  | demo     | usr_demo  |
| alice | alice    | usr_alice |

Env (compose or process):

| var | default | meaning |
|-----|---------|---------|
| `AUTH_JWT_SECRET` | `ponytail-dev-jwt-secret-change-me` | HS256 secret |
| `AUTH_ACCESS_TTL_SEC` | `3600` | access token TTL |
| `AUTH_REFRESH_TTL_SEC` | `604800` | refresh TTL |
| `AUTH_DEMO_USER` | _(unset)_ | extra `username:password` |

```text
POST /api/auth/login     {"username","password"} → access_token + refresh_token
POST /api/auth/refresh   {"refresh_token"}
GET  /api/auth/me        Authorization: Bearer <access>
```

### Bearer required

These need `Authorization: Bearer <access>` (WS: `?access_token=` or `Authorization` header):

```text
POST/GET /api/projects
GET      /api/projects/{id}
GET      /api/projects/{id}/snapshot
PUT/GET  /api/projects/{id}/assets/...
GET/POST /api/projects/{id}/members
DELETE   /api/projects/{id}/members/{user_id}
WS       /api/projects/{id}/collaboration
```

Create sets the caller as **owner**. Roles: `owner` | `editor` | `viewer` (write = owner/editor). Members APIs are owner-only for add/remove.

### Sharing

Owner-only invite. Token is reusable until revoked. Accept adds the caller as `editor` or `viewer` (existing members keep their role). `GET /api/projects?scope=shared` is the Open Shared list; `scope=owned` is Open Project.

```text
POST   /api/projects/{id}/shares          {"role":"viewer"|"editor"} → {id, token, role}
GET    /api/projects/{id}/shares
DELETE /api/projects/{id}/shares/{share_id}
GET    /api/shares/{token}                invite preview
POST   /api/shares/accept                 {"token"} → {project, already_member}
GET    /api/projects?scope=owned|shared
```

### Publish

`POST /api/projects/{id}/releases` builds from **server** collaborative state (CRDT slide if present, else workspace disk). Same `presentation.render` injection as Preview, but URLs are frozen under `/release/{release_id}/` (runtime copied into the release). Republish allocates a new id and moves the slug pointer. Old `/release/{id}` bytes do not change. Viewers cannot publish.

```text
POST/GET /api/projects/{id}/releases
GET      /api/projects/{id}/releases/{release_id}
GET      /s/{slug}                  current pointer (public)
GET      /s/{slug}/{path}
GET      /release/{release_id}      immutable (public)
GET      /release/{release_id}/{path}
```

Demo curl:

```bash
TOKEN=$(curl -sfS -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
curl -sfS http://127.0.0.1:8000/api/projects -H "Authorization: Bearer $TOKEN"
```
