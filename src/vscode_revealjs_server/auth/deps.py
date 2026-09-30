"""FastAPI helpers: require access JWT (M3)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Header, HTTPException, WebSocket

from vscode_revealjs_server.auth import service as auth_service


def require_user(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    token = auth_service.bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    user = auth_service.me_from_access(token)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid access token")
    return user


def user_from_websocket(
    websocket: WebSocket,
    *,
    access_token: str | None = None,
) -> dict[str, str] | None:
    """Resolve access JWT from ?access_token= or Authorization: Bearer."""
    token = (access_token or "").strip() or None
    if token is None:
        token = auth_service.bearer_token(websocket.headers.get("authorization"))
    if token is None:
        return None
    return auth_service.me_from_access(token)
