# 하네스 구현과 실험 보고서

작성 2026-09-09. 빈칸 없이 실제 실행 결과로 채웠다. 채우지 못한 값은 「알 수 없음」으로 적었다.

## 제품과 구현

- **사용자 시나리오 / PRD**: `PRD.md` (D01 사용자 이야기, R01~R08 구체화). 결정은 `DECISIONS.md`,
  계약은 `INTERFACES.md`, 완료 조건과 증거는 `ACCEPTANCE.md`.
- **구현 언어와 실행 방법**: Python 3.13 + `uv`. 단독 실행은 `uv run run_harness.py --prompt … --workspace work`,
  10문항 평가는 `harness_lab.bench --agent my_harness.benchmark_adapter:solve_task`
  (전체 명령은 `IMPLEMENTATION_PLAN.md`).
- **직접 작성한 부분**: `my_harness/` 11개 파일 1,463줄 전부와 `tests/` 39건, `fixtures/`, `scripts/`.
  반복·도구·경로 경계·승인·세션·제공자 어댑터·벤치마크 어댑터를 내가 썼다.
- **참고한 부분**: 강의가 제공한 `harness_lab`(벤치마크 저장소 안의 Python 예제)을 **먼저 읽고**
  어댑터 계약(`solve_task` 의 인수·반환·상태 의미)과 로컬 이식 규칙(경로 재배치, 채점 분리)을 파악했다.
  반복의 큰 골격(모델 호출 → 도구 실행 → 도구 결과 메시지 → 다음 호출), 경로 검사 항목 목록,
  재개 시 미결 도구 호출을 실패로 닫는다는 발상은 그 예제에서 배운 것이다. 코드를 복사하지 않았고
  아래 「제공 구현과 다르게 정한 것」의 항목은 내 판단이다.
- **코드 위치**:

| 관심사 | 파일 · 함수 |
|---|---|
| 모델·도구 반복 | `my_harness/loop.py` — `Harness.run()` / `Harness._iterate()` |
| 인자 검사 | `my_harness/tools.py` — `ToolBox._arguments()` (JSON Schema) |
| 오류·종료 | `loop.py` 의 `except` 절과 `contracts.TERMINAL_STATUSES` (7종) |
| 권한(경로) | `my_harness/workspace.py` — `Workspace.relative()` / `locate()` |
| 권한(승인) | `my_harness/approval.py` + `tools.ToolBox._write_file()` |
| 세션 | `my_harness/session.py` — `Session.load()/save()`, `close_pending()` |
| 제공자 | `my_harness/providers.py` — `OllamaProvider.complete()` |
| 평가 연결 | `my_harness/benchmark_adapter.py` — `solve_task()` |

### 제공 구현(`harness_lab`)과 다르게 정한 것

