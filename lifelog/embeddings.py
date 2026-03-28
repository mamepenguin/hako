from __future__ import annotations

import struct
import typing

if typing.TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

from lifelog.config import get_embedding_config

_model: SentenceTransformer | None = None

EMBEDDING_DIM = 768


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        cfg = get_embedding_config()
        _model = SentenceTransformer(cfg["model"])
    return _model


def make_embedding_input(title: str, content: str | None) -> str:
    cfg = get_embedding_config()
    max_chars = cfg["max_content_chars"]
    text = title
    if content:
        text += " " + content[:max_chars]
    return text


def embed(text: str) -> list[float]:
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True)
    return vec.tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    model = _get_model()
    vecs = model.encode(texts, normalize_embeddings=True, batch_size=32)
    return vecs.tolist()


def serialize_vec(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def deserialize_vec(data: bytes) -> list[float]:
    n = len(data) // 4
    return list(struct.unpack(f"{n}f", data))
