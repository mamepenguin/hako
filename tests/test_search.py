from __future__ import annotations

from datetime import datetime, timedelta

from kura.db import get_connection, insert_entry
from kura.search import hybrid_search, _time_decay, _rrf_fusion, _build_fts_query


def _make_conn(tmp_data_dir):
    db_path = tmp_data_dir / "test.db"
    return get_connection(db_path)


def test_basic_search(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    insert_entry(conn, title="Python programming guide", content="Learn Python basics", happened_at="2026-03-28T00:00:00")
    insert_entry(conn, title="Cooking recipes", content="Italian pasta", happened_at="2026-03-28T00:00:00")

    results = hybrid_search(conn, "Python")
    assert len(results) >= 1
    assert results[0]["title"] == "Python programming guide"


def test_search_with_source_filter(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    insert_entry(conn, source="web", title="Web article", url="https://a.com", happened_at="2026-03-28T00:00:00")
    insert_entry(conn, source="email", title="Email about web", happened_at="2026-03-28T00:00:00")

    results = hybrid_search(conn, "web", source="email")
    assert all(r["source"] == "email" for r in results)


def test_search_limit(tmp_data_dir, mock_embed):
    conn = _make_conn(tmp_data_dir)
    for i in range(10):
        insert_entry(conn, title=f"Test entry {i}", happened_at="2026-03-28T00:00:00")

    results = hybrid_search(conn, "Test", limit=3)
    assert len(results) <= 3


def test_time_decay_today():
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    decay = _time_decay(now, now)
    assert abs(decay - 1.0) < 0.01


def test_time_decay_half_life():
    half_life = 180.0
    past = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%dT%H:%M:%S")
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    decay = _time_decay(past, past, half_life=half_life)
    assert abs(decay - 0.5) < 0.05


def test_time_decay_floor():
    very_old = "2020-01-01T00:00:00"
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    decay = _time_decay(very_old, very_old, floor=0.1)
    assert decay == 0.1


def test_time_decay_uses_max_of_happened_and_created():
    old_happened = "2020-01-01T00:00:00"
    recent_created = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    decay = _time_decay(old_happened, recent_created)
    # Should use created_at (recent) as reference, so decay ~ 1.0
    assert decay > 0.9


def test_rrf_fusion_both_sources():
    fts = [1, 2, 3]
    vec = [2, 4, 1]
    scores = _rrf_fusion(fts, vec, k=60)
    # Entry 1 and 2 appear in both, should have higher scores
    assert scores[2] > scores[3]
    assert scores[1] > scores[4]


def test_rrf_fusion_empty():
    scores = _rrf_fusion([], [])
    assert scores == {}


def test_build_fts_query_escapes_quotes():
    result = _build_fts_query('test "quoted" text')
    assert result == '"test ""quoted"" text"'


def test_build_fts_query_simple():
    result = _build_fts_query("hello world")
    assert result == '"hello world"'
