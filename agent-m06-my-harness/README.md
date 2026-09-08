# 나만의 에이전트 하네스 — 구현체 + 고정 10문항 비교 실험

- 코스: AI Agent 파헤치기_Agt1 — m06 나만의 에이전트 하네스 만들기
- 커리큘럼: https://learn.modulabs.co.kr/camp/136/courses/2196/node-version/5358/steps/27048 (12강, step 27048–27059)
- 강의노트: `../../AI-Study/notes/aiffel/agent-m06-my-harness.md`
- 원문: `../../AI-Study/sources/aiffel/agent-m06-my-harness/raw.md`
- 상태: **구현·두 평가 완료** (2026-09-09) · 남은 것은 LMS 제출 클릭
- 제출: LMS 커리큘럼의 `프로젝트 제출` 항목 (`대기중`) — `제출하기 이동` 링크는 12강 페이지 상단

> 원문 12강에는 별도 `## 과제` 절도, 배점표 형태의 루브릭도 없다. **제출 요건이 본문 산문에 녹아 있다.**
> 「원문 요건 정리」 이하는 그 문장들을 요건별로 모은 것이고, 표현은 원문을 따랐다.

---

## 내가 만든 것

`my_harness` — 모델 요청 → 인자 검사 → 도구 실행 → 결과 반환의 반복을 **직접 구현한** CLI 하네스.
완성된 에이전트 CLI 나 Agent SDK 에 반복을 넘기지 않는다. 제공 예제(`harness_lab.local_agent`)를
호출하지도 않는다 — 벤치마크 어댑터도 내 `Harness` 를 돌린다.

```
my_harness/
  contracts.py          내부 계약(제공자·도구·반복이 공유) · 한도 · 종료 상태 7종
  loop.py               ★ 반복 본체 (모델 호출 · 인자 검사 · 도구 실행 · 종료 판정)
  providers.py          Ollama 네이티브 /api/chat 어댑터 (num_ctx 를 대화 한도에서 유도)
  tools.py              도구 5개 + JSON Schema 검사 + 실패 시 hint
  workspace.py          경로 경계 (절대경로 · .. · 숨김 · 심링크 · resolve 확인)
  execute.py            시간 제한 있는 Python 실행 (OS 샌드박스가 아니다)
  approval.py           diff 표시 + sha256 결속 승인 (EOF 는 거절)
  session.py            세션 파일 영속 + 이벤트 JSONL
  benchmark_adapter.py  고정 10문항 평가 연결 (solve_task)
run_harness.py          CLI 진입점
fixtures/               내 실습 자료 (모임 공지 · 결함 있는 계산 코드 + 테스트)
tests/                  모의 모델로 반복·한도·경계 검증 (39건)
scripts/                smoke 점검 · 제출용 결과 추출
```

### 실행법

```bash
uv sync --extra dev
uv run python -m pytest -q                     # 모의 검증 39건 (실제 모델 성능이 아니다)
uv run python -c "import shutil; shutil.copytree('fixtures','work')"
ollama serve                                   # 다른 터미널
uv run run_harness.py --prompt "work 폴더의 meeting.txt 를 읽고 모임 시각과 준비물을 알려 줘."   --workspace work --session reading
```

코드 수정 작업(승인 필요, 테스트 대상 고정):

```bash
uv run run_harness.py --prompt "receipt.py 가 test_receipt.py 를 통과하지 못한다. 테스트는 바꾸지 말고 고쳐 줘."   --workspace work --session receipt-fix --test-target "-s . -p test_receipt.py"
```

고정 10문항 평가는 `IMPLEMENTATION_PLAN.md` 의 「실행 환경과 의존성」에 명령 그대로 있다.

### 제출물 — 원문 7개 항목이 어디 있나

