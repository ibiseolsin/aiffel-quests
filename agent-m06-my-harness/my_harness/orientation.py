"""작업 폴더 관측 — 하네스가 본 사실을 모델에 그대로 알려 준다.

기준 실행(`own-baseline`)의 기록에서 나온 변경이다. 열 문항에서 도구 호출 110회 중
`list_files` 가 34회, 경로 실패(`not_found`·`path_rejected`)가 21회였다. 한 문항
(`recover-encrypted-db-credentials`)은 20단계 중 19단계를 `list_files` 로 태웠는데,
그 작업 폴더의 파일 14개가 **전부 숨김 경로**여서 `list_files` 가 매번 빈 목록을
돌려줬기 때문이다. 모델은 "폴더가 비었다" 와 "숨김은 보여 주지 않는다" 를 구분할
근거를 받지 못했다.

그래서 관측을 한곳에서 만들고 세 지점에 같은 사실을 넣는다.
1. 실행 시작 시 첫 메시지 (`brief`)
2. `list_files` 결과 (숨김 항목 개수·경로와 읽는 방법)
3. 경로 실패 응답의 후보 경로 (`candidates`)
"""
from __future__ import annotations

from dataclasses import dataclass
import difflib
from pathlib import Path

from .workspace import Workspace

MAX_BRIEF_FILES = 60
MAX_CANDIDATES = 5


@dataclass(frozen=True)
class Survey:
    visible: list[str]
    hidden: list[str]
    truncated: bool

    @property
    def total(self) -> int:
        return len(self.visible) + len(self.hidden)


def survey(workspace: Workspace, limit: int = 300) -> Survey:
    visible, hidden, truncated = workspace.all_files(limit)
    return Survey(visible, hidden, truncated)


def hidden_note(report: Survey) -> str:
    """숨김 파일을 읽는 방법. read_file 은 숨김 경로를 거부하므로 방법을 함께 준다."""
    if not report.hidden:
        return ""
    sample = ", ".join(report.hidden[:3])
    empty = " list_files 의 files 가 비어 있는 것은 폴더가 비었다는 뜻이 아니다." if not report.visible else ""
    return (f"숨김 경로 파일 {len(report.hidden)}개가 있다(예: {sample}). "
            f"read_file 은 숨김 경로를 거부한다.{empty} "
            "이 파일을 보려면 write_file 로 보조 .py 를 만들고 run_python 으로 실행해 읽어라.")


def brief(report: Survey, start_dir: str = ".") -> str:
    """첫 메시지에 붙일 관측 블록. list_files 왕복 없이 시작할 수 있게 한다."""
    lines = [f"[하네스 관측] 작업 폴더에 파일 {report.total}개가 있다. 시작 폴더는 {start_dir} 다."]
    if report.visible:
        shown = report.visible[:MAX_BRIEF_FILES]
        lines.append("보이는 파일: " + ", ".join(shown)
                     + (f" ... (외 {len(report.visible) - len(shown)}개)" if len(report.visible) > len(shown) else ""))
    else:
        lines.append("보이는 파일: 없음")
    note = hidden_note(report)
    if note:
        lines.append(note)
    if report.truncated:
        lines.append("목록이 상한에서 잘렸다. 더 필요하면 list_files 를 부르라.")
    lines.append("이 목록은 하네스가 방금 실제로 확인한 것이다. 없는 경로를 추측하지 말고 여기서 골라라.")
    return "\n".join(lines)


def candidates(report: Survey, requested: object) -> list[str]:
    """요청한 경로에 가까운 실제 경로. 파일 이름이 같은 것을 먼저 준다."""
    if not isinstance(requested, str) or not requested:
        return report.visible[:MAX_CANDIDATES]
    known = report.visible + report.hidden
    if not known:
        return []
    wanted = Path(requested.replace("\\", "/")).name.lower()
    same_name = [path for path in known if Path(path).name.lower() == wanted]
    close = difflib.get_close_matches(requested.replace("\\", "/"), known, n=MAX_CANDIDATES, cutoff=0.4)
    result: list[str] = []
    for path in same_name + close + known:
        if path not in result:
            result.append(path)
        if len(result) == MAX_CANDIDATES:
            break
    return result
