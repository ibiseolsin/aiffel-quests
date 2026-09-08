# 인터페이스 계약 — `my_harness`

상태: D02~D07 확정 후 채운 것. 세 연결(사용자↔제품 / 제품↔모델 / 제품↔도구)의 입력·출력·오류를 적는다.

## 1. 제품의 작업 계약 (사용자 ↔ 제품)

작업 하나 = CLI 호출 하나. 상태 전이는 다음만 허용한다.

```
running ──> waiting_approval ──> running ──> completed
   │                │                          
   │                └─(거절)─> running          (거절은 그 도구 호출만 실패시키고 반복을 계속한다)
   └─> step_limit | tool_limit | timeout | context_limit | provider_error | failed
```

`queued` 는 없다 — 동시 실행을 넣지 않았으므로(D09) 요청은 즉시 running 이다. `cancelled` 도 없다(D09).

| 동작 | 입력 | 출력 | 오류·경계 |
|---|---|---|---|
| 작업 시작 | `--prompt` (필수, 비어 있으면 거부), `--workspace`(기본 `work`), `--session`(선택), `--test-target`(선택) | 작업 id(`runs/<id>/`), 최종 상태, 최종 답, 근거 목록, 지표 | 빈 요청 → 종료 코드 2. 없는 workspace → 종료 코드 2. 세션 잠금 파일이 있으면 중복 실행 거부 |
| 상태 조회 | `runs/<id>/events.jsonl` (append-only) | 단계별 이벤트: `run_start` `model_call` `tool_call` `tool_result` `approval` `run_end` | 진행 중 파일은 마지막 줄이 없을 수 있다 — `run_end` 가 없으면 미완료로 읽는다 |
| 변경 승인/거절 | 표준입력 `y`/`n` (표시된 diff 에 대해) | 승인 시 파일 기록, 거절 시 파일 불변 | 표시 내용의 `sha256` 이 실제 기록 대상과 다르면 승인을 **재사용하지 않고** 거부한다. 비대화형 입력(EOF)은 **거절**로 처리한다 |
| 결과 조회 | 종료 시 표준출력 / `runs/<id>/result.json` | 상태·답·읽은 파일·바꾼 파일·테스트 결과·지표 | 미완료를 완료로 표시하지 않는다. 상태가 `completed` 가 아니면 답 대신 멈춘 이유를 먼저 쓴다 |
| 세션 이어가기 | `--session <이름>` + 새 `--prompt` | 이전 대화에 이어붙인 새 작업 | 세션 파일이 없으면 **새로 시작했다고 표시**한다(복원했다고 말하지 않는다). 저장된 설정(provider·model·workspace)이 다르면 거부하고 새 이름을 요구한다 |

### 구체적 계약 한 개 — `write_file`

- 이름: `write_file` (도구), 사용자 쪽 대응 동작은 "변경 승인/거절"
- 입력 타입: `{"path": string, "content": string}` — `additionalProperties: false`, 둘 다 필수
- 허용 범위: `path` 는 작업 폴더 상대경로 또는 작업 폴더 내부 절대경로. 길이 500자 이하.
  `content` 는 UTF-8 문자열, 1,000,000자 이하
- 정상 입력 예: `{"path": "receipt.py", "content": "def total(items):\n    ...\n"}`
- 정상 출력 예 (모델에 돌아가는 값):
  `{"ok": true, "output": "{\"path\": \"receipt.py\", \"bytes\": 128, \"created\": false, \"sha256\": \"…\"}"}`
- 잘못된 입력과 오류 출력 예:
  - `{"path": "../secret.txt", ...}` → `{"ok": false, "error": "path_rejected: parent traversal is not allowed", "hint": "workspace 상대경로를 쓰세요. list_files 로 실제 경로를 확인할 수 있습니다."}`
  - `{"path": "work.py"}` (content 없음) → `{"ok": false, "error": "invalid_arguments: 'content' is a required property"}`
  - 승인 거절 → `{"ok": false, "error": "rejected_by_user: 사용자가 변경을 거절했습니다", "hint": "다른 방법을 제안하거나 왜 이 변경이 필요한지 설명하세요."}`
- 상태 변화/부작용: 승인 후에만 파일을 쓴다. 임시 파일에 쓰고 `os.replace` 로 교체한다(부분 기록 없음).
  근거 원장(`evidence`)에 `{"action": "write", "path", "sha256", "bytes"}` 를 남긴다
- 재시도·중복: 같은 `(path, content)` 를 다시 요청하면 **승인을 다시 받는다**(승인은 도구 호출 id 에 묶인다).
  같은 도구 호출 id 를 두 번 실행하지 않는다

## 2. UI 와 계약의 대응 (CLI)

