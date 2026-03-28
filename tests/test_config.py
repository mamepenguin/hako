from __future__ import annotations

import tomllib
from pathlib import Path

from lifelog.config import load_config, get_search_config, get_embedding_config


def test_defaults_when_no_config(tmp_data_dir):
    cfg = load_config()
    assert cfg["search"]["rrf_k"] == 60
    assert cfg["search"]["time_decay_half_life_days"] == 180.0
    assert cfg["search"]["time_decay_floor"] == 0.1
    assert cfg["embedding"]["model"] == "cl-nagoya/ruri-v3-310m"
    assert cfg["embedding"]["max_content_chars"] == 500


def test_partial_override(tmp_data_dir):
    config_path = tmp_data_dir / "config.toml"
    config_path.write_text('[search]\nrrf_k = 80\n')
    cfg = load_config()
    assert cfg["search"]["rrf_k"] == 80
    assert cfg["search"]["time_decay_half_life_days"] == 180.0
    assert cfg["embedding"]["model"] == "cl-nagoya/ruri-v3-310m"


def test_get_search_config(tmp_data_dir):
    cfg = get_search_config()
    assert "rrf_k" in cfg
    assert "time_decay_half_life_days" in cfg
    assert "time_decay_floor" in cfg


def test_get_embedding_config(tmp_data_dir):
    cfg = get_embedding_config()
    assert "model" in cfg
    assert "max_content_chars" in cfg
