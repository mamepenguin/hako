from __future__ import annotations

from kura.db import (
    get_connection,
    insert_entry,
    delete_entry,
    get_entry,
    list_entries,
    get_stats,
)


def _make_conn(tmp_data_dir):
    db_path = tmp_data_dir / "test.db"
    return get_connection(db_path), db_path


def test_schema_creation(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    names = {r["name"] for r in tables}
    assert "entries" in names


def test_insert_and_get(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    entry_id, status = insert_entry(
        conn,
        source="web",
        title="Test Article",
        content="Some content here",
        url="https://example.com",
        happened_at="2026-03-28T12:00:00",
        tags="test,web",
    )
    assert status == "created"
    assert entry_id >= 1

    entry = get_entry(conn, entry_id)
    assert entry is not None
    assert entry["title"] == "Test Article"
    assert entry["source"] == "web"
    assert entry["url"] == "https://example.com"
    assert entry["access_count"] == 1


def test_url_dedup_updates(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    id1, s1 = insert_entry(
        conn,
        title="Original",
        url="https://example.com",
        happened_at="2026-03-28T12:00:00",
    )
    assert s1 == "created"

    id2, s2 = insert_entry(
        conn,
        title="Updated",
        url="https://example.com",
        happened_at="2026-03-28T13:00:00",
    )
    assert s2 == "updated"
    assert id2 == id1

    entry = get_entry(conn, id1)
    assert entry["title"] == "Updated"


def test_content_dedup_skips(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    id1, s1 = insert_entry(
        conn,
        title="My Memo",
        content="Hello world",
        happened_at="2026-03-28T12:00:00",
    )
    assert s1 == "created"

    id2, s2 = insert_entry(
        conn,
        title="My Memo",
        content="Hello world",
        happened_at="2026-03-28T13:00:00",
    )
    assert s2 == "skipped"
    assert id2 == id1


def test_delete_entry(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    entry_id, _ = insert_entry(
        conn,
        title="To Delete",
        happened_at="2026-03-28T12:00:00",
    )
    assert delete_entry(conn, entry_id) is True
    assert get_entry(conn, entry_id) is None
    assert delete_entry(conn, entry_id) is False


def test_list_entries_filters(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    insert_entry(conn, source="web", title="Web 1", url="https://a.com", happened_at="2026-03-01T00:00:00")
    insert_entry(conn, source="email", title="Email 1", happened_at="2026-03-15T00:00:00")
    insert_entry(conn, source="web", title="Web 2", url="https://b.com", happened_at="2026-03-28T00:00:00")

    all_entries = list_entries(conn)
    assert len(all_entries) == 3

    web_entries = list_entries(conn, source="web")
    assert len(web_entries) == 2
    assert all(e["source"] == "web" for e in web_entries)

    recent = list_entries(conn, since="2026-03-10T00:00:00")
    assert len(recent) == 2

    ranged = list_entries(conn, since="2026-03-10T00:00:00", until="2026-03-20T00:00:00")
    assert len(ranged) == 1

    limited = list_entries(conn, limit=1)
    assert len(limited) == 1


def test_get_stats(tmp_data_dir, mock_embed):
    conn, db_path = _make_conn(tmp_data_dir)
    insert_entry(conn, source="web", title="Web", url="https://a.com", happened_at="2026-03-28T00:00:00")
    insert_entry(conn, source="web", title="Web2", url="https://b.com", happened_at="2026-03-28T00:00:00")
    insert_entry(conn, source="email", title="Email", happened_at="2026-03-28T00:00:00")

    stats = get_stats(conn, db_path=db_path)
    assert stats["total_entries"] == 3
    assert stats["db_size_bytes"] > 0

    sources = {s["source"]: s["count"] for s in stats["sources"]}
    assert sources["web"] == 2
    assert sources["email"] == 1


def test_fts_triggered_on_insert(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    insert_entry(conn, title="Unique FTS Test", content="searchable content", happened_at="2026-03-28T00:00:00")

    rows = conn.execute(
        "SELECT rowid FROM entries_fts WHERE entries_fts MATCH '\"Unique FTS\"'"
    ).fetchall()
    assert len(rows) == 1


def test_fts_triggered_on_delete(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    entry_id, _ = insert_entry(conn, title="Delete FTS Test", happened_at="2026-03-28T00:00:00")
    delete_entry(conn, entry_id)

    rows = conn.execute(
        "SELECT rowid FROM entries_fts WHERE entries_fts MATCH '\"Delete FTS\"'"
    ).fetchall()
    assert len(rows) == 0


def test_vec_inserted_on_create(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    entry_id, _ = insert_entry(conn, title="Vec Test", happened_at="2026-03-28T00:00:00")

    row = conn.execute(
        "SELECT entry_id FROM entries_vec WHERE entry_id = ?", (entry_id,)
    ).fetchone()
    assert row is not None


def test_vec_deleted_on_delete(tmp_data_dir, mock_embed):
    conn, _ = _make_conn(tmp_data_dir)
    entry_id, _ = insert_entry(conn, title="Vec Delete", happened_at="2026-03-28T00:00:00")
    delete_entry(conn, entry_id)

    row = conn.execute(
        "SELECT entry_id FROM entries_vec WHERE entry_id = ?", (entry_id,)
    ).fetchone()
    assert row is None
