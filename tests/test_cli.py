from __future__ import annotations

from unittest.mock import patch

from click.testing import CliRunner

from lifelog.cli import main
from lifelog.db import get_connection


def _runner_with_db(tmp_data_dir, mock_embed):
    db_path = tmp_data_dir / "test.db"
    runner = CliRunner()

    def invoke(*args, **kwargs):
        with patch("lifelog.cli.get_connection", lambda: get_connection(db_path)):
            return runner.invoke(main, *args, catch_exceptions=False, **kwargs)

    return invoke


def test_ingest_web(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["ingest", "web", "--url", "https://example.com", "--title", "Test Page"])
    assert result.exit_code == 0
    assert "created" in result.output


def test_ingest_memo(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["ingest", "memo", "--title", "My Note", "--content", "Hello world"])
    assert result.exit_code == 0
    assert "created" in result.output


def test_ingest_email(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["ingest", "email", "--title", "Subject", "--content", "Body text"])
    assert result.exit_code == 0
    assert "created" in result.output


def test_search(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "memo", "--title", "Python tips", "--content", "Use list comprehensions"])
    result = invoke(["search", "Python"])
    assert result.exit_code == 0
    assert "Python tips" in result.output


def test_search_no_results(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["search", "nonexistent"])
    assert result.exit_code == 0
    assert "No results" in result.output


def test_list(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "memo", "--title", "Entry 1", "--content", "Content 1"])
    invoke(["ingest", "memo", "--title", "Entry 2", "--content", "Content 2"])
    result = invoke(["list"])
    assert result.exit_code == 0
    assert "Entry 1" in result.output
    assert "Entry 2" in result.output


def test_list_with_source_filter(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "web", "--url", "https://a.com", "--title", "Web"])
    invoke(["ingest", "memo", "--title", "Memo", "--content", "text"])
    result = invoke(["list", "--source", "web"])
    assert result.exit_code == 0
    assert "Web" in result.output
    assert "Memo" not in result.output


def test_show(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "memo", "--title", "Show Test", "--content", "Detail content"])
    result = invoke(["show", "1"])
    assert result.exit_code == 0
    assert "Show Test" in result.output
    assert "Detail content" in result.output


def test_show_not_found(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["show", "999"])
    assert result.exit_code == 0
    assert "not found" in result.output


def test_delete(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "memo", "--title", "To Delete", "--content", "Remove me"])
    result = invoke(["delete", "1", "--yes"])
    assert result.exit_code == 0
    assert "Deleted" in result.output

    result = invoke(["show", "1"])
    assert "not found" in result.output


def test_delete_not_found(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    result = invoke(["delete", "999", "--yes"])
    assert result.exit_code == 0
    assert "not found" in result.output


def test_stats(tmp_data_dir, mock_embed):
    invoke = _runner_with_db(tmp_data_dir, mock_embed)
    invoke(["ingest", "web", "--url", "https://a.com", "--title", "Web"])
    invoke(["ingest", "memo", "--title", "Memo", "--content", "text"])
    result = invoke(["stats"])
    assert result.exit_code == 0
    assert "Total entries: 2" in result.output
    assert "web: 1" in result.output
    assert "memo: 1" in result.output


def test_help(tmp_data_dir, mock_embed):
    runner = CliRunner()
    result = runner.invoke(main, ["--help"])
    assert result.exit_code == 0
    assert "Lifelog" in result.output
