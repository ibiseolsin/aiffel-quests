# 하네스 구현과 실험 보고서

작성 2026-09-09. 빈칸 없이 실제 실행 결과로 채웠다. 채우지 못한 값은 「알 수 없음」으로 적었다.

## 제품과 구현

- **사용자 시나리오 / PRD**: `PRD.md` (D01 사용자 이야기, R01~R08 구체화). 결정은 `DECISIONS.md`,
  계약은 `INTERFACES.md`, 완료 조건과 증거는 `ACCEPTANCE.md`.
- **구현 언어와 실행 방법**: Python 3.13 + `uv`. 단독 실행은 `uv run run_harness.py --prompt … --workspace work`,
  10문항 평가는 `harness_lab.bench --agent my_harness.benchmark_adapter:solve_task`
  (전체 명령은 `IMPLEMENTATION_PLAN.md`).
- **직접 작성한 부분**: `my_harness/` 12개 파일 1,593줄 전부, `tests/` 621줄(48건), `run_harness.py`·`scripts/` 289줄, `fixtures/` 5개 파일.
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
| 소스 SHA256 (개선) | `797f17bbb92413589a3b9eeee5712f185df8086b2343b67568475c9bfe64af16` |
| 실행 환경 | Windows-11-10.0.26200-SP0 · AMD64 Zen3 12 논리코어 · RAM 32 GiB · Python 3.13.15 · `hostlimits: unrestricted` |
| 의존성 잠금 | 내 하네스 `uv.lock` (이 저장소) · 벤치마크 `uv.lock` (v1.0.0 릴리스 그대로) |
| 문항 | 10 = easy 2 · medium 4 · hard 4 (원본 `task.toml` 난도 그대로) |
| 문항당 반복 | `--attempts 1` → **분모 10** |
| 한도 | `--max-steps 20` · `--max-seconds 600` · `--max-output-tokens 4000` · `--command-timeout 10` · 하네스 내부 도구 호출 상한 60(=20×3) · 도구 출력 8,000자 · 대화 60,000자 |
| 기준 실행 폴더 | `jobs/own-baseline` → 제출본 `results/own-baseline/` |
| 개선 실행 폴더 | `jobs/own-improved` → 제출본 `results/own-improved/` |
| 준비·채점 경로 확인 | `benchmark_source --prepare` 가 문항별 파일의 크기·SHA256 을 manifest 와 대조하고 통과했다. 어댑터 연결은 문항 1개 smoke(`scripts/smoke_one_task.py`)로 확인했다 — **이 smoke 와 `pytest` 48건은 개발 진단이고 학생 점수가 아니다.** `--self-check`(참고 풀이로 채점기를 검증하는 운영자 기능)는 실행하지 않았다 |

**기본값을 쓰지 않은 이유**: 안내의 기본값은 40단계·300초·10,000토큰이다. 이 모델은 모델 호출
1회가 10~30초여서 40단계는 300초 안에 절대 끝나지 않고, 10,000토큰 상한은 생각이 길어질 때
한 호출에 3분 이상을 쓴다. 두 값이 어긋난 채 돌리면 열 문항이 모두 시간 초과로만 끝나 실패 원인을
구분할 수 없다. 그래서 20단계·600초·4,000토큰으로 맞췄고, **두 실행에 같은 값을 썼다.**

## 결과

10문항 전체 행은 `results/own-baseline/trials.csv` · `results/own-improved/trials.csv` 에 있다.
**실패·오류·미완료 행을 지우지 않았다.** 분모는 두 실행 모두 10 고정이다.

### 점수

| 측정 | 통과/전체 시도 | 쉬움 | 중간 | 어려움 | 실패 | 실행 오류 | 미완료 | 시간 | 토큰 | 비용 |
|---|---|---|---|---|---|---|---|---|---|---|
| 기준 `own-baseline` | **0/10 (0.0%)** | 0/2 | 0/4 | 0/4 | 0 | **10** | 0 | 730.0초 | **알 수 없음** (10시행 중 8시행만 관측: 입력 965,271 · 출력 53,920) | **알 수 없음** |
| 개선 `own-improved` | **0/10 (0.0%)** | 0/2 | 0/4 | 0/4 | 0 | **10** | 0 | 650.6초 | **알 수 없음** (10시행 중 6시행만 관측: 입력 640,687 · 출력 40,269) | **알 수 없음** |

