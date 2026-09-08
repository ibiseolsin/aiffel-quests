"""반복·한도·오류 구분 검증 (A02 · A06 · A07)."""
from __future__ import annotations

import json
from pathlib import Path

from my_harness.approval import AutoApprover, RejectAllApprover
from my_harness.contracts import Limits, ModelTurn, ToolCall, Usage
from my_harness.loop import Harness
from my_harness.session import EventLog
from my_harness.tools import ToolBox
from my_harness.workspace import Workspace

from fakes import BrokenProvider, ScriptedProvider, turn_answer, turn_calls


def harness(work: Path, provider, *, approver=None, limits=None, log=None, **kwargs) -> Harness:
    tools = ToolBox(Workspace(work), approver or AutoApprover("테스트"), **kwargs)
    return Harness(provider, tools, limits=limits or Limits(max_steps=4, max_tool_calls=6),
                   log=log)


def tool_messages(messages: list[dict]) -> list[dict]:
    return [json.loads(message["content"]) for message in messages
            if message["role"] == "tool"]


async def test_tool_call_is_validated_executed_and_returned(work: Path):
    """A02: 모의 모델이 도구를 요청하면 인자 검사 → 실행 → 결과 반환 → 종료."""
    provider = ScriptedProvider([
        turn_calls(("c1", "read_file", {"path": "meeting.txt"})),
        turn_answer("모임은 9월 15일 저녁 7시 30분이고 노트북과 충전기를 가져가야 한다."),
    ])
    outcome = await harness(work, provider).run("meeting.txt 를 읽고 시각과 준비물을 알려 줘")
    assert outcome.status == "completed"
    assert "7시 30분" in outcome.answer
    results = tool_messages(outcome.messages)
    assert results[0]["ok"] is True
    assert "9월 15일" in results[0]["output"]
    assert [item["action"] for item in outcome.evidence] == ["read"]
    assert outcome.metrics.model_calls == 2 and outcome.metrics.tool_calls == 1


async def test_invalid_tool_arguments_go_back_to_the_model(work: Path):
    """A07 앞줄: 도구 인자 오류는 모델에 반환하고 반복을 계속한다."""
    provider = ScriptedProvider([
        turn_calls(("c1", "read_file", {"path": "../../etc/passwd"})),
        turn_calls(("c2", "read_file", {"path": "meeting.txt"})),
        turn_answer("경로를 고쳐 읽었다."),
    ])
    outcome = await harness(work, provider).run("파일을 읽어 줘")
    assert outcome.status == "completed"
    results = tool_messages(outcome.messages)
    assert results[0]["ok"] is False and "path_rejected" in results[0]["error"]
    assert results[1]["ok"] is True
    # 실패한 호출도 지표에 남는다 — 성공으로 세지 않는다.
    assert outcome.metrics.tool_errors == 1


async def test_provider_failure_stops_the_run_and_is_shown_to_the_user(work: Path):
    """A07 뒷줄: 모델 API 실패는 모델에 돌려주지 않고 provider_error 로 끝낸다."""
    provider = BrokenProvider("연결이 거부됐다")
    outcome = await harness(work, provider).run("아무거나 해 줘")
    assert outcome.status == "provider_error"
    assert "연결이 거부됐다" in outcome.reason
    assert outcome.answer == ""
    assert outcome.metrics.usage_known is False
    assert tool_messages(outcome.messages) == []


async def test_repeating_mock_stops_at_the_step_limit(work: Path):
    """A06: 계속 도구만 부르는 모의 모델은 합의한 한도에서 멈추고 이유를 남긴다."""
    provider = ScriptedProvider([turn_calls(("c1", "list_files", {}))], repeat_last=True)
    limits = Limits(max_steps=3, max_tool_calls=99)
    outcome = await harness(work, provider, limits=limits).run("계속 뭔가 해 봐")
    assert outcome.status == "step_limit"
    assert "3회" in outcome.reason
    assert outcome.metrics.model_calls == 3


async def test_repeating_mock_stops_at_the_tool_call_limit(work: Path):
    provider = ScriptedProvider([turn_calls(("c1", "list_files", {}), ("c2", "list_files", {}))],
                                repeat_last=True)
    limits = Limits(max_steps=99, max_tool_calls=4)
    outcome = await harness(work, provider, limits=limits).run("계속 뭔가 해 봐")
    assert outcome.status == "tool_limit"
    assert outcome.metrics.tool_calls == 4


