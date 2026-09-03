"""F1 채점 — 에이전트에게 주지 않는다. 실행이 끝난 뒤에만 복사한다."""
from src.chunk_id import make_chunk_id


def test_example_from_plan():
    assert make_chunk_id("hr-guide", 3, 5) == "hr-guide-p3-c5"


def test_no_zero_padding():
    assert make_chunk_id("x", 0, 0) == "x-p0-c0"
    assert make_chunk_id("x", 12, 7) == "x-p12-c7"


def test_same_page_chunks_differ():
    assert make_chunk_id("d", 1, 0) != make_chunk_id("d", 1, 1)
