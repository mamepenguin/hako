from __future__ import annotations

from lifelog.embeddings import make_embedding_input, serialize_vec, deserialize_vec


def test_make_embedding_input_title_only(tmp_data_dir):
    result = make_embedding_input("Test Title", None)
    assert result == "Test Title"


def test_make_embedding_input_title_and_content(tmp_data_dir):
    result = make_embedding_input("Title", "Some content here")
    assert result == "Title Some content here"


def test_make_embedding_input_truncates_content(tmp_data_dir):
    long_content = "x" * 1000
    result = make_embedding_input("Title", long_content)
    # default max_content_chars = 500
    assert len(result) == len("Title ") + 500


def test_serialize_deserialize_roundtrip():
    vec = [0.1, 0.2, 0.3, -0.5, 1.0]
    data = serialize_vec(vec)
    restored = deserialize_vec(data)
    assert len(restored) == len(vec)
    for a, b in zip(vec, restored):
        assert abs(a - b) < 1e-6


def test_serialize_vec_768():
    vec = [float(i) / 768 for i in range(768)]
    data = serialize_vec(vec)
    assert len(data) == 768 * 4
    restored = deserialize_vec(data)
    assert len(restored) == 768