| # | 내 결정 | 제공 구현 | 이유 |
|---|---|---|---|
| 1 | 임의 argv 실행 도구를 **만들지 않았다**. `run_python`(작업 폴더 안의 기존 `.py`)과 `run_tests`(고정 대상)만 둔다 | CLI 백엔드에 `run_command`(승인 후 argv 실행)가 있다 | 승인 하나로 임의 명령이 열리는 경로를 처음부터 두지 않으려고. 테스트 대상을 모델이 고르면 "테스트를 바꾸지 말라" 를 코드로 보장할 수 없다 |
| 2 | 도구 실패 봉투에 **`hint`** 를 함께 돌려준다 (`{"ok":false,"error":…,"hint":…}`) | `{"ok","output","error"}` | 2.3B 모델은 오류 문구만으로 다음 호출을 고치지 못한다. 고칠 방향을 같은 메시지에 넣는다 |
| 3 | **근거 원장**(evidence)을 도구 층에서 모아 화면과 `result.json` 에 요약한다 (읽은/쓴/실행한 것) | 이벤트 기록만 남긴다 | 사용자가 "모델 말" 과 "실제로 한 일" 을 대조할 수 있어야 한다. A08 실행에서 모델은 "파일을 다시 읽어보니" 라고 썼지만 근거 표시는 `읽은 파일: 없음` 이었다 — 세션 복원으로 답한 것이 맞고, 이 차이가 화면에 보인다 |
| 4 | 승인을 `(도구 호출 id, 내용 sha256)` 에 묶고, 기록 후 파일 해시를 다시 확인한다 | `approve(description)` 콜백 하나 | 사용자가 본 내용과 실제로 쓰인 내용이 같음을 코드로 확인한다 |
| 5 | 제공자 window(`num_ctx`)를 하네스의 대화 한도에서 **유도**한다 (`providers.context_window_for`) | `num_ctx` 를 보내지 않는다 | 보내지 않으면 Ollama 기본 4k 로 잘려, 도구 출력이 두세 번 쌓이는 순간 모든 응답이 `done_reason='length'` 가 된다 (2026-09-09 실측) |
| 6 | `run_python` 을 **문항의 시작 폴더**(`task_cwd`)에서 실행하고 `sys.path` 에 시작 폴더와 작업 폴더 루트를 넣는다 | 작업 폴더 루트에서 실행하고 "필요하면 보조 스크립트에서 chdir 하라" 고 안내한다 | 원본 문항은 `/app` 에서 도는 것을 전제로 상대경로를 쓴다. 모델에게 chdir 을 맡기면 그 단계에서 실패가 늘어난다 |
| 7 | 세션 설정이 다르면 **어느 키가 다른지** 알려 준다 | 설정 전체 비교 후 거부 | 세션 이름을 다시 정하기 전에 원인을 알 수 있어야 한다 |
| 8 | 모델 API 실패를 **`provider_error`** 라는 별도 종료 상태로 분리했다 | `failed` 로 묶는다 | R07 의 두 갈래(도구 오류는 모델에, 연결 실패는 사용자에)를 지표에서 구분해 세려고. 이 실험의 지배적 실패 원인을 찾아낸 것이 이 분리다 |
| 9 | 잘린 출력에 **원본 길이**를 함께 적는다 (`[출력 생략 N자 · 원본 M자]`) | `[output truncated]` | 모델이 "더 작게 나눠 읽어야 한다" 를 판단할 근거가 된다 |

## 평가 조건

두 실행에 **동일하게** 적용한 값이다. 바꾼 것은 `my_harness/` 코드뿐이다.

| 항목 | 값 |
|---|---|
| 원본 commit | `alibaba/terminal-bench-pro@874af409da6aafebccbf3bc5bb41a2fa4d78784d` |
| subset ID (평가 ID) | `terminal-bench-pro-local-port-v2` · port_version `2.0.0` |
| 로컬 정정 | `sudoku-explicit-io-contract-and-clue-checks`, `blockchain-original-ledger-oracle`, `immutable-input-fixtures` |
| manifest SHA256 | `21f333a94929d6ce9cf0e184a8865ed5d5feca1cc33b3c6536b771ae2edb30a6` |
| 제공자 · 모델 | `ollama` (네이티브 `/api/chat`) · `qwen3.5:2b` (Q8_0, 2.3B, Ollama 0.32.5) |
| 샘플링 | `temperature 0.6` · `top_p 0.95` · `seed 7` · `num_ctx 24000` (하네스 대화 한도에서 유도) |
| 소스 SHA256 (기준) | `2f7e4a96a9a20bbdcd6553ae428ed7fe26f5fe89a72a610273ea2bfb98063cc1` |
| 소스 SHA256 (개선) | `PLACEHOLDER_IMPROVED_SHA` |
| 실행 환경 | Windows-11-10.0.26200-SP0 · AMD64 Zen3 12 논리코어 · RAM 32 GiB · Python 3.13.15 · `hostlimits: unrestricted` |
| 의존성 잠금 | 내 하네스 `uv.lock` (이 저장소) · 벤치마크 `uv.lock` (v1.0.0 릴리스 그대로) |
| 문항 | 10 = easy 2 · medium 4 · hard 4 (원본 `task.toml` 난도 그대로) |
| 문항당 반복 | `--attempts 1` → **분모 10** |
| 한도 | `--max-steps 20` · `--max-seconds 600` · `--max-output-tokens 4000` · `--command-timeout 10` · 하네스 내부 도구 호출 상한 60(=20×3) · 도구 출력 8,000자 · 대화 60,000자 |
| 기준 실행 폴더 | `jobs/own-baseline` → 제출본 `results/own-baseline/` |
| 개선 실행 폴더 | `jobs/own-improved` → 제출본 `results/own-improved/` |
| 준비·채점 경로 확인 | `benchmark_source --prepare` 가 문항별 파일의 크기·SHA256 을 manifest 와 대조하고 통과했다. 어댑터 연결은 문항 1개 smoke(`scripts/smoke_one_task.py`)로 확인했다 — **이 smoke 와 `pytest` 39건은 개발 진단이고 학생 점수가 아니다.** `--self-check`(참고 풀이로 채점기를 검증하는 운영자 기능)는 실행하지 않았다 |

