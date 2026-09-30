"""In-memory collaboration rooms: WebSocket fan-out + pycrdt Doc per project_id."""

from __future__ import annotations

from pathlib import Path

from fastapi import WebSocket
from pycrdt import Doc
from starlette.websockets import WebSocketDisconnect, WebSocketState

from vscode_revealjs_server.collaboration import protocol as proto

# ponytail: in-memory rooms (+ optional .data blob). Ceiling: lost on process wipe / no multi-instance.
# Upgrade: shared store (postgres update log or snapshot; open decision #6).
_DATA_DIR = Path(__file__).resolve().parents[3] / ".data" / "collaboration"


class CollaborationRoom:
    def __init__(self, project_id: str) -> None:
        self.project_id = project_id
        self.clients: set[WebSocket] = set()
        self.doc = Doc()
        self.revision = 0
        self._load()

    def _blob_path(self) -> Path:
        return _DATA_DIR / f"{self.project_id}.ydoc"

    def _load(self) -> None:
        path = self._blob_path()
        if not path.is_file():
            return
        blob = path.read_bytes()
        if blob:
            self.doc.apply_update(blob)
            self.revision = 1

    def _persist(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._blob_path().write_bytes(self.doc.get_update())

    def snapshot(self) -> bytes | None:
        update = self.doc.get_update()
        # empty yjs update is b"\x00\x00"
        if self.revision <= 0 or update == b"\x00\x00":
            return None
        return update

    async def join(self, ws: WebSocket) -> None:
        self.clients.add(ws)

    async def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def apply_and_broadcast(self, update: bytes, sender: WebSocket) -> None:
        self.doc.apply_update(update)
        self.revision += 1
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


class CollaborationManager:
    def __init__(self) -> None:
        self._rooms: dict[str, CollaborationRoom] = {}

    def room(self, project_id: str) -> CollaborationRoom:
        if project_id not in self._rooms:
            self._rooms[project_id] = CollaborationRoom(project_id)
        return self._rooms[project_id]

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
        await room.join(ws)
        await ws.send_text(proto.encode(proto.ready(revision=room.revision)))
        snap = room.snapshot()
        if snap is not None:
            await ws.send_bytes(snap)

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
                else:
                    await ws.send_text(
                        proto.encode(proto.error("unknown_type", f"unsupported type: {ctype}"))
                    )
        except WebSocketDisconnect:
            pass
        finally:
            await room.leave(ws)


manager = CollaborationManager()
