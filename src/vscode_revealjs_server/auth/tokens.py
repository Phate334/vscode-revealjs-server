"""Minimal HS256 JWT (stdlib only).

ponytail: hand-rolled HS256 for MVP stub — no PyJWT dep. Ceiling: no kid/JWKS,
no asymmetric algs. Upgrade: PyJWT + rotating secrets (prod hardening).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def jwt_secret() -> str:
    # ponytail: env override for compose; default is local-dev only.
    return os.environ.get("AUTH_JWT_SECRET", "ponytail-dev-jwt-secret-change-me")


def encode_jwt(payload: dict[str, Any], *, secret: str | None = None) -> str:
    key = (secret or jwt_secret()).encode("utf-8")
    header = {"alg": "HS256", "typ": "JWT"}
    h = _b64url_encode(json.dumps(header, separators=(",", ":"), sort_keys=True).encode())
    p = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64url_encode(hmac.new(key, f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


def decode_jwt(token: str, *, secret: str | None = None) -> dict[str, Any]:
    key = (secret or jwt_secret()).encode("utf-8")
    try:
        h, p, s = token.split(".")
    except ValueError as e:
        raise ValueError("malformed token") from e
    expected = _b64url_encode(hmac.new(key, f"{h}.{p}".encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, s):
        raise ValueError("bad signature")
    try:
        payload = json.loads(_b64url_decode(p))
    except (json.JSONDecodeError, ValueError) as e:
        raise ValueError("bad payload") from e
    if not isinstance(payload, dict):
        raise ValueError("payload must be object")
    exp = payload.get("exp")
    if exp is not None and int(exp) <= int(time.time()):
        raise ValueError("token expired")
    return payload


ACCESS_TTL_SEC = int(os.environ.get("AUTH_ACCESS_TTL_SEC", "3600"))
REFRESH_TTL_SEC = int(os.environ.get("AUTH_REFRESH_TTL_SEC", str(7 * 24 * 3600)))


def issue_tokens(*, user_id: str, username: str) -> dict[str, Any]:
    now = int(time.time())
    access = encode_jwt(
        {
            "sub": user_id,
            "username": username,
            "typ": "access",
            "iat": now,
            "exp": now + ACCESS_TTL_SEC,
        }
    )
    refresh = encode_jwt(
        {
            "sub": user_id,
            "username": username,
            "typ": "refresh",
            "iat": now,
            "exp": now + REFRESH_TTL_SEC,
        }
    )
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TTL_SEC,
    }
