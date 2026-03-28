from __future__ import annotations

import pytest

from lifelog.db import get_connection, get_entry
from lifelog.ingest import ingest_entry


def _make_conn(tmp_data_dir):
    db_path = tmp_data_dir / "test.db"
    return get_connection(db_path)


def test_ingest_memo(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    entry_id, status = ingest_entry(conn, source="memo", title="My Note", content="Hello")
    assert status == "created"
    entry = get_entry(conn, entry_id)
    assert entry["title"] == "My Note"
    assert entry["happened_at"] is not None


def test_ingest_web_requires_url(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    with pytest.raises(ValueError, match="url is required"):
        ingest_entry(conn, source="web", title="No URL")


def test_ingest_empty_title_raises(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    with pytest.raises(ValueError, match="title is required"):
        ingest_entry(conn, title="  ", happened_at="2026-03-28T00:00:00")


def test_ingest_url_dedup(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    id1, s1 = ingest_entry(conn, source="web", title="V1", url="https://example.com")
    id2, s2 = ingest_entry(conn, source="web", title="V2", url="https://example.com")
    assert s1 == "created"
    assert s2 == "updated"
    assert id1 == id2


def test_ingest_content_dedup(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    id1, s1 = ingest_entry(conn, title="Same", content="Same content")
    id2, s2 = ingest_entry(conn, title="Same", content="Same content")
    assert s1 == "created"
    assert s2 == "skipped"
    assert id1 == id2


def test_ingest_default_happened_at(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    entry_id, _ = ingest_entry(conn, title="Auto time")
    entry = get_entry(conn, entry_id)
    assert entry["happened_at"] is not None
    assert "2026" in entry["happened_at"]
