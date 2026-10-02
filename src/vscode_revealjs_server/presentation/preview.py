"""Preview Resolver: collaborative state → static Reveal HTML / path bytes (§19).

Does not read any client local filesystem. Text prefers live CRDT; other
text/assets come from server collaborative workspace. index.html is served
as-is (static site); chapter markdown still gets relative-asset rewrite.
"""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath

from vscode_revealjs_server.presentation.render import rewrite_chapter_relative_urls
from vscode_revealjs_server.projects.service import FsRejected, project_service


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
    """Resolve preview/{rel} from CRDT documents map or collaborative workspace/assets."""
    if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")):
        raise FsRejected(f"invalid preview path: {rel!r}")

    if project_service.get(project_id) is None:
        return None

    chapter = _chapter_of(rel)

    def maybe_rewrite_md(text: str) -> bytes:
        if rel.endswith(".md"):
            text = rewrite_chapter_relative_urls(
                text, project_id=project_id, chapter=chapter
            )
        return text.encode("utf-8")

    payload = project_service.workspace_file(project_id, rel)
    if payload is None:
        return None
    if rel.endswith(".md"):
        return PreviewBytes(maybe_rewrite_md(payload.decode("utf-8")), "text/markdown; charset=utf-8")
    return PreviewBytes(payload, _guess_media(rel))

