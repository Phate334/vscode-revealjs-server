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
FS_OPERATION = "fs.operation"
FS_OPERATION_ACK = "fs.operation_ack"
WORKSPACE_REVISION = "workspace.revision"
ASSET_CHANGED = "asset.changed"
WORKSPACE_RECONCILE_REQUIRED = "workspace.reconcile_required"

CONTROL_TYPES = frozenset(
    {
        HELLO,
        READY,
        ERROR,
        PING,
        PONG,
        FS_OPERATION,
        FS_OPERATION_ACK,
        WORKSPACE_REVISION,
        ASSET_CHANGED,
        WORKSPACE_RECONCILE_REQUIRED,
    }
)


def encode(msg: dict[str, Any]) -> str:
    return json.dumps(msg, separators=(",", ":"))


def decode(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("control message must be a JSON object with type")
    return data


def ready(
    *,
    revision: int,
    has_snapshot: bool = False,
    protocol_version: int = PROTOCOL_VERSION,
) -> dict[str, Any]:
    # revision = workspace topology revision (project meta), not CRDT update count.
    # has_snapshot: client must wait for one binary frame before flushReady (H1).
    return {
        "type": READY,
        "protocol_version": protocol_version,
        "revision": revision,
        "has_snapshot": has_snapshot,
    }


def error(code: str, message: str) -> dict[str, Any]:
    return {"type": ERROR, "code": code, "message": message}


def pong() -> dict[str, Any]:
    return {"type": PONG}


def fs_operation_ack(*, operation_id: str, revision: int) -> dict[str, Any]:
    return {
        "type": FS_OPERATION_ACK,
        "operation_id": operation_id,
        "revision": revision,
    }


def fs_operation_event(
    *,
    operation_id: str,
    revision: int,
    operation: dict[str, Any],
) -> dict[str, Any]:
    """Broadcast framing for peers (same type as client request; includes revision)."""
    return {
        "type": FS_OPERATION,
        "operation_id": operation_id,
        "revision": revision,
        "operation": operation,
    }


def workspace_revision(*, revision: int) -> dict[str, Any]:
    return {"type": WORKSPACE_REVISION, "revision": revision}


def asset_changed(
    *,
    path: str,
    revision: int,
    content_hash: str,
    size: int,
) -> dict[str, Any]:
    """Peers should HTTP GET the asset at path (last-write-wins; open decision #9)."""
    return {
        "type": ASSET_CHANGED,
        "path": path,
        "revision": revision,
        "content_hash": content_hash,
        "size": size,
    }


def reconcile_required(
    *,
    revision: int,
    reason: str,
    last_known_revision: int | None = None,
) -> dict[str, Any]:
    """Client should pause fs ops, re-fetch snapshot, and rebind (FS_RECONCILE)."""
    msg: dict[str, Any] = {
        "type": WORKSPACE_RECONCILE_REQUIRED,
        "revision": revision,
        "reason": reason,
    }
    if last_known_revision is not None:
        msg["last_known_revision"] = last_known_revision
    return msg