| # | 원문이 요구한 것 | 이 저장소 |
|---|---|---|
| 1 | 실제 실행 프로젝트와 **두 버전의 소스**, 의존성 설정·잠금 파일, `README.md` | `my_harness/`(현재=개선 버전) · `pyproject.toml` · `uv.lock` · 이 파일. **기준 버전 소스**는 `results/own-baseline/run-metadata.json` 의 `source_sha256` `2f7e4a96…` 로 고정되어 있고 커밋 `8312f0f` 이 그 상태다 (개선은 `797f17bb…`, 커밋 `4de051e`) |
| 2 | `PRD.md`, `DECISIONS.md`, `INTERFACES.md`, `ACCEPTANCE.md` | 같은 이름으로 이 폴더에 |
| 3 | `IMPLEMENTATION_PLAN.md` 와 `EXPERIMENT_REPORT.md` | 같은 이름으로 이 폴더에 |
| 4 | 고정 `benchmark/tasks.json` 과 두 실행의 설정·`run-metadata.json` | `results/own-baseline/tasks.json`(= manifest, sha256 `21f333a9…`) · `results/*/run-metadata.json` |
| 5 | 두 실행의 **원본 trial 결과**와 하네스 실행 기록 | `results/*/trials/<문항>__1/result.json` · `agent-events.jsonl` |
| 6 | 두 실행의 **10문항 전체** `trials.csv` · `report.json` · `index.html` | `results/own-baseline/`, `results/own-improved/`, 비교는 `results/comparison/` |
| 7 | 개선 가설, 변경 내용, 좋아진 점·나빠진 점, 남은 한계 | `EXPERIMENT_REPORT.md` 의 「실패 분석과 개선 가설」 |

제외한 경로와 이유, 다시 준비하는 방법은 `PROVENANCE.md` 와 `results/*/EXCLUDED.md`.

### 결과 한 줄

기준 `own-baseline` **0/10 (0.0%)** → 개선 `own-improved` **0/10 (0.0%)**. 점수는 그대로지만
모델 호출 -18%, 경로 형식 오류 -22건, 목록 재조회 -56%, easy 문항 하나는 검사 12/13 → **13/13
(이진 보상 1)** 이 됐다 — 다만 그 시행이 `context_limit` 으로 끝나 채점 규칙상 `error` 로
분류되므로 점수에는 들어가지 않는다. 자세한 내용은 `EXPERIMENT_REPORT.md`.

### 문서 지도

| 파일 | 내용 |
|---|---|
| `PRD.md` | 사용자 이야기(D01)와 R01~R08 구체화, 범위와 제외 |
| `DECISIONS.md` | D01~D09 상태·선택·이유 (D08·D09 는 DEFERRED) |
| `INTERFACES.md` | 세 연결의 입력·출력·오류 + 구체적 계약 한 개(`write_file`) |
| `ACCEPTANCE.md` | A01~A12 상태와 **실행 증거**, 내 시나리오 정상/실패 |
| `IMPLEMENTATION_PLAN.md` | 실행 환경·의존성·순서와 단계별 기록 |
| `EXPERIMENT_REPORT.md` | 기준·개선 두 평가, 실패 분석, 가설, 좋아진 점·나빠진 점·한계 |
| `PLAN.md` | 수직 슬라이스 목록과 고정한 실행 조건 |
| `PROVENANCE.md` | 내려받은 자료의 주소·해시·재준비 방법, 제외 경로와 이유 |
| `results/` | 두 실행의 `run-metadata.json` · `trials.csv` · `report.json` · `index.html` · 시행별 원본 결과 |
| `evidence/` | 실제 모델 검증 콘솔 기록 (A01·A03~A09) |

---

# 원문 요건 정리

아래는 착수 전에 원문 문장을 요건별로 모아 둔 것이다. 실제로 무엇을 어떻게 했는지는
위의 「내가 만든 것」과 `ACCEPTANCE.md` · `EXPERIMENT_REPORT.md` 에 있다.

## 만들 것

**세 가지를 함께** 완성한다. 하나라도 빠지면 원문 기준으로 제출물이 아니다.

