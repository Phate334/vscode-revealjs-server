import mimetypes

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket
from pydantic import BaseModel, Field

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation import preview as preview_service
from vscode_revealjs_server.presentation.runtime import (
    is_supported_runtime,
    resolve_runtime_file,
)
from vscode_revealjs_server.auth import service as auth_service
from vscode_revealjs_server.projects import project_service
from vscode_revealjs_server.projects.service import FsRejected

app = FastAPI(title="vscode-revealjs-server")


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class RefreshBody(BaseModel):
    refresh_token: str = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def auth_login(body: LoginBody) -> dict:
    """M3 auth stub: demo users (default demo/demo). Enforcement on routes = next slice."""
    got = auth_service.login(body.username, body.password)
    if got is None:
        raise HTTPException(status_code=401, detail="invalid credentials")
    return got


@app.post("/api/auth/refresh")
def auth_refresh(body: RefreshBody) -> dict:
    got = auth_service.refresh(body.refresh_token)
    if got is None:
        raise HTTPException(status_code=401, detail="invalid refresh token")
    return got


@app.get("/api/auth/me")
def auth_me(request: Request) -> dict:
    token = auth_service.bearer_token(request.headers.get("authorization"))
    if token is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    user = auth_service.me_from_access(token)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid access token")
    return user


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


@app.get("/runtimes/{runtime_name}/{runtime_path:path}")
def get_runtime(runtime_name: str, runtime_path: str) -> Response:
    """Shared reveal runtime files (Preview + future Publish). Registry only."""
    if not is_supported_runtime(runtime_name):
        raise HTTPException(status_code=404, detail="unknown runtime")
    path = resolve_runtime_file(runtime_path, name=runtime_name)
    if path is None:
        raise HTTPException(status_code=404, detail="runtime file not found")
    media, _ = mimetypes.guess_type(str(path))
    return Response(content=path.read_bytes(), media_type=media or "application/octet-stream")


@app.get("/p/{project_id}/preview")
def preview_index(project_id: str) -> Response:
    """Server Preview HTML composed from collaborative state (§19)."""
    # Trailing-slash alias keeps relative fetches consistent for clients that append /.
    got = preview_service.compose_index(project_id)
    if got is None:
        raise HTTPException(status_code=404, detail="project not found")
    return Response(content=got.body, media_type=got.media_type)


@app.get("/p/{project_id}/preview/")
def preview_index_slash(project_id: str) -> Response:
    return preview_index(project_id)


@app.get("/p/{project_id}/preview/{preview_path:path}")
def preview_path(project_id: str, preview_path: str) -> Response:
    """Preview path: CRDT text for bound slide, else collaborative workspace/assets."""
    try:
        got = preview_service.resolve_path(project_id, preview_path)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if got is None:
        if project_service.get(project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raise HTTPException(status_code=404, detail="preview path not found")
    return Response(content=got.body, media_type=got.media_type)
