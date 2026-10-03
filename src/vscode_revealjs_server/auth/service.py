"""Persisted users: register, login, refresh (stdlib PBKDF2, no plaintext).

ponytail: JSON file beside project data, single-node lock. No IdP.
AUTH_DEMO_USER, when set, only inserts missing usernames at startup.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from vscode_revealjs_server.auth.tokens import decode_jwt, issue_tokens

_PBKDF2_ROUNDS = 200_000
_LOCK = threading.Lock()
_USERS: dict[str, dict[str, str]] | None = None
_INVITES: list[dict[str, str]] | None = None


class UserExists(Exception):
    """Register called for a username that is already stored."""


def _users_path() -> Path:
    explicit = os.environ.get("AUTH_USERS_PATH", "").strip()
    if explicit:
        return Path(explicit)
    projects = os.environ.get("PROJECTS_DATA_DIR", "").strip()
    if projects:
        return Path(projects).parent / "users.json"
    collab = os.environ.get("COLLAB_DATA_DIR", "").strip()
    if collab:
        return Path(collab).parent / "users.json"
    return Path.cwd() / ".data" / "users.json"


def _invites_path() -> Path:
    return _users_path().with_name("account-invites.json")


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS
    )
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds_s, salt_hex, hash_hex = stored.split("$", 3)
        rounds = int(rounds_s)
        if algo != "pbkdf2_sha256" or rounds < 1 or rounds > 1_000_000:
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(digest, expected)


def _user_id(username: str) -> str:
    return "usr_" + hashlib.sha256(username.encode()).hexdigest()[:12]


def _check(username: str, password: str) -> tuple[str, str]:
    name = (username or "").strip()
    if not name or len(name) > 120:
        raise ValueError("invalid username")
    if not isinstance(password, str) or not password or len(password) > 200:
        raise ValueError("invalid password")
    return name, password


def _load() -> dict[str, dict[str, str]]:
    global _USERS
    if _USERS is not None:
        return _USERS
    path = _users_path()
    users: dict[str, dict[str, str]] = {}
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        raw = data.get("users", {})
        if not isinstance(raw, dict):
            raise RuntimeError("users file must contain a users object")
        for name, row in raw.items():
            if not isinstance(name, str) or not isinstance(row, dict):
                raise RuntimeError("users file has an invalid record")
            if "password" in row:
                raise RuntimeError("users file must not store plaintext passwords")
            user_id = row.get("id")
            password_hash = row.get("password_hash")
            if not isinstance(user_id, str) or not isinstance(password_hash, str):
                raise RuntimeError("users file record missing id or password_hash")
            users[name] = {"id": user_id, "password_hash": password_hash}
    _USERS = users
    return users


def _save() -> None:
    path = _users_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"users": _USERS or {}}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _load_invites() -> list[dict[str, str]]:
    global _INVITES
    if _INVITES is not None:
        return _INVITES
    path = _invites_path()
    rows: list[dict[str, str]] = []
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        raw = data.get("invites", [])
        if not isinstance(raw, list):
            raise RuntimeError("account invites file must contain an invites list")
        for row in raw:
            if not isinstance(row, dict):
                raise RuntimeError("account invites file has an invalid record")
            invite_id, token, created = row.get("id"), row.get("token"), row.get("created_at")
            if not all(isinstance(x, str) and x for x in (invite_id, token, created)):
                raise RuntimeError("account invites record missing id, token, or created_at")
            rows.append({"id": invite_id, "token": token, "created_at": created})
    _INVITES = rows
    return rows


def _save_invites() -> None:
    path = _invites_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"invites": _INVITES or []}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _insert(name: str, password: str) -> dict[str, str]:
    """Caller holds _LOCK. Does not save."""
    users = _load()
    row = {"id": _user_id(name), "password_hash": _hash_password(password)}
    users[name] = row
    return row


def _tokens(name: str, row: dict[str, str], *, created: bool | None = None) -> dict[str, Any]:
    tokens = issue_tokens(user_id=row["id"], username=name)
    out: dict[str, Any] = {**tokens, "user": {"id": row["id"], "username": name}}
    if created is not None:
        out["created"] = created
    return out


def register(username: str, password: str) -> dict[str, Any]:
    """Create a user. Raises UserExists if the username is taken."""
    name, password = _check(username, password)
    with _LOCK:
        users = _load()
        if name in users:
            raise UserExists(name)
        row = _insert(name, password)
        _save()
    return _tokens(name, row)


def login(username: str, password: str) -> dict[str, Any] | None:
    name, password = _check(username, password)
    with _LOCK:
        row = _load().get(name)
        if row is None or not _verify_password(password, row["password_hash"]):
            return None
        snapshot = dict(row)
    return _tokens(name, snapshot)


def create_account_invite() -> dict[str, str]:
    """Reusable account-registration token. Not tied to a project or role.

    ponytail: JSON file beside users, no expiry. Ceiling: leaked link registers
    anyone until the file is edited. Upgrade: expiry and revoke.
    """
    row = {
        "id": f"ain_{uuid.uuid4().hex[:12]}",
        "token": secrets.token_urlsafe(24),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with _LOCK:
        invites = _load_invites()
        invites.append(row)
        _save_invites()
    return dict(row)


def account_invite_exists(token: str) -> bool:
    token = (token or "").strip()
    if not token:
        return False
    with _LOCK:
        return any(row["token"] == token for row in _load_invites())


def register_with_invite(token: str, username: str, password: str) -> dict[str, Any] | None:
    """Create an account for a valid invite. Does not join a project.

    Returns None when the token is unknown. Raises UserExists when the name is taken.
    The invite stays valid so the same link can register more than one account.
    """
    name, password = _check(username, password)
    token = (token or "").strip()
    with _LOCK:
        if not token or not any(row["token"] == token for row in _load_invites()):
            return None
        if name in _load():
            raise UserExists(name)
        row = _insert(name, password)
        _save()
        snapshot = dict(row)
    return _tokens(name, snapshot)


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
    with _LOCK:
        row = _load().get(username)
        if row is None or row["id"] != user_id:
            return None
        snapshot = dict(row)
    return _tokens(username, snapshot)


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


def _parse_demo_users(raw: str) -> dict[str, str]:
    """username → password. Empty raw is no seed. Bad syntax raises RuntimeError."""
    users: dict[str, str] = {}
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
        users[name] = password
    if not users:
        raise RuntimeError(
            "AUTH_DEMO_USER must be comma-separated username:password pairs"
        )
    return users


def _seed_demo_users() -> None:
    """Insert AUTH_DEMO_USER names that are not already stored. Hashes, then drops plaintext."""
    raw = os.environ.get("AUTH_DEMO_USER", "").strip()
    if not raw:
        _load()
        return
    pairs = _parse_demo_users(raw)
    with _LOCK:
        users = _load()
        changed = False
        for name, password in pairs.items():
            if name not in users:
                _insert(name, password)
                changed = True
        if changed:
            _save()


_seed_demo_users()
