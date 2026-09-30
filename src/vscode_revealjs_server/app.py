from fastapi import FastAPI, HTTPException, WebSocket
from pydantic import BaseModel, Field

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.projects import project_service

app = FastAPI(title="vscode-revealjs-server")


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/projects")
def create_project(body: CreateProjectBody) -> dict:
    # ponytail: no auth; upgrade token + owner (M3).
    try:
        return project_service.create(name=body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/projects")
def list_projects() -> list[dict]:
    return project_service.list_projects()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    meta = project_service.get(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="project not found")
    return meta


@app.get("/api/projects/{project_id}/snapshot")
def get_snapshot(project_id: str) -> dict:
    snap = project_service.snapshot(project_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="project not found")
    return snap


@app.websocket("/api/projects/{project_id}/collaboration")
async def collaboration_ws(websocket: WebSocket, project_id: str) -> None:
    # ponytail: fixed PoC project_id path only; no auth. Upgrade: token + membership (M3).
    await manager.handle(websocket, project_id)
