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

# #6: one merged Y.Doc state blob per project (documents Map); no permanent update log.
# Optional future compaction OK. Per-path Y.Docs / per-path blob table deferred (would break Map CRDT).
# Ceiling: single-node process; lost on wipe without .data volume.
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
        """Seed documents map from workspace text files; migrate legacy content key."""
        from pycrdt import Map, Text

        docs = self.doc.get("documents", type=Map)
        self._migrate_legacy_content(docs)

        seeded = False
        for rel in project_service.list_collaborative_text_paths(self.project_id):
            existing = docs.get(rel)
            if existing is not None and str(existing):
                continue
            body = project_service.read_workspace_text(self.project_id, rel)
            if body is None:
                continue
            if existing is None:
                ytext = Text()
                docs[rel] = ytext
            else:
                ytext = existing
            if body and not str(ytext):
                ytext.insert(0, body)
                seeded = True
            elif existing is None:
                seeded = True
        if seeded or list(docs.keys()):
            self.crdt_generation = max(self.crdt_generation, 1)
            if seeded:
                self._persist()

    def _migrate_legacy_content(self, docs: object) -> None:
        """Move single-file PoC Y.Text('content') into documents[slide_path]."""
        from pycrdt import Map, Text

        assert isinstance(docs, Map)
        if list(docs.keys()):
            return
        legacy = self.doc.get("content", type=Text)
        body = str(legacy)
        if not body:
            return
        slide = project_service.collaborative_slide_path(self.project_id) or "slide.md"
        ytext = Text()
        docs[slide] = ytext
        ytext.insert(0, body)
        self.crdt_generation = max(self.crdt_generation, 1)
        self._persist()

    def _persist(self) -> None:
        """Atomic merged-state blob (encodeStateAsUpdate / get_update); no update log (#6)."""
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

    def collaborative_text(self, path: str | None = None) -> str | None:
        """Y.Text for path (default: primary slide); None if CRDT not seeded / missing."""
        from pycrdt import Map, Text

        if self.crdt_generation <= 0:
            return None
        docs = self.doc.get("documents", type=Map)
        if path is None:
            path = project_service.collaborative_slide_path(self.project_id)
            if path is None:
                # Legacy single-file blob
                legacy = self.doc.get("content", type=Text)
                body = str(legacy)
                return body if body else None
        got = docs.get(path)
        if got is None:
            return None
        return str(got)

    def collaborative_texts(self) -> dict[str, str]:
        """All path → text currently in the documents map."""
        from pycrdt import Map

        if self.crdt_generation <= 0:
            return {}
        docs = self.doc.get("documents", type=Map)
        out: dict[str, str] = {}
        for key in docs.keys():
            if isinstance(key, str):
                out[key] = str(docs[key])
        return out

    def apply_fs_to_documents(self, operation: dict) -> bytes | None:
        """Keep documents map aligned with topology create/delete/rename; return yjs update."""
        from pycrdt import Map, Text

        from vscode_revealjs_server.projects.service import is_collaborative_text_rel

        kind = operation.get("kind")
        before = self.doc.get_state()
        docs = self.doc.get("documents", type=Map)
        changed = False

        if kind == "create":
            path = operation.get("path")
            if isinstance(path, str) and is_collaborative_text_rel(path):
                content = operation.get("content") or ""
                if not isinstance(content, str):
                    content = ""
                existing = docs.get(path)
                if existing is None:
                    ytext = Text()
                    docs[path] = ytext
                    if content:
                        ytext.insert(0, content)
                    changed = True

        elif kind == "delete":
            path = operation.get("path")
            if isinstance(path, str):
                for key in list(docs.keys()):
                    if key == path or key.startswith(path + "/"):
                        del docs[key]
                        changed = True
        elif kind in ("rename", "move"):
            frm = operation.get("from")
            to = operation.get("to")
            if isinstance(frm, str) and isinstance(to, str):
                keys = list(docs.keys())
                # File rename
                if frm in keys:
                    body = str(docs[frm])
                    del docs[frm]
                    if is_collaborative_text_rel(to):
                        ytext = Text()
                        docs[to] = ytext
                        if body:
                            ytext.insert(0, body)
                    changed = True
                else:
                    # Chapter directory rename: move prefixed keys
                    prefix = frm + "/"
                    for key in keys:
                        if isinstance(key, str) and key.startswith(prefix):
                            suffix = key[len(prefix) :]
                            new_key = f"{to}/{suffix}"
                            body = str(docs[key])
                            del docs[key]
                            if is_collaborative_text_rel(new_key):
                                ytext = Text()
                                docs[new_key] = ytext
                                if body:
                                    ytext.insert(0, body)
                            changed = True

        if not changed:
            return None
        self.crdt_generation += 1
        self._persist()
        return self.doc.get_update(before)

    async def join(self, ws: WebSocket, client_id: str = "") -> None:
        self.clients.add(ws)
        if client_id:
            self.client_ids[ws] = client_id

    async def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)
        self.client_ids.pop(ws, None)

    async def apply_and_broadcast(self, update: bytes, sender: WebSocket) -> None:
        with project_service._mut:
            self.doc.apply_update(update)
            self.crdt_generation += 1
            self._persist()
        await self.broadcast_bytes(update, exclude=sender)

    async def broadcast_bytes(self, data: bytes, *, exclude: WebSocket | None = None) -> None:
        dead: list[WebSocket] = []
        for client in tuple(self.clients):
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
        for client in tuple(self.clients):
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
        project_service.collaborative_state = self.collaborative_state

    def room(self, project_id: str) -> CollaborationRoom:
        with project_service._mut:
            if project_id not in self._rooms:
                self._rooms[project_id] = CollaborationRoom(project_id)
            return self._rooms[project_id]

    def collaborative_state(self, project_id: str) -> tuple[dict[str, str], bytes | None]:
        with project_service._mut:
            room = self.room(project_id)
            return room.collaborative_texts(), room.snapshot()

    async def apply_operations(self, project_id: str, operations: list[dict], base: int) -> dict:
        """Commit a prefix in order. Return receipts plus the first failure; never hide partial success."""
        async with self._fs_lock:
            room = self.room(project_id)
            result: dict = {"results": [], "structure_revision": project_service.structure_revision(project_id)}
            updates: list[bytes] = []
            with project_service._mut:
                for index, operation in enumerate(operations):
                    before = project_service.structure_revision(project_id)
                    try:
                        revision, normalized = project_service.apply_fs_operation(
                            project_id, operation, base_revision=base,
                        )
                    except (FsRejected, OSError) as exc:
                        result["failed"] = {"index": index, "message": str(exc)}
                        break
                    result["results"].append({"structure_revision": revision, "operation": normalized})
                    # Replayed HTTP receipts must not reapply a rename/delete to the Y.Doc.
                    if project_service.structure_revision(project_id) != before:
                        update = room.apply_fs_to_documents(normalized)
                        if update is not None:
                            updates.append(update)
                    base = project_service.structure_revision(project_id) or 0
                result["structure_revision"] = project_service.structure_revision(project_id)
            for update in updates:
                await room.broadcast_bytes(update)
            if result["results"]:
                await room.broadcast_text(proto.encode({
                    "type": "workspace.operations", **result,
                }))
            return result

    async def handle(
        self,
        ws: WebSocket,
        project_id: str,
        *,
        user_id: str = "",
        can_write: bool = True,
    ) -> None:
        _ = user_id  # reserved for presence / actor_id
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

        if msg.get("protocol_version") != proto.PROTOCOL_VERSION:
            await ws.send_text(proto.encode(proto.error("protocol_version", "upgrade to protocol v2")))
            await ws.close(code=4400)
            return
        last_known = msg.get("last_known_structure_revision")
        last_known_rev: int | None = None
        if isinstance(last_known, int) and not isinstance(last_known, bool):
            last_known_rev = last_known
        elif last_known is not None:
            await ws.send_text(
                proto.encode(proto.error("bad_hello", "last_known_structure_revision must be int"))
            )
            await ws.close()
            return

        with project_service._mut:
            server_rev = project_service.structure_revision(project_id) or 0
            snap = room.snapshot()
        await ws.send_text(
            proto.encode(proto.ready(structure_revision=server_rev, has_snapshot=snap is not None, can_write=can_write))
        )
        if snap is not None:
            await ws.send_bytes(snap)

        await room.join(ws, client_id)
        # The ready frame never advances the client's last-applied structure cursor.
        server_rev = project_service.structure_revision(project_id) or 0
        # Revision gap requires a safe snapshot merge, preserving local pending intent.
        if last_known_rev is not None and server_rev - last_known_rev >= REVISION_GAP_THRESHOLD:
            await ws.send_text(
                proto.encode(
                    proto.reconcile_required(
                        structure_revision=server_rev,
                        reason="revision_gap",
                    )
                )
            )

        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if "bytes" in message and message["bytes"] is not None:
                    if not can_write:
                        await ws.send_text(
                            proto.encode(proto.error("forbidden", "write permission required"))
                        )
                        continue
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
                    await ws.send_text(proto.encode({**proto.pong(), "id": control.get("id")}))
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
        """Notify every client, including the writer, without a second revision message."""
        room = self.room(project_id)
        await room.broadcast_text(proto.encode({
            "type": "asset.changed", "path": path, "revision": revision,
            "structure_revision": revision, "content_hash": content_hash, "size": size,
        }))



manager = CollaborationManager()
