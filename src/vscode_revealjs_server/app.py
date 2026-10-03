import secrets
import time
from urllib.parse import quote
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from vscode_revealjs_server.auth import service as auth_service
from vscode_revealjs_server.auth.deps import require_user, user_from_websocket
from vscode_revealjs_server.auth.tokens import encode_jwt, decode_jwt
from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation import preview as preview_service
from vscode_revealjs_server.presentation.publish import publish as publish_release
from vscode_revealjs_server.presentation.publish import read_published
from vscode_revealjs_server.projects import project_service
from vscode_revealjs_server.projects.service import (
    AssetConflict,
    FsRejected,
)

app = FastAPI(title="vscode-revealjs-server")


class WorkspaceOperation(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(min_length=1, max_length=120)
    kind: Literal["create", "delete", "rename", "move", "mkdir", "write"]
    path: str | None = None
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    content: str | None = None


class WorkspaceOperationsBody(BaseModel):
    base_revision: int = Field(ge=0, strict=True)
    operations: list[WorkspaceOperation] = Field(min_length=1, max_length=200)


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class RefreshBody(BaseModel):
    refresh_token: str = Field(min_length=1)


def _forbid_unless_member(project_id: str, user_id: str) -> None:
    """Any signed-in user. Membership is not required; unknown projects are 404."""
    del user_id
    if project_service.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")


def _forbid_unless_writer(project_id: str, user_id: str) -> None:
    """Edit does not require a member role."""
    _forbid_unless_member(project_id, user_id)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/register", status_code=201)
def auth_register(body: LoginBody) -> dict:
    """Create an account. Does not overwrite an existing username."""
    try:
        return auth_service.register(body.username, body.password)
    except auth_service.UserExists:
        raise HTTPException(status_code=409, detail="username already registered")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/auth/login")
def auth_login(body: LoginBody) -> dict:
    """Sign in. Unknown username and wrong password are both 401."""
    try:
        got = auth_service.login(body.username, body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
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
def list_projects(
    user: Annotated[dict[str, str], Depends(require_user)],
    scope: str | None = Query(default=None),
) -> list[dict]:
    """scope=owned | shared. Omit for every project the caller belongs to."""
    if scope not in (None, "owned", "shared"):
        raise HTTPException(status_code=400, detail="scope must be owned or shared")
    return project_service.list_projects(user_id=user["id"], scope=scope)


@app.get("/api/projects/{project_id}")
def get_project(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_member(project_id, user["id"])
    meta = project_service.get(project_id, user_id=user["id"])
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


@app.post("/api/projects/{project_id}/workspace/operations")
async def workspace_operations(
    project_id: str, body: WorkspaceOperationsBody,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_writer(project_id, user["id"])
    result = await manager.apply_operations(
        project_id,
        [operation.model_dump(by_alias=True, exclude_none=True) for operation in body.operations],
        body.base_revision,
    )
    if "failed" in result:
        raise HTTPException(status_code=409, detail=result)
    return result


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


@app.put("/api/projects/{project_id}/assets/{asset_path:path}")
async def put_asset(
    project_id: str,
    asset_path: str,
    request: Request,
    user: Annotated[dict[str, str], Depends(require_user)],
    client_id: str | None = Query(default=None),
    base_revision: int | None = Query(default=None),
    force: bool = Query(default=False),
) -> dict:
    """Upload / replace a binary asset with optimistic concurrency (#9).

    When the path already exists, base_revision must match stored asset revision
    unless force=true. Mismatch → 409 AssetConflict.
    """
    _forbid_unless_writer(project_id, user["id"])
    body = await request.body()
    try:
        rev, info = project_service.put_asset(
            project_id,
            asset_path,
            body,
            base_revision=base_revision,
            force=force,
        )
    except AssetConflict as e:
        raise HTTPException(status_code=409, detail=e.as_dict()) from e
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
    return {"structure_revision": rev, **info}


@app.get("/api/projects/{project_id}/assets/{asset_path:path}")
def get_asset(
    project_id: str,
    asset_path: str,
    user: Annotated[dict[str, str], Depends(require_user)],
    content_hash: str | None = Query(default=None),
) -> Response:
    _forbid_unless_member(project_id, user["id"])
    try:
        with project_service._mut:
            got = project_service.get_asset(project_id, asset_path)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if got is None:
        if project_service.get(project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raise HTTPException(status_code=404, detail="asset not found")
    payload, info = got
    if content_hash is not None and content_hash != info["content_hash"]:
        raise HTTPException(status_code=409, detail="asset changed since snapshot; fetch a new snapshot")
    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "X-Content-Hash": info["content_hash"],
            "X-Asset-Size": str(info["size"]),
            "X-Asset-Revision": str(info.get("revision", 0)),
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
    if project_service.get(project_id) is None:
        await websocket.accept()
        await websocket.close(code=4404, reason="project not found")
        return
    can_write = project_service.can_write(project_id, user["id"])
    await manager.handle(websocket, project_id, user_id=user["id"], can_write=can_write)



def _invite_url(request: Request, token: str) -> str:
    """Account-invite link. Token stays in the fragment so a browser does not send it."""
    base = str(request.base_url).rstrip("/")
    return f"{base}/join#{quote(token, safe='')}"


def _presentation_url(request: Request, project_id: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/open#{quote(project_id, safe='')}"


@app.get("/join", response_class=HTMLResponse)
def join_hint() -> HTMLResponse:
    """Hint page for an account invite. Registration happens in VS Code, not here."""
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>Create an account</title>"
        "<p>In VS Code, run <strong>Presentation: Accept Invitation</strong> and paste this link. "
        "Enter a username and password to create an account and sign in. "
        "This link does not add you to a presentation.</p>"
    )


@app.get("/open", response_class=HTMLResponse)
def open_hint() -> HTMLResponse:
    """Hint page for a presentation link. Opening happens in VS Code."""
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>Open presentation</title>"
        "<p>In VS Code, run <strong>Presentation: Open Presentation</strong>, choose "
        "<strong>Open from link…</strong>, and paste this link. "
        "Sign in first. Any signed-in user can edit.</p>"
    )


@app.post("/api/account-invites", status_code=201)
def post_account_invite(
    request: Request,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    """Signed-in user creates a reusable account-registration link. No project required."""
    _ = user
    invite = auth_service.create_account_invite()
    invite["url"] = _invite_url(request, invite["token"])
    return invite


@app.get("/api/account-invites/{token}")
def get_account_invite(token: str) -> dict:
    """Confirm an account invite before prompting for a username. Does not register."""
    if not auth_service.account_invite_exists(token):
        raise HTTPException(status_code=404, detail="invite not found")
    return {"valid": True}


@app.post("/api/account-invites/{token}/register", status_code=201)
def register_account_invite(token: str, body: LoginBody) -> dict:
    """Create an account from an invite and sign in. Does not join a project."""
    try:
        got = auth_service.register_with_invite(token, body.username, body.password)
    except auth_service.UserExists:
        raise HTTPException(status_code=409, detail="username already registered")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if got is None:
        raise HTTPException(status_code=404, detail="invite not found")
    return got


@app.get("/api/projects/{project_id}/link")
def get_project_link(
    project_id: str,
    request: Request,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    """Link any signed-in user can open and edit. Does not add members."""
    _forbid_unless_member(project_id, user["id"])
    meta = project_service.get(project_id)
    assert meta is not None
    return {"project_id": project_id, "name": meta["name"], "url": _presentation_url(request, project_id)}


@app.post("/api/projects/{project_id}/publish")
def post_publish(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    """Publish command: snapshot collaborative state into an immutable release."""
    _forbid_unless_writer(project_id, user["id"])
    try:
        return publish_release(project_id)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/projects/{project_id}/releases")
def get_releases(
    project_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> list[dict]:
    _forbid_unless_member(project_id, user["id"])
    rows = project_service.list_releases(project_id)
    if rows is None:
        raise HTTPException(status_code=404, detail="project not found")
    return rows


@app.get("/api/projects/{project_id}/releases/{release_id}")
def get_release(
    project_id: str,
    release_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_member(project_id, user["id"])
    row = project_service.get_release(project_id, release_id)
    if row is None:
        if project_service.get(project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raise HTTPException(status_code=404, detail="release not found")
    return row


@app.get("/api/releases/{release_id}")
def get_release_global(
    release_id: str,
    user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    """Release resource by id (caller must be a member of the owning project)."""
    row = project_service.get_release_global(release_id)
    if row is None:
        raise HTTPException(status_code=404, detail="release not found")
    _forbid_unless_member(str(row["project_id"]), user["id"])
    return row


def _serve_published(root: object, rel: str) -> Response:
    from pathlib import Path

    if not isinstance(root, Path):
        raise HTTPException(status_code=404, detail="not found")
    try:
        got = read_published(root, rel)
    except FsRejected as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if got is None:
        raise HTTPException(status_code=404, detail="not found")
    body, media = got
    return Response(content=body, media_type=media)


@app.get("/presentations/{slug}")
def public_presentation_root(slug: str) -> RedirectResponse:
    """Trailing slash so relative slide/theme/runtime URLs resolve."""
    return RedirectResponse(url=f"/presentations/{slug}/", status_code=307)


@app.get("/presentations/{slug}/{rel_path:path}")
def public_presentation(slug: str, rel_path: str = "") -> Response:
    """Human-friendly alias pointing at the project's current published release."""
    root = project_service.resolve_slug_dir(slug)
    if root is None:
        raise HTTPException(status_code=404, detail="not published")
    return _serve_published(root, rel_path)


@app.get("/releases/{release_id}")
def public_release_root(release_id: str) -> RedirectResponse:
    """Trailing slash so relative slide/theme/runtime URLs resolve."""
    return RedirectResponse(url=f"/releases/{release_id}/", status_code=307)


@app.get("/releases/{release_id}/{rel_path:path}")
def public_release(release_id: str, rel_path: str = "") -> Response:
    """Immutable self-contained release bytes."""
    root = project_service.resolve_release_dir(release_id)
    if root is None:
        raise HTTPException(status_code=404, detail="release not found")
    return _serve_published(root, rel_path)


PREVIEW_TTL_SECONDS = 600


@app.post("/api/projects/{project_id}/preview-session")
def preview_session(
    project_id: str, user: Annotated[dict[str, str], Depends(require_user)],
) -> dict:
    _forbid_unless_member(project_id, user["id"])
    expires = int(time.time()) + PREVIEW_TTL_SECONDS
    token = encode_jwt({"typ": "preview", "sub": user["id"], "project_id": project_id,
                        "exp": expires, "nonce": secrets.token_hex(16)})
    return {"url": f"/preview/{project_id}/?token={token}", "expires_at": expires}


def _preview_auth(project_id: str, request: Request, token: str | None = None) -> dict:
    credential = token or request.cookies.get("presentation_preview")
    try:
        claims = decode_jwt(credential or "")
        if (claims.get("typ") != "preview" or claims.get("project_id") != project_id
                or not isinstance(claims.get("exp"), int)
                or claims["exp"] <= int(time.time())):
            raise ValueError("invalid preview session")
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="preview session expired or invalid") from exc
    if project_service.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return claims


def _private_preview_response(body: bytes, media_type: str) -> Response:
    return Response(content=body, media_type=media_type, headers={
        "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    })


@app.get("/preview/{project_id}")
def preview_index_redirect(project_id: str, request: Request, token: str | None = None) -> Response:
    return preview_index(project_id, request, token)


@app.get("/preview/{project_id}/")
def preview_index(project_id: str, request: Request, token: str | None = None) -> Response:
    claims = _preview_auth(project_id, request, token)
    if token:
        # Bootstrap a path-scoped HttpOnly cookie so relative assets are protected too.
        response = RedirectResponse(url=f"/preview/{project_id}/", status_code=303)
        response.set_cookie("presentation_preview", token, path=f"/preview/{project_id}/",
                            max_age=max(0, claims["exp"] - int(time.time())),
                            httponly=True, secure=request.url.scheme == "https", samesite="strict")
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response
    snap = project_service.snapshot(project_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="project not found")
    index = next((row["content"] for row in snap["files"] if row["path"] == "index.html"), None)
    if index is None:
        raise HTTPException(status_code=404, detail="index.html not found")
    # ponytail: poll the fingerprint for live preview; upgrade to a read-only event stream at scale.
    script = """<script>
(() => {
  const initial = '%s';
  const timer = setInterval(async () => {
    try {
      const response = await fetch('./__state', {cache: 'no-store'});
      if (response.status === 401 || response.status === 403) { clearInterval(timer); return; }
      if (response.ok && (await response.text()) !== initial) location.reload();
    } catch (_) { /* A transient outage is retried on the next interval. */ }
  }, 1500);
})();
</script>""" % snap["content_hash"]
    body = index.replace("</body>", script + "</body>") if "</body>" in index else index + script
    return _private_preview_response(body.encode("utf-8"), "text/html")


@app.get("/preview/{project_id}/__state")
def preview_state(project_id: str, request: Request) -> Response:
    _preview_auth(project_id, request)
    snap = project_service.snapshot(project_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="project not found")
    return _private_preview_response(snap["content_hash"].encode("ascii"), "text/plain")


@app.get("/preview/{project_id}/{preview_path:path}")
def preview_path(project_id: str, preview_path: str, request: Request) -> Response:
    _preview_auth(project_id, request)
    try:
        got = preview_service.resolve_path(project_id, preview_path)
    except FsRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if got is None:
        raise HTTPException(status_code=404, detail="preview path not found")
    return _private_preview_response(got.body, got.media_type)
