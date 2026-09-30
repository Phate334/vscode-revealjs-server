"""Filesystem-backed project create/list/get + workspace snapshot.

ponytail: local dir store (no Postgres). Ceiling: single-node, no members/auth.
Upgrade: §18.1 project tables + membership (M3).
"""

from __future__ import annotations

import json
import os
import re
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

    @staticmethod
    def _public(meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": meta["id"],
            "name": meta["name"],
            "created_at": meta["created_at"],
            "revision": meta.get("revision", 0),
        }


project_service = ProjectService()
