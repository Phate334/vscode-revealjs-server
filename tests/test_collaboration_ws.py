"""Two clients join; one sends a CRDT update; the other receives it."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from pycrdt import Doc, Text

from vscode_revealjs_server.app import app
from vscode_revealjs_server.collaboration import protocol as proto
from vscode_revealjs_server.collaboration.manager import CollaborationManager


def _hello(client_id: str) -> str:
    return json.dumps(
        {
            "type": proto.HELLO,
            "client_id": client_id,
            "protocol_version": proto.PROTOCOL_VERSION,
        }
    )


def test_two_clients_broadcast_update(tmp_path, monkeypatch):
    # Isolate persistence away from shared .data/
    monkeypatch.setattr(
        "vscode_revealjs_server.collaboration.manager._DATA_DIR",
        tmp_path / "collaboration",
    )
    # Fresh manager so rooms don't leak across tests / prior runs
    fresh = CollaborationManager()
    monkeypatch.setattr("vscode_revealjs_server.app.manager", fresh)
    monkeypatch.setattr("vscode_revealjs_server.collaboration.manager.manager", fresh)

    project_id = "poc-slide"
    with TestClient(app) as client:
        with (
            client.websocket_connect(f"/api/projects/{project_id}/collaboration") as alice,
            client.websocket_connect(f"/api/projects/{project_id}/collaboration") as bob,
        ):
            alice.send_text(_hello("alice"))
            bob.send_text(_hello("bob"))

            ready_a = json.loads(alice.receive_text())
            ready_b = json.loads(bob.receive_text())
            assert ready_a["type"] == proto.READY
            assert ready_b["type"] == proto.READY

            doc = Doc()
            text = doc.get("content", type=Text)
            with doc.transaction():
                text += "# Hello from Alice\n"
            update = doc.get_update()

            alice.send_bytes(update)
            received = bob.receive_bytes()
            assert received == update

            bob_doc = Doc()
            bob_doc.apply_update(received)
            assert str(bob_doc.get("content", type=Text)) == "# Hello from Alice\n"
