from __future__ import annotations

import math
import sqlite3
from datetime import datetime

from kura.config import get_search_config
from kura.db import _touch_accessed
from kura.embeddings import embed, serialize_vec


def hybrid_search(
    conn: sqlite3.Connection,
    query: str,
    *,
    source: str = "",
    limit: int = 10,
) -> list[dict]:
    cfg = get_search_config()

    fts_results = _fts_search(conn, query, source, limit=50)
    vec_results = _vec_search(conn, query, source, limit=50)

    rrf_scores = _rrf_fusion(fts_results, vec_results, k=cfg["rrf_k"])

    now = datetime.now()
    scored = []
    for entry_id, rrf_score in rrf_scores.items():
        row = conn.execute(
            "SELECT * FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if row is None:
            continue

        decay = _time_decay(
            row["happened_at"],
            row["created_at"],
            half_life=cfg["time_decay_half_life_days"],
            floor=cfg["time_decay_floor"],
        )
        final_score = rrf_score * decay

        entry = dict(row)
        entry["score"] = round(final_score, 6)
        scored.append(entry)

    scored.sort(key=lambda x: x["score"], reverse=True)
    results = scored[:limit]

    _touch_accessed(conn, [r["id"] for r in results])

    return results


def _fts_search(
    conn: sqlite3.Connection,
    query: str,
    source: str,
    limit: int,
) -> list[int]:
    fts_query = _build_fts_query(query)

    if source:
        rows = conn.execute(
            """SELECT e.id FROM entries e
               JOIN entries_fts f ON f.rowid = e.id
               WHERE entries_fts MATCH ?
                 AND e.source = ?
               LIMIT ?""",
            (fts_query, source, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT e.id FROM entries e
               JOIN entries_fts f ON f.rowid = e.id
               WHERE entries_fts MATCH ?
               LIMIT ?""",
            (fts_query, limit),
        ).fetchall()

    return [r["id"] for r in rows]


def _vec_search(
    conn: sqlite3.Connection,
    query: str,
    source: str,
    limit: int,
) -> list[int]:
    vec = embed(query)

    rows = conn.execute(
        """SELECT v.entry_id, v.distance
           FROM entries_vec v
           WHERE v.embedding MATCH ?
             AND k = ?
           ORDER BY v.distance""",
        (serialize_vec(vec), limit),
    ).fetchall()

    if not source:
        return [r["entry_id"] for r in rows]

    # Post-filter by source
    filtered = []
    for r in rows:
        entry = conn.execute(
            "SELECT source FROM entries WHERE id = ?", (r["entry_id"],)
        ).fetchone()
        if entry and entry["source"] == source:
            filtered.append(r["entry_id"])
    return filtered


def _rrf_fusion(
    fts_ids: list[int],
    vec_ids: list[int],
    k: int = 60,
) -> dict[int, float]:
    scores: dict[int, float] = {}

    for rank, eid in enumerate(fts_ids):
        scores[eid] = scores.get(eid, 0.0) + 1.0 / (k + rank + 1)

    for rank, eid in enumerate(vec_ids):
        scores[eid] = scores.get(eid, 0.0) + 1.0 / (k + rank + 1)

    return scores


def _time_decay(
    happened_at: str,
    created_at: str,
    half_life: float = 180.0,
    floor: float = 0.1,
) -> float:
    now = datetime.now()
    reference = max(
        datetime.fromisoformat(happened_at),
        datetime.fromisoformat(created_at),
    )
    days_old = max((now - reference).days, 0)
    decay = math.pow(0.5, days_old / half_life)
    return max(decay, floor)


def _build_fts_query(query: str) -> str:
    escaped = query.replace('"', '""')
    return f'"{escaped}"'