- **점수 차이 0.0%p.** `improved` 라는 이름이 개선을 확인해 주지 않는다는 것을 이 실험이 그대로 보여 준다.
- 분모는 두 실행 모두 10 고정이다. `fail 0 · error 10` 인 것은 **어느 시행도 `completed` 로 끝나지
  않아서**다 — 벤치마크는 `status != "completed"` 인 시행에 `AgentIncomplete` 예외를 붙이고,
  보고서는 예외가 있는 시행을 `error` 로 분류한다. 보상이 1 이어도 마찬가지다(아래 easy 문항).
- 토큰 합계는 `null`(알 수 없음)이다. 시간 한도·잘린 응답으로 끝난 시행은 사용량을 신뢰할 수 없어
  `usage_known=False` 로 보고했고, **모르는 값을 0 으로 채우지 않았다.** 비용은 로컬 모델이라 청구액이
  없다 — 전력·감가는 계산하지 않았으므로 「알 수 없음」이다.
- 시간은 이 기계(12논리코어, 다른 프로그램과 공유)의 값이다.

### 문항별 (10문항 전체, 지운 행 없음)

`검사` 는 채점기가 통과시킨 개별 검사 수다. **이진 점수에서 부분 통과는 전부 실패**이므로
점수에는 들어가지 않는다. 원본 행은 `results/*/trials.csv` · `verifier-summary.csv`.

| 난도 | 문항 | 기준 상태 | 기준 검사 | 개선 상태 | 개선 검사 | 보상 | 입력 변경 |
|---|---|---|---|---|---|---|---|
| easy | `extract-paper-metadata-to-json` | step_limit | 12/13 | context_limit | **13/13** | **0 → 1** | 0 → 0 |
| easy | `python-sudoku-solver-backtracking` | step_limit | 2/22 | step_limit | 2/22 | 0 → 0 | 0 → 0 |
| medium | `detect-corrupted-blockchain-transaction` | provider_error | 2/11 | provider_error | 2/11 | 0 → 0 | 0 → 0 |
| medium | `implement-go-board-analyzer` | context_limit | 0/16 | step_limit | 0/16 | 0 → 0 | 0 → 0 |
| medium | `python-sokoban-bfs-solver` | step_limit | 4/12 | provider_error | 0/12 | 0 → 0 | **1 → 0** |
| medium | `recover-encrypted-db-credentials` | step_limit | 0/30 | step_limit | 0/30 | 0 → 0 | 0 → 0 |
| hard | `advanced-json-to-rfc4180-csv-converter` | provider_error | 0/90 | context_limit | 0/90 | 0 → 0 | 0 → 0 |
| hard | `implement-depgraph-dependency-resolver` | step_limit | 0/13 | step_limit | 0/13 | 0 → 0 | 0 → 0 |
| hard | `implement-lz77-file-compressor` | step_limit | 2/85 | provider_error | 2/85 | 0 → 0 | 0 → 0 |
| hard | `implement-nonogram-puzzle-solver` | step_limit | 4/13 | provider_error | 4/13 | 0 → 0 | 0 → 0 |

두 줄이 중요하다.

- **`extract-paper-metadata-to-json` 은 개선 버전에서 실제로 풀렸다** — 검사 13/13, 이진 보상 **1**.
  그런데 하네스가 대화 길이 한도(`context_limit`)에서 멈춰 `completed` 로 끝내지 못했고, 채점 규칙상
  **보상 1 과 실행 미완료가 함께 있으면 성공이 아니므로 여전히 `error`** 다. 점수 0/10 은 이 규칙을
  그대로 적용한 값이다.
