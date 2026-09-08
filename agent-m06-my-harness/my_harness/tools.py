"""도구 다섯 개와 그 경계.

인자 스키마 검사 → 경로 검사 → (필요하면) 승인 → 실행 → 봉투(envelope) 반환.
검사는 모델이 무엇을 요구했는지와 무관하게 코드에서 적용한다 (R05).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from . import orientation
from .approval import Approver, ChangeRequest
from .contracts import ToolCall, ToolOutcome, ToolRejected, ToolSpec
from .execute import run_python_file, run_unittest
from .workspace import MAX_FILE_BYTES, Workspace, digest, write_atomic

STRING = {"type": "string"}
NO_ARGS = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}


def _object(**fields: dict) -> dict:
    return {"type": "object", "properties": fields, "required": list(fields),
            "additionalProperties": False}


LIST_FILES = ToolSpec(
    "list_files",
    "작업 폴더의 파일 목록을 최대 300개까지 돌려준다. 보이는 파일은 files, 숨김 경로 파일은 hidden 으로 따로 표시한다 (숨김은 read_file 로 열 수 없고 run_python 보조 스크립트로 읽는다). 심볼릭 링크는 제외한다.",
    NO_ARGS)
READ_FILE = ToolSpec(
    "read_file",
    "작업 폴더 안의 UTF-8 텍스트 파일을 읽는다. 경로는 작업 폴더 상대경로 또는 작업 폴더 내부의 절대경로.",
    _object(path=STRING))
WRITE_FILE = ToolSpec(
    "write_file",
    "작업 폴더 안의 파일 내용 전체를 쓴다. 사람 승인이 필요하고, 거절되면 파일은 바뀌지 않는다.",
    _object(path=STRING, content=STRING))
RUN_PYTHON = ToolSpec(
    "run_python",
    "작업 폴더 안에 이미 있는 .py 파일을 문자열 인자와 함께 실행한다. 인라인 코드나 셸 명령은 실행하지 않는다. 필요하면 먼저 파일로 쓴다.",
    _object(path=STRING, args={"type": "array", "items": STRING, "maxItems": 30}))
RUN_TESTS = ToolSpec(
    "run_tests",
    "미리 고정된 테스트 대상을 unittest 로 실행한다. 인자는 없고 실행 대상을 바꿀 수 없다.",
    NO_ARGS)


class ToolBox:
    """한 작업에서 쓸 도구 모음. test_target 이 없으면 run_tests 는 등록되지 않는다."""

    def __init__(self, workspace: Workspace, approver: Approver, *,
                 test_target: list[str] | None = None,
                 command_timeout: float = 30.0,
                 start_dir: str = ".",
                 allow_write: bool = True):
        self.workspace = workspace
        self.approver = approver
        self.test_target = test_target
        self.command_timeout = command_timeout
        self.start_dir = start_dir or "."
        self.evidence: list[dict[str, Any]] = []
        self._handlers = {
            LIST_FILES.name: self._list_files,
            READ_FILE.name: self._read_file,
            RUN_PYTHON.name: self._run_python,
        }
        self.definitions = [LIST_FILES, READ_FILE, RUN_PYTHON]
        if allow_write:
            self.definitions.insert(2, WRITE_FILE)
            self._handlers[WRITE_FILE.name] = self._write_file
        if test_target:
            self.definitions.append(RUN_TESTS)
            self._handlers[RUN_TESTS.name] = self._run_tests
        self._validators = {spec.name: Draft202012Validator(spec.parameters)
                            for spec in self.definitions}

    # ------------------------------------------------------------------ 진입
    async def run(self, call: ToolCall) -> ToolOutcome:
        handler = self._handlers.get(call.name)
        if handler is None:
            known = ", ".join(sorted(self._handlers))
            return ToolOutcome(call.id, call.name, False,
                               error=f"unknown_tool: 등록되지 않은 도구 {call.name!r}",
                               hint=f"쓸 수 있는 도구: {known}")
        arguments: dict[str, Any] = {}
        try:
            arguments = self._arguments(call)
            payload = await handler(call, arguments)
        except ToolRejected as exc:
            return ToolOutcome(call.id, call.name, False, error=str(exc),
                               hint=self._enriched_hint(exc, arguments))
        except (OSError, UnicodeDecodeError, ValueError, TypeError) as exc:
            return ToolOutcome(call.id, call.name, False,
                               error=f"tool_failed: {type(exc).__name__}: {exc}")
        ok = bool(payload.pop("_ok", True))
        hint = str(payload.pop("_hint", ""))
        text = json.dumps(payload, ensure_ascii=False)
        if ok:
            return ToolOutcome(call.id, call.name, True, output=text, hint=hint)
        return ToolOutcome(call.id, call.name, False,
                           error=f"tool_reported_failure: {text}", hint=hint)

    def _arguments(self, call: ToolCall) -> dict[str, Any]:
        raw = call.arguments
        if isinstance(raw, str):
            try:
                raw = json.loads(raw or "{}")
            except json.JSONDecodeError as exc:
                raise ToolRejected("invalid_arguments", f"인자가 JSON 이 아니다: {exc.msg}",
                                   "인자를 JSON 객체로 보내세요.") from exc
        if not isinstance(raw, dict):
            raise ToolRejected("invalid_arguments", "인자는 JSON 객체여야 한다")
        try:
            self._validators[call.name].validate(raw)
        except ValidationError as exc:
            where = "/".join(str(part) for part in exc.absolute_path) or "(최상위)"
            raise ToolRejected("invalid_arguments", f"{where}: {exc.message}",
                               f"{call.name} 의 인자 스키마를 다시 확인하세요.") from exc
        return raw

    def _enriched_hint(self, exc: ToolRejected, arguments: dict) -> str:
        """경로 실패에는 하네스가 방금 확인한 실제 후보 경로를 붙여 돌려준다.

        기준 실행에서 경로 실패 21건이 대부분 "다시 list_files" 로 이어졌다. 고칠 재료를
        같은 응답에 넣어 왕복을 없앤다.
        """
        if exc.code not in {"not_found", "path_rejected", "not_python", "not_a_file"}:
            return exc.hint
        report = orientation.survey(self.workspace)
        choices = orientation.candidates(report, arguments.get("path"))
        parts = [exc.hint] if exc.hint else []
        if choices:
            parts.append("작업 폴더의 실제 경로 후보: " + ", ".join(choices))
        note = orientation.hidden_note(report)
        if note:
            parts.append(note)
        return " ".join(parts)

    # ------------------------------------------------------------------ 도구
    async def _list_files(self, call: ToolCall, arguments: dict) -> dict:
        report = orientation.survey(self.workspace)
        payload: dict[str, Any] = {"files": report.visible, "count": len(report.visible),
                                   "hidden_count": len(report.hidden),
                                   "hidden": report.hidden[:50],
                                   "truncated": report.truncated,
                                   "start_dir": self.start_dir}
        note = orientation.hidden_note(report)
        if note:
            payload["_hint"] = note
        return payload

    async def _read_file(self, call: ToolCall, arguments: dict) -> dict:
        relative, target = self.workspace.resolve_for_read(arguments["path"])
        size = target.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ToolRejected(
                "too_large", f"{relative} 는 {size} byte 로 상한({MAX_FILE_BYTES})을 넘는다",
                "필요한 부분만 읽는 보조 스크립트를 write_file 로 만들고 run_python 으로 실행하세요.")
        data = target.read_bytes()
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ToolRejected("not_utf8", f"{relative} 는 UTF-8 텍스트가 아니다",
                               "바이너리 파일은 run_python 으로 여는 보조 스크립트를 쓰세요.") from exc
        sha = digest(data)
        self.evidence.append({"action": "read", "path": relative, "bytes": len(data), "sha256": sha})
        return {"path": relative, "bytes": len(data), "sha256": sha, "content": content}

    async def _write_file(self, call: ToolCall, arguments: dict) -> dict:
        content = arguments["content"]
        if len(content) > MAX_FILE_BYTES:
            raise ToolRejected("too_large", f"내용이 {MAX_FILE_BYTES}자 상한을 넘는다")
        relative, target = self.workspace.resolve_for_write(arguments["path"])
        before = None
        if target.exists():
            try:
                before = target.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise ToolRejected(
                    "not_utf8", f"{relative} 의 현재 내용이 UTF-8 이 아니어서 diff 를 보여 줄 수 없다") from exc
        sha = digest(content.encode("utf-8"))
        request = ChangeRequest(call.id, relative, before, content, sha)
        if not self.approver.confirm(request):
            self.evidence.append({"action": "write_rejected", "path": relative, "sha256": sha})
            raise ToolRejected("rejected_by_user", "사용자가 이 변경을 거절했다. 파일은 그대로다",
                               "왜 이 변경이 필요한지 설명하거나 다른 방법을 제안하세요.")
        # 승인 시점의 내용을 그대로 쓴다. 승인 뒤에 내용을 다시 만들지 않는다.
        written = write_atomic(target, request.after)
        if digest(target.read_bytes()) != sha:  # pragma: no cover - 방어적 확인
            raise ToolRejected("write_mismatch", "기록된 내용이 승인한 내용과 다르다")
        self.evidence.append({"action": "write", "path": relative, "bytes": written,
                              "sha256": sha, "created": request.created,
                              "approval": self.approver.mode})
        return {"path": relative, "bytes": written, "created": request.created, "sha256": sha}

    async def _run_python(self, call: ToolCall, arguments: dict) -> dict:
        args = arguments["args"]
        if any(len(value) > 2000 for value in args):
            raise ToolRejected("invalid_arguments", "인자 하나가 2000자를 넘는다")
        relative, target = self.workspace.resolve_for_read(arguments["path"])
        if target.suffix != ".py":
            raise ToolRejected("not_python", f"{relative} 는 .py 파일이 아니다",
                               "실행할 코드를 먼저 .py 파일로 write_file 하세요.")
        cwd = self._start_path()
        result = await run_python_file(self.workspace.root, target, list(args), cwd,
                                       self.command_timeout)
        self.evidence.append({"action": "run_python", "path": relative, "args": list(args),
                              "exit_code": result["exit_code"], "timed_out": result["timed_out"]})
        ok = result["exit_code"] == 0 and not result["timed_out"]
        payload = {"path": relative, "cwd": self.start_dir, **result, "_ok": ok}
        if result["timed_out"]:
            payload["_hint"] = f"{self.command_timeout}초 안에 끝나지 않았다. 더 작은 입력으로 확인하세요."
        return payload

    async def _run_tests(self, call: ToolCall, arguments: dict) -> dict:
        target = list(self.test_target or [])
        result = await run_unittest(self.workspace.root, target, self.command_timeout)
        self.evidence.append({"action": "run_tests", "target": target,
                              "exit_code": result["exit_code"], "timed_out": result["timed_out"]})
        ok = result["exit_code"] == 0 and not result["timed_out"]
        return {"target": target, **result, "_ok": ok}

    def _start_path(self) -> Path:
        if self.start_dir in {".", ""}:
            return self.workspace.root
        return self.workspace.locate(self.start_dir)
