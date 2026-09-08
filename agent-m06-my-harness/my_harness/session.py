"""세션 저장과 이벤트 기록 (D07 · R06).

세션 파일에는 모델에 보이는 대화가 그대로 들어간다 — 도구 인자와 파일 내용도 포함된다.
따라서 실습 자료만 다루고, 공개 저장소에 올리지 않는다. 키는 저장하지 않는다.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

NAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")
FORMAT_VERSION = 2


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Session:
    """이름 하나 = 파일 하나. 같은 이름을 두 프로세스가 동시에 쓰는 것은 막지 않는다."""

    def __init__(self, directory: Path, name: str):
        if not NAME_PATTERN.fullmatch(name):
            raise ValueError("세션 이름은 영문/숫자/_/- 1~64자여야 한다")
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.name = name
        self.path = directory / f"{name}.json"

    @property
    def exists(self) -> bool:
        return self.path.exists()

    def load(self, settings: dict[str, Any]) -> list[dict[str, Any]]:
        """저장된 대화를 돌려준다. 없으면 빈 목록 — 복원했다고 말하지 않는다."""
        if not self.path.exists():
            return []
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if data.get("format_version") != FORMAT_VERSION:
            raise ValueError("세션 파일 형식이 다르다. 새 세션 이름을 쓰세요")
        stored = data.get("settings", {})
        different = {key: (stored.get(key), value) for key, value in settings.items()
                     if stored.get(key) != value}
        if different:
            names = ", ".join(sorted(different))
            raise ValueError(f"세션의 설정이 다르다 ({names}). 새 세션 이름을 쓰세요")
        messages = data.get("messages", [])
        close_pending(messages)
        return messages

    def save(self, settings: dict[str, Any], messages: list[dict[str, Any]]) -> None:
        payload = {"format_version": FORMAT_VERSION, "name": self.name,
                   "updated_at": now(), "settings": settings, "messages": messages}
        handle, temporary = tempfile.mkstemp(prefix=f"{self.name}-", suffix=".tmp",
                                             dir=self.path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)


def close_pending(messages: list[dict[str, Any]]) -> None:
    """결과가 없는 도구 요청을 실패로 닫는다.

    중단된 실행을 이어받을 때 필요하다. 도구를 다시 실행하지 않는다 — 부작용이 이미
    일어났는지 알 수 없으므로 모델에게 상태를 직접 확인하라고 알려 준다.
    """
    repaired: list[dict[str, Any]] = []
    pending: dict[str, dict[str, Any]] = {}

    def flush() -> None:
        for call in pending.values():
            repaired.append({
                "role": "tool", "call_id": call["id"], "name": call["name"],
                "content": json.dumps({"ok": False,
                                       "error": "interrupted: 결과를 확인하지 못한 채 중단됐다",
                                       "hint": "다시 실행하기 전에 현재 상태를 먼저 확인하세요."},
                                      ensure_ascii=False)})
        pending.clear()

    for message in messages:
        if message.get("role") != "tool":
            flush()
        repaired.append(message)
        if message.get("role") == "assistant":
            pending = {call["id"]: call for call in message.get("calls", [])}
        elif message.get("role") == "tool":
            pending.pop(message.get("call_id"), None)
    flush()
    messages[:] = repaired


class EventLog:
    """append-only JSONL. 파일 내용·도구 인자·키는 넣지 않는다 — 경로와 결과만 남긴다."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: str, **fields: Any) -> None:
        record = {"at": now(), "event": event, **fields}
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
