from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket
from pydantic import BaseModel, Field

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.projects import project_service
from vscode_revealjs_server.projects.service import FsRejected

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


@app.put("/api/projects/{project_id}/assets/{asset_path:path}")
async def put_asset(
    project_id: str,
    asset_path: str,
    request: Request,
    client_id: str | None = Query(default=None),
) -> dict:
    """Upload / replace a binary asset; bump revision; notify WS peers."""
    body = await request.body()
    try:
        rev, info = project_service.put_asset(project_id, asset_path, body)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await manager.notify_asset_changed(
        project_id,
        path=info["path"],
        revision=rev,
        content_hash=info["content_hash"],
        size=info["size"],
        exclude_client_id=client_id,
    )
    return {"revision": rev, **info}


@app.get("/api/projects/{project_id}/assets/{asset_path:path}")
def get_asset(project_id: str, asset_path: str) -> Response:
    try:
        got = project_service.get_asset(project_id, asset_path)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if got is None:
        if project_service.get(project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raise HTTPException(status_code=404, detail="asset not found")
    payload, info = got
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Content-Hash": info["content_hash"],
            "X-Asset-Size": str(info["size"]),
        },
    )


@app.websocket("/api/projects/{project_id}/collaboration")
async def collaboration_ws(websocket: WebSocket, project_id: str) -> None:
    # ponytail: fixed PoC project_id path only; no auth. Upgrade: token + membership (M3).
    await manager.handle(websocket, project_id)
