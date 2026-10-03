"""Shared Preview/Publish helpers: chapter asset URL rewrite.

Projects are static sites: index.html owns Reveal.initialize + slide sections.
Preview/Publish serve collaborative index.html as-is (no deck.yaml injection).
Runtime assets live under project-relative runtime/ (vendored at create).
New projects copy src/vscode_revealjs_server/runtimes/template/ as-is.
"""

from __future__ import annotations

import re

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
    not the markdown file. Preview pages live at `/preview/{id}/`; Publish
    passes `url_prefix=/releases/{release_id}` so frozen markdown stays immutable.
    """
    prefix = url_prefix if url_prefix is not None else f"/preview/{project_id}"
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
