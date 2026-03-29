"""Tests for plugins.web CLI."""

from __future__ import annotations

from unittest.mock import patch

from click.testing import CliRunner

from kura.db import get_connection, get_entry
from plugins.web import main


def _runner_with_db(tmp_data_dir, mock_embed):
    db_path = tmp_data_dir / "test.db"
    runner = CliRunner()

    def invoke(*args, **kwargs):
        with patch("plugins.web.get_connection", lambda: get_connection(db_path)):
            return runner.invoke(main, *args, catch_exceptions=False, **kwargs)

    return invoke


def test_web_plugin_fetches_and_ingests(tmp_data_dir, mock_embed, monkeypatch):
    from kura.fetchers.web import PageInfo

    def fake_fetch(url):
        return PageInfo(title="Fetched Title", content="Fetched content text", url=url)

    monkeypatch.setattr("plugins.web.fetch_page", fake_fetch)

    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["https://example.com/article"])
    assert result.exit_code == 0
    assert "created" in result.output
    assert "Fetched Title" in result.output


def test_web_plugin_title_override(tmp_data_dir, mock_embed, monkeypatch):
    from kura.fetchers.web import PageInfo

    def fake_fetch(url):
        return PageInfo(title="Auto Title", content="content", url=url)

    monkeypatch.setattr("plugins.web.fetch_page", fake_fetch)

    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["https://example.com", "--title", "My Title"])
    assert result.exit_code == 0
    assert "My Title" in result.output


def test_web_plugin_fetch_failure(tmp_data_dir, mock_embed, monkeypatch):
    import httpx

    def fake_fetch(url):
        raise httpx.HTTPStatusError(
            "404", request=httpx.Request("GET", url), response=httpx.Response(404)
        )

    monkeypatch.setattr("plugins.web.fetch_page", fake_fetch)

    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["https://example.com/missing"])
    assert result.exit_code == 0
    assert "Fetch failed" in result.output
    assert "created" in result.output


def test_web_plugin_with_tags(tmp_data_dir, mock_embed, monkeypatch):
    from kura.fetchers.web import PageInfo

    def fake_fetch(url):
        return PageInfo(title="Tagged", content="stuff", url=url)

    monkeypatch.setattr("plugins.web.fetch_page", fake_fetch)

    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["https://example.com", "--tags", "tech,ai"])
    assert result.exit_code == 0
    assert "created" in result.output
