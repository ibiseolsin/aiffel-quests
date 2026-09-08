# own-improved — 제출에서 제외한 경로와 이유

원본 실행 폴더: `vendor/agent-terminal-benchmark/jobs/own-improved/` (저장소에 커밋하지 않음)
**원래 실행 메타데이터를 덮어쓰지 않았다.** 아래 `run-metadata.json` 은 실행 당시 파일 그대로이고,
제출용 정리본의 소스 해시(`source_sha256`)는 그 실행 스냅샷의 값이다.

| 제외한 경로 | 이유 |
|---|---|
| `jobs/own-improved/source/benchmark/upstream/` | 내려받은 **원본 문제·자료·풀이**. 고정 커밋 `874af409…4d78784d` 에서 다시 준비할 수 있다 (`PROVENANCE.md`) |
| `jobs/own-improved/<문항>__1/workspace/` | 시행별 작업 폴더 — 원본 fixture 사본이 들어 있다 |
| `jobs/own-improved/<문항>__1/verifier/test_outputs.py` | **원본 채점 코드** |
| `jobs/own-improved/<문항>__1/verifier/stdout.txt`, `stderr.txt`, `results.xml` | 채점 표준출력·오류·JUnit XML. **실패 메시지에 원본 기대값이 들어간다.** 대신 문항별 검사 개수와 실패한 검사 **이름**만 `verifier-summary.csv` 로 옮겼다 |
| `jobs/own-improved/<문항>__1/agent/session/trial.json` | 모델에 보인 대화 전문 — 원본 fixture 내용이 그대로 들어 있다 |
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
