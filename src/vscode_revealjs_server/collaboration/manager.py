"""In-memory collaboration rooms: WebSocket fan-out + pycrdt Doc per project_id."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import WebSocket
from pycrdt import Doc
from starlette.websockets import WebSocketDisconnect, WebSocketState

from vscode_revealjs_server.collaboration import protocol as proto
from vscode_revealjs_server.projects.service import FsRejected, project_service

# ponytail: in-memory rooms (+ optional .data blob). Ceiling: lost on process wipe / no multi-instance.
# Upgrade: shared store (postgres update log or snapshot; open decision #6).
# COLLAB_DATA_DIR for containers; else cwd/.data (repo root when started via compose/uv).
_DATA_DIR = Path(os.environ.get("COLLAB_DATA_DIR", str(Path.cwd() / ".data" / "collaboration")))

# ponytail: open-decision #5 — no op log yet, any missed topology rev is unsafe.
# Threshold=1 forces snapshot reconcile on reconnect gap. Ceiling: reconnect thrash.
# Upgrade: persist ops / raise threshold with Git-bulk evidence.
REVISION_GAP_THRESHOLD = 1


class CollaborationRoom:
    def __init__(self, project_id: str) -> None:
        self.project_id = project_id
        self.clients: set[WebSocket] = set()
        self.client_ids: dict[WebSocket, str] = {}
        self.doc = Doc()
        # CRDT blob generation counter (not workspace topology revision).
        self.crdt_generation = 0
        self._load()

    def _blob_path(self) -> Path:
        return _DATA_DIR / f"{self.project_id}.ydoc"

    def _load(self) -> None:
        path = self._blob_path()
        if path.is_file():
            blob = path.read_bytes()
            if blob:
                self.doc.apply_update(blob)
                self.crdt_generation = 1
        # Empty room + known project → seed from workspace slide.md so dual clients
        # do not both insert the same file (CRDT concat / duplicate text).
        if self.snapshot() is None:
            self._seed_from_project()

    def _seed_from_project(self) -> None:
        from pycrdt import Text

        text = project_service.collaborative_slide_text(self.project_id)
        if not text:
            return
        ytext = self.doc.get("content", type=Text)
        if str(ytext):
            return
        ytext.insert(0, text)
        self.crdt_generation = 1
        self._persist()

    def _persist(self) -> None:
        """Atomic ydoc write (temp + replace) so crash mid-write keeps prior blob (H6)."""
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = self._blob_path()
        payload = self.doc.get_update()
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(payload)
        tmp.replace(path)

    def snapshot(self) -> bytes | None:
        update = self.doc.get_update()
        # empty yjs update is b"\x00\x00"
        if self.crdt_generation <= 0 or update == b"\x00\x00":
            return None
        return update

    async def join(self, ws: WebSocket, client_id: str = "") -> None:
        self.clients.add(ws)
        if client_id:
            self.client_ids[ws] = client_id

    async def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)
        self.client_ids.pop(ws, None)

    async def apply_and_broadcast(self, update: bytes, sender: WebSocket) -> None:
        self.doc.apply_update(update)
        self.crdt_generation += 1
        self._persist()
        await self.broadcast_bytes(update, exclude=sender)

    async def broadcast_bytes(self, data: bytes, *, exclude: WebSocket | None = None) -> None:
        dead: list[WebSocket] = []
        for client in self.clients:
            if client is exclude:
                continue
            if client.client_state != WebSocketState.CONNECTED:
                dead.append(client)
                continue
            try:
                await client.send_bytes(data)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)
            self.client_ids.pop(client, None)

    async def broadcast_text(self, data: str, *, exclude: WebSocket | None = None) -> None:
        dead: list[WebSocket] = []
        for client in self.clients:
            if client is exclude:
                continue
            if client.client_state != WebSocketState.CONNECTED:
                dead.append(client)
                continue
            try:
                await client.send_text(data)
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)
            self.client_ids.pop(client, None)


class CollaborationManager:
    def __init__(self) -> None:
        self._rooms: dict[str, CollaborationRoom] = {}
        # ponytail: one lock for all projects' fs ops. Ceiling: cross-project contention.
        # Upgrade: per-project lock or DB transaction (M3).
        self._fs_lock = asyncio.Lock()

    def room(self, project_id: str) -> CollaborationRoom:
        if project_id not in self._rooms:
            self._rooms[project_id] = CollaborationRoom(project_id)
        return self._rooms[project_id]

    def _workspace_revision(self, project_id: str) -> int:
        rev = project_service.revision(project_id)
        # Fixtures may use synthetic project_id (e.g. "poc") without meta → 0.
        return 0 if rev is None else rev

    async def handle(self, ws: WebSocket, project_id: str) -> None:
        await ws.accept()
        room = self.room(project_id)
        try:
            raw = await ws.receive_text()
            msg = proto.decode(raw)
        except Exception:
            await ws.send_text(proto.encode(proto.error("bad_hello", "expected hello JSON")))
            await ws.close()
            return

        if msg.get("type") != proto.HELLO:
            await ws.send_text(proto.encode(proto.error("bad_hello", "first message must be hello")))
            await ws.close()
            return

        client_id = msg.get("client_id")
        if not client_id or not isinstance(client_id, str):
            await ws.send_text(proto.encode(proto.error("bad_hello", "client_id required")))
            await ws.close()
            return

        # ponytail: protocol_version accepted but not negotiated; upgrade when clients diverge.
        last_known = msg.get("last_known_revision")
        last_known_rev: int | None = None
        if isinstance(last_known, int) and not isinstance(last_known, bool):
            last_known_rev = last_known
        elif last_known is not None:
            await ws.send_text(
                proto.encode(proto.error("bad_hello", "last_known_revision must be int"))
            )
            await ws.close()
            return

        await room.join(ws, client_id)
        server_rev = self._workspace_revision(project_id)
        snap = room.snapshot()
        await ws.send_text(
            proto.encode(proto.ready(revision=server_rev, has_snapshot=snap is not None))
        )
        if snap is not None:
            await ws.send_bytes(snap)

        # Revision gap → client must re-fetch workspace snapshot (topology/assets).
        if last_known_rev is not None and server_rev - last_known_rev >= REVISION_GAP_THRESHOLD:
            await ws.send_text(
                proto.encode(
                    proto.reconcile_required(
                        revision=server_rev,
                        reason="revision_gap",
                        last_known_revision=last_known_rev,
                    )
                )
            )

        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if "bytes" in message and message["bytes"] is not None:
                    await room.apply_and_broadcast(message["bytes"], sender=ws)
                    continue
                text = message.get("text")
                if text is None:
                    continue
                try:
                    control = proto.decode(text)
                except Exception:
                    await ws.send_text(proto.encode(proto.error("bad_message", "invalid JSON")))
                    continue
                ctype = control.get("type")
                if ctype == proto.PING:
                    await ws.send_text(proto.encode(proto.pong()))
                elif ctype == proto.HELLO:
                    await ws.send_text(proto.encode(proto.error("already_joined", "hello already sent")))
                elif ctype == proto.FS_OPERATION:
                    await self._handle_fs_operation(ws, room, project_id, control)
                else:
                    await ws.send_text(
                        proto.encode(proto.error("unknown_type", f"unsupported type: {ctype}"))
                    )
        except WebSocketDisconnect:
            pass
        finally:
            await room.leave(ws)

    async def _handle_fs_operation(
        self,
        ws: WebSocket,
        room: CollaborationRoom,
        project_id: str,
        control: dict,
    ) -> None:
        op_id = control.get("operation_id")
        operation = control.get("operation")
        if not isinstance(op_id, str) or not op_id:
            await ws.send_text(proto.encode(proto.error("bad_fs_op", "operation_id required")))
            return
        if not isinstance(operation, dict):
            await ws.send_text(proto.encode(proto.error("bad_fs_op", "operation object required")))
            return
        base = control.get("base_revision")
        base_rev: int | None
        if base is None:
            base_rev = None
        elif isinstance(base, int) and not isinstance(base, bool):
            base_rev = base
        else:
            await ws.send_text(proto.encode(proto.error("bad_fs_op", "base_revision must be int")))
            return

        async with self._fs_lock:
            try:
                rev, normalized = project_service.apply_fs_operation(
                    project_id,
                    operation,
                    base_revision=base_rev,
                )
            except FsRejected as e:
                err = str(e)
                await ws.send_text(proto.encode(proto.error("fs_rejected", err)))
                # Stale base → force snapshot reconcile (same path as hello gap).
                if "stale base_revision" in err:
                    server_rev = self._workspace_revision(project_id)
                    known = base_rev if base_rev is not None else -1
                    if server_rev - known >= REVISION_GAP_THRESHOLD:
                        await ws.send_text(
                            proto.encode(
                                proto.reconcile_required(
                                    revision=server_rev,
                                    reason="stale_base_revision",
                                    last_known_revision=base_rev,
                                )
                            )
                        )
                return
            except Exception as e:
                await ws.send_text(proto.encode(proto.error("fs_error", str(e))))
                return

            await ws.send_text(
                proto.encode(proto.fs_operation_ack(operation_id=op_id, revision=rev))
            )
            event = proto.encode(
                proto.fs_operation_event(
                    operation_id=op_id,
                    revision=rev,
                    operation=normalized,
                )
            )
            await room.broadcast_text(event, exclude=ws)
            await room.broadcast_text(
                proto.encode(proto.workspace_revision(revision=rev)),
                exclude=None,
            )

    async def notify_asset_changed(
        self,
        project_id: str,
        *,
        path: str,
        revision: int,
        content_hash: str,
        size: int,
        exclude_client_id: str | None = None,
    ) -> None:
        """Broadcast asset.changed + workspace.revision after HTTP PUT."""
        room = self.room(project_id)
        exclude: WebSocket | None = None
        if exclude_client_id:
            for ws, cid in room.client_ids.items():
                if cid == exclude_client_id:
                    exclude = ws
                    break
        event = proto.encode(
            proto.asset_changed(
                path=path,
                revision=revision,
                content_hash=content_hash,
                size=size,
            )
        )
        await room.broadcast_text(event, exclude=exclude)
        await room.broadcast_text(
            proto.encode(proto.workspace_revision(revision=revision)),
            exclude=None,
        )



manager = CollaborationManager()
