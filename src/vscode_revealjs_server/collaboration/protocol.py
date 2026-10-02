"""Protocol v2: realtime CRDT frames and notifications; commands use HTTP."""
from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = 2
HELLO = "hello"
PING = "ping"


def encode(msg: dict[str, Any]) -> str:
    return json.dumps(msg, separators=(",", ":"))


def decode(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("control message must be an object with type")
    return data


def ready(*, structure_revision: int, has_snapshot: bool, can_write: bool) -> dict:
    return {"type": "ready", "protocol_version": PROTOCOL_VERSION,
            "structure_revision": structure_revision, "has_snapshot": has_snapshot,
            "can_write": can_write}


def error(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


def pong() -> dict:
    return {"type": "pong"}


def reconcile_required(*, structure_revision: int, reason: str) -> dict:
    return {"type": "reconcile_required", "structure_revision": structure_revision,
            "reason": reason}
