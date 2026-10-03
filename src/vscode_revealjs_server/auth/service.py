"""In-memory demo users + login/refresh/me (M3 auth stub).

ponytail: no Postgres / OAuth. Ceiling: single-node users from AUTH_DEMO_USER.
Upgrade: real IdP or user table.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any

from vscode_revealjs_server.auth.tokens import decode_jwt, issue_tokens


def _demo_users() -> dict[str, dict[str, str]]:
    """username → {id, password} from AUTH_DEMO_USER.

    Comma-separated username:password pairs. No built-in accounts.
    Unset or empty → nobody can sign in. A non-empty value that does not
    parse raises RuntimeError so a bad seed fails instead of silently
    dropping accounts.
    """
    raw = os.environ.get("AUTH_DEMO_USER", "").strip()
    if not raw:
        return {}
    users: dict[str, dict[str, str]] = {}
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        if ":" not in item:
            raise RuntimeError(
                "AUTH_DEMO_USER must be comma-separated username:password pairs"
            )
        name, password = item.split(":", 1)
        name = name.strip()
        if not name or not password:
            raise RuntimeError(
                "AUTH_DEMO_USER must be comma-separated username:password pairs"
            )
        if name in users:
            raise RuntimeError(f"AUTH_DEMO_USER repeats username {name}")
        users[name] = {
            "id": "usr_" + hashlib.sha256(name.encode()).hexdigest()[:12],
            "password": password,
        }
    if not users:
        raise RuntimeError(
            "AUTH_DEMO_USER must be comma-separated username:password pairs"
        )
    return users


def login(username: str, password: str) -> dict[str, Any] | None:
    username = (username or "").strip()
    users = _demo_users()
    row = users.get(username)
    if row is None or row["password"] != password:
        return None
    tokens = issue_tokens(user_id=row["id"], username=username)
    return {**tokens, "user": {"id": row["id"], "username": username}}


def refresh(refresh_token: str) -> dict[str, Any] | None:
    try:
        payload = decode_jwt(refresh_token)
    except ValueError:
        return None
    if payload.get("typ") != "refresh":
        return None
    user_id = payload.get("sub")
    username = payload.get("username")
    if not isinstance(user_id, str) or not isinstance(username, str):
        return None
    if username not in _demo_users():
        return None
    tokens = issue_tokens(user_id=user_id, username=username)
    return {**tokens, "user": {"id": user_id, "username": username}}


def me_from_access(access_token: str) -> dict[str, str] | None:
    try:
        payload = decode_jwt(access_token)
    except ValueError:
        return None
    if payload.get("typ") != "access":
        return None
    user_id = payload.get("sub")
    username = payload.get("username")
    if not isinstance(user_id, str) or not isinstance(username, str):
        return None
    return {"id": user_id, "username": username}


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


# Fail at import when the operator set a seed that cannot be parsed.
_demo_users()
