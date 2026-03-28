from __future__ import annotations

import tomllib
from pathlib import Path

DATA_DIR = Path.home() / ".lifelog"
CONFIG_PATH = DATA_DIR / "config.toml"

_DEFAULT_CONFIG = {
    "search": {
        "rrf_k": 60,
        "time_decay_half_life_days": 180.0,
        "time_decay_floor": 0.1,
    },
    "embedding": {
        "model": "cl-nagoya/ruri-v3-310m",
        "max_content_chars": 500,
    },
}


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return _DEFAULT_CONFIG
    with open(CONFIG_PATH, "rb") as f:
        cfg = tomllib.load(f)
    merged = {}
    for section, defaults in _DEFAULT_CONFIG.items():
        merged[section] = {**defaults, **cfg.get(section, {})}
    return merged


def get_search_config() -> dict:
    return load_config()["search"]


def get_embedding_config() -> dict:
    return load_config()["embedding"]
