"""문항 하나로 어댑터 연결을 확인한다 (전체 실행 전 점검용).

이것은 점수가 아니다 — `harness_lab.bench` 로 10문항을 실제로 돌려야 A11/A12 다.
벤치마크 저장소 루트에서 실행한다:

    PYTHONPATH=<이 저장소> uv run python <이 파일> python-sudoku-solver-backtracking
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import shutil
import sys
import tempfile

from harness_lab.benchmark_source import prepare
from harness_lab.grading import grade

from my_harness.benchmark_adapter import solve_task

OPTIONS = {"provider": "ollama", "model": "qwen3.5:2b", "max_steps": 12,
           "max_seconds": 420.0, "max_output_tokens": 4000, "command_timeout": 10.0}


async def main(task_name: str) -> int:
    root = Path.cwd()
    scratch = Path(tempfile.mkdtemp(prefix="smoke-"))
    workspace, logs = scratch / "workspace", scratch / "agent"
    try:
        prepared = prepare(task_name, workspace, cache=root / ".benchmark-cache")
        options = {**OPTIONS,
                   "task_cwd": str(Path(prepared["cwd"]).relative_to(workspace)).replace("\\", "/")}
        result = await solve_task(prepared["instruction"], workspace, logs, options)
        print(json.dumps({key: result[key] for key in ("status", "metrics")},
                         ensure_ascii=False, indent=2))
        print("최종 답 앞부분:", (result["answer"] or "")[:400])
        verdict = await grade(Path(prepared["task_dir"]), workspace, timeout=360,
                              fixture_sha256=prepared["fixture_sha256"])
        print("채점:", json.dumps({key: verdict.get(key) for key in
                                 ("reward", "passed", "total", "fixture_changed")},
                                ensure_ascii=False))
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1])))