| # | 산출물 | 원문의 표현 |
|---|---|---|
| 1 | **동작하는 구현체** | 모델 요청·도구 실행·결과 반환의 반복을 **자신의 소스에서** 구현 |
| 2 | **고정 10문항의 기준·개선 두 평가** | "기본 제출에는 열 문제를 문항당 한 번씩 실행한 기준 평가와, 같은 열 문제를 다시 실행한 변경 후 평가가 모두 필요합니다. **총 두 평가**" |
| 3 | **근거를 연결한 분석** | `EXPERIMENT_REPORT.md` — 실패 분석·개선 가설·좋아진 점과 나빠진 점·남은 한계 |

### 원문이 명시한 실패 조건

- **"명세와 코드만 만들고 실제 평가를 한 번도 실행하지 않았다면 실험을 완료한 제출물은 아닙니다."**
- **"한 번 실행해 높은 점수가 나왔다고 비교 과정을 생략하지 않습니다."**
- `dry-run` 과 모의 테스트만 수행한 것은 **"실행 가능한 연결을 점검한 단계이며 실제 평가가 남아 있다"**

### 완료 조건이 *아닌* 것

- **10문항 전부 통과는 완료 조건이 아니다.** "쉬움 2개·중간 4개·어려움 4개를 모두 통과하지 못해도
  분석할 수 있는 실험입니다."
- **높은 점수 하나가 성과가 아니다.** "무엇을 바꿨고 어떤 조건에서 어떤 결과를 관찰했는지 검증 가능한
  형태로 설명하는 것"

---

## 제출 자료 (원문의 7개 항목, 그대로)

1. 실제 실행 프로젝트와 **두 버전의 소스**, 의존성 설정·잠금 파일, `README.md`
2. `PRD.md`, `DECISIONS.md`, API·도구 명세인 `INTERFACES.md`, `ACCEPTANCE.md`
3. `IMPLEMENTATION_PLAN.md` 와 작성한 `EXPERIMENT_REPORT.md`
4. 고정 `benchmark/tasks.json` 과 기준·개선의 설정, `run-metadata.json`
5. 두 실행의 **원본 trial 결과**와 하네스 실행 기록
6. 두 실행의 **10문항 전체**를 담은 `trials.csv`, `report.json`, `index.html`
7. 개선 가설, 변경 내용, 좋아진 점과 나빠진 점, 남은 한계

### 제출에서 제외할 것

- `jobs/<실험이름>/source/benchmark/upstream/` — 내려받은 **원본 문제·자료·풀이·테스트**
- `.benchmark-cache/`
- 로그에 섞인 **원본 정답·검사 코드** (가리고 위치와 이유를 남긴다)
- **API 키·토큰·개인 자료**
- 시행별 작업 폴더와 `verifier/` 도 같은 기준으로 확인 (원본 fixture 가 들어갈 수 있다)

> **"원문을 제외한다는 이유로 실패 시행이나 불리한 점수 행을 삭제하지 않습니다."**
> 제출용 파일 목록에 **제외 경로와 이유**, **고정 upstream 주소·커밋·파일 해시와 자료를 다시 준비하는
> 방법**을 적는다. **원래 실행 메타데이터를 덮어쓰지 않는다** (제출용 정리본의 소스 해시는 달라진다).

### 보존할 것

자신의 구현·변경 내용, 시행별 `result.json`, 하네스 이벤트 기록, 채점 결과 XML·표준 출력·오류 출력,
실행 메타데이터, 집계 보고서.

---

## 원문이 지정한 재료

### 실습 자료 (다운로드)

| 저장소 | 파일 | 릴리스 |
|---|---|---|
| `github.com/SunCreation/agent-building-practice` | `harness-design-kit.zip` (1~8강 설계 자료) | v4.0.0 |
| `github.com/SunCreation/agent-building-practice` | `harness-lab.zip` (9강 Python 구현 예제) | v4.0.0 |
| `github.com/SunCreation/agent-terminal-benchmark` | `agent-terminal-benchmark.zip` (10~12강 평가) | v1.0.0 |

