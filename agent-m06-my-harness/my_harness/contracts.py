"""제공자·도구·반복이 공유하는 내부 계약.

이 모듈은 어떤 모델 제공자의 필드도 알지 못한다. 제공자 어댑터가 자기 형식을
여기로 번역하고, 반복(loop)과 도구는 이 형식만 본다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(RuntimeError):
    """모델 API 연결·응답 문제. 모델에 돌려주지 않고 반복을 중단한다 (R07)."""


class ApprovalRejected(Exception):
    """사용자가 변경을 거절했다. 도구 실패로 모델에 돌려준다 (R05)."""


class ToolRejected(Exception):
    """도구가 인자·경로·상태를 이유로 실행을 거부했다. 모델에 돌려준다 (R07)."""

    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.hint = code, message, hint


@dataclass(frozen=True)
class ToolSpec:
    """모델에 보여 줄 도구 하나의 이름·설명·인자 스키마."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    """모델이 요청한 도구 호출. arguments 는 아직 검사되지 않았다."""

    id: str
    name: str
    arguments: dict[str, Any] | str


@dataclass(frozen=True)
class ToolOutcome:
    """도구 실행 결과. 이 형태 그대로 모델에 돌아간다."""

    call_id: str
    name: str
    ok: bool
    output: str = ""
    error: str = ""
    hint: str = ""

    def envelope(self) -> dict[str, Any]:
        value: dict[str, Any] = {"ok": self.ok}
        if self.ok:
            value["output"] = self.output
        else:
            value["error"] = self.error
            if self.hint:
                value["hint"] = self.hint
        return value


@dataclass(frozen=True)
class Usage:
    """모르는 값을 0 으로 쓰지 않기 위해 known 을 따로 들고 다닌다."""

    input_tokens: int = 0
    output_tokens: int = 0
    known: bool = True


@dataclass
class ModelTurn:
    """모델 한 번의 응답을 제공자 독립 형태로 옮긴 것."""

    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    # 다음 요청에 그대로 돌려줘야 하는 제공자별 항목 (Ollama thinking 등).
    opaque: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class Limits:
    """모든 값은 양수다. 0 이나 음수는 '한도 없음' 이 아니라 설정 오류다."""

    max_steps: int = 12
    max_tool_calls: int = 30
    max_seconds: float = 300.0
    tool_timeout_seconds: float = 30.0
    max_tool_output_chars: int = 16_000
    # 2.3B 로컬 모델의 실제 window 에 맞춘 값. 제공자 num_ctx 를 여기서 유도한다.
    max_context_chars: int = 60_000

    def __post_init__(self) -> None:
        values = [self.max_steps, self.max_tool_calls, self.max_seconds,
                  self.tool_timeout_seconds, self.max_tool_output_chars, self.max_context_chars]
        if min(values) <= 0:
            raise ValueError("모든 실행 한도는 양수여야 한다")


@dataclass
class Metrics:
    model_calls: int = 0
    tool_calls: int = 0
    tool_errors: int = 0
    approvals_granted: int = 0
    approvals_rejected: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    usage_known: bool = True
    elapsed_seconds: float = 0.0


# 종료 상태. completed 만 "모델이 스스로 답을 내고 끝냈다" 는 뜻이며,
# 답이 맞다는 뜻은 아니다 (정답 판단은 채점기·사람이 한다).
TERMINAL_STATUSES = (
    "completed",       # 모델이 도구 없이 최종 답을 냈다
    "step_limit",      # 모델 호출 한도
    "tool_limit",      # 도구 호출 한도
    "timeout",         # 전체 시간 한도
    "context_limit",   # 대화 길이 한도
    "provider_error",  # 모델 API 연결·응답 실패 (사용자에게 표시)
    "failed",          # 그 밖의 하네스 예외
)


@dataclass
class RunOutcome:
    status: str
    answer: str
    reason: str
    metrics: Metrics
    evidence: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)


class Provider(Protocol):
    """모델 제공자 어댑터. D08 을 미뤘으므로 구현체는 Ollama 하나다."""

    name: str
    model: str

    async def complete(self, messages: list[dict[str, Any]], tools: list[ToolSpec]) -> ModelTurn: ...


class ToolBackend(Protocol):
    """도구 모음. 반복은 definitions 와 run() 만 안다."""

    definitions: list[ToolSpec]

    async def run(self, call: ToolCall) -> ToolOutcome: ...
