"""Filesystem-backed project create/list/get + workspace snapshot + fs ops.

ponytail: local dir store (no Postgres). Ceiling: single-node, no members/auth.
Upgrade: §18.1 project tables + membership (M3).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Sibling of collaboration blobs under .data/
_PROJECTS_DIR = Path(
    os.environ.get(
        "PROJECTS_DATA_DIR",
        str(Path(os.environ.get("COLLAB_DATA_DIR", str(Path.cwd() / ".data" / "collaboration"))).parent / "projects"),
    )
)

_SAFE_NAME = re.compile(r"^[\w\s.\-]{1,120}$")
# §3.1 two-level layout: root file or chapter/file
_SAFE_REL = re.compile(r"^(?:[\w.\-]+|[\w.\-]+/[\w.\-]+)$")
_SAFE_DIR = re.compile(r"^[\w.\-]+$")
_FS_KINDS = frozenset({"create", "delete", "rename", "move", "mkdir"})


class FsRejected(ValueError):
    """Path / op validation failure for fs.operation."""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _default_template(title: str) -> dict[str, str]:
    """Relative path → utf-8 text content."""
    deck = (
        f"title: {title}\n"
        "runtime: reveal-v1\n"
        "\n"
        "chapters:\n"
        "  - 01-introduction\n"
        "\n"
        "reveal:\n"
        "  transition: slide\n"
        "  controls: true\n"
        "  progress: true\n"
    )
    index = (
        "<!DOCTYPE html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        f"  <meta charset=\"utf-8\" />\n"
        f"  <title>{title}</title>\n"
        "  <!-- Preview/Publish fill reveal.js runtime later (M2). -->\n"
        "</head>\n"
        "<body>\n"
        "  <div class=\"reveal\"><div class=\"slides\"><!-- chapters --></div></div>\n"
        "</body>\n"
        "</html>\n"
    )
    slide = f"# {title}\n\nFirst slide.\n"
    return {
        "deck.yaml": deck,
        "index.html": index,
        "01-introduction/slide.md": slide,
    }


def _is_under(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class ProjectService:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _PROJECTS_DIR

    def _project_dir(self, project_id: str) -> Path:
        return self.root / project_id

    def _meta_path(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "meta.json"

    def _workspace(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "workspace"

    def _read_meta(self, project_id: str) -> dict[str, Any] | None:
        path = self._meta_path(project_id)
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_meta(self, meta: dict[str, Any]) -> None:
        pid = meta["id"]
        self._project_dir(pid).mkdir(parents=True, exist_ok=True)
        self._meta_path(pid).write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def revision(self, project_id: str) -> int | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        return int(meta.get("revision", 0))

    def list_projects(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if meta:
                out.append(self._public(meta))
        return out

    def get(self, project_id: str) -> dict[str, Any] | None:
        meta = self._read_meta(project_id)
        return self._public(meta) if meta else None

    def create(self, *, name: str) -> dict[str, Any]:
        name = name.strip()
        if not name or not _SAFE_NAME.match(name):
            raise ValueError("invalid project name")
        project_id = f"prj_{uuid.uuid4().hex[:12]}"
        ws = self._workspace(project_id)
        ws.mkdir(parents=True, exist_ok=True)
        for rel, content in _default_template(name).items():
            if not _SAFE_REL.match(rel):
                raise RuntimeError(f"template path rejected: {rel}")
            dest = ws / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
        meta = {
            "id": project_id,
            "name": name,
            "created_at": _now(),
            "revision": 0,
        }
        self._write_meta(meta)
        return self._public(meta)

    def snapshot(self, project_id: str) -> dict[str, Any] | None:
        """Consistent workspace view @ current revision (JSON manifest).

        ponytail: JSON text files only (no tar/zip, no binary bodies). Ceiling: large
        assets / #10 archive format. Upgrade: archive + asset refs (M1 assets / M3 publish).
        """
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        ws = self._workspace(project_id)
        files: list[dict[str, str]] = []
        directories: list[str] = []
        if ws.is_dir():
            for path in sorted(ws.rglob("*")):
                rel = path.relative_to(ws).as_posix()
                if path.is_dir():
                    directories.append(rel)
                    continue
                if not _SAFE_REL.match(rel):
                    continue
                # Text only for this slice; skip obvious binaries by extension.
                if path.suffix.lower() in {
                    ".png",
                    ".jpg",
                    ".jpeg",
                    ".gif",
                    ".webp",
                    ".svg",
                    ".mp4",
                    ".webm",
                    ".pdf",
                    ".woff",
                    ".woff2",
                }:
                    continue
                files.append(
                    {
                        "path": rel,
                        "content": path.read_text(encoding="utf-8"),
                    }
                )
        return {
            "project_id": project_id,
            "name": meta["name"],
            "revision": meta.get("revision", 0),
            "directories": directories,
            "files": files,
            "assets": [],
        }

    def _resolve_rel(self, project_id: str, rel: str) -> Path:
        ws = self._workspace(project_id)
        if ".." in rel.split("/") or rel.startswith("/") or rel.startswith("\\"):
            raise FsRejected(f"path escapes workspace: {rel}")
        dest = (ws / rel).resolve()
        if not _is_under(ws, dest) and dest != ws.resolve():
            raise FsRejected(f"path escapes workspace: {rel}")
        return dest

    def _bump_revision(self, meta: dict[str, Any]) -> int:
        meta["revision"] = int(meta.get("revision", 0)) + 1
        self._write_meta(meta)
        return int(meta["revision"])

    def apply_fs_operation(
        self,
        project_id: str,
        operation: dict[str, Any],
        *,
        base_revision: int | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """Authoritative fs op under project workspace; bump revision.

        ponytail: process-local apply (no multi-writer lock across instances). Ceiling:
        concurrent writers on multi-replica. Upgrade: DB row lock / single writer (M3).
        """
        meta = self._read_meta(project_id)
        if meta is None:
            raise FsRejected("project not found")
        current = int(meta.get("revision", 0))
        if base_revision is not None and int(base_revision) != current:
            raise FsRejected(f"stale base_revision {base_revision}, current {current}")

        if not isinstance(operation, dict):
            raise FsRejected("operation must be an object")
        kind = operation.get("kind")
        if kind not in _FS_KINDS:
            raise FsRejected(f"unsupported kind: {kind}")

        ws = self._workspace(project_id)
        ws.mkdir(parents=True, exist_ok=True)
        ws_resolved = ws.resolve()
        normalized: dict[str, Any] = {"kind": kind}

        if kind == "mkdir":
            rel = operation.get("path")
            if not isinstance(rel, str) or not _SAFE_DIR.match(rel):
                raise FsRejected(f"invalid mkdir path: {rel!r}")
            dest = self._resolve_rel(project_id, rel)
            if dest.exists():
                raise FsRejected(f"already exists: {rel}")
            dest.mkdir(parents=False, exist_ok=False)
            normalized["path"] = rel

        elif kind == "create":
            rel = operation.get("path")
            if not isinstance(rel, str) or not _SAFE_REL.match(rel):
                raise FsRejected(f"invalid create path: {rel!r}")
            dest = self._resolve_rel(project_id, rel)
            if dest.exists():
                raise FsRejected(f"already exists: {rel}")
            parent = dest.parent
            if parent != ws_resolved:
                if not _SAFE_DIR.match(parent.name) or parent.parent.resolve() != ws_resolved:
                    raise FsRejected(f"invalid parent for create: {rel}")
                parent.mkdir(parents=False, exist_ok=True)
            content = operation.get("content", "")
            if content is None:
                content = ""
            if not isinstance(content, str):
                raise FsRejected("create content must be a string")
            # ponytail: text create only; binary goes Asset Service (Slice 3).
            dest.write_text(content, encoding="utf-8")
            normalized["path"] = rel
            normalized["content"] = content

        elif kind == "delete":
            rel = operation.get("path")
            if not isinstance(rel, str):
                raise FsRejected("delete path required")
            if _SAFE_REL.match(rel):
                dest = self._resolve_rel(project_id, rel)
                if not dest.is_file():
                    raise FsRejected(f"not a file: {rel}")
                dest.unlink()
            elif _SAFE_DIR.match(rel):
                dest = self._resolve_rel(project_id, rel)
                if not dest.is_dir():
                    raise FsRejected(f"not a directory: {rel}")
                shutil.rmtree(dest)
            else:
                raise FsRejected(f"invalid delete path: {rel!r}")
            normalized["path"] = rel

        elif kind in ("rename", "move"):
            src_rel = operation.get("from")
            dst_rel = operation.get("to")
            if not isinstance(src_rel, str) or not isinstance(dst_rel, str):
                raise FsRejected("rename/move requires from and to")
            src_ok = bool(_SAFE_REL.match(src_rel) or _SAFE_DIR.match(src_rel))
            dst_ok = bool(_SAFE_REL.match(dst_rel) or _SAFE_DIR.match(dst_rel))
            if not src_ok or not dst_ok:
                raise FsRejected(f"invalid rename/move paths: {src_rel!r} → {dst_rel!r}")
            src = self._resolve_rel(project_id, src_rel)
            dst = self._resolve_rel(project_id, dst_rel)
            if not src.exists():
                raise FsRejected(f"source missing: {src_rel}")
            if dst.exists():
                raise FsRejected(f"target exists: {dst_rel}")
            if dst.parent != ws_resolved and not dst.parent.exists():
                if _SAFE_DIR.match(dst.parent.name) and dst.parent.parent.resolve() == ws_resolved:
                    dst.parent.mkdir(parents=False, exist_ok=True)
                else:
                    raise FsRejected(f"invalid target parent: {dst_rel}")
            src.rename(dst)
            normalized["from"] = src_rel
            normalized["to"] = dst_rel

        else:
            raise FsRejected(f"unsupported kind: {kind}")

        rev = self._bump_revision(meta)
        return rev, normalized

    @staticmethod
    def _public(meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": meta["id"],
            "name": meta["name"],
            "created_at": meta["created_at"],
            "revision": meta.get("revision", 0),
        }


project_service = ProjectService()
