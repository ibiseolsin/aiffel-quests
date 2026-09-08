"""작업 폴더 관측 검증 (기준 실행 기록에서 나온 변경).

기준 실행에서 관측된 두 증상을 회귀 검사로 고정한다.
1. 파일이 전부 숨김 경로인 작업 폴더에서 `list_files` 가 빈 목록만 주어 모델이 20단계를 태웠다.
2. 경로 실패 응답이 "list_files 를 다시 부르라" 로만 끝나 왕복이 반복됐다.
"""
from __future__ import annotations

import json
from pathlib import Path

from my_harness import orientation
from my_harness.approval import AutoApprover
from my_harness.contracts import ToolCall
from my_harness.tools import ToolBox
from my_harness.workspace import Workspace


def box(work: Path) -> ToolBox:
    return ToolBox(Workspace(work), AutoApprover("테스트"))


def hidden_workspace(tmp_path: Path) -> Path:
    """recover-encrypted-db-credentials 처럼 공개 fixture 가 전부 숨김 경로인 폴더."""
    root = tmp_path / "hidden-only"
    blocks = root / "db" / ".disk_blocks"
    blocks.mkdir(parents=True)
    for index in range(3):
        (blocks / f"block_{index:03}.bin").write_bytes(bytes([index]) * 16)
    (root / "db" / ".recovery_notes.txt").write_text("메모\n", encoding="utf-8")
    return root


def test_survey_separates_hidden_from_visible(work: Path):
    (work / ".env").write_text("SECRET=1\n", encoding="utf-8")
    report = orientation.survey(Workspace(work))
    assert "meeting.txt" in report.visible
    assert ".env" in report.hidden
    assert report.total == len(report.visible) + len(report.hidden)


def test_brief_lists_real_files_and_says_it_observed_them(work: Path):
    text = orientation.brief(orientation.survey(Workspace(work)), start_dir="app")
    assert "meeting.txt" in text and "receipt.py" in text
    assert "시작 폴더는 app" in text
    assert "추측하지 말고" in text


def test_brief_explains_an_empty_visible_list(tmp_path: Path):
    root = hidden_workspace(tmp_path)
    text = orientation.brief(orientation.survey(Workspace(root)))
    assert "보이는 파일: 없음" in text
    assert "숨김 경로 파일 4개" in text
    assert "폴더가 비었다는 뜻이 아니다" in text
    assert "run_python" in text


async def test_list_files_reports_hidden_entries_and_how_to_read_them(tmp_path: Path):
    root = hidden_workspace(tmp_path)
    outcome = await box(root).run(ToolCall("1", "list_files", {}))
    assert outcome.ok
    payload = json.loads(outcome.output)
    assert payload["files"] == [] and payload["count"] == 0
    assert payload["hidden_count"] == 4
    assert "db/.recovery_notes.txt" in payload["hidden"]
    assert "run_python" in outcome.hint


async def test_missing_path_answer_carries_real_candidates(work: Path):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": "app/receipt.py"}))
    assert not outcome.ok and "not_found" in outcome.error
    assert "실제 경로 후보" in outcome.hint
    assert "receipt.py" in outcome.hint


async def test_escaped_path_answer_also_carries_candidates(work: Path):
    outcome = await box(work).run(ToolCall("1", "read_file", {"path": "../meeting.txt"}))
    assert not outcome.ok and "path_rejected" in outcome.error
    assert "meeting.txt" in outcome.hint


async def test_candidates_prefer_the_same_file_name(work: Path):
    nested = work / "sub" / "deep"
    nested.mkdir(parents=True)
    (nested / "receipt.py").write_text("# 다른 위치\n", encoding="utf-8")
    report = orientation.survey(Workspace(work))
    choices = orientation.candidates(report, "app/nowhere/receipt.py")
    assert choices[0] in {"receipt.py", "sub/deep/receipt.py"}
    assert {"receipt.py", "sub/deep/receipt.py"} <= set(choices)


def test_candidates_are_empty_for_an_empty_workspace(tmp_path: Path):
    root = tmp_path / "empty"
    root.mkdir()
    assert orientation.candidates(orientation.survey(Workspace(root)), "x.txt") == []


async def test_hidden_paths_are_still_refused_by_the_file_tools(tmp_path: Path):
    """관측을 알려 주는 것과 열어 주는 것은 다르다 — A05 의 경계는 그대로다."""
    root = hidden_workspace(tmp_path)
    outcome = await box(root).run(ToolCall("1", "read_file", {"path": "db/.recovery_notes.txt"}))
    assert not outcome.ok and "path_rejected" in outcome.error
