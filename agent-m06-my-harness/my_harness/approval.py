"""변경 승인 (D06 · R05).

승인은 "이 파일에 이 내용" 하나에 묶인다. 사용자가 본 내용의 sha256 이 실제로 기록할
내용과 다르면 그 승인을 쓰지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
import difflib
import sys
from typing import Protocol


@dataclass(frozen=True)
class ChangeRequest:
    call_id: str
    path: str
    before: str | None      # None 이면 새 파일
    after: str
    sha256: str

    @property
    def created(self) -> bool:
        return self.before is None

    def diff(self, context: int = 3) -> str:
        before = (self.before or "").splitlines(keepends=True)
        after = self.after.splitlines(keepends=True)
        lines = difflib.unified_diff(before, after,
                                     fromfile=f"a/{self.path}" + (" (없음)" if self.created else ""),
                                     tofile=f"b/{self.path}", n=context)
        return "".join(lines) or "(내용 차이 없음)"

    def summary(self) -> str:
        added = removed = 0
        for line in self.diff(context=0).splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                added += 1
            elif line.startswith("-") and not line.startswith("---"):
                removed += 1
        kind = "새 파일" if self.created else "수정"
        return f"{kind} {self.path} · +{added} -{removed} 줄 · {len(self.after.encode('utf-8'))} byte · sha256 {self.sha256[:12]}"


class Approver(Protocol):
    mode: str

    def confirm(self, request: ChangeRequest) -> bool: ...


class ConsoleApprover:
    """사람이 diff 를 보고 y/n. 비대화형(EOF)은 거절로 처리한다 — 자동 승인이 아니다."""

    mode = "console"

    def __init__(self, stream=None, prompt_stream=None, max_diff_lines: int = 120):
        self.stream = stream or sys.stdin
        self.out = prompt_stream or sys.stdout
        self.max_diff_lines = max_diff_lines

    def confirm(self, request: ChangeRequest) -> bool:
        lines = request.diff().splitlines()
        shown = lines[: self.max_diff_lines]
        print("\n── 변경 승인 요청 ──", file=self.out)
        print(request.summary(), file=self.out)
        print("\n".join(shown), file=self.out)
        if len(lines) > len(shown):
            print(f"... (diff {len(lines) - len(shown)}줄 생략)", file=self.out)
        print("적용할까요? [y/N] ", end="", file=self.out, flush=True)
        try:
            answer = self.stream.readline()
        except (EOFError, OSError):
            answer = ""
        if not answer:
            print("\n(입력 없음 — 거절로 처리한다)", file=self.out)
            return False
        return answer.strip().lower() in {"y", "yes"}


class AutoApprover:
    """일회용 작업 폴더 전용. 왜 자동 승인인지 이유를 기록에 남긴다."""

    mode = "auto"

    def __init__(self, reason: str):
        if not reason:
            raise ValueError("자동 승인에는 이유가 필요하다")
        self.reason = reason

    def confirm(self, request: ChangeRequest) -> bool:
        return True


class RejectAllApprover:
    """A04 검증용 — 항상 거절한다."""

    mode = "reject-all"

    def confirm(self, request: ChangeRequest) -> bool:
        return False
