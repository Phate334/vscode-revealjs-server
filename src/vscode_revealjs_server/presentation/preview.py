"""Preview Resolver: collaborative state → reveal HTML / path bytes (§19).

Does not read any client local filesystem. Text prefers live CRDT for the
bound slide; other text/assets come from server collaborative workspace.
"""

from __future__ import annotations

import html
import mimetypes
import re
from dataclasses import dataclass

from vscode_revealjs_server.collaboration.manager import manager
from vscode_revealjs_server.presentation.runtime import DEFAULT_RUNTIME
from vscode_revealjs_server.projects.service import FsRejected, is_binary_rel, project_service

_CHAPTER_LINE = re.compile(r"^\s*-\s+(.+?)\s*$")
_RUNTIME_LINE = re.compile(r"^runtime:\s*(.+?)\s*$")
_TITLE_LINE = re.compile(r"^title:\s*(.+?)\s*$")


@dataclass(frozen=True)
class PreviewBytes:
    body: bytes
    media_type: str


def _parse_deck(deck: str) -> tuple[str, str, list[str]]:
    """Minimal deck.yaml: title, runtime, chapters list. No full YAML dep."""
    title = "Presentation"
    runtime = DEFAULT_RUNTIME
    chapters: list[str] = []
    in_chapters = False
    for raw in deck.splitlines():
        line = raw.rstrip()
        if in_chapters:
            m = _CHAPTER_LINE.match(line)
            if m:
                chapters.append(m.group(1).strip().strip("\"'"))
                continue
            if line.startswith(" ") or line.startswith("\t") or not line or line.startswith("#"):
                continue
            in_chapters = False
        if line.strip() == "chapters:":
            in_chapters = True
            continue
        tm = _TITLE_LINE.match(line)
        if tm:
            title = tm.group(1).strip().strip("\"'")
            continue
        rm = _RUNTIME_LINE.match(line)
        if rm:
            runtime = rm.group(1).strip().strip("\"'")
    return title, runtime, chapters


def _guess_media(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    if mt:
        return mt
    if path.endswith(".md"):
        return "text/markdown; charset=utf-8"
    if path.endswith((".yaml", ".yml")):
        return "text/yaml; charset=utf-8"
    return "application/octet-stream"


def resolve_path(project_id: str, rel: str) -> PreviewBytes | None:
    """Resolve preview/{rel} from CRDT (bound slide) or collaborative workspace/assets."""
    if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")):
        raise FsRejected(f"invalid preview path: {rel!r}")

    if project_service.get(project_id) is None:
        return None

    slide_rel = project_service.collaborative_slide_path(project_id)
    if slide_rel and rel == slide_rel:
        crdt = manager.collaborative_text(project_id)
        if crdt is not None:
            return PreviewBytes(crdt.encode("utf-8"), "text/markdown; charset=utf-8")
        disk = project_service.read_workspace_text(project_id, rel)
        if disk is None:
            return None
        return PreviewBytes(disk.encode("utf-8"), "text/markdown; charset=utf-8")

    if is_binary_rel(rel):
        got = project_service.get_asset(project_id, rel)
        if got is None:
            return None
        payload, _info = got
        return PreviewBytes(payload, _guess_media(rel))

    text = project_service.read_workspace_text(project_id, rel)
    if text is None:
        return None
    return PreviewBytes(text.encode("utf-8"), _guess_media(rel))


def compose_index(project_id: str) -> PreviewBytes | None:
    """Build reveal bootstrap HTML from deck.yaml + chapters; runtime via /runtimes/."""
    if project_service.get(project_id) is None:
        return None
    deck = project_service.read_workspace_text(project_id, "deck.yaml") or ""
    title, runtime, chapters = _parse_deck(deck)
    if not chapters:
        # Fallback: bound slide path's parent chapter, or root slide.md
        slide = project_service.collaborative_slide_path(project_id)
        if slide and "/" in slide:
            chapters = [slide.rsplit("/", 1)[0]]
        elif slide == "slide.md":
            chapters = []
        else:
            chapters = ["01-introduction"]

    # Absolute URLs so /preview (no trailing slash) still resolves assets.
    base = f"/p/{project_id}/preview"
    rt = f"/runtimes/{runtime}"

    def section_for(md_url: str) -> str:
        # Reveal markdown plugin wants regex with literal \n in the attribute.
        sep = "^\\n---\\n$"
        vsep = "^\\n--\\n$"
        return (
            f'      <section data-markdown="{html.escape(md_url, quote=True)}"\n'
            f'               data-separator="{html.escape(sep, quote=True)}"\n'
            f'               data-separator-vertical="{html.escape(vsep, quote=True)}"\n'
            f'               data-charset="utf-8"></section>'
        )

    if chapters:
        sections = [section_for(f"{base}/{ch}/slide.md") for ch in chapters]
    else:
        sections = [section_for(f"{base}/slide.md")]

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{html.escape(title)}</title>
  <link rel="stylesheet" href="{html.escape(rt)}/reset.css" />
  <link rel="stylesheet" href="{html.escape(rt)}/reveal.css" />
  <link rel="stylesheet" href="{html.escape(rt)}/theme/black.css" />
</head>
<body>
  <div class="reveal">
    <div class="slides">
{chr(10).join(sections)}
    </div>
  </div>
  <script src="{html.escape(rt)}/reveal.js"></script>
  <script src="{html.escape(rt)}/markdown/markdown.js"></script>
  <script>
    Reveal.initialize({{
      hash: true,
      transition: "slide",
      plugins: [RevealMarkdown]
    }});
  </script>
</body>
</html>
"""
    return PreviewBytes(body.encode("utf-8"), "text/html; charset=utf-8")
