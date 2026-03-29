from __future__ import annotations

import click

from kura.db import (
    get_connection,
    delete_entry,
    get_entry,
    list_entries,
    list_sources,
    get_stats,
)
from kura.save import save_entry
from kura.search import hybrid_search


@click.group()
def main():
    """Kura: data store with hybrid search."""
    pass


@main.command()
@click.option("--title", required=True, help="Entry title")
@click.option("--content", default=None, help="Entry content or excerpt")
@click.option("--source", default="", help="Data source identifier (e.g. web, email, craft)")
@click.option("--url", default=None, help="Related URL")
@click.option("--tags", default="", help="Comma-separated tags")
@click.option("--happened-at", default=None, help="When it happened (ISO 8601)")
def add(title, content, source, url, tags, happened_at):
    """Add an entry."""
    conn = get_connection()
    try:
        entry_id, status = save_entry(
            conn, source=source, title=title, content=content, url=url,
            happened_at=happened_at, tags=tags,
        )
        click.echo(f"{status}: id={entry_id} {title}")
    finally:
        conn.close()


@main.command()
def sources():
    """List known data sources."""
    conn = get_connection()
    try:
        src_list = list_sources(conn)
        if not src_list:
            click.echo("No sources found.")
            return
        for s in src_list:
            click.echo(f"  {s['source']}: {s['count']}")
    finally:
        conn.close()


@main.command()
@click.argument("query")
@click.option("--source", default="", help="Filter by source")
@click.option("--limit", default=10, help="Max results")
def search(query, source, limit):
    """Search entries with hybrid search."""
    conn = get_connection()
    try:
        results = hybrid_search(conn, query, source=source, limit=limit)
        if not results:
            click.echo("No results found.")
            return
        for r in results:
            _print_entry_summary(r)
    finally:
        conn.close()


@main.command("list")
@click.option("--source", default="", help="Filter by source")
@click.option("--since", default="", help="From date (ISO 8601)")
@click.option("--until", default="", help="To date (ISO 8601)")
@click.option("--limit", default=20, help="Max results")
def list_cmd(source, since, until, limit):
    """List entries chronologically."""
    conn = get_connection()
    try:
        entries = list_entries(conn, source=source, since=since, until=until, limit=limit)
        if not entries:
            click.echo("No entries found.")
            return
        for e in entries:
            _print_entry_summary(e)
    finally:
        conn.close()


@main.command()
@click.argument("entry_id", type=int)
def show(entry_id):
    """Show entry details."""
    conn = get_connection()
    try:
        entry = get_entry(conn, entry_id)
        if entry is None:
            click.echo(f"Entry {entry_id} not found.")
            return
        _print_entry_detail(entry)
    finally:
        conn.close()


@main.command()
@click.argument("entry_id", type=int)
@click.confirmation_option(prompt="Are you sure you want to delete this entry?")
def delete(entry_id):
    """Delete an entry."""
    conn = get_connection()
    try:
        if delete_entry(conn, entry_id):
            click.echo(f"Deleted entry {entry_id}.")
        else:
            click.echo(f"Entry {entry_id} not found.")
    finally:
        conn.close()


@main.command()
def stats():
    """Show database statistics."""
    conn = get_connection()
    try:
        s = get_stats(conn)
        click.echo(f"Total entries: {s['total_entries']}")
        click.echo(f"DB size: {s['db_size_mb']} MB")
        if s["sources"]:
            click.echo("\nBy source:")
            for src in s["sources"]:
                click.echo(f"  {src['source']}: {src['count']}")
    finally:
        conn.close()


def _print_entry_summary(entry: dict) -> None:
    score = entry.get("score", "")
    score_str = f" [{score:.4f}]" if score != "" else ""
    source = entry.get("source", "")
    source_str = f" ({source})" if source else ""
    click.echo(f"  [{entry['id']}]{source_str} {entry['title']}{score_str}")
    if entry.get("url"):
        click.echo(f"       {entry['url']}")
    click.echo(f"       {entry['happened_at']}")


def _print_entry_detail(entry: dict) -> None:
    click.echo(f"ID:          {entry['id']}")
    click.echo(f"Title:       {entry['title']}")
    click.echo(f"Source:      {entry['source'] or '(none)'}")
    if entry.get("url"):
        click.echo(f"URL:         {entry['url']}")
    click.echo(f"Happened at: {entry['happened_at']}")
    click.echo(f"Created at:  {entry['created_at']}")
    click.echo(f"Tags:        {entry['tags'] or '(none)'}")
    click.echo(f"Accessed:    {entry['access_count']} times")
    if entry.get("content"):
        click.echo(f"\n{entry['content']}")
