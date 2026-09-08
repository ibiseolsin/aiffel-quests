# 실습 자료 출처와 재준비 방법

제출물·저장소에서 제외한 자료의 고정 주소와 해시다. `vendor/` 는 커밋하지 않는다.

## 내려받은 릴리스 (2026-09-09 확인)

| 파일 | 주소 | 크기(byte) | SHA256 |
|---|---|---|---|
| `harness-design-kit.zip` | `github.com/SunCreation/agent-building-practice` 릴리스 `v4.0.0` | 14887 | `05b4be482e21205a651e4df1bd83182c1c39e73634b5f29dc2b04b130039c834` |
| `harness-lab.zip` | 같은 저장소 `v4.0.0` | 107678 | `95ac34050d325c9b8308b983ba8c001c1bb8701eb9cd02dbdef96a990f5143fd` |
| `agent-terminal-benchmark.zip` | `github.com/SunCreation/agent-terminal-benchmark` 릴리스 `v1.0.0` | 122428 | `fa931d1b0fecddc3c63368535183515df7ae1243376589d18446b69907d645da` |

README 표의 주소·릴리스 태그와 일치하는 것을 GitHub 릴리스 API 로 확인했다.

## 원본 문제 (제외 대상)

- 저장소: `alibaba/terminal-bench-pro`
- 고정 커밋: `874af409da6aafebccbf3bc5bb41a2fa4d78784d`
- 평가 ID: `terminal-bench-pro-local-port-v2` (port_version `2.0.0`)
- 파일별 크기·SHA256 은 `benchmark/tasks.json` 의 `source_files` 에 있고, 준비 단계가 매번 대조한다.

## 다시 준비하는 방법

```bash
mkdir -p vendor && cd vendor
curl -sLO https://github.com/SunCreation/agent-building-practice/releases/download/v4.0.0/harness-design-kit.zip
curl -sLO https://github.com/SunCreation/agent-building-practice/releases/download/v4.0.0/harness-lab.zip
curl -sLO https://github.com/SunCreation/agent-terminal-benchmark/releases/download/v1.0.0/agent-terminal-benchmark.zip
for z in *.zip; do unzip -q "$z"; done && rm *.zip
cd agent-terminal-benchmark && uv sync --locked
uv run python -m harness_lab.benchmark_source --prepare   # 원본 문제 다운로드 + 해시 대조
```

## 제외한 경로와 이유

| 경로 | 이유 |
|---|---|
| `vendor/agent-terminal-benchmark/.benchmark-cache/` | 원본 문제·참고 풀이·채점 코드 |
| `vendor/agent-terminal-benchmark/jobs/*/source/benchmark/upstream/` | 실행 스냅샷에 복사된 원본 문제 |
| `vendor/agent-terminal-benchmark/jobs/*/*/verifier/` | 채점기 출력에 원본 기대값이 섞인다 |
| `vendor/agent-terminal-benchmark/jobs/*/*/workspace/` | 시행별 작업 폴더 — 원본 fixture 사본 |
| `vendor/harness-lab/`, `vendor/harness-design-kit/` | 강의 제공 자료 (내 구현이 아니다) |

**실패 시행이나 불리한 점수 행은 지우지 않았다.** `results/` 의 `trials.csv`·`report.json` 은
10문항 전체 행을 그대로 담는다.
