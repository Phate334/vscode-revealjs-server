from fastapi import FastAPI, WebSocket

from vscode_revealjs_server.collaboration.manager import manager

app = FastAPI(title="vscode-revealjs-server")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/api/projects/{project_id}/collaboration")
async def collaboration_ws(websocket: WebSocket, project_id: str) -> None:
    # ponytail: fixed PoC project_id path only; no auth. Upgrade: token + membership (M3).
    await manager.handle(websocket, project_id)
