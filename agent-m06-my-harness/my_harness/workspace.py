"""작업 폴더 경계. 모델의 지시와 무관하게 이 검사가 먼저 적용된다 (R05).

이것은 OS 샌드박스가 아니다. run_python/run_tests 는 사용자 계정 권한으로 돌기
때문에, 실습용 파일만 있는 폴더에서만 실행한다.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .contracts import ToolRejected

MAX_PATH_CHARS = 500
MAX_FILE_BYTES = 1_000_000


class Workspace:
    """작업 폴더 하나. 모든 도구 경로는 여기를 통과해야 한다."""

    def __init__(self, root: Path):
        root = Path(root)
        if not root.is_dir():
            raise ValueError(f"작업 폴더가 없다: {root}")
        self.root = root.resolve(strict=True)
        # 호출자가 준 표기(예: Windows 8.3 이름, macOS /var 대 /private/var)도
        # 절대경로 접두어로 받아 준다. 모델이 준 경로를 resolve 해서 링크를 숨기지는 않는다.
        self._absolute_roots = tuple(dict.fromkeys([self.root, Path(os.path.abspath(root))]))

    # ------------------------------------------------------------------ 경로
    def relative(self, value: object) -> str:
        """모델이 준 경로 문자열을 작업 폴더 상대경로로 바꾼다. 실패하면 거부한다."""
        if not isinstance(value, str) or not value.strip():
            raise ToolRejected("path_rejected", "비어 있지 않은 경로 문자열이 필요하다",
                               "list_files 로 실제 경로를 확인하세요.")
        if len(value) > MAX_PATH_CHARS:
            raise ToolRejected("path_rejected", f"경로가 {MAX_PATH_CHARS}자를 넘는다")
        path = Path(value)
        if ".." in path.parts:
            raise ToolRejected("path_rejected", "상위 폴더 이동(..)은 허용하지 않는다",
                               "작업 폴더 기준 상대경로를 쓰세요.")
        if path.is_absolute():
            for base in self._absolute_roots:
                if path.is_relative_to(base):
                    path = path.relative_to(base)
                    break
            else:
                raise ToolRejected("path_rejected", "절대경로가 작업 폴더를 벗어난다",
                                   "작업 폴더 안의 경로만 쓸 수 있습니다.")
        relative = path.as_posix()
        if not relative or relative == ".":
            raise ToolRejected("path_rejected", "파일 경로가 필요하다 (폴더가 아니다)")
        self.locate(relative)  # 숨김·심링크·이탈 검사를 여기서 한 번 더 통과시킨다
        return relative

    def locate(self, relative: str) -> Path:
        """상대경로를 실제 경로로 만든다. 구성요소마다 심링크·숨김을 검사한다."""
        target = self.root
        for part in Path(relative).parts:
            if part in {"", "."}:
                continue
            if part.startswith("."):
                raise ToolRejected("path_rejected", "숨김 경로는 허용하지 않는다")
            target = target / part
            if target.is_symlink():
                raise ToolRejected("path_rejected", "심볼릭 링크는 허용하지 않는다")
        # 마지막에 실제로 작업 폴더 안인지 확인한다. 앞의 문자열 검사만 믿지 않는다.
        try:
            resolved = target.resolve()
        except OSError as exc:  # pragma: no cover - 플랫폼 의존 경로 오류
            raise ToolRejected("path_rejected", f"경로를 확인할 수 없다 ({type(exc).__name__})") from exc
        if resolved != self.root and not resolved.is_relative_to(self.root):
            raise ToolRejected("path_rejected", "경로가 작업 폴더를 벗어난다")
        return target

    def resolve_for_read(self, value: object) -> tuple[str, Path]:
        relative = self.relative(value)
        target = self.locate(relative)
        if not target.exists():
            raise ToolRejected("not_found", f"파일이 없다: {relative}",
                               "list_files 로 실제 파일 목록을 확인하세요.")
        if target.is_dir():
            raise ToolRejected("not_a_file", f"폴더다: {relative}", "폴더 안의 파일 경로를 주세요.")
        if not target.is_file():
            raise ToolRejected("not_a_file", f"일반 파일이 아니다: {relative}")
        return relative, target

    def resolve_for_write(self, value: object) -> tuple[str, Path]:
        relative = self.relative(value)
        target = self.locate(relative)
        if target.is_dir():
            raise ToolRejected("not_a_file", f"폴더에는 쓸 수 없다: {relative}")
        return relative, target

    # ------------------------------------------------------------------ 목록
    def all_files(self, limit: int = 300) -> tuple[list[str], list[str], bool]:
        """보이는 파일과 숨김 경로 파일을 따로 돌려준다.

        숨김 파일은 도구로 열 수 없지만 **존재한다는 사실은 알려야 한다** — 기준 실행에서
        모델이 빈 목록을 받고 "폴더가 비었다" 로 오해해 단계를 다 태운 문항이 있었다.
        """
        visible: list[str] = []
        hidden: list[str] = []
        for directory, names, filenames in os.walk(self.root, followlinks=False):
            here = Path(directory)
            names[:] = sorted(name for name in names
                              if name != "__pycache__" and not (here / name).is_symlink())
            for name in sorted(filenames):
                target = here / name
                if target.is_symlink() or not target.is_file():
                    continue
                relative = target.relative_to(self.root).as_posix()
                bucket = hidden if any(part.startswith(".") for part in relative.split("/")) else visible
                bucket.append(relative)
                if len(visible) + len(hidden) >= limit:
                    return visible, hidden, True
        return visible, hidden, False

    def visible_files(self, limit: int = 300) -> tuple[list[str], bool]:
        visible, _hidden, truncated = self.all_files(limit)
        return visible, truncated


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_atomic(target: Path, content: str) -> int:
    """임시 파일에 쓰고 교체한다 — 부분 기록된 파일을 남기지 않는다."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".my-harness-tmp")
    data = content.encode("utf-8")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return len(data)
