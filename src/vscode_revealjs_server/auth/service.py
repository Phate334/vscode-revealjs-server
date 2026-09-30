"""In-memory demo users + login/refresh/me (M3 auth stub).

ponytail: no Postgres / OAuth. Ceiling: single-node demo users from env.
Upgrade: real IdP or user table (M3 members follow-on).
"""

from __future__ import annotations

import hashlib
import os
from typing import Any

from vscode_revealjs_server.auth.tokens import decode_jwt, issue_tokens


def _demo_users() -> dict[str, dict[str, str]]:
    """username → {id, password}.

    Built-ins: demo/demo, alice/alice. Optional AUTH_DEMO_USER=name:pass.
    """
    users = {
        "demo": {"id": "usr_demo", "password": "demo"},
        "alice": {"id": "usr_alice", "password": "alice"},
    }
    extra = os.environ.get("AUTH_DEMO_USER", "").strip()
    if extra and ":" in extra:
        name, pw = extra.split(":", 1)
        name = name.strip()
        if name:
            uid = "usr_" + hashlib.sha256(name.encode()).hexdigest()[:12]
            users[name] = {"id": uid, "password": pw}
    return users


def find_user(*, username: str | None = None, user_id: str | None = None) -> dict[str, str] | None:
    """Return {id, username} from demo store, or None."""
    users = _demo_users()
    if username is not None:
        name = username.strip()
        row = users.get(name)
        if row is None:
            return None
        return {"id": row["id"], "username": name}
    if user_id is not None:
        for name, row in users.items():
            if row["id"] == user_id:
                return {"id": row["id"], "username": name}
        return None
    return None


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
    # Ensure user still exists in demo store
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
