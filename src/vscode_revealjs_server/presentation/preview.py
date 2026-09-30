"""Preview Resolver: collaborative state → reveal HTML / path bytes (§19).

Does not read any client local filesystem. Text prefers live CRDT for the
bound slide; other text/assets come from server collaborative workspace.
HTML assembly lives in presentation.render (shared with future Publish).
"""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation.render import (
    fallback_chapters_for,
    render_presentation_html,
    rewrite_chapter_relative_urls,
)
from vscode_revealjs_server.projects.service import FsRejected, is_binary_rel, project_service


@dataclass(frozen=True)
class PreviewBytes:
    body: bytes
    media_type: str


def _guess_media(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    if mt:
        return mt
    if path.endswith(".md"):
        return "text/markdown; charset=utf-8"
    if path.endswith((".yaml", ".yml")):
        return "text/yaml; charset=utf-8"
    return "application/octet-stream"


def _chapter_of(rel: str) -> str:
    """Parent dir for chapter-relative rewrite; empty for root files."""
    parent = PurePosixPath(rel).parent.as_posix()
    return "" if parent == "." else parent


def resolve_path(project_id: str, rel: str) -> PreviewBytes | None:
    """Resolve preview/{rel} from CRDT (bound slide) or collaborative workspace/assets."""
    if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")):
        raise FsRejected(f"invalid preview path: {rel!r}")

    if project_service.get(project_id) is None:
        return None

    slide_rel = project_service.collaborative_slide_path(project_id)
    chapter = _chapter_of(rel)

    def maybe_rewrite_md(text: str) -> bytes:
        if rel.endswith(".md"):
            text = rewrite_chapter_relative_urls(
                text, project_id=project_id, chapter=chapter
            )
        return text.encode("utf-8")

    if slide_rel and rel == slide_rel:
        crdt = manager.collaborative_text(project_id)
        if crdt is not None:
            return PreviewBytes(maybe_rewrite_md(crdt), "text/markdown; charset=utf-8")
        disk = project_service.read_workspace_text(project_id, rel)
        if disk is None:
            return None
        return PreviewBytes(maybe_rewrite_md(disk), "text/markdown; charset=utf-8")

    if is_binary_rel(rel):
        got = project_service.get_asset(project_id, rel)
        if got is None:
            return None
        payload, _info = got
        return PreviewBytes(payload, _guess_media(rel))

    text = project_service.read_workspace_text(project_id, rel)
    if text is None:
        return None
    if rel.endswith(".md"):
        return PreviewBytes(maybe_rewrite_md(text), "text/markdown; charset=utf-8")
    return PreviewBytes(text.encode("utf-8"), _guess_media(rel))


def compose_index(project_id: str) -> PreviewBytes | None:
    """Render Preview HTML from collaborative index.html + deck (shared renderer)."""
    if project_service.get(project_id) is None:
        return None
    deck = project_service.read_workspace_text(project_id, "deck.yaml") or ""
    index_html = project_service.read_workspace_text(project_id, "index.html")
    slide = project_service.collaborative_slide_path(project_id)
    body = render_presentation_html(
        project_id=project_id,
        index_html=index_html,
        deck_yaml=deck,
        fallback_chapters=fallback_chapters_for(deck, slide),
    )
    return PreviewBytes(body.encode("utf-8"), "text/html; charset=utf-8")
