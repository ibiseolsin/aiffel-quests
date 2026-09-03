"""F2 채점 — 에이전트에게 주지 않는다."""
import json

from src.emit import emit


def test_example_from_plan():
    assert emit([{"a": 1}, {"b": 2}]) == '{"a": 1}\n{"b": 2}'


def test_no_trailing_newline():
    assert not emit([{"a": 1}]).endswith("\n")


def test_empty_is_empty_string():
    assert emit([]) == ""


def test_each_line_parses():
    out = emit([{"a": 1}, {"b": 2}, {"c": 3}])
    assert [json.loads(x) for x in out.split("\n")] == [{"a": 1}, {"b": 2}, {"c": 3}]


def test_non_ascii_not_escaped():
    assert emit([{"a": "가"}]) == '{"a": "가"}'