> 벤치마크 ZIP 안의 **`BENCHMARK_ERRATA.md`**(정정 내역)와 **`STUDENT_GUIDE.md`**(연결 안내)를 먼저
> 읽는다. 원문이 밝힌 정정 두 건: **스도쿠 함수 계약 공개**, **블록체인 입력·정답 불일치 교정.**
> **입력 파일을 변경하면 실패 처리**된다.
>
> **주의**: 위 주소는 강의노트 수집 과정에서 확인된 것이고 원문 본문에는 링크 텍스트만 남아 있다.
> 착수 전에 LMS 에서 실제 링크를 다시 확인할 것.

### 벤치마크

- **Terminal-Bench Pro** 고정 커밋 `874af409da6aafebccbf3bc5bb41a2fa4d78784d`
  (`github.com/alibaba/terminal-bench-pro`)
- **easy 2 · medium 4 · hard 4 = 10문항.** 난도는 **원본 `task.toml` 메타데이터** 그대로

| 문제 | 난도 | 분야 |
|---|---|---|
| `extract-paper-metadata-to-json` | easy | 자료 처리 |
| `python-sudoku-solver-backtracking` | easy | 게임 |
| `detect-corrupted-blockchain-transaction` | medium | 디버깅 |
| `implement-go-board-analyzer` | medium | 소프트웨어 엔지니어링 |
| `python-sokoban-bfs-solver` | medium | 게임 |
| `recover-encrypted-db-credentials` | medium | 자료 처리 |
| `advanced-json-to-rfc4180-csv-converter` | hard | 자료 처리 |
| `implement-depgraph-dependency-resolver` | hard | 시스템 관리 |
| `implement-lz77-file-compressor` | hard | 자료 처리 |
| `implement-nonogram-puzzle-solver` | hard | 게임 |

> **Docker 는 필요하지 않다** (`execution_mode: local-port`). 원본의 `/app`·`/protected`·`/home/user`
> 를 `workspace/…` 로 옮겨 실행하고 **원본 `tests/test_outputs.py` 를 pytest 로 채점**한다.
> **중국어로 작성된 문제도 있다** — 번역하며 조건을 줄이지 않는다.

### 런타임

- **Python 3.13+**, `uv` (`uv sync --locked`, `--extra dev`)
- 채점이 호출하는 도구: `pytest`, `mypy`, `flake8`, `unittest`
- **모델**: OpenAI Responses API (원문 예시 `gpt-4.1-mini`, 키는 `OPENAI_API_KEY`) 또는
  Ollama 네이티브 `/api/chat` (`http://localhost:11434`, 원문 예시 `qwen3.5:2b`)
- **키는 실행할 터미널에 설정한다** — 채팅·PRD·보고서·캡처에 붙이지 않는다

### 한도 (기본값)

| 경로 | 값 |
|---|---|
| 일반 CLI | 모델 12회 · 도구 30회 · 300초 · 도구당 30초 · 도구 출력 16,000자 · 대화 200,000자(`context_limit`) |
| 벤치마크 | 40단계 · 300초 · 응답당 10,000토큰 · Python 실행 10초 |

조정 옵션: `--max-steps`, `--max-seconds`, `--max-output-tokens`, `--command-timeout`.
**기준·개선 두 실행에 동일하게 적용한다.**

---

## 설계 결정 D01~D09

첫 구현 전에 **D01~D07 을 합의**한다. **D08·D09 는 `DEFERRED` 로 둘 수 있다** (이유를 남긴다).

| ID | 결정 대상 |
|---|---|
| D01 | 사용자와 업무 |
| D02 | 플랫폼 (화면 + 하네스 실행 위치) |
| D03 | 구현 언어 |
| D04 | 첫 모델 제공자와 모델 |
| D05 | 최초 도구와 작업 범위 |
| D06 | 승인 방식 |
| D07 | 세션 (대화 저장 범위) |
| D08 | 추가 제공자 |
| D09 | 확장 기능 (취소·동시 실행·원격 접속 등) |

