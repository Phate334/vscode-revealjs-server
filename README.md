# vscode-revealjs-server

FastAPI app managed with [uv](https://github.com/astral-sh/uv).

## Setup

```bash
uv sync
```

## Run

```bash
uv run vscode-revealjs-server
```

Or:

```bash
uv run uvicorn vscode_revealjs_server.app:app --reload
```

Health check: `GET http://127.0.0.1:8000/health`
