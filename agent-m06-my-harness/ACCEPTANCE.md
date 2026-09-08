# 완료 조건과 실행 증거

`NOT_RUN` / `PASS`(실행 증거가 있을 때만) / `FAIL` / `DEFERRED`.
**모의 모델 검증과 실제 모델 검증을 따로 적는다.** 모의 검사(`pytest`) 통과는 실제 모델 성능이 아니다.

- 코드 버전: `own-baseline` = 커밋 시점의 `my_harness/` (각 실행의 `run-metadata.json` 에 `source_sha256`)
- 실행 환경: Windows 11 / Python 3.13.15 / `uv` 0.12.8
- provider · 모델: Ollama 네이티브 `/api/chat` · `qwen3.5:2b` (Q8_0, 2.3B), `temperature 0.6` · `top_p 0.95` · `seed 7`
- 실습 fixture: `fixtures/meeting.txt`, `fixtures/receipt.py` + `test_receipt.py`(버그 3개·테스트 5개), `fixtures/greeting.py` + `test_greeting.py`(버그 1개·테스트 2개) — 전부 내가 만든 것
- 증거 파일: `evidence/` · 모의 검증: `uv run python -m pytest -q` → **48 passed** (기준 버전 시점 39건 + 개선 변경의 회귀 검사 9건)
- **두 버전**: `own-baseline` 소스 `2f7e4a96…`, `own-improved` 소스 `797f17bb…` (각 실행의 `run-metadata.json`). 아래 표에서 버전이 갈리는 항목은 둘을 함께 적었다.

| ID | 관련 요구 | 상황과 행동 | 기대 결과 | 상태 | 실제 증거 |
|---|---|---|---|---|---|
| A01 | R01~R03 | 실습 파일을 **실제 모델**로 읽어 요약 요청 | 실제 읽기 기록과 원문에 맞는 근거 | **PASS** | `evidence/A01-read.txt` — 도구 2회(list_files→read_file), 답의 "9월 15일 화요일 저녁 7시 30분", "노트북·충전기·실습 로그 출력물 1부", "3층 세미나실 B" 가 fixture 원문과 일치. 근거 표시 `읽은 파일: meeting.txt` |
| A02 | R02 | **모의 모델**이 도구 요청 후 결과를 받아 종료 | 인자 검사·실행·결과 연결·종료 | **PASS** (모의) | `tests/test_loop.py::test_tool_call_is_validated_executed_and_returned` — 스키마 검사 → 실행 → 봉투 반환 → `completed`, 모델 2회·도구 1회 |
| A03 | R04~R05 | 결함 코드 수정 요청 (승인 `y`) | 변경 승인 후 적용, 지정 테스트 성공 | **PASS** (개선 버전) / **FAIL** (기준 버전) | **개선 버전 · `evidence/A03-improved-greeting.txt`**: `run_tests` 실패 확인 → `test_greeting.py`·`greeting.py` 읽기 → diff 표시(`수정 greeting.py · +4 -9 줄 · 126 byte · sha256 1e502e55…`) → `y` 승인 → 적용 → `run_tests` **exit 0** → `completed`, 종료 코드 0. 하네스 밖에서 `python -m unittest` 재확인 `OK`, `test_greeting.py` 는 diff 없음. 파일 sha256 `50337f13…` → `1e502e55…`<br>**기준 버전 · `evidence/A03-baseline-fail.txt`**: 같은 종류의 작업이 `provider_error: done_reason='length'` 로 죽었다.<br>**더 어려운 결함(`receipt.py`, 버그 3개)은 개선 버전에서도 실패** — `evidence/A03-improved.txt`: 14단계를 다 쓰고 `step_limit`, 테스트 실패가 2개에서 4개로 늘었다. 승인·적용·테스트 경로는 전부 동작했고 실패는 **모델의 코드 품질**이다 (2.3B). 원인 구분을 `EXPERIMENT_REPORT.md` 에 적었다 |
| A04 | R05 | 파일 변경을 **거절** | 파일 내용이 변경되지 않음 | **PASS** (두 버전) | 개선 버전 `evidence/A04-reject-improved.txt` — 거절 3회, `greeting.py` sha256 `50337f13…` 실행 전후 **동일**, 근거 표시 `바꾼 파일: 없음` · 기준 버전 `evidence/A04-reject.txt` — 거절 2회, `receipt.py` sha256 `cb3f8581…` 전후 동일 · 모의: `tests/test_loop.py::test_rejected_change_keeps_the_run_going_and_the_file_unchanged` |
| A05 | R05 | 허용 폴더 밖 읽기·쓰기 요청 | **코드의 경로 검사**로 거부 | **PASS** | `evidence/A05-path-escape.txt` — 실제 모델이 `C:/Windows/win.ini` 와 `../../secret.txt` 를 호출 → `path_rejected: 절대경로가 작업 폴더를 벗어난다` / `상위 폴더 이동(..)은 허용하지 않는다`. 두 번 다 도구 실패로 모델에 반환되고 작업은 계속됐다 · 모의: `tests/test_tools.py` 의 경로 검사 6건 |
| A06 | R02 | **모의 모델**이 계속 도구 호출 | 합의한 한도에서 종료, 이유 표시 | **PASS** (모의) | `tests/test_loop.py::test_repeating_mock_stops_at_the_step_limit` → `step_limit` ("모델 호출 한도 3회에 걸려 멈췄다"), `::test_repeating_mock_stops_at_the_tool_call_limit` → `tool_limit`, `::test_total_timeout_is_reported_as_timeout` → `timeout` |
| A07 | R01~R02 | 잘못된 인자 / 모델 연결 실패 | 오류를 보여 주고 성공으로 기록하지 않음 | **PASS** | 도구 인자 오류: `evidence/A05-path-escape.txt` (모델에 반환, 작업 계속, 종료 코드 0) · 연결 실패: `evidence/A07-provider-failure.txt` — `--host http://127.0.0.1:9` 로 `provider_error: Ollama 연결 실패 (ConnectError)`, **종료 코드 1**, 토큰 미확인 표시 |
| A08 | R06 | 같은 세션에서 후속 요청 | 합의한 대화/상태 범위가 이어짐 | **PASS** | `evidence/A08-A09-session-followup.txt` — 세션 `reading` 에서 "회비/마감" 질문에 도구 0회로 답했고(앞 실행의 read_file 결과를 이어받음) 값이 fixture 와 일치 · in-process 연속: `tests/test_session.py::test_second_request_in_the_same_session_sees_the_first` |
| A09 | R06 | 저장 후 앱 재시작 | 저장 정책대로 복원 | **PASS** | 같은 증거 — CLI 는 한 번 실행 = 한 작업이므로 위 후속 요청은 **새 프로세스**였고 `세션 reading: 이전 대화를 복원했다` 를 출력했다 · `tests/test_session.py::test_restart_restores_from_the_file`, `::test_different_settings_are_refused`, `::test_missing_session_starts_fresh_without_claiming_restore` |
| A10 | R07 | 추가 provider 로 같은 읽기 작업 | 지원 범위·차이와 결과 기록 | **DEFERRED (D08)** | `OPENAI_API_KEY` 가 없어 실행으로 검증할 수 없다. 검증하지 못한 어댑터 코드를 넣지 않았다. `providers.Provider` 프로토콜로 자리만 분리 (`DECISIONS.md` D08) |
| A11 | R08 | 고정 10문항 기준 평가 | 원본 결과·설정, 오류·미완료 포함 점수 | **PASS** | `results/own-baseline/` — 아래 표 |
| A12 | R08 | 가설에 따른 변경 후 동일 조건 재평가 | 원본 결과와 비교표, 코드 변경·결론 | **PASS** | `results/own-improved/`, `results/comparison/`, `EXPERIMENT_REPORT.md` |

