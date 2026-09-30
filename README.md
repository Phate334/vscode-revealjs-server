# vscode-revealjs-server

FastAPI collaboration server (uv) + VS Code extension PoC.

## Server (Docker Compose)

```bash
docker compose up -d --build
./scripts/compose-smoke.sh   # GET http://127.0.0.1:8000/health → {"status":"ok"}
```

Published port: `8000`. WS: `ws://127.0.0.1:8000/api/projects/{project_id}/collaboration`

Acceptance and live checks use the compose endpoint (`localhost:8000`), not host `uv run uvicorn`. Do not add a unit-test suite — verify with compose smoke + real VS Code Extension Development Host windows (see `AGENTS.md`).

## Extension

See `extension/README.md`. Connect URL comes from `.presentation/workspace.json` (`server` + `projectId`); fixtures already include that file.

## Preview (M2)

Server Preview reads collaborative state (CRDT text + workspace assets), not client disks:

```text
GET /p/{project_id}/preview
GET /p/{project_id}/preview/{path}
GET /runtimes/reveal-v1/...   # shared reveal.js runtime (Publish will reuse)
```

In VS Code: **Presentation: Open Preview** opens the Server Preview URL from `.presentation/workspace.json`.

## Auth (M3 stub)

Demo user `demo` / `demo` (override with `AUTH_DEMO_USER=name:pass`, secret `AUTH_JWT_SECRET`):

```text
POST /api/auth/login     {"username","password"} → access_token + refresh_token
POST /api/auth/refresh   {"refresh_token"}
GET  /api/auth/me        Authorization: Bearer <access>
```

Route enforcement (HTTP/WS require token) is the next M3 slice — Preview/collab still open for now.