상태: `OPEN` (미결정) / `CHOSEN` (합의) / `DEFERRED` (**필요 없다는 뜻이 아니라 나중에**).

## 검증 항목 A01~A12

`ACCEPTANCE.md`. 상태: `NOT_RUN` / `PASS`(**실행 증거가 있을 때만**) / `FAIL` / `DEFERRED`.

| ID | 원문에서 확인된 내용 |
|---|---|
| A01 | **실제 모델**의 자료 작업 — 연결·읽기 + **최종 답의 근거 일치** |
| A02 | **모의** 도구 호출 — 인수 검사, 실제 도구 연결, 결과 반환, 종료 |
| A03 | 코드 변경 — 변경 전 실패 → 제안 확인 → 승인 → 재검사 → **무관한 변경·기대값 조작 없음** |
| A04 | 변경 **거절** 뒤 **파일 내용이 그대로**인지 대조 |
| A05 | 작업 폴더 **밖 경로 이탈 요청이 코드의 검사에서 거절**되는지 |
| A06 | **반복하는 모의 응답** — 합의한 한도에서 멈추는지 |
| A07 | 오류 구분 — 도구 인수 오류(모델에 반환) vs API 연결 실패(사용자에 표시) |
| A08 | **같은 세션 후속 요청** (실행 중 이어짐 / 재시작 복원은 다른 기능) |
| A09 | 재시작 복원 — D07 에서 영속 저장을 안 골랐으면 `DEFERRED` 가능 |
| A10 | 추가 제공자 — D08 을 미뤘으면 `DEFERRED` 가능 |
| A11 | **기준 측정** (R08 연결) |
| A12 | **변경 후 비교 실험** (R08 연결) |

> **공통 필수 항목이 어렵다는 이유로 `DEFERRED` 로 바꾸지 않는다** — 실패 원인과 남은 구현을 기록한다.
> **Oracle 환경 검사나 단위 테스트의 성공을 A11·A12 의 실제 모델 평가 증거로 대신하지 않는다.**

---

## 실행 명령 (원문 그대로)

### 설계 자료

```bash
# harness-design-kit 을 개발 도우미의 작업 폴더로 열고 대화로 D01~D07 을 채운다
```

### 제공 Python 하네스 (harness-lab 루트 — pyproject.toml·run.py·harness_lab/ 이 보이는 곳)

```bash
uv sync --locked
uv run run.py
uv run python -c "import shutil; shutil.copytree('examples/workspace', 'work')"
```

```bash
uv run run.py --provider openai --model gpt-4.1-mini --workspace work --session reading --prompt "meeting.txt를 읽고 모임 시각과 준비물을 알려 줘."
```

```bash
uv run run.py --provider openai --model gpt-4.1-mini --workspace work --session receipt-fix --prompt "영수증 계산의 테스트를 실행하고 잘못된 부분을 고쳐 줘. 테스트는 바꾸지 말고 다시 확인해 줘."
uv run python -m unittest discover -s work -p test_receipt.py -v
```

```bash
uv sync --locked --extra dev
uv run python -m pytest -q
```

### 벤치마크 (agent-terminal-benchmark 루트)

```bash
uv sync --locked
uv run python -m harness_lab.benchmark_source --prepare
uv run python -m harness_lab.bench --name baseline --provider openai --model gpt-4.1-mini --dry-run
```

```bash
uv run python -m harness_lab.bench --name baseline --provider openai --model gpt-4.1-mini --attempts 1
uv run python -m harness_lab.bench --name improved --provider openai --model gpt-4.1-mini --attempts 1
```

내 하네스를 연결했으면 `--agent` 를 붙인다:

```bash
uv run python -m harness_lab.bench --name baseline-own --agent my_agent:solve_task --provider openai --model gpt-4.1-mini
```

### 모니터·보고서

