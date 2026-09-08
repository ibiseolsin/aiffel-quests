"""도구 경계 검증 (A05 · A07 의 도구 인자 오류 부분)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from my_harness.approval import AutoApprover, RejectAllApprover
from my_harness.contracts import ToolCall
from my_harness.tools import ToolBox
from my_harness.workspace import Workspace


def box(work: Path, approver=None, **kwargs) -> ToolBox:
    return ToolBox(Workspace(work), approver or AutoApprover("테스트"), **kwargs)


def payload(outcome) -> dict:
    return json.loads(outcome.output)


@pytest.mark.asyncio
async def test_read_file_returns_content_and_hash(work: Path):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": "meeting.txt"}))
    assert outcome.ok
    body = payload(outcome)
    assert "9월 15일" in body["content"]
    assert len(body["sha256"]) == 64


@pytest.mark.asyncio
@pytest.mark.parametrize("path", [
    "../secret.txt",
    "work/../../secret.txt",
    ".hidden/notes.txt",
    "",
])
async def test_path_escape_is_rejected(work: Path, path: str):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": path}))
    assert not outcome.ok
    assert "path_rejected" in outcome.error


@pytest.mark.asyncio
async def test_absolute_path_outside_workspace_is_rejected(work: Path, outside: Path):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": str(outside)}))
    assert not outcome.ok
    assert "path_rejected" in outcome.error
    assert outside.read_text(encoding="utf-8").startswith("작업 폴더 밖")


@pytest.mark.asyncio
async def test_absolute_path_inside_workspace_is_accepted(work: Path):
    inside = (work / "meeting.txt").resolve().as_posix()
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": inside}))
    assert outcome.ok


@pytest.mark.asyncio
async def test_missing_file_is_reported_not_crashed(work: Path):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": "없는파일.txt"}))
    assert not outcome.ok
    assert "not_found" in outcome.error
    assert "list_files" in outcome.hint


@pytest.mark.asyncio
async def test_invalid_arguments_are_rejected_by_schema(work: Path):
    tools = box(work)
    missing = await tools.run(ToolCall("1", "write_file", {"path": "a.txt"}))
    assert not missing.ok and "invalid_arguments" in missing.error
    extra = await tools.run(ToolCall("2", "read_file", {"path": "meeting.txt", "encoding": "utf8"}))
    assert not extra.ok and "invalid_arguments" in extra.error
    wrong_type = await tools.run(ToolCall("3", "read_file", {"path": 7}))
    assert not wrong_type.ok and "invalid_arguments" in wrong_type.error


@pytest.mark.asyncio
async def test_unknown_tool_is_reported_with_the_known_list(work: Path):
    outcome = await box(work).run(ToolCall("1", "delete_everything", {}))
    assert not outcome.ok
    assert "unknown_tool" in outcome.error
    assert "read_file" in outcome.hint


@pytest.mark.asyncio
async def test_write_requires_approval_and_rejection_leaves_file_untouched(work: Path):
    before = (work / "receipt.py").read_text(encoding="utf-8")
    tools = box(work, RejectAllApprover())
    outcome = await tools.run(ToolCall("1", "write_file",
                                       {"path": "receipt.py", "content": "raise SystemExit\n"}))
    assert not outcome.ok
    assert "rejected_by_user" in outcome.error
    assert (work / "receipt.py").read_text(encoding="utf-8") == before
    assert [item["action"] for item in tools.evidence] == ["write_rejected"]


@pytest.mark.asyncio
async def test_approved_write_applies_exactly_the_approved_content(work: Path):
    tools = box(work)
    content = "print('안녕')\n"
    outcome = await tools.run(ToolCall("1", "write_file", {"path": "hello.py", "content": content}))
    assert outcome.ok
    assert (work / "hello.py").read_text(encoding="utf-8") == content
    assert payload(outcome)["created"] is True


@pytest.mark.asyncio
async def test_write_outside_workspace_is_rejected(work: Path, outside: Path):
    outcome = await box(work).run(ToolCall("1", "write_file",
                                           {"path": "../outside/secret.txt", "content": "덮어씀"}))
    assert not outcome.ok and "path_rejected" in outcome.error
    assert outside.read_text(encoding="utf-8").startswith("작업 폴더 밖")


@pytest.mark.asyncio
async def test_run_python_executes_existing_file_only(work: Path):
    tools = box(work)
    (work / "show.py").write_text("print('실행됨')\n", encoding="utf-8")
    ok = await tools.run(ToolCall("1", "run_python", {"path": "show.py", "args": []}))
    assert ok.ok and "실행됨" in payload(ok)["stdout"]
    missing = await tools.run(ToolCall("2", "run_python", {"path": "없다.py", "args": []}))
    assert not missing.ok and "not_found" in missing.error
    not_python = await tools.run(ToolCall("3", "run_python", {"path": "meeting.txt", "args": []}))
    assert not not_python.ok and "not_python" in not_python.error


@pytest.mark.asyncio
async def test_run_python_failure_is_reported_as_failure(work: Path):
    (work / "boom.py").write_text("raise ValueError('터짐')\n", encoding="utf-8")
    outcome = await box(work).run(ToolCall("1", "run_python", {"path": "boom.py", "args": []}))
    assert not outcome.ok
    assert "tool_reported_failure" in outcome.error
    assert "터짐" in outcome.error


@pytest.mark.asyncio
async def test_run_python_timeout_is_reported(work: Path):
    (work / "slow.py").write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    outcome = await box(work, command_timeout=1).run(
        ToolCall("1", "run_python", {"path": "slow.py", "args": []}))
    assert not outcome.ok
    assert '"timed_out": true' in outcome.error


@pytest.mark.asyncio
async def test_run_tests_uses_the_fixed_target_and_takes_no_arguments(work: Path):
    tools = box(work, test_target=["-s", ".", "-p", "test_receipt.py"])
    assert "run_tests" in {spec.name for spec in tools.definitions}
    outcome = await tools.run(ToolCall("1", "run_tests", {}))
    assert not outcome.ok  # fixture 에는 결함이 두 개 있다
    assert "FAILED" in outcome.error
    refused = await tools.run(ToolCall("2", "run_tests", {"pattern": "test_other.py"}))
    assert not refused.ok and "invalid_arguments" in refused.error


@pytest.mark.asyncio
async def test_run_tests_is_not_registered_without_a_target(work: Path):
    assert "run_tests" not in {spec.name for spec in box(work).definitions}


@pytest.mark.asyncio
async def test_list_files_skips_hidden_and_pycache(work: Path):
    (work / ".env").write_text("SECRET=1\n", encoding="utf-8")
    (work / "__pycache__").mkdir()
    (work / "__pycache__" / "x.pyc").write_bytes(b"\x00")
    outcome = await box(work).run(ToolCall("1", "list_files", {}))
    files = payload(outcome)["files"]
    assert "meeting.txt" in files
    assert not any(name.startswith(".") or "__pycache__" in name for name in files)
