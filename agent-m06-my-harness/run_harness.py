"""내 하네스 CLI 진입점.

패키지 안의 파일을 직접 실행하면 상대 import 가 깨진다 — 항상 이 파일로 실행한다.

    uv run run_harness.py --prompt "..." --workspace work
"""
from my_harness.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
