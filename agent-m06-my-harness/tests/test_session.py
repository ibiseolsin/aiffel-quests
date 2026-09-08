"""세션 검증 (A08 · A09)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from my_harness.approval import AutoApprover
from my_harness.contracts import Limits
from my_harness.loop import Harness
from my_harness.session import Session, close_pending
from my_harness.tools import ToolBox
from my_harness.workspace import Workspace

from fakes import ScriptedProvider, turn_answer, turn_calls

SETTINGS = {"provider": "scripted", "model": "scripted-model"}


def build(work: Path, provider, session: Session) -> Harness:
    tools = ToolBox(Workspace(work), AutoApprover("테스트"))
    return Harness(provider, tools, limits=Limits(max_steps=4, max_tool_calls=6),
                   session=session, settings=SETTINGS)


async def test_second_request_in_the_same_session_sees_the_first(work: Path, tmp_path: Path):
    """A08: 같은 세션의 후속 요청은 이전 대화를 이어받는다."""
    session = Session(tmp_path / "sessions", "reading")
    first = ScriptedProvider([
        turn_calls(("c1", "read_file", {"path": "meeting.txt"})),
        turn_answer("9월 15일 저녁 7시 30분이다."),
    ])
    await build(work, first, session).run("모임 시각이 언제야?")

    second = ScriptedProvider([turn_answer("준비물은 노트북·충전기·실습 로그다.")])
    outcome = await build(work, second, session).run("그럼 준비물은?")
    assert outcome.status == "completed"
    # 두 번째 모델 요청이 첫 요청과 그 도구 결과를 이미 들고 있다.
    sent = second.calls[0]
    roles = [message["role"] for message in sent]
    assert roles.count("user") == 2 and "tool" in roles
    assert any("모임 시각이 언제야?" == message.get("content") for message in sent)


async def test_restart_restores_from_the_file(work: Path, tmp_path: Path):
    """A09: 프로세스가 끝난 뒤 새 Session 객체로도 복원된다 (파일 영속, D07)."""
    directory = tmp_path / "sessions"
    provider = ScriptedProvider([turn_answer("첫 답")])
    await build(work, provider, Session(directory, "resume")).run("첫 요청")

    reopened = Session(directory, "resume")
    assert reopened.exists
    restored = reopened.load(SETTINGS)
    assert [message["role"] for message in restored][:2] == ["system", "user"]
    assert any(message.get("content") == "첫 답" for message in restored)


async def test_missing_session_starts_fresh_without_claiming_restore(tmp_path: Path):
    session = Session(tmp_path / "sessions", "none-yet")
    assert session.exists is False
    assert session.load(SETTINGS) == []


def test_different_settings_are_refused(tmp_path: Path):
    session = Session(tmp_path / "sessions", "mismatch")
    session.save(SETTINGS, [{"role": "user", "content": "안녕"}])
    with pytest.raises(ValueError, match="설정이 다르다"):
        session.load({**SETTINGS, "model": "other-model"})


def test_bad_session_name_is_refused(tmp_path: Path):
    with pytest.raises(ValueError):
        Session(tmp_path / "sessions", "이름/슬래시")


def test_save_is_atomic_and_leaves_no_temp_files(tmp_path: Path):
    directory = tmp_path / "sessions"
    session = Session(directory, "atomic")
    session.save(SETTINGS, [{"role": "user", "content": "하나"}])
    session.save(SETTINGS, [{"role": "user", "content": "둘"}])
    assert [path.name for path in sorted(directory.iterdir())] == ["atomic.json"]
    data = json.loads(session.path.read_text(encoding="utf-8"))
    assert data["messages"][-1]["content"] == "둘"


def test_pending_tool_calls_are_closed_as_failures_not_reexecuted():
    messages = [
        {"role": "user", "content": "요청"},
        {"role": "assistant", "content": "", "calls": [{"id": "c1", "name": "write_file",
                                                        "arguments": {}}]},
    ]
    close_pending(messages)
    assert messages[-1]["role"] == "tool"
    envelope = json.loads(messages[-1]["content"])
    assert envelope["ok"] is False and "interrupted" in envelope["error"]
