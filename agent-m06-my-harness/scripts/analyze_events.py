"""실행 하나(또는 둘)의 하네스 기록을 세어 표로 만든다.

`report.json` 은 점수와 상태만 준다. 실패 원인을 고르려면 도구별 결과가 필요하다.

    uv run python scripts/analyze_events.py own-baseline own-improved
"""
from __future__ import annotations

import collections
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
JOBS = ROOT / "vendor/agent-terminal-benchmark/jobs"


def analyze(name: str) -> dict:
    job = JOBS / name
    tools: collections.Counter = collections.Counter()
    statuses: collections.Counter = collections.Counter()
    per_task = {}
    steps = errors = calls = 0
    for trial in sorted(job.glob("*__1")):
        result = json.loads((trial / "result.json").read_text(encoding="utf-8"))
        agent = result.get("agent_result") or {}
        metrics = agent.get("metrics") or {}
        statuses[agent.get("status")] += 1
        steps += metrics.get("model_calls") or 0
        calls += metrics.get("tool_calls") or 0
        errors += metrics.get("tool_errors") or 0
        counts: collections.Counter = collections.Counter()
        events = trial / "agent" / "events.jsonl"
        if events.exists():
            for line in events.read_text(encoding="utf-8").splitlines():
                event = json.loads(line)
                if event["event"] == "tool_result":
                    key = (event["name"], "ok" if event["ok"] else (event.get("error") or "?"))
                    counts[key] += 1
                    tools[key] += 1
        verdict = result.get("verifier_result") or {}
        per_task[result["task_name"]] = {
            "status": agent.get("status"),
            "reward": verdict.get("reward"),
            "checks": f"{verdict.get('checks_passed')}/{verdict.get('checks_total')}",
            "model_calls": metrics.get("model_calls"),
            "tool_calls": metrics.get("tool_calls"),
            "tool_errors": metrics.get("tool_errors"),
            "elapsed_seconds": metrics.get("elapsed_seconds"),
            "top_tools": counts.most_common(4),
        }
    return {"name": name, "statuses": dict(statuses), "tools": tools,
            "steps": steps, "tool_calls": calls, "tool_errors": errors, "per_task": per_task}


def show(report: dict) -> None:
    print(f"\n===== {report['name']} =====")
    print("상태 분포:", report["statuses"])
    print(f"모델 호출 합계 {report['steps']} · 도구 호출 {report['tool_calls']} "
          f"(실패 {report['tool_errors']}, {report['tool_errors'] / max(1, report['tool_calls']):.0%})")
    print("도구별 결과:")
    for (tool, status), n in report["tools"].most_common():
        print(f"   {tool:12} {status:26} {n}")
    print("문항별:")
    for task, row in sorted(report["per_task"].items()):
        print(f"   {task[:40]:42} {str(row['status']):14} r={row['reward']} {row['checks']:>7} "
              f"steps={row['model_calls']} tools={row['tool_calls']}/{row['tool_errors']} "
              f"{row['elapsed_seconds']}s")


def main(names: list[str]) -> int:
    reports = [analyze(name) for name in names]
    for report in reports:
        show(report)
    if len(reports) == 2:
        first, second = reports
        print("\n===== 차이 =====")
        keys = sorted(set(first["tools"]) | set(second["tools"]))
        for key in keys:
            before, after = first["tools"].get(key, 0), second["tools"].get(key, 0)
            if before != after:
                print(f"   {key[0]:12} {key[1]:26} {before:3} -> {after:3} ({after - before:+d})")
        for field in ("steps", "tool_calls", "tool_errors"):
            print(f"   {field:12} {first[field]} -> {second[field]} ({second[field] - first[field]:+d})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