- **`python-sokoban-bfs-solver` 의 기준 4/12 는 애초에 무효였다.** 기준 실행에서 에이전트가 입력
  `app/level1.txt` 를 **변경**했고(`fixture_changes: ["app/level1.txt"]`), 정정 v2 는 입력이 바뀌면 다른
  검사가 통과해도 보상 0 으로 처리한다. 개선 버전은 입력을 건드리지 않았다(0건). 검사 수는
  4 → 0 으로 내려갔지만 **입력을 바꿔 얻은 4 와 바꾸지 않은 0 은 같은 종류의 값이 아니다.**

### 하네스 지표 (내 실행 기록에서 센 것)

`results/*/trials/<문항>__1/agent-events.jsonl` 을 세었다 (`scripts/analyze_events.py`).

| 지표 | 기준 | 개선 | 차이 |
|---|---|---|---|
| 종료 상태 | step_limit 7 · provider_error 2 · context_limit 1 | step_limit 4 · provider_error 4 · context_limit 2 | — |
| 모델 호출 합계 | 167 | **137** | **-30 (-18%)** |
| 도구 호출 합계 | 168 | **142** | **-26 (-15%)** |
| 도구 실패 | 73 (43%) | 75 (**53%**) | +2 |
| `list_files` 호출 | 41 | **18** | **-23 (-56%)** |
| `read_file` `path_rejected` | 23 | **1** | **-22** |
| `run_python` `invalid_arguments` | 10 | **1** | **-9** |
| `read_file` `not_found` | 15 | 31 | **+16** |
| `run_python` `not_found` | 5 | 17 | **+12** |
| `write_file` 성공 | 19 | 22 | +3 |
| 입력 fixture 를 바꾼 시행 | 1 | **0** | -1 |
| 전체 실행 시간 | 730.0초 | 650.6초 | -79.4초 |

비교 보고서(`results/comparison/report.json`)는 `controlled_comparison: true`,
`differences_or_unknowns: []`, `score_delta: 0.0` 으로 기록했다 — 모델·한도·평가 버전이 같았고
**바뀐 것은 하네스 코드뿐**이라는 것을 도구 쪽에서도 확인했다.

## 실패 분석과 개선 가설

### 대표 실패 하나 (기준 실행)

- **문항**: `recover-encrypted-db-credentials` (medium, 자료 처리)
- **요청**: 준비된 지시문 그대로 — 디스크 블록에서 암호화된 DB 자격증명을 복구해 지정 파일로 쓰는 작업.
- **관찰한 도구 실행** (`results/own-baseline/trials/recover-encrypted-db-credentials__1/agent-events.jsonl`):
  20단계 중 **19단계가 `list_files`** 였다. 4단계에서 `read_file` 을 한 번 시도해 `not_found` 를 받은 뒤
  다시 `list_files` 만 반복하다 `step_limit` 으로 끝났다. 파일을 **한 번도 읽지 못했다**
  (`evidence_counts: {}`).
- **채점 결과**: 30개 검사 중 0개 통과, 보상 0.
- **추정 원인과 근거**: 그 시행의 작업 폴더에 있는 파일 14개가 **전부 숨김 경로**였다
  (`db/.disk_blocks/block_000.bin` … `db/.recovery_notes.txt`). 내 `list_files` 는 숨김 경로를 제외했으므로
  매번 `{"files": [], "count": 0}` 을 돌려줬다. 모델은 **"폴더가 비었다" 와 "숨김은 보여 주지 않는다" 를
  구분할 근거를 받지 못했다.** 시스템 프롬프트에 "숨김·바이너리 fixture 는 보조 스크립트로 읽어라" 라고
  적어 두었지만, 도구 결과가 빈 목록이면 그 문장은 실행으로 이어지지 않았다.
