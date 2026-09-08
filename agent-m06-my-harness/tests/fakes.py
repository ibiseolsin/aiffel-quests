"""모의 모델 (A02 · A06 · A07).

실제 모델 없이 반복·인자 검사·한도·오류 처리를 검증한다. 모의 검증은 실제 모델
검증을 대신하지 않는다 — ACCEPTANCE.md 에 둘을 따로 적는다.
"""
from __future__ import annotations

from typing import Any

from my_harness.contracts import ModelTurn, ProviderError, ToolCall, ToolSpec, Usage


class ScriptedProvider:
    """미리 정해 둔 응답을 순서대로 내놓는다. 다 쓰면 마지막 응답을 반복한다."""

    name = "scripted"

    def __init__(self, turns: list[ModelTurn], *, repeat_last: bool = False):
        if not turns:
            raise ValueError("응답이 하나는 있어야 한다")
        self.model = "scripted-model"
        self.turns = turns
        self.repeat_last = repeat_last
        self.calls: list[list[dict[str, Any]]] = []

    async def complete(self, messages: list[dict[str, Any]], tools: list[ToolSpec]) -> ModelTurn:
        self.calls.append([dict(message) for message in messages])
        index = len(self.calls) - 1
        if index < len(self.turns):
            return self.turns[index]
        if self.repeat_last:
            return self.turns[-1]
        raise AssertionError("모의 모델에 준비된 응답보다 많이 요청했다")


class BrokenProvider:
    """모델 API 연결 실패를 흉내낸다 (R07 의 두 번째 줄)."""

    name = "broken"
    model = "broken-model"

    def __init__(self, message: str = "연결이 거부됐다"):
        self.message = message
        self.calls = 0

    async def complete(self, messages, tools) -> ModelTurn:
        self.calls += 1
        raise ProviderError(self.message)


def turn_calls(*specs: tuple[str, str, dict], text: str = "") -> ModelTurn:
    calls = [ToolCall(identifier, name, arguments) for identifier, name, arguments in specs]
    return ModelTurn(text=text, calls=calls, usage=Usage(10, 5, True))


def turn_answer(text: str) -> ModelTurn:
    return ModelTurn(text=text, calls=[], usage=Usage(10, 5, True))