```bash
uv run python -m harness_lab.report jobs/baseline --manifest benchmark/tasks.json --attempts 1 --watch 5 --output reports/baseline
uv run python -m harness_lab.report jobs/improved --manifest benchmark/tasks.json --attempts 1 --compare jobs/baseline --output reports/comparison
```

---

## 내 하네스 연결 규격

`examples/benchmark_agent.py` 를 프로젝트 루트의 **`my_agent.py`** 로 복사해 구현한다.
**템플릿은 연결 전 오류를 내도록 되어 있고 정답을 대신 만들어 주지 않는다.**

```python
async def solve_task(instruction, workspace, logs_dir, options):
    # 자신의 하네스를 호출하고 실제 결과를 반환합니다.
    ...
```

| 인수 | 내용 |
|---|---|
| `instruction` | 문제 설명 (원문 그대로 전달) |
| `workspace` | 이번 시행의 작업 폴더 |
| `logs_dir` | 실행 기록 위치 |
| `options` | 모델·한도 등 설정 (`command_timeout`, `task_cwd` 등) |

반환값은 **`status` · `answer` · `metrics`** 를 가진 사전. 완료 상태는 **`completed`** —
**실제 정답 여부는 채점기가 판단한다.** 정확한 필드는 `harness_lab/local_agent.py` 의 `solve_task`
(제공 baseline 연결 사례)를 확인한다.

> TypeScript·Rust 로 구현했다면 **이 Python 함수가 그 프로그램을 호출**하게 만든다 — 입력·출력, 종료
> 코드, 시간 제한, 사용량 미관측 처리까지 확인하고 **외부 실행 파일과 의존성 버전도 기록**한다.
> **모델·도구 반복을 수행하는 주체는 제출한 하네스여야 한다.**

---

## 점수 판정 규칙 (원문이 못박은 것)

| 상태 | 의미 |
|---|---|
| `pass` | 완료된 시행의 **이진 보상이 정확히 1** |
| `fail` | 완료된 시행의 **이진 보상이 정확히 0** |
| `error` | 실행 예외, 비이진·누락 보상, 종료된 작업의 결과 누락 |
| `pending` | 아직 완료 결과를 확인할 수 없음 |

- **분모는 10문항 고정.** 성공 3·실패 4·오류 2·미완료 1 → **3/10** (3/8 로 계산하면 환경 문제를 지운 것)
- **`0.7` 같은 비이진 보상은 부분 점수를 주지 않고 오류로 표시**하고 원래 값을 남긴다
- **실행 예외와 보상 1 이 함께 있으면 정상 성공이 아니다**
- 반복 3회면 **분모 30** — "각 문제 한 번이라도 성공했으니 100%" 는 `pass@k` 로 다른 지표다
- 보고서의 `--attempts` 가 실행 메타데이터와 다르면 **오류를 낸다**
- `kind: grader_self_check` 와 `--self-check` 결과는 **채점 경로 진단이고 학생 점수에 합치지 않는다**
- **`unknown` 은 0 이 아니다** — 토큰·비용·시간. `usage_known=False` 면 완전한 값이 아니다

---

## 함정 (원문이 명시한 것)

- **개발 AI 가 폴더를 요약해 준 것은 내 하네스의 증거가 아니다** — 만든 프로그램을 따로 실행하고
  **그 프로그램의 모델 요청·도구 실행 기록**을 남긴다
- **완성된 에이전트 CLI 나 Agent SDK 에 모델·도구 반복을 통째로 넘기지 않는다** (그 방식은 다음 수업)
- **기본 예제의 점수를 자기 구현의 점수로 제출하지 않는다** — `--agent` 로 실제 연결부를 바꾼다
- **비교에서 문제·모델·한도를 바꾸면 하네스 변경만의 효과를 볼 수 없다.** 바꿨다면 조건이 달라진
  실험이라고 명시한다