- 열 문항 전체로 넓혀 보면 같은 종류의 낭비가 지배적이었다: 도구 호출 168회 중 실패 73회(43%)였고
  그중 **51회가 경로 문제**(`read_file path_rejected` 23 · `not_found` 15 · `write_file path_rejected` 8 ·
  `run_python not_found` 5), `list_files` 는 41회(전체 호출의 24%) 불렸다.

### 변경한 한 가지 요소

**하네스가 관측한 작업 폴더 사실을 모델에 명시적으로 준다.** 관측을 만드는 곳은 새 모듈
`my_harness/orientation.py` 한 곳이고, 같은 관측이 세 지점에 들어간다.

1. 실행 시작 시 첫 메시지 (`brief`) — 실제 파일 목록, 시작 폴더, 숨김 항목 개수와 읽는 방법
2. `list_files` 결과 — `hidden`·`hidden_count` 를 함께 주고, `files` 가 비었는데 `hidden` 이 있으면
   "폴더가 비었다는 뜻이 아니다" 를 `hint` 로 명시
3. 경로 실패(`not_found`·`path_rejected`·`not_python`·`not_a_file`)의 `hint` — 그 순간 관측한
   **실제 후보 경로**(같은 파일명 우선, 최대 5개)

**권한 경계는 넓히지 않았다.** 파일 도구는 여전히 숨김 경로를 거부한다 — 존재만 알리고 열지는 않는다.
`tests/test_orientation.py::test_hidden_paths_are_still_refused_by_the_file_tools` 가 이것을 고정한다.

실제 변경량: `orientation.py` 88줄 신설, `tools.py`·`workspace.py`·`benchmark_adapter.py`·`cli.py` 에서
76줄 변경(줄 바꿈 문자 차이 제외), 회귀 검사 9건 추가(39 → 48건). 두 스냅샷의 소스 해시
`2f7e4a96…` → `797f17bb…`.

### 예상한 영향

목록 재조회와 경로 실패가 줄어 같은 단계 예산으로 더 멀리 가고, 최소 한두 문항에서 요구된
산출물까지 도달할 것으로 봤다.

### 실제 변화

**좋아진 점**

- **의도한 낭비가 실제로 줄었다.** `list_files` 41 → 18(-56%), `read_file path_rejected` 23 → 1(-22),
  `run_python invalid_arguments` 10 → 1(-9). 모델 호출 167 → 137(-18%), 전체 시간 730 → 651초.
- **easy 문항 하나가 실제로 풀렸다**: `extract-paper-metadata-to-json` 검사 12/13 → **13/13**,
  이진 보상 0 → **1**. 기준 실행은 마지막 검사(`test_all_papers_processed`)를 통과하지 못했다.
- **입력 fixture 를 바꾼 시행이 1 → 0** 이 됐다. 기준 실행의 sokoban 은 입력 `app/level1.txt` 를
  고쳤다(그 자체로 보상 0). 실제 경로를 알려 주니 입력을 덮어쓰는 행동이 사라졌다.
- `write_file` 성공 19 → 22 — 탐색 대신 산출물 작성에 단계를 더 썼다.
- 제품 기능 쪽에서도 A03 이 `FAIL` → `PASS` 로 바뀌었다 (`ACCEPTANCE.md`).

**나빠진 점**

- **점수는 그대로 0/10 이다.** 실제로 푼 문항이 생겼는데도 `context_limit` 으로 끝나 `completed` 가
  아니었고, 채점 규칙상 `error` 로 분류됐다. **하네스가 일을 끝냈다고 선언하지 못하면 점수가 되지 않는다.**
- **도구 실패율이 43% → 53% 로 올랐다.** 총 호출이 줄었는데 실패 건수는 +2 였다. 세부적으로
  `read_file not_found` 15 → 31, `run_python not_found` 5 → 17 로 늘었다. 관측을 준 뒤 모델이
  **아직 만들지 않은 산출물 경로를 미리 읽으려 하는** 호출이 늘었다(자기 산출물 확인). 지금 설계는
  그것을 실패로만 돌려주고 "아직 없다 — 먼저 만들라" 로 구분해 주지 않는다.
