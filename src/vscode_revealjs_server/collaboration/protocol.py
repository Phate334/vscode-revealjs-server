"""JSON control messages for collaboration WebSocket. Binary frames = opaque CRDT updates."""

from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = 1

HELLO = "hello"
READY = "ready"
ERROR = "error"
PING = "ping"
PONG = "pong"

CONTROL_TYPES = frozenset({HELLO, READY, ERROR, PING, PONG})


def encode(msg: dict[str, Any]) -> str:
    return json.dumps(msg, separators=(",", ":"))


def decode(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("control message must be a JSON object with type")
    return data


def ready(*, revision: int, protocol_version: int = PROTOCOL_VERSION) -> dict[str, Any]:
    return {
        "type": READY,
        "protocol_version": protocol_version,
        "revision": revision,
    }


def error(code: str, message: str) -> dict[str, Any]:
    return {"type": ERROR, "code": code, "message": message}


def pong() -> dict[str, Any]:
    return {"type": PONG}