| CLI | 계약 |
|---|---|
| `uv run run_harness.py --prompt "…" --workspace work` | 작업 시작 |
| `--session reading` | 세션 이어가기 |
| `--test-target "-s work -p test_receipt.py"` | `run_tests` 가 실행할 **고정 대상** (모델이 바꿀 수 없다) |
| `--auto-approve` | 승인 자동화. **작업 폴더가 일회용 사본일 때만** 쓴다(벤치마크 어댑터가 이 모드를 쓴다). 이벤트에 `approval_mode: auto` 로 남는다 |
| `--max-steps` `--max-seconds` `--max-tool-calls` | 한도 조정 |
| 종료 코드 | `0` completed / `1` 그 외 종료 상태 / `2` 사용법 오류 |
| 진행 표시 | 단계마다 `[3/12] model → read_file(work/meeting.txt) ok` 한 줄 |

## 3. 모델 제공자 연결부

내부 계약은 제공자 필드를 모른다.

```python
class Provider(Protocol):
    name: str
    model: str
    async def complete(self, messages: list[Message], tools: list[ToolSpec]) -> ModelTurn: ...

@dataclass ModelTurn:
    text: str
    calls: list[ToolCall]          # ToolCall(id, name, arguments: dict|str)
    usage: Usage                   # Usage(input_tokens, output_tokens, known: bool)
    opaque: list[dict]             # 제공자가 다음 요청에 되돌려줘야 하는 것 (예: thinking)
```

- 첫 제공자/모델: **Ollama 네이티브 `POST /api/chat`**, `qwen3.5:2b`, 기본 주소 `http://localhost:11434`
  (`OLLAMA_HOST` 로 변경). 공식 문서: `github.com/ollama/ollama/blob/main/docs/api.md`
- 도구 호출 식별자: Ollama 는 호출 id 를 주지 않을 수 있다 → 없으면 하네스가
  `local-<step>-<index>` 를 붙여 결과와 짝을 맞춘다. **모델이 준 id 는 그대로 쓴다**
- 일반 답과 도구 호출: `tool_calls` 가 있으면 **텍스트가 있어도 도구를 먼저 실행**한다.
  `tool_calls` 가 없고 텍스트만 있으면 `completed` 로 종료한다. 둘 다 없으면 오류다
- 여러 도구 요청: **받은 순서대로 순차 실행**한다(동시 실행 없음, D09). 도구 한도를 넘긴 요청은
  실행하지 않고 `{"ok": false, "error": "tool_limit_reached"}` 를 돌려준다
- 지원하지 않는 기능·파싱 실패·네트워크 오류: 모두 `ProviderError` 로 올려 반복을 중단하고
  상태 `provider_error` 로 끝낸다. **모델에 되돌려주지 않는다** (R07)
- `done_reason` 이 `stop` 이 아니면(예: `length`) 그 응답의 도구를 실행하지 않는다 — 잘린 인자를 실행하지 않는다
- 사용량: `prompt_eval_count`/`eval_count` 가 응답에 없으면 `Usage.known=False`.
  **모르는 값을 0 으로 쓰지 않는다**
- 재시도: 하지 않는다(첫 버전). 실패는 그대로 표시한다

> OpenAI 와 Ollama 에 같은 필드를 보내면 같은 기능이 동작한다고 가정하지 않는다. 모델 응답은
> 실행 전에 **JSON Schema 로 인자를 검사**한다.

## 4. 실행 도구 계약

| 도구 | 인자 | 반환 | 허용 범위 | 승인·오류 |
|---|---|---|---|---|
| `list_files` | `{}` | `{"files": [...], "truncated": bool}` 최대 300개 | 작업 폴더 하위 **보이는** 파일만 | 없음. 숨김·심링크·`__pycache__` 제외 |
| `read_file` | `{"path": string}` | `{"path", "bytes", "sha256", "content"}` | 작업 폴더 안, 일반 파일, 1,000,000 byte 이하 | 경로 이탈·없는 파일·디렉터리·바이너리(UTF-8 디코드 실패) → 오류 |
| `write_file` | `{"path", "content"}` | 위 §1 참조 | 작업 폴더 안 | **승인 필요.** 거절 시 파일 불변 |
| `run_python` | `{"path": string, "args": [string]}` | `{"exit_code", "stdout", "stderr", "timed_out"}` | 작업 폴더 안의 **기존 `.py` 파일**. 인라인 코드·셸 금지. args 30개·각 2000자 이하 | 시간 초과(기본 30초, 벤치마크는 `command_timeout`) → `timed_out: true`. 종료 코드 0 이 아니면 `ok: false` |
| `run_tests` | `{}` | `{"exit_code", "stdout", "stderr", "timed_out"}` | **`--test-target` 로 고정된 대상만**. 인자를 받지 않는다 | `--test-target` 이 없으면 등록하지 않는다(도구 목록에 없다) |

- 경로 검사는 **도구 코드 안에서** 모델의 지시와 무관하게 적용한다: 절대경로는 작업 폴더 내부만,
  `..` 금지, 숨김 경로 금지, 구성요소마다 심링크 검사, 최종 `resolve()` 가 작업 폴더 안인지 확인.
- 작업 폴더 분리는 **OS 격리가 아니다.** `run_python`/`run_tests` 는 사용자 계정 권한으로 돈다.
- 도구 출력이 16,000자를 넘으면 앞뒤를 남기고 가운데를 `[출력 생략 N자]` 로 줄인다(원본 길이를 남긴다).
