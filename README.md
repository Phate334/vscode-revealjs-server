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
