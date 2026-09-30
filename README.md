# vscode-revealjs-server

FastAPI collaboration server (uv) + VS Code extension PoC.

## Server (Docker Compose)

```bash
docker compose up -d --build
./scripts/compose-smoke.sh   # GET http://127.0.0.1:8000/health → {"status":"ok"}
```

Published port: `8000`. WS: `ws://127.0.0.1:8000/api/projects/{project_id}/collaboration?access_token=<jwt>`

Acceptance and live checks use the compose endpoint (`localhost:8000`), not host `uv run uvicorn`. Do not add a unit-test suite — verify with compose smoke + real VS Code Extension Development Host windows (see `AGENTS.md`).

## Extension

See `extension/README.md`. Connect URL comes from `.presentation/workspace.json` (`server` + `projectId`); fixtures already include that file.

## Preview (M2)

Server Preview reads collaborative state (CRDT text + workspace assets), not client disks. **Preview stays open (no Bearer)** so browser Open Preview keeps working:

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

Demo curl:

```bash
TOKEN=$(curl -sfS -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
curl -sfS http://127.0.0.1:8000/api/projects -H "Authorization: Bearer $TOKEN"
```
