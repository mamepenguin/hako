from __future__ import annotations

import hashlib
import struct
from unittest.mock import patch

import pytest

EMBEDDING_DIM = 768


def _deterministic_vec(text: str) -> list[float]:
    """Generate a deterministic 768-dim vector from text hash."""
    h = hashlib.sha256(text.encode()).digest()
    rng_seed = int.from_bytes(h[:4], "big")
    import random

    rng = random.Random(rng_seed)
    vec = [rng.gauss(0, 1) for _ in range(EMBEDDING_DIM)]
    norm = sum(x * x for x in vec) ** 0.5
    return [x / norm for x in vec]


@pytest.fixture()
def tmp_data_dir(tmp_path, monkeypatch):
    """Override DATA_DIR and CONFIG_PATH to use tmp directory."""
    monkeypatch.setattr("lifelog.config.DATA_DIR", tmp_path)
    monkeypatch.setattr("lifelog.config.CONFIG_PATH", tmp_path / "config.toml")
    return tmp_path


@pytest.fixture()
def mock_embed(monkeypatch):
    """Mock embed and embed_batch to avoid loading sentence-transformers."""

    def fake_embed(text: str) -> list[float]:
        return _deterministic_vec(text)

    def fake_embed_batch(texts: list[str]) -> list[list[float]]:
        return [_deterministic_vec(t) for t in texts]

    monkeypatch.setattr("lifelog.embeddings.embed", fake_embed)
    monkeypatch.setattr("lifelog.embeddings.embed_batch", fake_embed_batch)
    return fake_embed
