"""Plugin: save web pages by URL."""

from __future__ import annotations

import click
import httpx

from kura.db import get_connection
from kura.fetchers.web import fetch_page
from kura.save import save_entry


@click.command()
@click.argument("url")
@click.option("--title", default="", help="Override page title (auto-detected if omitted)")
@click.option("--content", default=None, help="Override content (auto-extracted if omitted)")
@click.option("--tags", default="", help="Comma-separated tags")
@click.option("--happened-at", default=None, help="When you saw it (ISO 8601)")
def main(url, title, content, tags, happened_at):
    """Fetch a web page and save it."""
    try:
        click.echo(f"Fetching {url} ...")
        page = fetch_page(url)
        if not title:
            title = page.title
        if content is None:
            content = page.content
        url = page.url  # resolved after redirects
    except httpx.HTTPError as exc:
        click.echo(f"Fetch failed: {exc}", err=True)
        if not title:
            title = url

    conn = get_connection()
    try:
        entry_id, status = save_entry(
            conn, source="web", title=title, content=content, url=url,
            happened_at=happened_at, tags=tags,
        )
        click.echo(f"{status}: id={entry_id} {title}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
