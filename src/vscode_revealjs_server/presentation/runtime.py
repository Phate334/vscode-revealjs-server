"""Shared reveal.js runtime registry for Preview and Publish.

ponytail: vendored reveal-v1 (reveal.js 5.1.0). Ceiling: single runtime pin.
Upgrade: multi-runtime select from project HTML / release freeze.

Security: never path-join user-supplied runtime_name. Only allowlisted keys
resolve to directories under runtimes/.
"""

from __future__ import annotations

from pathlib import Path

_RUNTIME_ROOT = Path(__file__).resolve().parent.parent / "runtimes"

# Allowlist only — values are concrete dirs, never derived from request strings.
SUPPORTED_RUNTIMES: dict[str, Path] = {
    "reveal-v1": _RUNTIME_ROOT / "reveal-v1",
}
DEFAULT_RUNTIME = "reveal-v1"


def is_supported_runtime(name: str | None) -> bool:
    return isinstance(name, str) and name in SUPPORTED_RUNTIMES


def resolve_runtime_name(name: str | None) -> str:
    """Map a runtime name to a registry key; unknown → DEFAULT_RUNTIME."""
    if is_supported_runtime(name):
        return name  # type: ignore[return-value]
    return DEFAULT_RUNTIME


def runtime_dir(name: str = DEFAULT_RUNTIME) -> Path | None:
    """Registry lookup only; None if name not allowlisted."""
    root = SUPPORTED_RUNTIMES.get(name)
    if root is None or not root.is_dir():
        return None
    return root


def resolve_runtime_file(rel: str, *, name: str = DEFAULT_RUNTIME) -> Path | None:
    """Safe join under an allowlisted runtime root; None if missing/unknown/escapes."""
    if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")):
        return None
    root = runtime_dir(name)
    if root is None:
        return None
    root = root.resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None
