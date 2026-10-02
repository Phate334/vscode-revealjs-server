"""Publish an immutable self-contained release from collaborative state.

Projects are static sites: freeze collaborative text (including index.html),
copy binary assets and project-local runtime/ into the release directory.

Storage (Phase 1; supersedes decision #10):
- Full tree copy into releases/{id}/ (text + binaries + runtime/).
- No shared /runtimes HTTP registry, no content-addressed blobs/, no assets.json.
"""

from __future__ import annotations

import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Any

from vscode_revealjs_server.presentation.render import rewrite_chapter_relative_urls
from vscode_revealjs_server.projects.service import (
    FsRejected,
    _now,
    project_service,
)


def _chapter_of(rel: str) -> str:
    parent = Path(rel).parent.as_posix()
    return "" if parent == "." else parent


def publish(project_id: str) -> dict[str, Any]:
    """Snapshot collaborative state into a self-contained release dir; update slug."""
    cap = project_service.capture_workspace(project_id)
    if cap is None:
        raise FsRejected("project not found")

    release_id = f"rel_{uuid.uuid4().hex[:12]}"
    final, staging = project_service.release_staging_paths(project_id, release_id)
    if final.exists():
        raise FsRejected("release id collision")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=False)

    asset_base = f"/releases/{release_id}"
    try:
        for rel in cap["directories"]:
            (staging / rel).mkdir(parents=True, exist_ok=True)
        for row in cap["files"]:
            rel = row["path"]
            content = row["content"]
            if rel.endswith(".md"):
                content = rewrite_chapter_relative_urls(
                    content,
                    project_id=project_id,
                    chapter=_chapter_of(rel),
                    url_prefix=asset_base,
                )
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
        for row in cap["assets"]:
            dest = staging / row["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(row["data"])
        staging.rename(final)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise

    record = {
        "id": release_id,
        "created_at": _now(),
        "structure_revision": int(cap["structure_revision"]),
        "content_hash": cap["content_hash"],
    }
    try:
        return project_service.commit_release(project_id, record)
    except Exception:
        shutil.rmtree(final, ignore_errors=True)
        raise


def read_published(root: Path, rel: str) -> tuple[bytes, str] | None:
    """Read one file inside a self-contained release directory."""
    rel = (rel or "").strip().lstrip("/")
    if rel in ("", "."):
        rel = "index.html"
    if ".." in rel.split("/") or rel.startswith(("\\",)):
        raise FsRejected(f"invalid release path: {rel!r}")
    root_r = root.resolve()
    dest = (root_r / rel).resolve()
    try:
        dest.relative_to(root_r)
    except ValueError as e:
        raise FsRejected(f"invalid release path: {rel!r}") from e

    if not dest.is_file():
        return None
    media, _enc = mimetypes.guess_type(str(dest))
    if dest.suffix == ".html":
        media = "text/html; charset=utf-8"
    elif dest.suffix == ".md":
        media = "text/markdown; charset=utf-8"
    elif dest.suffix in (".css",):
        media = "text/css; charset=utf-8"
    elif dest.suffix == ".js":
        media = "text/javascript; charset=utf-8"
    return dest.read_bytes(), media or "application/octet-stream"
