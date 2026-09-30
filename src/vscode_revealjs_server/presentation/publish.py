"""Publish an immutable release from server collaborative state (§21–22).

Reuses presentation.render and the runtime registry. Does not read a client disk.

Storage (#10):
- Runtime shared by version at /runtimes/{name}/ (not copied into each release).
- Assets content-addressed under shared blobs/sha256-...; release keeps path→hash map.
- Release dir holds text snapshot + assets.json + runtime pin — no tar/zip, no ~3MB runtime copy.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Any

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation.render import (
    fallback_chapters_for,
    parse_deck,
    render_presentation_html,
    rewrite_chapter_relative_urls,
)
from vscode_revealjs_server.presentation.runtime import runtime_dir
from vscode_revealjs_server.projects.service import (
    FsRejected,
    _now,
    is_binary_rel,
    project_service,
)

_ASSETS_MANIFEST = "assets.json"


def _chapter_of(rel: str) -> str:
    parent = Path(rel).parent.as_posix()
    return "" if parent == "." else parent


def _content_hash(files: list[dict[str, str]], assets: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for f in sorted(files, key=lambda row: row["path"]):
        digest = hashlib.sha256(f["content"].encode("utf-8")).hexdigest()
        parts.append(f"f:{f['path']}:{digest}")
    for a in sorted(assets, key=lambda row: row["path"]):
        digest = hashlib.sha256(a["data"]).hexdigest()
        parts.append(f"a:{a['path']}:{digest}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def _overlay_crdt(project_id: str, cap: dict[str, Any]) -> None:
    """Prefer live multi-doc CRDT text over workspace disk for matching paths."""
    texts = manager.collaborative_texts(project_id)
    if not texts:
        return
    by_path = {row["path"]: row for row in cap["files"]}
    for rel, body in texts.items():
        if is_binary_rel(rel):
            continue
        if rel in by_path:
            by_path[rel]["content"] = body
        else:
            row = {"path": rel, "content": body}
            cap["files"].append(row)
            by_path[rel] = row


def publish(project_id: str) -> dict[str, Any]:
    """Snapshot collaborative state, write a new release dir, point the slug at it.

    Decision #10: pin runtime version; store asset blobs by hash; text inline in release.
    """
    cap = project_service.capture_workspace(project_id)
    if cap is None:
        raise FsRejected("project not found")
    _overlay_crdt(project_id, cap)

    deck = next((f["content"] for f in cap["files"] if f["path"] == "deck.yaml"), "")
    index_html = next((f["content"] for f in cap["files"] if f["path"] == "index.html"), None)
    _title, runtime_name, _chapters = parse_deck(deck)
    rt_src = runtime_dir(runtime_name)
    if rt_src is None:
        raise FsRejected(f"runtime not registered: {runtime_name}")

    release_id = f"rel_{uuid.uuid4().hex[:12]}"
    final, staging = project_service.release_staging_paths(project_id, release_id)
    if final.exists():
        raise FsRejected("release id collision")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=False)

    asset_base = f"/release/{release_id}"
    # Shared runtime URL — same registry Preview uses (#10).
    runtime_base = f"/runtimes/{runtime_name}"
    asset_map: dict[str, str] = {}
    try:
        for row in cap["files"]:
            rel = row["path"]
            if rel == "index.html" or rel == _ASSETS_MANIFEST:
                continue
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
            digest = project_service.store_blob(row["data"])
            asset_map[row["path"]] = digest
        (staging / _ASSETS_MANIFEST).write_text(
            json.dumps(
                {"runtime": runtime_name, "assets": asset_map},
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        html = render_presentation_html(
            project_id=project_id,
            index_html=index_html,
            deck_yaml=deck,
            fallback_chapters=fallback_chapters_for(deck, cap.get("slide_path")),
            asset_base=asset_base,
            runtime_base=runtime_base,
        )
        (staging / "index.html").write_text(html, encoding="utf-8")
        staging.rename(final)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise

    record = {
        "id": release_id,
        "created_at": _now(),
        "revision": int(cap["revision"]),
        "content_hash": _content_hash(cap["files"], cap["assets"]),
        "runtime": runtime_name,
        "assets": asset_map,
    }
    try:
        return project_service.commit_release(project_id, record)
    except Exception:
        shutil.rmtree(final, ignore_errors=True)
        raise


def _load_asset_map(root: Path) -> dict[str, str]:
    manifest = root / _ASSETS_MANIFEST
    if not manifest.is_file():
        return {}
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    assets = data.get("assets") if isinstance(data, dict) else None
    if not isinstance(assets, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in assets.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def read_published(root: Path, rel: str) -> tuple[bytes, str] | None:
    """Read one file inside a release directory (text) or via content-addressed blob."""
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

    if dest.is_file():
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

    # Content-addressed asset (#10): path → sha256 in assets.json → shared blob store.
    digest = _load_asset_map(root_r).get(rel)
    if digest:
        blob = project_service.read_blob(digest)
        if blob is not None:
            media, _enc = mimetypes.guess_type(rel)
            return blob, media or "application/octet-stream"
    return None
