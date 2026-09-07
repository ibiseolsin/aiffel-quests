"""agent-m02 실험 러너 — 조작 항목은 「완료 절 본문의 유무」 하나뿐이다.

한 셀 = (fixture, condition, rep). 셀마다 깨끗한 작업 폴더를 만들고 헤드리스
`claude -p` 를 한 번 돌린 뒤, 보류해 둔 채점 테스트를 그때 복사해 pytest 로 채점한다.

사용:
    python run_experiment.py --reps 1 --fixtures f1 --conditions full folded
    python run_experiment.py --reps 2                      # 전체 12셀
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent
DOCS = ROOT / "fixtures" / "docs"
SKEL = ROOT / "fixtures" / "skeleton"
GRAD = ROOT / "fixtures" / "grading"
WORKROOT = Path(
    r"C:\Users\김지훈\AppData\Local\Temp\claude"
    r"\C--Users-----dev-aiffel-quests\b32f33c3-80ed-46e7-bcc5-f4a45ad9bc4d"
    r"\scratchpad\agent-m02-runs"
)

# ── 고정 조건 (모든 셀에서 같다) ──────────────────────────────────────────────
MODEL = "sonnet"
MAX_TURNS = "30"
ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]
PERMISSION_MODE = "acceptEdits"
SEED = 20260903

FIXTURES = {
    "f1": ("chunk_id.py", "make_chunk_id", "test_f1_chunk_id.py"),
    "f2": ("emit.py", "emit", "test_f2_emit.py"),
    "f3": ("config.py", "load_config", "test_f3_config.py"),
}
CONDITIONS = {"full": "PLAN-full.md", "folded": "PLAN-folded.md"}

PROMPT = """이 폴더의 PLAN.md 를 읽고, 현재 단계에 적힌 결정에 따라 src/{f} 의 {fn} 를 구현하라.

- 테스트는 주어지지 않는다. PLAN.md 가 유일한 명세다.
- src/{f} 만 고친다. 다른 파일을 만들거나 고치지 마라.
- 끝나면 무엇을 구현했는지 한 줄로 답하라."""


def build_workdir(cell_dir: Path, fixture: str, condition: str) -> str:
    """작업 폴더를 새로 만든다. 채점 테스트는 넣지 않는다."""
    src_file, func, _ = FIXTURES[fixture]
    if cell_dir.exists():
        shutil.rmtree(cell_dir)
    (cell_dir / "src").mkdir(parents=True)
    shutil.copy2(SKEL / "src" / src_file, cell_dir / "src" / src_file)
    shutil.copy2(DOCS / CONDITIONS[condition], cell_dir / "PLAN.md")
    return PROMPT.format(f=src_file, fn=func)


def grade(cell_dir: Path, fixture: str) -> tuple[bool, str]:
    """보류해 둔 테스트를 지금 복사해 채점한다."""
    _, _, test_file = FIXTURES[fixture]
    shutil.copy2(GRAD / test_file, cell_dir / test_file)
    (cell_dir / "src" / "__init__.py").touch()
    p = subprocess.run(
        [sys.executable, "-m", "pytest", test_file, "-q", "--no-header", "-p", "no:cacheprovider"],
        cwd=cell_dir, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return p.returncode == 0, (p.stdout or "")[-1500:]


def run_cell(fixture: str, condition: str, rep: int, outdir: Path) -> dict:
    name = f"{fixture}-{condition}-r{rep}"
    cell_dir = WORKROOT / name
    prompt = build_workdir(cell_dir, fixture, condition)
    src_file = FIXTURES[fixture][0]
    before = (cell_dir / "src" / src_file).read_text(encoding="utf-8")

    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--model", MODEL,
        "--max-turns", MAX_TURNS,
        "--permission-mode", PERMISSION_MODE,
        "--strict-mcp-config",
        "--allowedTools", *ALLOWED_TOOLS,
    ]
    print(f"  ▶ {name} ...", end="", flush=True)
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=cell_dir, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    wall = time.perf_counter() - t0

    try:
        res = json.loads(p.stdout)
    except json.JSONDecodeError:
        res = {"is_error": True, "_raw_stdout": p.stdout[:3000], "_stderr": p.stderr[:2000]}

    after = (cell_dir / "src" / src_file).read_text(encoding="utf-8")
    passed, pytest_out = grade(cell_dir, fixture)
    u = res.get("usage", {}) or {}
    row = {
        "cell": name, "fixture": fixture, "condition": condition, "rep": rep,
        "passed": int(passed),
        "input_tokens": u.get("input_tokens", 0),
        "cache_creation_input_tokens": u.get("cache_creation_input_tokens", 0),
        "cache_read_input_tokens": u.get("cache_read_input_tokens", 0),
        "output_tokens": u.get("output_tokens", 0),
        "total_input_tokens": (u.get("input_tokens", 0)
                               + u.get("cache_creation_input_tokens", 0)
                               + u.get("cache_read_input_tokens", 0)),
        "num_turns": res.get("num_turns", 0),
        "permission_denials": len(res.get("permission_denials", []) or []),
        "duration_ms": res.get("duration_ms", 0),
        "wall_s": round(wall, 2),
        "is_error": int(bool(res.get("is_error"))),
        "terminal_reason": res.get("terminal_reason", ""),
        "list_cost_usd": res.get("total_cost_usd", 0),
    }
    (outdir / f"{name}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
    (outdir / f"{name}.trace.md").write_text(
        f"# {name}\n\n## 프롬프트 (조건 간 동일)\n\n```\n{prompt}\n```\n\n"
        f"## before — src/{src_file}\n\n```python\n{before}\n```\n\n"
        f"## after — src/{src_file}\n\n```python\n{after}\n```\n\n"
        f"## 모델 최종 응답\n\n```\n{res.get('result', '')}\n```\n\n"
        f"## 채점 (pytest, 실행 뒤 투입)\n\n```\n{pytest_out}\n```\n",
        encoding="utf-8")
    print(f" {'PASS' if passed else 'FAIL'}  "
          f"in={row['total_input_tokens']:,} out={row['output_tokens']:,} "
          f"turns={row['num_turns']} deny={row['permission_denials']} "
          f"{row['wall_s']}s {row['terminal_reason']}")
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--fixtures", nargs="+", default=list(FIXTURES))
    ap.add_argument("--conditions", nargs="+", default=list(CONDITIONS))
    ap.add_argument("--tag", default="")
    a = ap.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    outdir = ROOT / "runs" / (f"{stamp}-{a.tag}" if a.tag else stamp)
    outdir.mkdir(parents=True, exist_ok=True)
    WORKROOT.mkdir(parents=True, exist_ok=True)

    cells = [(f, c, r) for f in a.fixtures for c in a.conditions
             for r in range(1, a.reps + 1)]
    random.Random(SEED).shuffle(cells)  # 순서 효과 제거, 시드 고정으로 재현 가능

    print(f"셀 {len(cells)}개 → {outdir}")
    print(f"고정: model={MODEL} max_turns={MAX_TURNS} tools={','.join(ALLOWED_TOOLS)} "
          f"permission_mode={PERMISSION_MODE} strict_mcp=on")
    rows = [run_cell(*c, outdir) for c in cells]

    with (outdir / "results.csv").open("w", newline="", encoding="utf-8") as fh:
        wtr = csv.DictWriter(fh, fieldnames=list(rows[0]))
        wtr.writeheader()
        wtr.writerows(rows)
    print(f"\n결과 → {outdir / 'results.csv'}")


if __name__ == "__main__":
    main()