> **공통 필수 항목을 어렵다는 이유로 DEFERRED 로 바꾸지 않았다.** 기준 버전에서 `FAIL` 이던 A03 은
> 원인을 기록한 뒤 개선 버전에서 재실행해 `PASS` 로 바꿨고, 개선 버전에서도 실패한 더 어려운 결함
> (`receipt.py`)은 실패로 남기고 원인을 구분해 적었다. A10 만 D08(추가 provider 미선택) 때문에 `DEFERRED` 다.
> **Oracle 환경 검사나 단위 테스트 성공을 A11·A12 의 실제 모델 평가 증거로 쓰지 않았다.**

## 내 사용자 이야기의 시나리오 (D01)

### 정상 사례 — 근거 있는 요약

- **Given** 작업 폴더 `work/` 에 `meeting.txt` 하나가 있고, 그 안에 모임 일시·장소·준비물이 적혀 있다.
  세션 이름은 `reading` 이고 이전 기록은 없다.
- **When** `--prompt "work 폴더의 meeting.txt 를 읽고 모임 시각과 준비물을 알려 줘."` 로 실행한다.
- **Then** (1) 종료 상태가 `completed` 이고 종료 코드가 0 이다. (2) 근거 표시의 `읽은 파일` 에
  `meeting.txt` 가 있다. (3) 답의 시각·준비물이 원문 문장과 일치한다 — 원문에 없는 회비·장소를
  지어내지 않는다. (4) `runs/<id>/events.jsonl` 에 `tool_call`/`tool_result` 가 남고 **파일 내용은 남지 않는다**.
- **관찰**: 통과 (`evidence/A01-read.txt`). 이벤트 기록에 원문 문자열이 없는 것은
  `tests/test_loop.py::test_events_are_recorded_for_every_step` 이 함께 확인한다.

### 실패 사례 — 승인 없는 변경 시도

- **Given** 작업 폴더에 `receipt.py`(결함 3개)와 `test_receipt.py`(테스트 5개, 2개 실패)가 있다.
  `receipt.py` 의 sha256 을 미리 기록한다.
- **When** `--prompt "receipt.py 의 total 함수를 규칙대로 고쳐 줘."` 로 실행하고, 승인 요청마다 `n` 을 입력한다.
- **Then** (1) 각 `write_file` 이 `rejected_by_user` 로 모델에 반환된다. (2) 실행 후 `receipt.py` 의
  sha256 이 실행 전과 같다. (3) 근거 표시에 `거절된 변경: receipt.py (파일은 그대로)` 가 나온다.
  (4) 종료 코드가 0 이 아니다 — 거절된 작업을 성공으로 보고하지 않는다.
- **관찰**: 통과 (`evidence/A04-reject.txt`). 기대값은 실행 전에 정한 것이고, 구현이 돌려준 값을
  베낀 것이 아니다 — sha256 은 실행 **전에** 계산했다.
