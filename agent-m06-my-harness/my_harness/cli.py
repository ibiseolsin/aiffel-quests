"""CLI (D02). 작업 하나 = 호출 하나.

종료 코드: 0 completed · 1 그 밖의 종료 상태 · 2 사용법 오류.
키는 인자로 받지 않는다 — 이 버전의 제공자(Ollama)는 키가 필요 없다.
"""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import shlex
import sys
import uuid

from .approval import AutoApprover, ConsoleApprover
from .contracts import Limits, ProviderError
from .loop import Harness
from .providers import build_provider
from .session import EventLog, Session, now
from .tools import ToolBox
from .workspace import Workspace


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="run_harness.py", description=__doc__)
    p.add_argument("--prompt", required=True, help="자연어 요청 하나")
    p.add_argument("--workspace", type=Path, default=Path("work"), help="작업 폴더 (기본 work)")
    p.add_argument("--session", default="", help="세션 이름. 주면 파일로 저장하고 이어간다")
    p.add_argument("--test-target", default="",
                   help='run_tests 가 실행할 고정 unittest 인자. 예: "-s work -p test_receipt.py"')
    p.add_argument("--provider", default="ollama", choices=["ollama"])
    p.add_argument("--model", default=os.environ.get("MY_HARNESS_MODEL", "qwen3.5:2b"))
    p.add_argument("--host", default=os.environ.get("OLLAMA_HOST", ""), help="Ollama 주소")
    p.add_argument("--auto-approve", action="store_true",
                   help="일회용 작업 폴더 전용. 승인 없이 파일 변경을 적용한다")
    p.add_argument("--no-write", action="store_true", help="write_file 도구를 등록하지 않는다")
    p.add_argument("--max-steps", type=int, default=12)
    p.add_argument("--max-tool-calls", type=int, default=30)
    p.add_argument("--max-seconds", type=float, default=300)
    p.add_argument("--tool-timeout", type=float, default=30)
    p.add_argument("--command-timeout", type=float, default=30)
    p.add_argument("--max-output-tokens", type=int, default=2000)
    p.add_argument("--temperature", type=float, default=0.6)
    p.add_argument("--seed", type=int, default=7, help="재현성을 위한 고정 seed")
    p.add_argument("--max-context-chars", type=int, default=60_000,
                   help="대화 길이 상한. 제공자의 num_ctx 를 이 값에서 유도한다")
    p.add_argument("--runs-dir", type=Path, default=Path("runs"))
    p.add_argument("--sessions-dir", type=Path, default=Path("sessions"))
    p.add_argument("--quiet", action="store_true")
    return p


async def execute(args: argparse.Namespace) -> int:
    try:
        workspace = Workspace(args.workspace)
    except ValueError as exc:
        print(f"사용법 오류: {exc}", file=sys.stderr)
        return 2
    if not args.prompt.strip():
        print("사용법 오류: --prompt 가 비어 있다", file=sys.stderr)
        return 2

    run_id = now()[:19].replace(":", "").replace("-", "") + "-" + uuid.uuid4().hex[:6]
    run_dir = Path(args.runs_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log = EventLog(run_dir / "events.jsonl")

    approver = (AutoApprover("일회용 작업 폴더에서 --auto-approve 로 실행")
                if args.auto_approve else ConsoleApprover())
    test_target = shlex.split(args.test_target) if args.test_target.strip() else None
    tools = ToolBox(workspace, approver, test_target=test_target,
                    command_timeout=args.command_timeout, allow_write=not args.no_write)
    limits = Limits(max_steps=args.max_steps, max_tool_calls=args.max_tool_calls,
                    max_seconds=args.max_seconds, tool_timeout_seconds=args.tool_timeout,
                    max_context_chars=args.max_context_chars)

    settings = {"provider": args.provider, "model": args.model,
                "workspace": workspace.root.as_posix(),
                "tools": [spec.name for spec in tools.definitions]}
    session = Session(args.sessions_dir, args.session) if args.session else None
    resuming = bool(session and session.exists)

    try:
        provider, client = build_provider(args.provider, args.model,
                                          timeout=args.max_seconds,
                                          max_output_tokens=args.max_output_tokens,
                                          max_context_chars=args.max_context_chars,
                                          temperature=args.temperature, seed=args.seed,
                                          host=args.host or None)
    except ProviderError as exc:
        print(f"사용법 오류: {exc}", file=sys.stderr)
        return 2

    def progress(line: str) -> None:
        if not args.quiet:
            print(line, flush=True)

    harness = Harness(provider, tools, limits=limits, log=log, session=session,
                      settings=settings, on_progress=progress)
    if session:
        progress(f"세션 {session.name}: " + ("이전 대화를 복원했다" if resuming else "새로 시작한다"))
    try:
        try:
            outcome = await harness.run(args.prompt)
        except ValueError as exc:
            print(f"사용법 오류: {exc}", file=sys.stderr)
            return 2
    finally:
        await client.aclose()

    payload = {"run_id": run_id, "prompt": args.prompt, "status": outcome.status,
               "reason": outcome.reason, "answer": outcome.answer,
               "settings": settings, "limits": asdict(limits),
               "approval_mode": approver.mode, "session": args.session or None,
               "session_resumed": resuming, "test_target": test_target,
               "metrics": asdict(outcome.metrics), "evidence": outcome.evidence}
    (run_dir / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report(outcome, run_dir)
    return 0 if outcome.status == "completed" else 1


def report(outcome, run_dir: Path) -> None:
    print()
    if outcome.status == "completed":
        print("상태: completed (모델이 답을 냈다 — 답이 맞다는 뜻은 아니다)")
        print("\n" + outcome.answer.strip())
    else:
        print(f"상태: {outcome.status} — 완료되지 않았다")
        print(f"이유: {outcome.reason}")
        if outcome.answer.strip():
            print("\n" + outcome.answer.strip())
    reads = [item["path"] for item in outcome.evidence if item["action"] == "read"]
    writes = [item["path"] for item in outcome.evidence if item["action"] == "write"]
    rejected = [item["path"] for item in outcome.evidence if item["action"] == "write_rejected"]
    runs = [item for item in outcome.evidence if item["action"] in {"run_python", "run_tests"}]
    print("\n── 근거 ──")
    print(f"읽은 파일: {', '.join(reads) if reads else '없음'}")
    print(f"바꾼 파일: {', '.join(writes) if writes else '없음'}")
    if rejected:
        print(f"거절된 변경: {', '.join(rejected)} (파일은 그대로)")
    for item in runs:
        label = item.get("path") or " ".join(item.get("target", []))
        print(f"실행: {item['action']} {label} → exit {item['exit_code']}"
              + (" (시간 초과)" if item.get("timed_out") else ""))
    metrics = outcome.metrics
    usage = (f"{metrics.input_tokens}/{metrics.output_tokens} 토큰"
             if metrics.usage_known else "토큰 미확인 (unknown ≠ 0)")
    print(f"모델 {metrics.model_calls}회 · 도구 {metrics.tool_calls}회"
          f"(실패 {metrics.tool_errors}) · {metrics.elapsed_seconds}초 · {usage}")
    print(f"기록: {run_dir / 'events.jsonl'}")


def use_utf8_output() -> None:
    """Windows 기본 콘솔 인코딩(cp949)은 한글 외 문자에서 죽는다. UTF-8 로 고정한다."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    use_utf8_output()
    args = parser().parse_args(argv)
    try:
        return asyncio.run(execute(args))
    except KeyboardInterrupt:
        print("\n중단됐다 (이미 적용된 변경은 되돌리지 않는다)", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
