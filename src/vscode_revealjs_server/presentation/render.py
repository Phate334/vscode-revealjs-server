"""Shared Preview/Publish helpers: chapter asset URL rewrite.

Projects are static sites: index.html owns Reveal.initialize + slide sections.
Preview/Publish serve collaborative index.html as-is (no deck.yaml injection).
"""

from __future__ import annotations

import html
import re

from vscode_revealjs_server.presentation.runtime import DEFAULT_RUNTIME

# Relative URL rewrite in chapter markdown / HTML fragments (R2).
_MD_LINK = re.compile(r"(!?\[[^\]]*\]\()([^\s)]+)(\))")
_HTML_ATTR = re.compile(
    r"(<(?:img|video|source|a)\b[^>]*?\b(?:src|href)\s*=\s*)([\"'])([^\"']+)\2",
    re.IGNORECASE,
)


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


def rewrite_chapter_relative_urls(
    text: str,
    *,
    project_id: str,
    chapter: str,
    url_prefix: str | None = None,
) -> str:
    """Rewrite relative img/video/source/a (and md links) to absolute chapter URLs.

    Reveal's markdown plugin resolves relative URLs against the HTML page,
    not the markdown file. Preview pages live at `/p/{id}/preview/`; Publish
    passes `url_prefix=/release/{release_id}` so frozen markdown stays immutable.
    """
    prefix = url_prefix if url_prefix is not None else f"/p/{project_id}/preview"
    prefix = prefix.rstrip("/")
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


def _section_for(md_rel: str) -> str:
    sep = "^\\n---\\n$"
    vsep = "^\\n--\\n$"
    return (
        f'      <section data-markdown="{html.escape(md_rel, quote=True)}"\n'
        f'               data-separator="{html.escape(sep, quote=True)}"\n'
        f'               data-separator-vertical="{html.escape(vsep, quote=True)}"\n'
        f'               data-charset="utf-8"></section>'
    )


def default_index_html(title: str) -> str:
    """Complete standalone Reveal.js deck for newly created projects.

    Runtime assets use the shared /runtimes/{DEFAULT_RUNTIME}/ registry.
    Chapter markdown paths are relative so Preview (/preview/) and Publish
    (/release/{id}/) resolve correctly when served with a trailing slash.
    """
    t = html.escape(title)
    rt = f"/runtimes/{DEFAULT_RUNTIME}"
    e = html.escape
    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-Hant">\n'
        "<head>\n"
        '  <meta charset="utf-8" />\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        f"  <title>{t}</title>\n"
        f'  <link rel="stylesheet" href="{e(rt)}/reset.css" />\n'
        f'  <link rel="stylesheet" href="{e(rt)}/reveal.css" />\n'
        f'  <link rel="stylesheet" href="{e(rt)}/theme/black.css" />\n'
        '  <link rel="stylesheet" href="theme.css" />\n'
        "</head>\n"
        "<body>\n"
        '  <div class="reveal">\n'
        '    <div class="slides">\n'
        f"{_section_for('01-introduction/slide.md')}\n"
        "    </div>\n"
        "  </div>\n"
        f'  <script src="{e(rt)}/reveal.js"></script>\n'
        f'  <script src="{e(rt)}/markdown/markdown.js"></script>\n'
        "  <script>\n"
        "    Reveal.initialize({\n"
        "      hash: true,\n"
        '      transition: "slide",\n'
        "      controls: true,\n"
        "      progress: true,\n"
        "      plugins: [RevealMarkdown]\n"
        "    });\n"
        "  </script>\n"
        "</body>\n"
        "</html>\n"
    )


def default_agents_md() -> str:
    """Preliminary editing guidance for agents/humans (Traditional Chinese)."""
    return (
        "# 簡報編輯指引\n"
        "\n"
        "- 在各章節的 `slide.md`（Markdown）裡編輯內容；章節順序以 `index.html` 的"
        " `<section data-markdown=\"...\">` 為準。\n"
        "- 版面與樣式請用 CSS（例如根目錄 `theme.css`），不要在內容裡寫 HTML 標籤。\n"
        "- Reveal.js 設定（transition、controls、plugins 等）請直接改 `index.html` 裡的"
        " `Reveal.initialize({...})`。\n"
        "- 預覽與發布把專案當靜態網站提供；執行期腳本／樣式走 `/runtimes/reveal-v1/`，"
        "章節 markdown 請用相對路徑。\n"
    )


def default_theme_css() -> str:
    return (
        "/* Project layout / theme overrides. Prefer CSS over HTML inside slide.md. */\n"
        "\n"
    )
