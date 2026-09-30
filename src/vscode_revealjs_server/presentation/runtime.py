"""Shared reveal.js runtime roots for Preview and future Publish.

ponytail: vendored reveal-v1 (reveal.js 5.1.0). Ceiling: single runtime pin.
Upgrade: multi-runtime select from deck.yaml + release freeze (M3).
"""

from __future__ import annotations

from pathlib import Path

_RUNTIME_ROOT = Path(__file__).resolve().parent.parent / "runtimes"
DEFAULT_RUNTIME = "reveal-v1"


def runtime_dir(name: str = DEFAULT_RUNTIME) -> Path:
    return _RUNTIME_ROOT / name


def resolve_runtime_file(rel: str, *, name: str = DEFAULT_RUNTIME) -> Path | None:
    """Safe join under runtimes/{name}; None if missing or escapes."""
    if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")):
        return None
    root = runtime_dir(name).resolve()
    if not root.is_dir():
        return None
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None
