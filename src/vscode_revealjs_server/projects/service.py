"""Filesystem-backed project create/list/get + workspace snapshot + fs ops + assets.

ponytail: local dir store (no Postgres). Ceiling: single-node, no members/auth.
Upgrade: §18.1 project tables + membership (M3).
"""

from __future__ import annotations

import hashlib
import threading
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
_BINARY_EXT = frozenset({
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
})


def is_binary_rel(rel: str) -> bool:
    return Path(rel).suffix.lower() in _BINARY_EXT


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



def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Temp + replace in same directory (H6)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    _atomic_write_bytes(path, text.encode(encoding))


class ProjectService:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _PROJECTS_DIR
        # ponytail: process-local mutation lock for fs/asset/snapshot consistency (B4).
        # Ceiling: multi-replica. Upgrade: DB transaction / distributed lock (M3).
        self._mut = threading.RLock()

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
        _atomic_write_text(
            self._meta_path(pid),
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
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
            _atomic_write_text(dest, content)
        meta = {
            "id": project_id,
            "name": name,
            "created_at": _now(),
            "revision": 0,
        }
        self._write_meta(meta)
        return self._public(meta)

    def collaborative_slide_text(self, project_id: str) -> str | None:
        """Prefer nested chapter slide.md, else root — for empty-room CRDT seed."""
        ws = self._workspace(project_id)
        if not ws.is_dir():
            return None
        nested = sorted(ws.glob(f"*/slide.md"))
        if nested:
            return nested[0].read_text(encoding="utf-8")
        root = ws / "slide.md"
        if root.is_file():
            return root.read_text(encoding="utf-8")
        hits = sorted(ws.rglob("slide.md"))
        return hits[0].read_text(encoding="utf-8") if hits else None

    def _build_snapshot_unlocked(self, project_id: str, meta: dict[str, Any]) -> dict[str, Any]:
        """Build manifest; caller holds _mut."""
        ws = self._workspace(project_id)
        files: list[dict[str, str]] = []
        directories: list[str] = []
        assets: list[dict[str, object]] = []
        hash_parts: list[str] = []
        if ws.is_dir():
            for path in sorted(ws.rglob("*")):
                rel = path.relative_to(ws).as_posix()
                if path.is_dir():
                    directories.append(rel)
                    hash_parts.append(f"d:{rel}")
                    continue
                if not _SAFE_REL.match(rel):
                    continue
                if is_binary_rel(rel):
                    raw = path.read_bytes()
                    digest = hashlib.sha256(raw).hexdigest()
                    assets.append(
                        {
                            "path": rel,
                            "content_hash": digest,
                            "size": len(raw),
                        }
                    )
                    hash_parts.append(f"a:{rel}:{digest}")
                    continue
                content = path.read_text(encoding="utf-8")
                digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
                files.append({"path": rel, "content": content})
                hash_parts.append(f"f:{rel}:{digest}")
        content_hash = hashlib.sha256("\n".join(hash_parts).encode("utf-8")).hexdigest()
        return {
            "project_id": project_id,
            "name": meta["name"],
            "revision": int(meta.get("revision", 0)),
            "content_hash": content_hash,
            "directories": directories,
            "files": files,
            "assets": assets,
        }

    def snapshot(self, project_id: str) -> dict[str, Any] | None:
        """Consistent workspace view @ current revision (JSON manifest).

        Holds mutation lock; retries if revision moves mid-build (B4).
        ponytail: text inline; binaries as path/hash/size refs (GET separately). Ceiling:
        large assets / #10 archive format. Upgrade: tar/zip bundle (M3 publish).
        """
        # ponytail: up to 3 rebuilds under lock if concurrent bump races the unlocked
        # re-check — lock held for whole build so mismatch should be rare.
        for _ in range(3):
            with self._mut:
                meta = self._read_meta(project_id)
                if meta is None:
                    return None
                rev_before = int(meta.get("revision", 0))
                snap = self._build_snapshot_unlocked(project_id, meta)
                meta_after = self._read_meta(project_id)
                if meta_after is None:
                    return None
                rev_after = int(meta_after.get("revision", 0))
                if rev_after == rev_before and snap["revision"] == rev_before:
                    return snap
                # Rare: another thread wrote without lock — rebuild.
        with self._mut:
            meta = self._read_meta(project_id)
            if meta is None:
                return None
            return self._build_snapshot_unlocked(project_id, meta)

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

        ponytail: process-local apply + _mut (B4). Ceiling: multi-replica.
        Upgrade: DB row lock / single writer (M3).
        """
        with self._mut:
            return self._apply_fs_operation_unlocked(
                project_id, operation, base_revision=base_revision
            )

    def _apply_fs_operation_unlocked(
        self,
        project_id: str,
        operation: dict[str, Any],
        *,
        base_revision: int | None = None,
    ) -> tuple[int, dict[str, Any]]:
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
            _atomic_write_text(dest, content)
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

    def put_asset(
        self,
        project_id: str,
        rel: str,
        data: bytes,
    ) -> tuple[int, dict[str, Any]]:
        """Store binary at workspace-relative path; bump revision (last-write-wins).

        ponytail: bytes live under workspace/ + _mut (B4). Ceiling: dedup / CDN.
        Upgrade: §18.2 assets/{hash} (M3).
        """
        with self._mut:
            return self._put_asset_unlocked(project_id, rel, data)

    def _put_asset_unlocked(
        self,
        project_id: str,
        rel: str,
        data: bytes,
    ) -> tuple[int, dict[str, Any]]:
        meta = self._read_meta(project_id)
        if meta is None:
            raise FsRejected("project not found")
        if not isinstance(rel, str) or not _SAFE_REL.match(rel):
            raise FsRejected(f"invalid asset path: {rel!r}")
        if not is_binary_rel(rel):
            raise FsRejected(f"not a binary asset extension: {rel!r}")
        if not isinstance(data, (bytes, bytearray)):
            raise FsRejected("asset body must be bytes")

        ws = self._workspace(project_id)
        ws.mkdir(parents=True, exist_ok=True)
        ws_resolved = ws.resolve()
        dest = self._resolve_rel(project_id, rel)
        parent = dest.parent
        if parent != ws_resolved:
            if not _SAFE_DIR.match(parent.name) or parent.parent.resolve() != ws_resolved:
                raise FsRejected(f"invalid parent for asset: {rel}")
            parent.mkdir(parents=False, exist_ok=True)

        payload = bytes(data)
        _atomic_write_bytes(dest, payload)
        digest = hashlib.sha256(payload).hexdigest()
        rev = self._bump_revision(meta)
        return rev, {
            "path": rel,
            "content_hash": digest,
            "size": len(payload),
        }

    def get_asset(self, project_id: str, rel: str) -> tuple[bytes, dict[str, Any]] | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        if not isinstance(rel, str) or not _SAFE_REL.match(rel):
            raise FsRejected(f"invalid asset path: {rel!r}")
        if not is_binary_rel(rel):
            raise FsRejected(f"not a binary asset extension: {rel!r}")
        dest = self._resolve_rel(project_id, rel)
        if not dest.is_file():
            return None
        payload = dest.read_bytes()
        return payload, {
            "path": rel,
            "content_hash": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
        }

    @staticmethod
    def _public(meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": meta["id"],
            "name": meta["name"],
            "created_at": meta["created_at"],
            "revision": meta.get("revision", 0),
        }


project_service = ProjectService()
