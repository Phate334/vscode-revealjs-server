"""Vendored seeds copied into each new project workspace.

ponytail: single bundled reveal-v1 (reveal.js 5.1.0) + static project template.
Ceiling: one seed pin. Upgrade: optional per-project runtime upgrade without
shared HTTP registry.
"""

from __future__ import annotations

import html
import shutil
from pathlib import Path

# Package-shipping seeds (not an HTTP registry).
_PACKAGE_SEED = Path(__file__).resolve().parent.parent / "runtimes" / "reveal-v1"
_PACKAGE_TEMPLATE = Path(__file__).resolve().parent.parent / "runtimes" / "template"

# Workspace-relative directory name for the project-local runtime tree.
PROJECT_RUNTIME_DIR = "runtime"

# Replaced in index.html (HTML-escaped) and slide.md when a project is created.
_TITLE_MARKER = "{{title}}"

# Template paths that receive the presentation name.
_TITLE_FILES = frozenset({"index.html", "01-introduction/slide.md"})


def package_seed_dir() -> Path:
    """Absolute path to the reveal-v1 seed shipped with the server package."""
    if not _PACKAGE_SEED.is_dir():
        raise FileNotFoundError(f"runtime seed missing: {_PACKAGE_SEED}")
    return _PACKAGE_SEED


def package_template_dir() -> Path:
    """Absolute path to the new-presentation template shipped with the package."""
    if not _PACKAGE_TEMPLATE.is_dir():
        raise FileNotFoundError(f"project template missing: {_PACKAGE_TEMPLATE}")
    return _PACKAGE_TEMPLATE


def copy_seed_into(workspace: Path) -> Path:
    """Copy the package seed into workspace/runtime/. Returns the dest dir."""
    dest = workspace / PROJECT_RUNTIME_DIR
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(package_seed_dir(), dest)
    return dest


def copy_template_into(workspace: Path, *, title: str) -> None:
    """Copy the static project template into workspace and apply the title."""
    seed = package_template_dir()
    for src in sorted(seed.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(seed).as_posix()
        dest = workspace / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        if rel in _TITLE_FILES and _TITLE_MARKER in text:
            replacement = html.escape(title) if rel.endswith(".html") else title
            text = text.replace(_TITLE_MARKER, replacement)
        dest.write_text(text, encoding="utf-8")
