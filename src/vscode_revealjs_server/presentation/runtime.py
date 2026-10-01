"""Vendored Reveal.js seed copied into each project as workspace/runtime/.

ponytail: single bundled reveal-v1 (reveal.js 5.1.0). Ceiling: one seed pin.
Upgrade: optional per-project runtime upgrade without shared HTTP registry.
"""

from __future__ import annotations

import shutil
from pathlib import Path

# Package-shipping seed (not an HTTP registry).
_PACKAGE_SEED = Path(__file__).resolve().parent.parent / "runtimes" / "reveal-v1"

# Workspace-relative directory name for the project-local runtime tree.
PROJECT_RUNTIME_DIR = "runtime"


def package_seed_dir() -> Path:
    """Absolute path to the reveal-v1 seed shipped with the server package."""
    if not _PACKAGE_SEED.is_dir():
        raise FileNotFoundError(f"runtime seed missing: {_PACKAGE_SEED}")
    return _PACKAGE_SEED


def copy_seed_into(workspace: Path) -> Path:
    """Copy the package seed into workspace/runtime/. Returns the dest dir."""
    dest = workspace / PROJECT_RUNTIME_DIR
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(package_seed_dir(), dest)
    return dest
