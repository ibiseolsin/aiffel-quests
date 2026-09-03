"""F3 채점 — 에이전트에게 주지 않는다."""
import pytest

from src.config import load_config


def test_example_from_plan():
    assert load_config({"LLM_BASE_URL": "http://x"}) == {"base_url": "http://x"}


def test_old_name_is_not_read():
    with pytest.raises(KeyError):
        load_config({"OLLAMA_URL": "http://y"})


def test_missing_raises():
    with pytest.raises(KeyError):
        load_config({})


def test_no_fallback_default():
    with pytest.raises(KeyError):
        load_config({"SOMETHING_ELSE": "http://z"})