- **`improved` 라는 이름이 개선을 확인해 주지 않는다**
- **기존 실행 폴더를 덮어쓰지 않는다** — 같은 이름으로 두 번 실행하면 거부된다
- **원본 `solution/` 이나 숨겨진 채점 코드를 읽어 정답에 맞추지 않는다.** 검증기의 기대값을 수정하거나
  참고답안을 에이전트에 주면 비교의 의미가 사라진다
- **작업 폴더 분리는 OS 격리가 아니다** (`hostlimits: unrestricted`). 실행 코드는 학생 계정 권한으로
  돈다 — 민감한 자료를 평가 작업에 섞지 않는다
- **모의 검사(`pytest -q`) 통과를 실제 모델의 열 문제 성능으로 기록하지 않는다**
- **`uv run harness_lab/cli.py` 처럼 패키지 내부 파일을 직접 실행하면 import 오류** — `run.py` 를 쓴다
- **키를 설정한 터미널과 실행 터미널이 다르면 값이 전달되지 않는다**
- **고정 10문항은 개발용 평가 집합** — 그 안의 개선을 일반화 결론으로 넓히지 않는다
- **벤치마크 점수가 올라도 제품 기능(승인·거절)이 깨졌으면 회귀 문제**로 함께 다룬다

---

## 착수 전 빈칸 — 확인 결과

실습 ZIP 을 받아 확인한 값이다 (2026-09-09).

| 빈칸 | 확인한 것 |
|---|---|
| 실습 ZIP 의 실제 링크 | 표의 주소·릴리스 태그가 GitHub 릴리스 API 와 일치했다. 크기·SHA256 은 `PROVENANCE.md` |
| `PRD.md` R01~R08 전문 | 설계 키트의 `PRD.md` 에 표로 있다. 내가 구체화한 문장은 이 폴더의 `PRD.md` |
| `ACCEPTANCE.md` A01~A12 문장 | 설계 키트 원문과 위 표가 일치했다 (A09·A10 만 조건부 DEFERRED 허용) |
| D09 의 항목명 | 원문도 "취소, 진행 이벤트, 동시 실행, 원격 접속 등에서 필요한 것을 선택하거나 미룬다" 로 **묶어서** 제시한다. 나는 진행 이벤트만 넣고 나머지를 미뤘다 |
| `solve_task` 반환 필드 | `{"status", "answer", "metrics"}`. `metrics.usage_known` 이 참일 때만 벤치마크가 토큰을 기록하고, 아니면 `null` 로 남긴다. `status != "completed"` 면 `exception_info: AgentIncomplete` 가 붙어 **점수에서 error 로 분류**된다 |
| `--self-check` | `harness_lab.bench` 의 옵션이다. 참고 풀이로 채점 경로를 검증하는 운영자 기능이고 학생 점수가 아니다. 이 실험에서는 실행하지 않았다 |
| `BENCHMARK_ERRATA.md` 정정 전체 | 세 건이다 — 스도쿠 I/O 계약 공개·검사 22개로 강화, 블록체인 정답을 원본 원장에서 계산·원장 불변 검사(11개), **모든 문항의 입력 해시 검사**. 평가 ID `terminal-bench-pro-local-port-v2` |
| `configured_path`·`CREDENTIALS_PATH` 류 | 이 저장소에는 없다. 대신 `OLLAMA_HOST`(기본 `http://localhost:11434`), `OPENAI_API_KEY`, 그리고 `bench --jobs`(기본 `<루트>/jobs`)·`--manifest`(기본 `benchmark/tasks.json`) 가 경로를 정한다 |

---

## 진행 순서

진행 상황은 `PLAN.md` 에 있다. 마지막 항목(LMS 제출 클릭)만 남았다.

---

> **주의**: 원문 본문의 프롬프트 예시("…같이 정하자", "…코드는 아직 만들지 마")와 실행 명령은
> **교육 콘텐츠**이며, 학생이 자기 환경에서 판단해 실행할 것이다. 노트를 만든 세션은 실행하지 않았다.
