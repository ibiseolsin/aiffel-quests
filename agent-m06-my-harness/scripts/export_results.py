"""실행 결과를 제출용 `results/<이름>/` 으로 복사한다.

원본 문제·참고 풀이·채점 코드·시행별 작업 폴더는 복사하지 않는다. 대신 제외한 경로와
이유를 `results/<이름>/EXCLUDED.md` 에 남긴다. **실패 시행이나 불리한 점수 행은 지우지 않는다.**

    uv run python scripts/export_results.py own-baseline [own-improved ...]
"""
from __future__ import annotations

import csv
import json
from pathlib import Path
import shutil
import sys
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
JOBS = ROOT / "vendor/agent-terminal-benchmark/jobs"
REPORTS = ROOT / "vendor/agent-terminal-benchmark/reports"
RESULTS = ROOT / "results"

EXCLUDED_TEMPLATE = """# {name} — 제출에서 제외한 경로와 이유

원본 실행 폴더: `vendor/agent-terminal-benchmark/jobs/{name}/` (저장소에 커밋하지 않음)
**원래 실행 메타데이터를 덮어쓰지 않았다.** 아래 `run-metadata.json` 은 실행 당시 파일 그대로이고,
제출용 정리본의 소스 해시(`source_sha256`)는 그 실행 스냅샷의 값이다.

| 제외한 경로 | 이유 |
|---|---|
| `jobs/{name}/source/benchmark/upstream/` | 내려받은 **원본 문제·자료·풀이**. 고정 커밋 `874af409…4d78784d` 에서 다시 준비할 수 있다 (`PROVENANCE.md`) |
| `jobs/{name}/<문항>__1/workspace/` | 시행별 작업 폴더 — 원본 fixture 사본이 들어 있다 |
| `jobs/{name}/<문항>__1/verifier/test_outputs.py` | **원본 채점 코드** |
| `jobs/{name}/<문항>__1/verifier/stdout.txt`, `stderr.txt`, `results.xml` | 채점 표준출력·오류·JUnit XML. **실패 메시지에 원본 기대값이 들어간다.** 대신 문항별 검사 개수와 실패한 검사 **이름**만 `verifier-summary.csv` 로 옮겼다 |
| `jobs/{name}/<문항>__1/agent/session/trial.json` | 모델에 보인 대화 전문 — 원본 fixture 내용이 그대로 들어 있다 |
| `.benchmark-cache/` | 원본 문제·참고 풀이·채점 코드 캐시 |
| API 키·토큰 | 이 실험은 로컬 Ollama 를 써서 키가 없다. 코드·프롬프트·기록에 키를 쓰지 않는다 |

담은 파일을 `api_key|secret|token|BEGIN PRIVATE` 로 훑어 확인했다 — 걸린 것은 `n_input_tokens` 류
지표 이름과 A05 검증에 쓴 가짜 경로 `secret.txt` 뿐이다. 다만 `run-metadata.json` 과 시행별
`result.json` 의 **절대경로에 실행한 컴퓨터의 계정 이름이 들어 있다.** 원래 실행 메타데이터를
덮어쓰지 않기 위해 그대로 두었다.

## 담은 것

- `run-metadata.json` — 실행 설정·한도·소스 해시 (원본 그대로)
- `tasks.json` — 고정 10문항 manifest (원본 그대로)
- `trials.csv` · `report.json` · `index.html` — **10문항 전체 행**
- `trials/<문항>__1/result.json` — 시행별 원본 결과 (에이전트 상태·예외·채점 개수 포함)
- `trials/<문항>__1/agent-events.jsonl` — 내 하네스의 실행 기록. 설계상 **파일 내용·도구 인자를 남기지 않는다**
- `verifier-summary.csv` — 문항별 검사 통과/실패 개수와 실패한 검사 이름
"""


def failed_checks(xml_path: Path) -> list[str]:
    if not xml_path.exists():
        return []
    try:
        tree = ElementTree.parse(xml_path)
    except ElementTree.ParseError:
        return ["(XML 파싱 실패)"]
    names = []
    for case in tree.iter("testcase"):
        if any(child.tag in {"failure", "error"} for child in case):
            names.append(f"{case.get('classname', '')}::{case.get('name', '')}".lstrip(":"))
    return names


def export_report_only(name: str) -> None:
    """`--compare` 로 만든 비교 보고서처럼 실행 폴더가 없는 산출물을 옮긴다."""
    source = REPORTS / name
    if not source.is_dir():
        raise SystemExit(f"보고서 폴더가 없다: {source}")
    target = RESULTS / name
    target.mkdir(parents=True, exist_ok=True)
    copied = []
    for path in sorted(source.iterdir()):
        if path.is_file():
            shutil.copy2(path, target / path.name)
            copied.append(path.name)
    print(f"{name}: {', '.join(copied)} -> {target}")


def export(name: str) -> None:
    job = JOBS / name
    if not job.is_dir():
        raise SystemExit(f"실행 폴더가 없다: {job}")
    target = RESULTS / name
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(job / "run-metadata.json", target / "run-metadata.json")
    shutil.copy2(job / "manifest.json", target / "tasks.json")
    for filename in ("trials.csv", "report.json", "index.html"):
        source = REPORTS / name / filename
        if source.exists():
            shutil.copy2(source, target / filename)
        else:
            print(f"  경고: {source} 가 없다 — report 명령을 먼저 실행할 것")
    summary = []
    for trial in sorted(job.glob("*__1")):
        result = json.loads((trial / "result.json").read_text(encoding="utf-8"))
        destination = target / "trials" / trial.name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(trial / "result.json", destination / "result.json")
        events = trial / "agent" / "events.jsonl"
        if events.exists():
            shutil.copy2(events, destination / "agent-events.jsonl")
        verdict = result.get("verifier_result") or {}
        agent = result.get("agent_result") or {}
        summary.append({
            "task_name": result["task_name"],
            "agent_status": agent.get("status"),
            "stop_reason": (agent.get("metrics") or {}).get("stop_reason", ""),
            "reward": verdict.get("reward"),
            "checks_passed": verdict.get("checks_passed"),
            "checks_total": verdict.get("checks_total"),
            "checks_failed": verdict.get("checks_failed"),
            "checks_errors": verdict.get("checks_errors"),
            "fixture_changes": len(verdict.get("fixture_changes") or []),
            "exception_type": (result.get("exception_info") or {}).get("exception_type", ""),
            "failed_checks": " | ".join(failed_checks(trial / "verifier" / "results.xml")),
        })
    with (target / "verifier-summary.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(summary[0]))
        writer.writeheader()
        writer.writerows(summary)
    (target / "EXCLUDED.md").write_text(EXCLUDED_TEMPLATE.format(name=name), encoding="utf-8")
    print(f"{name}: 시행 {len(summary)}건 -> {target}")


def main(names: list[str]) -> int:
    if not names:
        raise SystemExit(__doc__)
    for name in names:
        if (JOBS / name).is_dir():
            export(name)
        else:
            export_report_only(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
