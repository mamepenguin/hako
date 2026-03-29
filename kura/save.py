from __future__ import annotations

import sqlite3
from datetime import datetime

from kura.db import insert_entry


def save_entry(
    conn: sqlite3.Connection,
    *,
    source: str = "",
    title: str,
    content: str | None = None,
    url: str | None = None,
    happened_at: str | None = None,
    tags: str = "",
) -> tuple[int, str]:
    """High-level save with validation.

    Returns (entry_id, status) where status is 'created', 'updated', or 'skipped'.
    """
    if not title.strip():
        raise ValueError("title is required")

    if source == "web" and not url:
        raise ValueError("url is required for source 'web'")

    if happened_at is None:
        happened_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    return insert_entry(
        conn,
        source=source,
        title=title,
        content=content,
        url=url,
        happened_at=happened_at,
        tags=tags,
    )
