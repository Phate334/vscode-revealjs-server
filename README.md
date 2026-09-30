# vscode-revealjs-server

FastAPI collaboration server (uv) + VS Code extension PoC.

## Server (Docker Compose)

```bash
docker compose up -d --build
./scripts/compose-smoke.sh   # GET http://127.0.0.1:8000/health → {"status":"ok"}
```

Published port: `8000`. WS: `ws://127.0.0.1:8000/api/projects/{project_id}/collaboration`

## Unit tests (in-process)

```bash
uv sync --group dev
uv run pytest
```

Live-server checks must use the compose published port, not host uvicorn.

## Extension

See `extension/README.md` (default WS assumes compose is up).
