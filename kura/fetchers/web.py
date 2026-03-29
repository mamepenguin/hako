"""Fetch web page metadata: title and leading text."""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from bs4 import BeautifulSoup


@dataclass(frozen=True)
class PageInfo:
    title: str
    content: str
    url: str


_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) kura/0.1",
    "Accept": "text/html,application/xhtml+xml",
}

_TIMEOUT = 15.0
_MAX_CONTENT_CHARS = 2000


def fetch_page(url: str, *, max_content_chars: int = _MAX_CONTENT_CHARS) -> PageInfo:
    """Fetch a URL and extract title + leading text content.

    Raises httpx.HTTPError on network failures.
    """
    resp = httpx.get(url, headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=True)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")

    title = _extract_title(soup) or url
    content = _extract_content(soup, max_chars=max_content_chars)

    return PageInfo(title=title, content=content, url=str(resp.url))


def _extract_title(soup: BeautifulSoup) -> str:
    # Prefer og:title > <title> > first <h1>
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return og["content"].strip()

    if soup.title and soup.title.string:
        return soup.title.string.strip()

    h1 = soup.find("h1")
    if h1:
        return h1.get_text(strip=True)

    return ""


def _extract_content(soup: BeautifulSoup, *, max_chars: int) -> str:
    # Prefer og:description > meta description > body text
    og = soup.find("meta", property="og:description")
    if og and og.get("content"):
        desc = og["content"].strip()
        if len(desc) > 50:
            return desc[:max_chars]

    meta_desc = soup.find("meta", attrs={"name": "description"})
    if meta_desc and meta_desc.get("content"):
        desc = meta_desc["content"].strip()
        if len(desc) > 50:
            return desc[:max_chars]

    # Fall back to body text: extract from <article> or <main> or <body>
    container = soup.find("article") or soup.find("main") or soup.find("body")
    if container is None:
        return ""

    # Remove noise elements
    for tag in container.find_all(["script", "style", "nav", "header", "footer", "aside"]):
        tag.decompose()

    text = container.get_text(separator="\n", strip=True)
    # Collapse multiple blank lines
    lines = [line for line in text.splitlines() if line.strip()]
    return "\n".join(lines)[:max_chars]
