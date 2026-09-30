import mimetypes
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket
from pydantic import BaseModel, Field

from vscode_revealjs_server.auth import service as auth_service
from vscode_revealjs_server.auth.deps import require_user, user_from_websocket
from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation import preview as preview_service
from vscode_revealjs_server.presentation.runtime import (
    is_supported_runtime,
    resolve_runtime_file,
)
from vscode_revealjs_server.projects import project_service
from vscode_revealjs_server.projects.service import ROLE_EDITOR, ROLE_VIEWER, FsRejected

app = FastAPI(title="vscode-revealjs-server")


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class RefreshBody(BaseModel):
    refresh_token: str = Field(min_length=1)


class AddMemberBody(BaseModel):
    """Add by username (demo store) or user_id; role editor|viewer."""

    username: str | None = Field(default=None, min_length=1, max_length=120)
    user_id: str | None = Field(default=None, min_length=1, max_length=120)
    role: str = Field(default=ROLE_EDITOR, min_length=1, max_length=32)


def _forbid_unless_member(project_id: str, user_id: str) -> None:
    if project_service.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    if not project_service.can_read(project_id, user_id):
        raise HTTPException(status_code=403, detail="not a project member")


def _forbid_unless_writer(project_id: str, user_id: str) -> None:
    _forbid_unless_member(project_id, user_id)
    if not project_service.can_write(project_id, user_id):
        raise HTTPException(status_code=403, detail="write permission required")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def auth_login(body: LoginBody) -> dict:
    """Demo users: demo/demo, alice/alice (+ AUTH_DEMO_USER)."""
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
def auth_me(user: Annotated[dict[str, str], Depends(require_user)]) -> dict:
    return user


@app.post("/api/projects")
def create_project(
    body: CreateProjectBody,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    try:
        return project_service.create(
            name=body.name,
            owner_id=user["id"],
            owner_username=user["username"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/projects")
def list_projects(user: Annotated[dict[str, str], Depends(require_user)]) -> list[dict]:
    return project_service.list_projects(user_id=user["id"])


@app.get("/api/projects/{project_id}")
def get_project(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_member(project_id, user["id"])
    meta = project_service.get(project_id)
    assert meta is not None
    return meta


@app.get("/api/projects/{project_id}/snapshot")
def get_snapshot(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_member(project_id, user["id"])
    snap = project_service.snapshot(project_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="project not found")
    return snap


@app.get("/api/projects/{project_id}/members")
def get_members(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> list[dict]:
    _forbid_unless_member(project_id, user["id"])
    members = project_service.list_members(project_id)
    if members is None:
        raise HTTPException(status_code=404, detail="project not found")
    return members


@app.post("/api/projects/{project_id}/members")
def post_member(
    project_id: str,
    body: AddMemberBody,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> list[dict]:
    _forbid_unless_member(project_id, user["id"])
    if not project_service.can_manage_members(project_id, user["id"]):
        raise HTTPException(status_code=403, detail="owner permission required")
    if body.role not in (ROLE_EDITOR, ROLE_VIEWER):
        raise HTTPException(status_code=400, detail="role must be editor or viewer")
    if not body.username and not body.user_id:
        raise HTTPException(status_code=400, detail="username or user_id required")
    target = auth_service.find_user(username=body.username, user_id=body.user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user not found")
    try:
        return project_service.add_member(
            project_id,
            user_id=target["id"],
            username=target["username"],
            role=body.role,
        )
    except FsRejected as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.delete("/api/projects/{project_id}/members/{member_user_id}")
def delete_member(
    project_id: str,
    member_user_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> list[dict]:
    _forbid_unless_member(project_id, user["id"])
    if not project_service.can_manage_members(project_id, user["id"]):
        raise HTTPException(status_code=403, detail="owner permission required")
    try:
        return project_service.remove_member(project_id, member_user_id)
    except FsRejected as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.put("/api/projects/{project_id}/assets/{asset_path:path}")
async def put_asset(
    project_id: str,
    asset_path: str,
    request: Request,
    user: Annotated[dict[str, str], Depends(require_user)],
    client_id: str | None = Query(default=None),
) -> dict:
    """Upload / replace a binary asset; bump revision; notify WS peers."""
    _forbid_unless_writer(project_id, user["id"])
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
def get_asset(
    project_id: str,
    asset_path: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> Response:
    _forbid_unless_member(project_id, user["id"])
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
async def collaboration_ws(
    websocket: WebSocket,
    project_id: str,
    access_token: str | None = Query(default=None),
) -> None:
    """Collaboration WS — require Bearer via ?access_token= or Authorization header."""
    user = user_from_websocket(websocket, access_token=access_token)
    if user is None:
        await websocket.accept()
        await websocket.close(code=4401, reason="missing or invalid access token")
        return
    # Real projects require membership; unknown id (e.g. fixture "poc") allows any authed user.
    if project_service.get(project_id) is not None:
        if not project_service.can_read(project_id, user["id"]):
            await websocket.accept()
            await websocket.close(code=4403, reason="not a project member")
            return
        can_write = project_service.can_write(project_id, user["id"])
    else:
        can_write = True
    await manager.handle(websocket, project_id, user_id=user["id"], can_write=can_write)


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
    """Server Preview HTML — open for demo (browser Open Preview has no Bearer)."""
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
