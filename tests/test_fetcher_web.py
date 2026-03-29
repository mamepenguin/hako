"""Tests for kura.fetchers.web."""

from __future__ import annotations

import pytest

from kura.fetchers.web import PageInfo, fetch_page, _extract_title, _extract_content

from bs4 import BeautifulSoup


# --- _extract_title ---

def test_extract_title_og():
    html = '<html><head><meta property="og:title" content="OG Title"></head></html>'
    soup = BeautifulSoup(html, "html.parser")
    assert _extract_title(soup) == "OG Title"


def test_extract_title_tag():
    html = "<html><head><title>Page Title</title></head></html>"
    soup = BeautifulSoup(html, "html.parser")
    assert _extract_title(soup) == "Page Title"


def test_extract_title_h1_fallback():
    html = "<html><body><h1>Heading</h1></body></html>"
    soup = BeautifulSoup(html, "html.parser")
    assert _extract_title(soup) == "Heading"


def test_extract_title_empty():
    html = "<html><body><p>No title here</p></body></html>"
    soup = BeautifulSoup(html, "html.parser")
    assert _extract_title(soup) == ""


# --- _extract_content ---

def test_extract_content_og_description():
    html = '<html><head><meta property="og:description" content="A long enough description that exceeds fifty characters for testing purposes."></head><body></body></html>'
    soup = BeautifulSoup(html, "html.parser")
    result = _extract_content(soup, max_chars=200)
    assert "long enough description" in result


def test_extract_content_meta_description():
    html = '<html><head><meta name="description" content="Another sufficiently long description text that exceeds fifty chars for testing."></head><body></body></html>'
    soup = BeautifulSoup(html, "html.parser")
    result = _extract_content(soup, max_chars=200)
    assert "sufficiently long" in result


def test_extract_content_body_fallback():
    html = "<html><body><article><p>Paragraph one.</p><p>Paragraph two.</p></article></body></html>"
    soup = BeautifulSoup(html, "html.parser")
    result = _extract_content(soup, max_chars=200)
    assert "Paragraph one" in result
    assert "Paragraph two" in result


def test_extract_content_strips_noise():
    html = "<html><body><nav>nav</nav><article><p>Real content.</p><script>evil()</script></article></body></html>"
    soup = BeautifulSoup(html, "html.parser")
    result = _extract_content(soup, max_chars=200)
    assert "Real content" in result
    assert "evil" not in result
    assert "nav" not in result


def test_extract_content_truncates():
    html = "<html><body><p>" + "x" * 500 + "</p></body></html>"
    soup = BeautifulSoup(html, "html.parser")
    result = _extract_content(soup, max_chars=100)
    assert len(result) <= 100


# --- fetch_page (with mocked HTTP) ---

def test_fetch_page(monkeypatch):
    html = """
    <html>
    <head>
        <title>Test Page</title>
        <meta property="og:description" content="This is a sufficiently long description for the og tag to pass the fifty character threshold.">
    </head>
    <body><article><p>Body content here.</p></article></body>
    </html>
    """

    class FakeResponse:
        status_code = 200
        text = html
        url = "https://example.com/page"

        def raise_for_status(self):
            pass

    def fake_get(url, **kwargs):
        return FakeResponse()

    import httpx
    monkeypatch.setattr(httpx, "get", fake_get)

    page = fetch_page("https://example.com/page")
    assert isinstance(page, PageInfo)
    assert page.title == "Test Page"
    assert "sufficiently long description" in page.content
    assert page.url == "https://example.com/page"


def test_fetch_page_redirect(monkeypatch):
    html = "<html><head><title>Redirected</title></head><body></body></html>"

    class FakeResponse:
        status_code = 200
        text = html
        url = "https://example.com/final"

        def raise_for_status(self):
            pass

    import httpx
    monkeypatch.setattr(httpx, "get", lambda url, **kw: FakeResponse())

    page = fetch_page("https://example.com/start")
    assert page.url == "https://example.com/final"
    assert page.title == "Redirected"


def test_fetch_page_http_error(monkeypatch):
    import httpx

    def fake_get(url, **kwargs):
        raise httpx.HTTPStatusError(
            "404", request=httpx.Request("GET", url), response=httpx.Response(404)
        )

    monkeypatch.setattr(httpx, "get", fake_get)

    with pytest.raises(httpx.HTTPError):
        fetch_page("https://example.com/missing")
