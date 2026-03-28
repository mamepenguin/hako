"""Local embedding cache to avoid recomputation.

Stores content_hash -> embedding mappings in a lightweight SQLite DB
at ~/.lifelog/embedding_cache.db.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from lifelog.config import DATA_DIR
from lifelog.embeddings import EMBEDDING_DIM, serialize_vec, deserialize_vec

CACHE_PATH = DATA_DIR / "embedding_cache.db"


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def _get_cache_conn(cache_path: Path | None = None) -> sqlite3.Connection:
    path = cache_path or CACHE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS embedding_cache (
            content_hash TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
        )
    """)
    conn.commit()
    return conn


def lookup_batch(
    contents: list[str], cache_path: Path | None = None
) -> dict[str, list[float] | None]:
    """Look up cached embeddings for a batch of contents."""
    conn = _get_cache_conn(cache_path)
    try:
        result: dict[str, list[float] | None] = {}
        hash_to_content: dict[str, str] = {}
        for content in contents:
            h = _content_hash(content)
            hash_to_content[h] = content
            result[content] = None

        hashes = list(hash_to_content.keys())
        for i in range(0, len(hashes), 500):
            batch = hashes[i : i + 500]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"SELECT content_hash, embedding FROM embedding_cache WHERE content_hash IN ({placeholders})",
                batch,
            ).fetchall()
            for row in rows:
                content = hash_to_content[row[0]]
                result[content] = deserialize_vec(row[1])

        return result
    finally:
        conn.close()


def store_batch(
    items: list[tuple[str, list[float]]], cache_path: Path | None = None
) -> None:
    """Store content -> embedding pairs in the cache."""
    if not items:
        return
    conn = _get_cache_conn(cache_path)
    try:
        conn.executemany(
            "INSERT OR REPLACE INTO embedding_cache (content_hash, embedding) VALUES (?, ?)",
            [(_content_hash(content), serialize_vec(vec)) for content, vec in items],
        )
        conn.commit()
    finally:
        conn.close()
