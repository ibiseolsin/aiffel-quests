# 구현 계획과 각 단계의 기록

## 시작 조건

D01~D07 을 `DECISIONS.md` 에서 CHOSEN 으로 확정했고 D08·D09 는 이유와 함께 DEFERRED 로 뒀다.
계약은 `INTERFACES.md`, 완료 조건은 `ACCEPTANCE.md`.

## 실행 환경과 의존성

| 항목 | 값 |
|---|---|
| OS | Windows 11 Education 26200 (`LongPathsEnabled=1`) |
| Python | 3.13.15 |
| 패키지 관리 | `uv` 0.12.8 — `pyproject.toml` + `uv.lock` (이 저장소) |
| 내 하네스 의존성 | `httpx>=0.28,<1`, `jsonschema>=4.26,<5` · dev: `pytest==8.4.1`, `pytest-asyncio>=1.0,<2` |
| 모델 런타임 | Ollama 0.32.5 (`ollama serve`), 모델 `qwen3.5:2b` (Q8_0, 2.3B, context 262144) |
| 벤치마크 | `agent-terminal-benchmark` v1.0.0 (`vendor/`, 커밋하지 않음 — `PROVENANCE.md`) |

두 환경을 하나로 합치지 않았다. 벤치마크는 자기 `uv` 환경에서 돌고, 내 패키지는 `PYTHONPATH` 로
얹는다 — 소스를 복사해 두 곳에 두지 않기 위해서다.

```bash
# 내 하네스 단독
uv sync --extra dev
uv run python -m pytest -q
uv run python -c "import shutil; shutil.copytree('fixtures', 'work')"
uv run run_harness.py --prompt "work 폴더의 meeting.txt 를 읽고 모임 시각과 준비물을 알려 줘." --workspace work --session reading

# 벤치마크 (벤치마크 루트에서, 내 저장소를 PYTHONPATH 로)
cd vendor/agent-terminal-benchmark
uv sync --locked
uv run python -m harness_lab.benchmark_source --prepare
export PYTHONPATH="/절대경로/agent-m06-my-harness"
uv run python -m harness_lab.bench --name own-baseline --agent my_harness.benchmark_adapter:solve_task \
  --provider ollama --model qwen3.5:2b --attempts 1 \
  --max-steps 20 --max-seconds 600 --max-output-tokens 4000 --command-timeout 10
```

## 1. 첫 수직 구현

- 선택 작업/도구: `meeting.txt` 읽고 요약 — `list_files` + `read_file`
- 실제 모델 전에 모의로 확인한 것: 인자 스키마 검사, 도구 결과 봉투, 종료 조건, 한도
- 완료 증거: A01 (`evidence/A01-read.txt`), A02 (`pytest`)

## 2. 범용 작업의 품질

경로 이탈·없는 파일·잘못된 인자·반복 한도·출력 잘림을 검증했다 → A05·A06·A07.
`ToolRejected` 를 코드(`hint` 포함)로 모델에 돌려주는 형태로 계약을 확정했다.

## 3. 코딩 작업과 권한

fixture 를 두 단계로 두었다. `fixtures/greeting.py`(결함 1개, 테스트 2개)와
`fixtures/receipt.py`(결함 3개, 테스트 5개 중 2개 실패). 변경 제안 → diff 표시 → 승인/거절 → 적용 →
**고정 대상** 테스트 → 결과. 거절 시 sha256 대조.

- A03: 기준 버전 `FAIL`(잘린 응답으로 반복이 죽음) → 개선 버전 `greeting.py` 에서 `PASS`
  (승인 후 적용, `run_tests` exit 0, 하네스 밖 재확인 OK)
- `receipt.py` 는 개선 버전에서도 실패했다. **하네스 경로는 다 돌았고**(읽기 4회·기록 5회·테스트 3회)
  실패는 모델이 만든 수정의 품질이다 — 원인 구분을 `EXPERIMENT_REPORT.md` 에 적었다.
- A04: 두 버전 모두 `PASS` (거절 뒤 파일 sha256 불변)

## 4. 제품 기능

세션 파일 영속과 설정 불일치 거부, 진행 이벤트(JSONL) → A08·A09.
추가 provider·취소·동시 실행은 D08·D09 로 미뤘다.

## 5. 고정 10문항 비교 실험

`my_harness/benchmark_adapter.py` 로 연결하고, 기준 실행 → 실패 기록 분석 → 가설 하나 → 개선 →
같은 조건 재측정. 모델·한도·문항·평가 버전을 고정하고 하네스 코드만 바꾼다.