async def test_total_timeout_is_reported_as_timeout(work: Path):
    (work / "slow.py").write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
    provider = ScriptedProvider([turn_calls(("c1", "run_python", {"path": "slow.py", "args": []}))],
                                repeat_last=True)
    limits = Limits(max_steps=5, max_tool_calls=5, max_seconds=1.5, tool_timeout_seconds=10)
    outcome = await harness(work, provider, limits=limits, command_timeout=9).run("느린 걸 실행해")
    assert outcome.status == "timeout"
    assert outcome.metrics.usage_known is False


async def test_rejected_change_keeps_the_run_going_and_the_file_unchanged(work: Path):
    """A04: 거절하면 파일은 그대로고, 반복은 계속된다."""
    before = (work / "receipt.py").read_text(encoding="utf-8")
    provider = ScriptedProvider([
        turn_calls(("c1", "write_file", {"path": "receipt.py", "content": "raise SystemExit\n"})),
        turn_answer("거절되어 파일을 바꾸지 않았다."),
    ])
    outcome = await harness(work, provider, approver=RejectAllApprover()).run("코드를 고쳐 줘")
    assert outcome.status == "completed"
    assert (work / "receipt.py").read_text(encoding="utf-8") == before
    assert outcome.metrics.approvals_rejected == 1
    assert tool_messages(outcome.messages)[0]["error"].startswith("rejected_by_user")


async def test_model_with_neither_text_nor_tools_is_a_provider_error(work: Path):
    provider = ScriptedProvider([ModelTurn(text="   ", calls=[], usage=Usage(1, 1, True))])
    outcome = await harness(work, provider).run("아무거나")
    assert outcome.status == "provider_error"


async def test_unknown_usage_is_not_counted_as_zero(work: Path):
    provider = ScriptedProvider([ModelTurn(text="끝", calls=[], usage=Usage(0, 0, False))])
    outcome = await harness(work, provider).run("아무거나")
    assert outcome.status == "completed"
    assert outcome.metrics.usage_known is False


async def test_long_tool_output_is_truncated_with_the_original_size(work: Path):
    (work / "big.txt").write_text("가" * 20_000, encoding="utf-8")
    provider = ScriptedProvider([
        turn_calls(("c1", "read_file", {"path": "big.txt"})),
        turn_answer("읽었다"),
    ])
    limits = Limits(max_steps=3, max_tool_calls=3, max_tool_output_chars=2_000)
    outcome = await harness(work, provider, limits=limits).run("큰 파일을 읽어 줘")
    output = tool_messages(outcome.messages)[0]["output"]
    assert len(output) <= 2_000
    assert "출력 생략" in output


async def test_context_limit_stops_before_calling_the_model(work: Path):
    provider = ScriptedProvider([turn_answer("여기까지 오지 않는다")])
    limits = Limits(max_steps=3, max_tool_calls=3, max_context_chars=10)
    outcome = await harness(work, provider, limits=limits).run("짧은 요청")
    assert outcome.status == "context_limit"
    assert provider.calls == []


async def test_duplicate_call_ids_are_made_unique(work: Path):
    provider = ScriptedProvider([
        turn_calls(("same", "list_files", {}), ("same", "list_files", {})),
        turn_answer("끝"),
    ])
    outcome = await harness(work, provider).run("두 번 불러 봐")
    ids = [message["call_id"] for message in outcome.messages if message["role"] == "tool"]
    assert len(ids) == len(set(ids)) == 2


async def test_events_are_recorded_for_every_step(work: Path, tmp_path: Path):
    log = EventLog(tmp_path / "events.jsonl")
    provider = ScriptedProvider([
        turn_calls(("c1", "read_file", {"path": "meeting.txt"})),
        turn_answer("끝"),
    ])
    await harness(work, provider, log=log).run("읽어 줘")
    events = [json.loads(line) for line in log.path.read_text(encoding="utf-8").splitlines()]
    names = [event["event"] for event in events]
    assert names[0] == "run_start" and names[-1] == "run_end"
    assert "tool_call" in names and "tool_result" in names
    # 기록에 파일 내용이나 도구 인자를 넣지 않는다.
    assert "9월 15일" not in log.path.read_text(encoding="utf-8")