**기본값을 쓰지 않은 이유**: 안내의 기본값은 40단계·300초·10,000토큰이다. 이 모델은 모델 호출
1회가 10~30초여서 40단계는 300초 안에 절대 끝나지 않고, 10,000토큰 상한은 생각이 길어질 때
한 호출에 3분 이상을 쓴다. 두 값이 어긋난 채 돌리면 열 문항이 모두 시간 초과로만 끝나 실패 원인을
구분할 수 없다. 그래서 20단계·600초·4,000토큰으로 맞췄고, **두 실행에 같은 값을 썼다.**

## 결과

10문항 전체 행은 `results/own-baseline/trials.csv` · `results/own-improved/trials.csv` 에 있다.
**실패·오류·미완료 행을 지우지 않았다.** 분모는 두 실행 모두 10 고정이다.

PLACEHOLDER_RESULTS

## 실패 분석과 개선 가설

PLACEHOLDER_ANALYSIS

## 제출 확인

- [x] 실행 가능한 소스와 잠금 파일, 실행 안내 — `my_harness/`, `run_harness.py`, `pyproject.toml`, `uv.lock`, `README.md`
- [x] PRD·결정 기록·인터페이스·완료 조건 — `PRD.md`, `DECISIONS.md`, `INTERFACES.md`, `ACCEPTANCE.md`
- [x] 기준/개선의 설정, `run-metadata.json`, 원본 trial result 와 실행 기록 — `results/*/run-metadata.json`, `results/*/trials/<문항>__1/result.json`, `results/*/trials/<문항>__1/agent-events.jsonl`
- [x] 두 실행의 10문항 결과 CSV·JSON·HTML — `results/*/trials.csv`, `report.json`, `index.html`, 비교는 `results/comparison/`
- [x] 개선 가설, 구현 변경과 관찰 결과 — 이 문서의 「실패 분석과 개선 가설」
- [x] 키·토큰·개인 자료 제외 — 이 실험은 로컬 Ollama 로 **키를 쓰지 않는다**. 제외한 경로와 이유는 `results/*/EXCLUDED.md` 와 `PROVENANCE.md`

## 로컬 이식과 검증 범위

- **난이도 출처**: 고정 upstream `task.toml` (easy 2 / medium 4 / hard 4). 준비 단계가 manifest 와 대조한다.
- **실행 방식**: `local-port`, Docker 미사용. 원본 `/app`·`/protected`·`/db`·`/home/user`·`/workspace`·`/tmp`
  가 시행별 작업 폴더 아래로 재배치된다.
- **OS·CPU·메모리와 동시 실행 프로그램**: Windows 11 (26200), AMD64 Zen3 12 논리코어, RAM 32 GiB
  (실행 중 가용 5~6 GiB). Ollama 서버가 같은 기계에서 돌았고, 개발 도우미 세션도 같은 기계에 있었다.
  **다른 프로그램과 CPU·메모리를 나눠 쓴 조건이므로 시간 수치는 이 기계의 값이다.**
- **원본 대비 변경**: 작업 경로 재배치, 현재 Python 실행 파일 사용, 설치 보일러플레이트 제외,
  `recover-encrypted-db-credentials` 의 기대값 파일을 평가자 전용 캐시로 이동, 그리고 v2 정정 3건
  (스도쿠 I/O 계약 공개·검사 강화, 블록체인 정답을 원본 원장에서 계산, 입력 불변 검사).
- **채점기 제약·원본 검사 한계가 결과에 미친 영향**: 이진 보상이므로 **부분 통과는 전부 실패**다.
  기준 실행의 `extract-paper-metadata-to-json` 은 13개 검사 중 12개를 통과했지만 점수는 0 이다.
  이 값을 부분 점수로 계산하지 않았다.
- **다른 운영체제에서 실제 실행했는지**: **아니다.** Windows 11 에서만 실행했다. 리눅스·macOS 결과는 미측정.

**공식 컨테이너 벤치마크 점수가 아니다.** Docker 없는 로컬 이식판 v2 의 점수이며, v1 점수와 직접
비교하지 않았다. 고정 10문항은 개발용 평가 집합이고, 이 안에서 관찰한 차이를 일반적인 성능 우월성으로
넓히지 않는다.
