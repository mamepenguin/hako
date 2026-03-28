from __future__ import annotations

import sqlite3
from pathlib import Path

from lifelog.config import DATA_DIR
from lifelog.embeddings import (
    EMBEDDING_DIM,
    embed,
    make_embedding_input,
    serialize_vec,
)
from lifelog.embedding_cache import store_batch as cache_store_batch

DB_PATH = DATA_DIR / "lifelog.db"

_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT DEFAULT '',
    title         TEXT NOT NULL,
    content       TEXT,
    url           TEXT,
    happened_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    tags          TEXT DEFAULT '',
    accessed_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
    access_count  INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags,
    content='entries',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
    entry_id INTEGER PRIMARY KEY,
    embedding FLOAT[{EMBEDDING_DIM}]
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_url ON entries(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_happened_at ON entries(happened_at);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
"""


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.enable_load_extension(True)
    import sqlite_vec

    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA_SQL)
    conn.commit()


def insert_entry(
    conn: sqlite3.Connection,
    *,
    source: str = "",
    title: str,
    content: str | None = None,
    url: str | None = None,
    happened_at: str,
    tags: str = "",
) -> tuple[int, str]:
    """Insert an entry. Returns (entry_id, status) where status is 'created', 'updated', or 'skipped'."""
    embedding_input = make_embedding_input(title, content)
    vec = embed(embedding_input)
    cache_store_batch([(embedding_input, vec)])
    serialized = serialize_vec(vec)

    # URL dedup: update existing entry
    if url is not None:
        existing = conn.execute(
            "SELECT id FROM entries WHERE url = ?", (url,)
        ).fetchone()
        if existing:
            entry_id = existing["id"]
            conn.execute(
                """UPDATE entries
                   SET title = ?, content = ?, tags = ?, happened_at = ?,
                       accessed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')
                   WHERE id = ?""",
                (title, content, tags, happened_at, entry_id),
            )
            conn.execute(
                "UPDATE entries_vec SET embedding = ? WHERE entry_id = ?",
                (serialized, entry_id),
            )
            conn.commit()
            return entry_id, "updated"

    # Content dedup: skip if title+content match
    if url is None:
        existing = conn.execute(
            "SELECT id FROM entries WHERE title = ? AND content IS ? LIMIT 1",
            (title, content),
        ).fetchone()
        if existing:
            return existing["id"], "skipped"

    # New entry
    cursor = conn.execute(
        """INSERT INTO entries (source, title, content, url, happened_at, tags)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (source, title, content, url, happened_at, tags),
    )
    entry_id = cursor.lastrowid
    conn.execute(
        "INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)",
        (entry_id, serialized),
    )
    conn.commit()
    return entry_id, "created"


def delete_entry(conn: sqlite3.Connection, entry_id: int) -> bool:
    cursor = conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
    if cursor.rowcount == 0:
        return False
    conn.execute("DELETE FROM entries_vec WHERE entry_id = ?", (entry_id,))
    conn.commit()
    return True


def get_entry(conn: sqlite3.Connection, entry_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    if row is None:
        return None
    _touch_accessed(conn, [entry_id])
    # Re-read after touch to return updated access_count
    row = conn.execute(
        "SELECT * FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    return dict(row)


def list_entries(
    conn: sqlite3.Connection,
    *,
    source: str = "",
    since: str = "",
    until: str = "",
    limit: int = 20,
) -> list[dict]:
    conditions = []
    params: list = []
    if source:
        conditions.append("source = ?")
        params.append(source)
    if since:
        conditions.append("happened_at >= ?")
        params.append(since)
    if until:
        conditions.append("happened_at <= ?")
        params.append(until)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    params.append(limit)
    rows = conn.execute(
        f"SELECT * FROM entries {where} ORDER BY happened_at DESC LIMIT ?",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def get_stats(conn: sqlite3.Connection, db_path: Path | None = None) -> dict:
    path = db_path or DB_PATH
    total = conn.execute("SELECT COUNT(*) as c FROM entries").fetchone()["c"]

    source_counts = conn.execute(
        """SELECT source, COUNT(*) as c FROM entries
           GROUP BY source ORDER BY c DESC"""
    ).fetchall()

    db_size = path.stat().st_size if path.exists() else 0

    return {
        "total_entries": total,
        "sources": [{"source": r["source"] or "(empty)", "count": r["c"]} for r in source_counts],
        "db_size_bytes": db_size,
        "db_size_mb": round(db_size / (1024 * 1024), 2),
    }


def _touch_accessed(conn: sqlite3.Connection, entry_ids: list[int]) -> None:
    if not entry_ids:
        return
    placeholders = ",".join("?" for _ in entry_ids)
    conn.execute(
        f"""UPDATE entries
            SET accessed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
                access_count = access_count + 1
            WHERE id IN ({placeholders})""",
        entry_ids,
    )
    conn.commit()
