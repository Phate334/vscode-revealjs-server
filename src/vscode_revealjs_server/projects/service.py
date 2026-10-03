"""Filesystem-backed project create/list/get + workspace snapshot + fs ops + assets + members.

ponytail: local dir store (no Postgres). Ceiling: single-node members in meta.json.
Upgrade: §18.1 project tables + membership DB (post-MVP).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import threading
import json
import os
import re
import secrets
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from vscode_revealjs_server.presentation.runtime import copy_seed_into, copy_template_into

# Sibling of collaboration under .data/
_PROJECTS_DIR = Path(
    os.environ.get(
        "PROJECTS_DATA_DIR",
        str(Path(os.environ.get("COLLAB_DATA_DIR", str(Path.cwd() / ".data" / "collaboration"))).parent / "projects"),
    )
)

_SAFE_NAME = re.compile(r"^[\w\s.\-]{1,120}$")
# User content: root file or chapter/file. Vendored runtime/: nested segments allowed.
_SAFE_REL = re.compile(
    r"^(?:[\w.\-]+|[\w.\-]+/[\w.\-]+|runtime(?:/[\w.\-]+)+)$"
)
_SAFE_DIR = re.compile(r"^[\w.\-]+$")
_FS_KINDS = frozenset({"create", "delete", "rename", "move", "mkdir", "write"})
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

# MVP roles (§18.1 project_members.role)
ROLE_OWNER = "owner"
ROLE_EDITOR = "editor"

_RELEASE_ID = re.compile(r"^rel_[0-9a-f]{12}$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:48]
    if not s or not s[0].isalnum():
        return "deck"
    return s


def is_binary_rel(rel: str) -> bool:
    return Path(rel).suffix.lower() in _BINARY_EXT


# Collaborative text CRDT bindings (spec §9; YAGNI subset — not every non-binary).
_COLLAB_TEXT_EXT = frozenset({".md", ".css", ".html", ".yaml", ".yml", ".json"})
_COLLAB_IGNORE_PREFIXES = (
    ".presentation/",
    ".git/",
    "node_modules/",
    ".vscode/",
    "runtime/",
)


def is_collaborative_text_rel(rel: str) -> bool:
    """True when path should have a Y.Text in the documents map."""
    n = rel.replace("\\", "/")
    if any(n == p.rstrip("/") or n.startswith(p) for p in _COLLAB_IGNORE_PREFIXES):
        return False
    if is_binary_rel(rel):
        return False
    return Path(rel).suffix.lower() in _COLLAB_TEXT_EXT


class FsRejected(ValueError):
    """Path / op validation failure for fs.operation."""


class AssetConflict(Exception):
    """Optimistic concurrency failure on binary asset PUT (#9)."""

    def __init__(
        self,
        *,
        path: str,
        content_hash: str,
        revision: int,
        size: int,
    ) -> None:
        self.path = path
        self.content_hash = content_hash
        self.revision = revision
        self.size = size
        super().__init__(f"AssetConflict: {path} revision={revision}")

    def as_dict(self) -> dict[str, object]:
        return {
            "error": "AssetConflict",
            "path": self.path,
            "content_hash": self.content_hash,
            "revision": self.revision,
            "size": self.size,
        }


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
        # Workspace domain supplies a CRDT view while the same mutation lock is held.
        self.collaborative_state: Callable[[str], tuple[dict[str, str], bytes | None]] = (
            lambda _project_id: ({}, None)
        )

    def _project_dir(self, project_id: str) -> Path:
        if not re.fullmatch(r"prj_[0-9a-f]{12}", project_id):
            raise FsRejected("invalid project id")
        return self.root / project_id

    def _meta_path(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "meta.json"

    def _workspace(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "workspace"

    def _read_meta(self, project_id: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"prj_[0-9a-f]{12}", project_id):
            return None
        path = self._meta_path(project_id)
        if not path.is_file():
            return None
        meta = json.loads(path.read_text(encoding="utf-8"))
        if "structure_revision" not in meta:
            meta["structure_revision"] = meta.pop("revision", 0)
        return meta

    def _write_meta(self, meta: dict[str, Any]) -> None:
        pid = meta["id"]
        self._project_dir(pid).mkdir(parents=True, exist_ok=True)
        _atomic_write_text(
            self._meta_path(pid),
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
        )

    def structure_revision(self, project_id: str) -> int | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        return int(meta.get("structure_revision", 0))

    def list_projects(
        self,
        *,
        user_id: str | None = None,
        scope: str | None = None,
    ) -> list[dict[str, Any]]:
        """List projects the user owns or is a member of.

        scope: None/all, "owned" (owner_id == user), "shared" (member, not owner).
        """
        if scope not in (None, "owned", "shared"):
            raise ValueError("scope must be owned or shared")
        if not self.root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta:
                continue
            if user_id is not None and self._role_in_meta(meta, user_id) is None:
                continue
            owner = meta.get("owner_id")
            if scope == "owned" and owner != user_id:
                continue
            if scope == "shared" and (not isinstance(owner, str) or owner == user_id):
                continue
            out.append(self._public(meta, user_id=user_id))
        return out

    def get(self, project_id: str, *, user_id: str | None = None) -> dict[str, Any] | None:
        meta = self._read_meta(project_id)
        return self._public(meta, user_id=user_id) if meta else None

    def create(self, *, name: str, owner_id: str, owner_username: str) -> dict[str, Any]:
        name = name.strip()
        if not name or not _SAFE_NAME.match(name):
            raise ValueError("invalid project name")
        if not owner_id or not owner_username:
            raise ValueError("owner required")
        project_id = f"prj_{uuid.uuid4().hex[:12]}"
        ws = self._workspace(project_id)
        ws.mkdir(parents=True, exist_ok=True)
        copy_template_into(ws, title=name)
        copy_seed_into(ws)
        meta = {
            "id": project_id,
            "name": name,
            "created_at": _now(),
            "structure_revision": 0,
            "owner_id": owner_id,
            "slug": self._alloc_slug(name),
            "published_release_id": None,
            "releases": [],
            "members": [
                {
                    "user_id": owner_id,
                    "username": owner_username,
                    "role": ROLE_OWNER,
                }
            ],
        }
        self._write_meta(meta)
        return self._public(meta, user_id=owner_id)

    def collaborative_slide_path(self, project_id: str) -> str | None:
        """Workspace-relative path of the CRDT-bound slide.md (nested preferred)."""
        ws = self._workspace(project_id)
        if not ws.is_dir():
            return None
        nested = sorted(ws.glob("*/slide.md"))
        if nested:
            return nested[0].relative_to(ws).as_posix()
        root = ws / "slide.md"
        if root.is_file():
            return "slide.md"
        hits = sorted(ws.rglob("slide.md"))
        return hits[0].relative_to(ws).as_posix() if hits else None

    def collaborative_slide_text(self, project_id: str) -> str | None:
        """Prefer nested chapter slide.md, else root — for empty-room CRDT seed."""
        rel = self.collaborative_slide_path(project_id)
        if not rel:
            return None
        return self.read_workspace_text(project_id, rel)

    def list_collaborative_text_paths(self, project_id: str) -> list[str]:
        """Workspace-relative paths eligible for path→Y.Text CRDT binding."""
        ws = self._workspace(project_id)
        if not ws.is_dir():
            return []
        out: list[str] = []
        for path in sorted(ws.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(ws).as_posix()
            if not _SAFE_REL.match(rel):
                continue
            if is_collaborative_text_rel(rel):
                out.append(rel)
        return out

    def read_workspace_text(self, project_id: str, rel: str) -> str | None:
        """Read utf-8 text from server collaborative workspace disk (not client FS)."""
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        if not isinstance(rel, str) or not _SAFE_REL.match(rel):
            raise FsRejected(f"invalid path: {rel!r}")
        if is_binary_rel(rel):
            raise FsRejected(f"not a text path: {rel!r}")
        dest = self._resolve_rel(project_id, rel)
        if not dest.is_file():
            return None
        return dest.read_text(encoding="utf-8")

    def _build_snapshot_unlocked(
        self, project_id: str, meta: dict[str, Any], *, include_asset_data: bool = False,
    ) -> dict[str, Any]:
        """Materialize topology + current CRDT text + assets under one mutation lock."""
        texts, yjs_state = self.collaborative_state(project_id)
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
                    amap = meta.get("assets") if isinstance(meta.get("assets"), dict) else {}
                    arow = amap.get(rel) if isinstance(amap, dict) else None
                    arev = (
                        int(arow["revision"])
                        if isinstance(arow, dict) and "revision" in arow
                        else int(meta.get("structure_revision", 0))
                    )
                    assets.append(
                        {
                            "path": rel,
                            "content_hash": digest,
                            "size": len(raw),
                            "revision": arev,
                        }
                    )
                    if include_asset_data:
                        assets[-1]["data"] = raw
                    hash_parts.append(f"a:{rel}:{digest}")
                    continue
                content = texts.get(rel) if is_collaborative_text_rel(rel) else None
                if content is None:
                    content = path.read_text(encoding="utf-8")
                digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
                files.append({"path": rel, "content": content})
                hash_parts.append(f"f:{rel}:{digest}")
        content_hash = hashlib.sha256("\n".join(hash_parts).encode("utf-8")).hexdigest()
        return {
            "project_id": project_id,
            "name": meta["name"],
            "structure_revision": int(meta.get("structure_revision", 0)),
            "content_hash": content_hash,
            "yjs_state": base64.b64encode(yjs_state or b"\x00\x00").decode("ascii"),
            "directories": directories,
            "files": files,
            "assets": assets,
        }

    def snapshot(self, project_id: str) -> dict[str, Any] | None:
        """Consistent materialized view; asset GETs must match its content hashes."""
        with self._mut:
            meta = self._read_meta(project_id)
            return self._build_snapshot_unlocked(project_id, meta) if meta else None

    def _resolve_rel(self, project_id: str, rel: str) -> Path:
        ws = self._workspace(project_id)
        if ".." in rel.split("/") or rel.startswith("/") or rel.startswith("\\"):
            raise FsRejected(f"path escapes workspace: {rel}")
        if any(part in ("", ".", ".git", ".presentation", ".vscode", "node_modules") for part in rel.split("/")):
            raise FsRejected(f"reserved workspace path: {rel}")
        dest = (ws / rel).resolve()
        if not _is_under(ws, dest) and dest != ws.resolve():
            raise FsRejected(f"path escapes workspace: {rel}")
        return dest

    def _bump_structure_revision(self, meta: dict[str, Any]) -> int:
        meta["structure_revision"] = int(meta.get("structure_revision", 0)) + 1
        self._write_meta(meta)
        return int(meta["structure_revision"])

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
        current = int(meta.get("structure_revision", 0))
        if not isinstance(operation, dict):
            raise FsRejected("operation must be an object")
        receipt = meta.get("operation_receipts", {}).get(operation.get("id"))
        if receipt is not None:
            if receipt.get("request", receipt["operation"]) != operation:
                raise FsRejected("operation id reused with different content")
            return int(receipt["structure_revision"]), receipt["operation"]
        if base_revision is not None and int(base_revision) != current:
            raise FsRejected(f"stale base_revision {base_revision}, current {current}")

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
            if is_binary_rel(rel):
                raise FsRejected("binary files must use the asset API")
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

        elif kind == "write":
            rel = operation.get("path")
            content = operation.get("content")
            if (not isinstance(rel, str) or not _SAFE_REL.fullmatch(rel)
                    or is_binary_rel(rel) or is_collaborative_text_rel(rel)
                    or not isinstance(content, str)):
                raise FsRejected("write requires an existing non-collaborative text file")
            dest = self._resolve_rel(project_id, rel)
            if not dest.is_file():
                raise FsRejected(f"source missing: {rel}")
            _atomic_write_text(dest, content)
            normalized.update(path=rel, content=content)

        elif kind == "delete":
            rel = operation.get("path")
            if not isinstance(rel, str) or not _SAFE_REL.fullmatch(rel):
                raise FsRejected(f"invalid delete path: {rel!r}")
            dest = self._resolve_rel(project_id, rel)
            if dest.is_file():
                dest.unlink()
            elif dest.is_dir():
                shutil.rmtree(dest)
            else:
                raise FsRejected(f"source missing: {rel}")
            assets = self._asset_meta_map(meta)
            for key in [k for k in assets if k == rel or str(k).startswith(rel + "/")]:
                assets.pop(key, None)
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
            if src.is_dir() and not _SAFE_DIR.fullmatch(dst_rel):
                raise FsRejected("chapter directories must remain at workspace root")
            if dst.exists():
                raise FsRejected(f"target exists: {dst_rel}")
            if dst.parent != ws_resolved and not dst.parent.exists():
                if _SAFE_DIR.match(dst.parent.name) and dst.parent.parent.resolve() == ws_resolved:
                    dst.parent.mkdir(parents=False, exist_ok=True)
                else:
                    raise FsRejected(f"invalid target parent: {dst_rel}")
            src.rename(dst)
            assets = self._asset_meta_map(meta)
            if src_rel in assets:
                assets[dst_rel] = assets.pop(src_rel)
            else:
                prefix = src_rel + "/"
                for key in [k for k in list(assets) if str(k).startswith(prefix)]:
                    assets[dst_rel + str(key)[len(src_rel) :]] = assets.pop(key)
            normalized["from"] = src_rel
            normalized["to"] = dst_rel

        else:
            raise FsRejected(f"unsupported kind: {kind}")

        operation_id = operation.get("id")
        if isinstance(operation_id, str):
            normalized["id"] = operation_id
            # ponytail: receipts retained for this single-node workspace's lifetime.
            # Upgrade: acknowledged journal watermarks before compacting receipt history.
            meta.setdefault("operation_receipts", {})[operation_id] = {
                "operation": normalized, "request": operation, "structure_revision": current + 1,
            }
        rev = self._bump_structure_revision(meta)
        return rev, normalized

    def put_asset(
        self,
        project_id: str,
        rel: str,
        data: bytes,
        *,
        base_revision: int | None = None,
        force: bool = False,
    ) -> tuple[int, dict[str, Any]]:
        """Store binary at workspace-relative path; optimistic concurrency (#9).

        Asset metadata = path + content_hash + revision. PUT requires base_revision
        matching the stored revision when the path already exists (unless force).
        Mismatch → AssetConflict (HTTP 409). Workspace file kept for live Preview.
        """
        with self._mut:
            return self._put_asset_unlocked(
                project_id, rel, data, base_revision=base_revision, force=force
            )

    def _asset_meta_map(self, meta: dict[str, Any]) -> dict[str, Any]:
        raw = meta.get("assets")
        if not isinstance(raw, dict):
            raw = {}
            meta["assets"] = raw
        return raw

    def _existing_asset_info(
        self, project_id: str, meta: dict[str, Any], rel: str, dest: Path
    ) -> dict[str, Any] | None:
        """Return stored or synthesized asset info if the path already exists."""
        assets = self._asset_meta_map(meta)
        row = assets.get(rel)
        if isinstance(row, dict) and "content_hash" in row:
            return {
                "path": rel,
                "content_hash": str(row["content_hash"]),
                "revision": int(row.get("revision", meta.get("structure_revision", 0))),
                "size": int(row.get("size", 0)),
            }
        if dest.is_file():
            payload = dest.read_bytes()
            return {
                "path": rel,
                "content_hash": hashlib.sha256(payload).hexdigest(),
                "revision": int(meta.get("structure_revision", 0)),
                "size": len(payload),
            }
        return None

    def _put_asset_unlocked(
        self,
        project_id: str,
        rel: str,
        data: bytes,
        *,
        base_revision: int | None = None,
        force: bool = False,
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

        existing = self._existing_asset_info(project_id, meta, rel, dest)
        if existing is None and base_revision not in (None, 0) and not force:
            raise AssetConflict(path=rel, content_hash="", revision=int(meta.get("structure_revision", 0)), size=0)
        if dest.exists() and not dest.is_file():
            raise FsRejected(f"asset path is not a file: {rel}")
        if existing is not None and not force:
            current_rev = int(existing["revision"])
            if base_revision is None or int(base_revision) != current_rev:
                raise AssetConflict(
                    path=rel,
                    content_hash=str(existing["content_hash"]),
                    revision=current_rev,
                    size=int(existing["size"]),
                )

        payload = bytes(data)
        _atomic_write_bytes(dest, payload)
        digest = hashlib.sha256(payload).hexdigest()
        assets = self._asset_meta_map(meta)
        next_rev = int(meta.get("structure_revision", 0)) + 1
        assets[rel] = {
            "content_hash": digest,
            "revision": next_rev,
            "size": len(payload),
        }
        rev = self._bump_structure_revision(meta)
        return rev, {
            "path": rel,
            "content_hash": digest,
            "size": len(payload),
            "revision": rev,
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
        info = self._existing_asset_info(project_id, meta, rel, dest) or {
            "path": rel,
            "content_hash": hashlib.sha256(payload).hexdigest(),
            "revision": int(meta.get("structure_revision", 0)),
            "size": len(payload),
        }
        return payload, {
            "path": rel,
            "content_hash": str(info["content_hash"]),
            "size": int(info["size"]),
            "revision": int(info["revision"]),
        }

    @staticmethod
    def _role_in_meta(meta: dict[str, Any], user_id: str) -> str | None:
        """Owner (including legacy owner_id) or editor. Anyone else is not a member."""
        owner = meta.get("owner_id")
        if isinstance(owner, str) and owner == user_id:
            return ROLE_OWNER
        members = meta.get("members")
        if not isinstance(members, list):
            return None
        for row in members:
            if isinstance(row, dict) and row.get("user_id") == user_id:
                role = row.get("role")
                if role in (ROLE_OWNER, ROLE_EDITOR):
                    return role
        return None

    def member_role(self, project_id: str, user_id: str) -> str | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        return self._role_in_meta(meta, user_id)

    def can_read(self, project_id: str, user_id: str) -> bool:
        return self.member_role(project_id, user_id) in (ROLE_OWNER, ROLE_EDITOR)

    def can_write(self, project_id: str, user_id: str) -> bool:
        """Owner and editor can edit. Not a member cannot."""
        return self.can_read(project_id, user_id)

    def is_owner(self, project_id: str, user_id: str) -> bool:
        return self.member_role(project_id, user_id) == ROLE_OWNER

    def create_project_invite(self, project_id: str, created_by: str) -> dict[str, str]:
        """Reusable editor invite. Raw token is returned once; only its hash is stored.

        ponytail: no expiry, same as account invites. revoked_at is stored but there is
        no revoke API until account invites have one.
        """
        token = secrets.token_urlsafe(24)
        row: dict[str, Any] = {
            "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "project_id": project_id,
            "role": ROLE_EDITOR,
            "created_by": created_by,
            "created_at": _now(),
            "expires_at": None,
            "revoked_at": None,
        }
        with self._mut:
            meta = self._read_meta(project_id)
            if meta is None:
                raise FsRejected("project not found")
            invites = meta.get("project_invites")
            if not isinstance(invites, list):
                invites = []
                meta["project_invites"] = invites
            invites.append(row)
            self._write_meta(meta)
        return {"token": token, "role": ROLE_EDITOR, "project_id": project_id}

    def accept_project_invite(self, token: str, user_id: str, username: str) -> dict[str, Any] | None:
        """Add the signed-in user as editor. Idempotent. Does not downgrade an owner.

        Returns None when the token is unknown or revoked.
        """
        token = (token or "").strip()
        if not token or not user_id or not username:
            return None
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._mut:
            found = self._find_invite_unlocked(digest)
            if found is None:
                return None
            meta, invite = found
            if invite.get("revoked_at"):
                return None
            role = self._grant_editor_unlocked(meta, user_id, username)
            public = self._public(meta, user_id=user_id)
            public["role"] = role
            return public

    def _find_invite_unlocked(self, digest: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        if not self.root.is_dir():
            return None
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta:
                continue
            invites = meta.get("project_invites")
            if not isinstance(invites, list):
                continue
            for row in invites:
                stored = row.get("token_hash") if isinstance(row, dict) else None
                if isinstance(stored, str) and len(stored) == len(digest) and hmac.compare_digest(stored, digest):
                    return meta, row
        return None

    def _grant_editor_unlocked(self, meta: dict[str, Any], user_id: str, username: str) -> str:
        existing = self._role_in_meta(meta, user_id)
        if existing in (ROLE_OWNER, ROLE_EDITOR):
            return existing
        members = meta.get("members")
        if not isinstance(members, list):
            members = []
            meta["members"] = members
        members.append({"user_id": user_id, "username": username, "role": ROLE_EDITOR})
        self._write_meta(meta)
        return ROLE_EDITOR

    def list_members(self, project_id: str) -> list[dict[str, str]] | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        members = meta.get("members")
        if members is None:
            # Legacy: synthesize owner-less empty list (callers still need membership via legacy role)
            return []
        out: list[dict[str, str]] = []
        for row in members:
            if not isinstance(row, dict):
                continue
            uid, uname, role = row.get("user_id"), row.get("username"), row.get("role")
            if isinstance(uid, str) and isinstance(uname, str) and isinstance(role, str):
                out.append({"user_id": uid, "username": uname, "role": role})
        return out

    def _alloc_slug(self, name: str) -> str:
        """Unique public slug from project name.

        ponytail: scan meta.json files. Ceiling: create races on the same slug.
        Upgrade: unique index (post-MVP).
        """
        base = _slugify(name)
        taken = self._slugs_in_use()
        if base not in taken:
            return base
        for n in range(2, 100):
            cand = f"{base}-{n}"
            if cand not in taken:
                return cand
        return f"{base}-{uuid.uuid4().hex[:6]}"

    def _slugs_in_use(self) -> set[str]:
        found: set[str] = set()
        if not self.root.is_dir():
            return found
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta:
                continue
            slug = meta.get("slug")
            if isinstance(slug, str) and slug:
                found.add(slug)
        return found

    def ensure_slug(self, project_id: str) -> str:
        """Assign a slug if a pre-share project has none. Returns slug."""
        with self._mut:
            meta = self._read_meta(project_id)
            if meta is None:
                raise FsRejected("project not found")
            slug = meta.get("slug")
            if isinstance(slug, str) and slug:
                return slug
            slug = self._alloc_slug(str(meta.get("name") or "deck"))
            meta["slug"] = slug
            self._write_meta(meta)
            return slug

    def capture_workspace(self, project_id: str) -> dict[str, Any] | None:
        """Use the snapshot builder, including frozen binary bodies, for Publish."""
        with self._mut:
            meta = self._read_meta(project_id)
            return self._build_snapshot_unlocked(
                project_id, meta, include_asset_data=True,
            ) if meta else None

    def workspace_file(self, project_id: str, rel: str) -> bytes | None:
        """Preview shares the state resolver and authoritative disk topology."""
        with self._mut:
            if not _SAFE_REL.fullmatch(rel) or self._read_meta(project_id) is None:
                raise FsRejected(f"invalid workspace path: {rel!r}")
            path = self._resolve_rel(project_id, rel)
            if not path.is_file():
                return None
            if is_collaborative_text_rel(rel):
                texts, _state = self.collaborative_state(project_id)
                if rel in texts:
                    return texts[rel].encode("utf-8")
            return path.read_bytes()

    def release_staging_paths(self, project_id: str, release_id: str) -> tuple[Path, Path]:
        """Return (final_dir, staging_dir). Caller writes staging then renames."""
        if not _RELEASE_ID.match(release_id):
            raise FsRejected(f"invalid release id: {release_id!r}")
        base = self._project_dir(project_id) / "releases"
        final = base / release_id
        staging = base / f".{release_id}.building"
        return final, staging

    def commit_release(self, project_id: str, record: dict[str, Any]) -> dict[str, Any]:
        """Append an immutable release record and point the public slug at it."""
        with self._mut:
            meta = self._read_meta(project_id)
            if meta is None:
                raise FsRejected("project not found")
            if not isinstance(meta.get("slug"), str) or not meta.get("slug"):
                meta["slug"] = self._alloc_slug(str(meta.get("name") or "deck"))
            releases = meta.get("releases")
            if not isinstance(releases, list):
                releases = []
                meta["releases"] = releases
            releases.append(record)
            meta["published_release_id"] = record["id"]
            self._write_meta(meta)
            return self._release_public(meta, record)

    def list_releases(self, project_id: str) -> list[dict[str, Any]] | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        releases = meta.get("releases")
        if not isinstance(releases, list):
            return []
        return [self._release_public(meta, r) for r in releases if isinstance(r, dict)]

    def get_release(self, project_id: str, release_id: str) -> dict[str, Any] | None:
        meta = self._read_meta(project_id)
        if meta is None:
            return None
        releases = meta.get("releases")
        if not isinstance(releases, list):
            return None
        for r in releases:
            if isinstance(r, dict) and r.get("id") == release_id:
                return self._release_public(meta, r)
        return None

    def get_release_global(self, release_id: str) -> dict[str, Any] | None:
        """Lookup release metadata by id across projects (authenticated API)."""
        if not _RELEASE_ID.match(release_id) or not self.root.is_dir():
            return None
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta:
                continue
            releases = meta.get("releases")
            if not isinstance(releases, list):
                continue
            for r in releases:
                if isinstance(r, dict) and r.get("id") == release_id:
                    return self._release_public(meta, r)
        return None

    def resolve_release_dir(self, release_id: str) -> Path | None:
        if not _RELEASE_ID.match(release_id) or not self.root.is_dir():
            return None
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta:
                continue
            releases = meta.get("releases")
            if not isinstance(releases, list):
                continue
            if any(isinstance(r, dict) and r.get("id") == release_id for r in releases):
                path = self._project_dir(child.name) / "releases" / release_id
                return path if path.is_dir() else None
        return None

    def resolve_slug_dir(self, slug: str) -> Path | None:
        if not _SLUG.match(slug) or not self.root.is_dir():
            return None
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child.name)
            if not meta or meta.get("slug") != slug:
                continue
            rid = meta.get("published_release_id")
            if not isinstance(rid, str) or not _RELEASE_ID.match(rid):
                return None
            path = self._project_dir(child.name) / "releases" / rid
            return path if path.is_dir() else None
        return None

    @staticmethod
    def _release_public(meta: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
        slug = meta.get("slug") if isinstance(meta.get("slug"), str) else ""
        rid = str(record.get("id") or "")
        return {
            "id": rid,
            "project_id": meta["id"],
            "created_at": record.get("created_at"),
            "structure_revision": record.get("structure_revision", record.get("revision", 0)),
            "content_hash": record.get("content_hash"),
            "slug": slug,
            "current": meta.get("published_release_id") == rid,
            "public_path": f"/presentations/{slug}" if slug else "",
            "release_path": f"/releases/{rid}",
        }

    @staticmethod
    def _public(meta: dict[str, Any], *, user_id: str | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": meta["id"],
            "name": meta["name"],
            "created_at": meta["created_at"],
            "structure_revision": meta.get("structure_revision", 0),
        }
        owner_id = meta.get("owner_id")
        if isinstance(owner_id, str):
            out["owner_id"] = owner_id
        slug = meta.get("slug")
        if isinstance(slug, str) and slug:
            out["slug"] = slug
        published = meta.get("published_release_id")
        if isinstance(published, str) and published:
            out["published_release_id"] = published
        if user_id:
            role = ProjectService._role_in_meta(meta, user_id)
            if role:
                out["role"] = role
        return out


project_service = ProjectService()