## 각 단계의 기록

| 단계 | 관련 ID | 구현한 변경 | 확인한 결과 | 남은 문제 |
|---|---|---|---|---|
| 계약·골격 | R02·R07 | `contracts.py` — 내부 계약과 종료 상태 7종 | `pytest` 39건 통과 | — |
| 경로 경계 | R05/A05 | `workspace.py` — 절대경로·`..`·숨김·심링크·resolve 검사 | 실제 모델 이탈 시도 2건 거부 | 경로 검사는 OS 격리가 아니다 (명시함) |
| 도구 | R03·R04 | `tools.py` — 도구 5개, JSON Schema 검사, `hint` | 도구 단위 16건 통과 | `read_file` 은 UTF-8 텍스트만 — 바이너리는 보조 스크립트 |
| 실행 | R04 | `execute.py` — 시간 제한·출력 상한·환경 화이트리스트 | 시간 초과·비정상 종료 확인 | `-I` 가 `PYTHON*` 를 무시해 인코딩은 `-X utf8=1` 로 준다 (실측 후 수정) |
| 반복 | R01·R02 | `loop.py` — 한도 5종, 상태 7종, 근거 원장 | A02·A06·A07 | 잘린 응답(`done_reason='length'`)을 반복 종료로 처리 → **기준 실행의 지배적 실패 원인** |
| 승인 | R05/A03·A04 | `approval.py` — diff + sha256 결속, EOF=거절 | A04 | — |
| 세션 | R06/A08·A09 | `session.py` — 원자적 저장, 설정 불일치 거부, 미결 호출 닫기 | A08·A09 | 세션 파일에 fixture 내용이 들어간다 → 공개 제외 |
| 제공자 | R07 | `providers.py` — Ollama 네이티브, `num_ctx` 유도 | A01·A07 | `num_ctx` 미지정 시 4k 로 잘려 매 실행이 죽었다 (실측 후 수정) |
| 벤치마크 연결 | R08/A11 | `benchmark_adapter.py` | 문항 1개 smoke → 연결 확인 | smoke 는 점수가 아니다 |
| **기준 실행** | A11 | 변경 없음 | 10문항 `pass 0 · fail 0 · error 10` (`results/own-baseline/`) | 열 문항 모두 미완료로 끝났다 — 원인 분석은 `EXPERIMENT_REPORT.md` |
| **개선(가설 1건)** | A11→A12 | `orientation.py` 신설 + `list_files` 계약 확장 + 경로 실패 hint 에 실제 후보 경로 + 첫 메시지에 관측 블록 | `pytest` 48건 통과(회귀 9건 추가), A03 이 `FAIL`→`PASS`, A04 유지 | 결과 비교는 `results/comparison/` |

### 기준 실행 뒤 바꾼 것 (가설 1건)

기준 실행의 이벤트 기록을 세어 나온 변경이다. 자세한 근거·수치·결과는 `EXPERIMENT_REPORT.md`.

- 새 파일 `my_harness/orientation.py` — 작업 폴더 관측을 한곳에서 만든다 (`survey`/`brief`/`candidates`/`hidden_note`)
- `workspace.all_files()` — 보이는 파일과 숨김 경로 파일을 따로 돌려준다
- `tools.py` — `list_files` 가 `hidden`·`hidden_count` 를 함께 주고, 경로 실패의 `hint` 에 실제 후보 경로를 붙인다
- `benchmark_adapter.py` · `cli.py` — 실행 시작 시 같은 관측을 첫 메시지에 한 번 넣는다
- `tests/test_orientation.py` — 9건. **숨김 경로를 여는 것이 아니라는 것**(A05 경계 유지)까지 고정한다

### 실측으로 고친 설정 두 건 (기준 실행 **전**)

1. **`num_ctx` 미지정** — Ollama 기본 window(4k)에서 도구 출력이 두세 번 쌓이면 매 응답이
   `done_reason='length'` 가 됐다. 하네스가 허용한 대화 길이(`max_context_chars`)에서 `num_ctx` 를
   유도하도록 바꿨다 (`providers.context_window_for`).
2. **`temperature=0`** — 이 모델이 생각 루프에 빠져 `num_predict` 8000 을 다 쓰고 잘렸다.
   Qwen3 권장값(`0.6`/`top_p 0.95`)에 `seed 7` 을 붙여 재현성을 유지했다.

두 건은 **가설 검증이 아니라 설정 오류 수정**이므로 기준 실행 전에 고쳤고, 기준·개선 두 실행에
같은 값으로 적용했다.