- **`provider_error`(잘린 응답)가 2 → 4 로, `context_limit` 이 1 → 2 로 늘었다.** 관측 블록이
  프롬프트를 키워 대화 예산을 더 빨리 쓴다. `advanced-json-to-rfc4180-csv-converter` 는 6단계에서,
  `extract-paper-metadata-to-json` 은 13단계에서 대화 한도에 걸렸다.
- **sokoban 은 검사 4/12 → 0/12 로 내려갔다.** 다만 기준의 4 는 입력을 바꿔 얻은 값이라 보상 0
  이었으므로 점수로는 둘 다 0 이다. 그래도 "검사 통과 수" 지표만 보면 나빠진 문항이다.

**동일하게 유지한 조건 / 바뀐 조건**

- 유지: 문항 10개와 manifest 해시, 평가 ID·port_version, upstream 커밋, 제공자·모델, 샘플링
  (`temperature 0.6`·`top_p 0.95`·`seed 7`), 한도 4종, 시도 수 1, 실행 기계와 OS.
- 바뀐 것: **`my_harness/` 코드만.** 비교 보고서도 `controlled_comparison: true`,
  `differences_or_unknowns: []` 로 기록했다.
- 통제하지 못한 것: 같은 기계에서 Ollama 서버와 다른 프로그램이 동시에 돌았고, 두 실행은 시각이 다르다.
  시간 수치는 그 조건의 값이다.

### 결론과 다음 실험

- **결론**: 하네스가 관측한 사실을 모델에 주는 것은 **탐색 낭비를 실제로 줄였고**(모델 호출 -18%,
  경로 형식 오류 -22건, 목록 재조회 -56%) **한 문항을 실제로 풀게 했지만**, 고정 10문항의 이진 점수는
  0/10 그대로였다. 이 실험에서 병목은 "모델이 폴더를 모른다" 에서 **"하네스가 완주를 선언하지 못한다"**
  로 옮겨갔다. 아낀 예산을 대화 길이가 다시 먹었다.
- **다음 실험 (하나만)**: **대화 길이 한도에 닿았을 때 종료하지 않고, 오래된 도구 결과를 접어(요약·절삭)
  반복을 계속한다.** 근거: 개선 실행에서 실제로 보상 1 을 받은 시행이 `context_limit` 때문에 `error` 로
  분류됐고, `context_limit`·`provider_error` 가 10문항 중 6문항의 종료 원인이었다. 볼 지표는
  `completed` 시행 수(현재 0)와 `pass+fail` 합(현재 0)이다. 점수가 아니라 **완주율**을 먼저 본다.
- 이어서 볼 것: 아직 없는 산출물 경로의 `not_found` 를 "먼저 만들라" 로 구분하기,
  잘린 응답(`done_reason='length'`)을 회복 가능한 관측으로 돌려주기.

### 이 실험의 한계

- **문항당 1회 실행이다.** `seed` 를 고정했지만 문항별 변화는 한 번의 관측이므로,
  특히 sokoban 의 4 → 0 은 **잡음과 구분되지 않는다.** 반복 실행은 미측정이다.
- **고정 10문항은 개발용 평가 집합이다.** 같은 문항을 보고 개선했으므로 여기서 본 차이를
  일반적인 성능 향상으로 넓히지 않는다.
- **모델이 2.3B 로컬 모델이다.** 열 문항 전부 0 점인 조건에서 하네스 변경의 효과는 점수보다
  **종료 상태와 도구 실패 구성**에서만 보인다. 더 강한 모델에서 같은 변경이 같은 방향으로 작동하는지는
  미측정이다 (D08 을 미뤄 OpenAI 경로를 실행하지 않았다).
- **한 기계·한 OS 에서만 돌렸다.** 리눅스·macOS, Docker 환경, 공식 컨테이너 점수는 미측정이다.
- **`pass@k` 가 아니다.** 시도 1회의 평균이며, 반복을 늘리면 분모도 함께 늘어난다.

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
