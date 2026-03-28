from __future__ import annotations

from lifelog.embedding_cache import lookup_batch, store_batch


def test_store_and_lookup(tmp_data_dir):
    cache_path = tmp_data_dir / "embedding_cache.db"
    vec = [0.1] * 768
    store_batch([("hello world", vec)], cache_path=cache_path)

    result = lookup_batch(["hello world"], cache_path=cache_path)
    assert result["hello world"] is not None
    assert len(result["hello world"]) == 768
    assert abs(result["hello world"][0] - 0.1) < 1e-6


def test_lookup_miss(tmp_data_dir):
    cache_path = tmp_data_dir / "embedding_cache.db"
    result = lookup_batch(["nonexistent"], cache_path=cache_path)
    assert result["nonexistent"] is None


def test_store_overwrite(tmp_data_dir):
    cache_path = tmp_data_dir / "embedding_cache.db"
    vec1 = [0.1] * 768
    vec2 = [0.9] * 768
    store_batch([("text", vec1)], cache_path=cache_path)
    store_batch([("text", vec2)], cache_path=cache_path)

    result = lookup_batch(["text"], cache_path=cache_path)
    assert abs(result["text"][0] - 0.9) < 1e-6


def test_batch_operations(tmp_data_dir):
    cache_path = tmp_data_dir / "embedding_cache.db"
    items = [(f"text_{i}", [float(i) / 768] * 768) for i in range(10)]
    store_batch(items, cache_path=cache_path)

    texts = [f"text_{i}" for i in range(10)] + ["missing"]
    result = lookup_batch(texts, cache_path=cache_path)
    for i in range(10):
        assert result[f"text_{i}"] is not None
    assert result["missing"] is None
