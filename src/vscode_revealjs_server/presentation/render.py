"""Shared Preview/Publish HTML renderer: editable index.html + injection markers.

Contract (M2/M3): load collaborative index.html; replace markers with runtime
CSS, slide sections, and runtime JS. Publish must reuse this module — do not
fork a second HTML assembler.
"""

from __future__ import annotations

import html
import re

from vscode_revealjs_server.presentation.runtime import (
    DEFAULT_RUNTIME,
    resolve_runtime_name,
)

# Editable index.html injection points (default template + user edits).
MARKER_RUNTIME_CSS = "<!-- PRESENTATION_RUNTIME_CSS -->"
MARKER_SLIDES = "<!-- PRESENTATION_SLIDES -->"
MARKER_RUNTIME_JS = "<!-- PRESENTATION_RUNTIME_JS -->"

_CHAPTER_LINE = re.compile(r"^\s*-\s+(.+?)\s*$")
_RUNTIME_LINE = re.compile(r"^runtime:\s*(.+?)\s*$")
_TITLE_LINE = re.compile(r"^title:\s*(.+?)\s*$")

# Relative URL rewrite in chapter markdown / HTML fragments (R2).
_MD_LINK = re.compile(r"(!?\[[^\]]*\]\()([^\s)]+)(\))")
_HTML_ATTR = re.compile(
    r"(<(?:img|video|source|a)\b[^>]*?\b(?:src|href)\s*=\s*)([\"'])([^\"']+)\2",
    re.IGNORECASE,
)


def parse_deck(deck: str) -> tuple[str, str, list[str]]:
    """Minimal deck.yaml: title, runtime (registry-resolved), chapters list."""
    title = "Presentation"
    runtime_raw = DEFAULT_RUNTIME
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
            runtime_raw = rm.group(1).strip().strip("\"'")
    return title, resolve_runtime_name(runtime_raw), chapters


def _is_relative_asset_url(url: str) -> bool:
    u = url.strip()
    if not u or u.startswith(("#", "?", "/", "data:", "mailto:", "javascript:")):
        return False
    low = u.lower()
    if low.startswith(("http://", "https://", "//")):
        return False
    if ".." in u.split("/"):
        return False
    return True


def rewrite_chapter_relative_urls(text: str, *, project_id: str, chapter: str) -> str:
    """Rewrite relative img/video/source/a (and md links) to preview chapter URLs.

    Reveal's markdown plugin resolves relative URLs against the HTML page
    (`/p/{id}/preview`), so chapter-local `hero.png` must become
    `/p/{id}/preview/{chapter}/hero.png`.
    """
    prefix = f"/p/{project_id}/preview"
    if chapter:
        prefix = f"{prefix}/{chapter}"

    def abs_url(rel: str) -> str:
        rel = rel.strip()
        if rel.startswith("./"):
            rel = rel[2:]
        return f"{prefix}/{rel}"

    def md_sub(m: re.Match[str]) -> str:
        url = m.group(2)
        if not _is_relative_asset_url(url):
            return m.group(0)
        return f"{m.group(1)}{abs_url(url)}{m.group(3)}"

    def html_sub(m: re.Match[str]) -> str:
        url = m.group(3)
        if not _is_relative_asset_url(url):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}{abs_url(url)}{m.group(2)}"

    out = _MD_LINK.sub(md_sub, text)
    return _HTML_ATTR.sub(html_sub, out)


def _runtime_css_block(rt: str) -> str:
    e = html.escape
    return (
        f'  <link rel="stylesheet" href="{e(rt)}/reset.css" />\n'
        f'  <link rel="stylesheet" href="{e(rt)}/reveal.css" />\n'
        f'  <link rel="stylesheet" href="{e(rt)}/theme/black.css" />'
    )


def _runtime_js_block(rt: str) -> str:
    e = html.escape
    return (
        f'  <script src="{e(rt)}/reveal.js"></script>\n'
        f'  <script src="{e(rt)}/markdown/markdown.js"></script>\n'
        f"  <script>\n"
        f"    Reveal.initialize({{\n"
        f"      hash: true,\n"
        f'      transition: "slide",\n'
        f"      plugins: [RevealMarkdown]\n"
        f"    }});\n"
        f"  </script>"
    )


def _section_for(md_url: str) -> str:
    sep = "^\\n---\\n$"
    vsep = "^\\n--\\n$"
    return (
        f'      <section data-markdown="{html.escape(md_url, quote=True)}"\n'
        f'               data-separator="{html.escape(sep, quote=True)}"\n'
        f'               data-separator-vertical="{html.escape(vsep, quote=True)}"\n'
        f'               data-charset="utf-8"></section>'
    )


def _fallback_shell(title: str) -> str:
    """Built-in shell when collaborative index.html lacks injection markers."""
    t = html.escape(title)
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8" />\n'
        f"  <title>{t}</title>\n"
        f"  {MARKER_RUNTIME_CSS}\n"
        "</head>\n"
        "<body>\n"
        '  <div class="reveal">\n'
        '    <div class="slides">\n'
        f"      {MARKER_SLIDES}\n"
        "    </div>\n"
        "  </div>\n"
        f"  {MARKER_RUNTIME_JS}\n"
        "</body>\n"
        "</html>\n"
    )


def render_presentation_html(
    *,
    project_id: str,
    index_html: str | None,
    deck_yaml: str,
    fallback_chapters: list[str] | None = None,
) -> str:
    """Inject runtime + slides into editable index.html (Preview + Publish)."""
    title, runtime, chapters = parse_deck(deck_yaml)
    if not chapters and fallback_chapters is not None:
        chapters = list(fallback_chapters)

    base = f"/p/{project_id}/preview"
    rt = f"/runtimes/{runtime}"

    if chapters:
        sections = [_section_for(f"{base}/{ch}/slide.md") for ch in chapters]
    else:
        sections = [_section_for(f"{base}/slide.md")]
    slides_html = "\n".join(sections)

    shell = index_html if index_html is not None else ""
    if not (
        MARKER_RUNTIME_CSS in shell
        and MARKER_SLIDES in shell
        and MARKER_RUNTIME_JS in shell
    ):
        shell = _fallback_shell(title)

    # Preserve user <title> when present; otherwise leave fallback title.
    out = shell.replace(MARKER_RUNTIME_CSS, _runtime_css_block(rt), 1)
    out = out.replace(MARKER_SLIDES, slides_html, 1)
    out = out.replace(MARKER_RUNTIME_JS, _runtime_js_block(rt), 1)
    return out


def default_index_html(title: str) -> str:
    """Server create-project template with injection markers."""
    t = html.escape(title)
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8" />\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        f"  <title>{t}</title>\n"
        f"  {MARKER_RUNTIME_CSS}\n"
        "</head>\n"
        "<body>\n"
        '  <div class="reveal">\n'
        '    <div class="slides">\n'
        f"      {MARKER_SLIDES}\n"
        "    </div>\n"
        "  </div>\n"
        f"  {MARKER_RUNTIME_JS}\n"
        "</body>\n"
        "</html>\n"
    )
