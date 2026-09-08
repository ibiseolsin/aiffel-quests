# 작업 계획 (수직 슬라이스)

세부 설계는 `PRD.md` · `INTERFACES.md`, 단계별 기록은 `IMPLEMENTATION_PLAN.md`.
완료 기준은 전부 `ACCEPTANCE.md` 의 A01~A12 에 증거로 연결된다.

- [x] 1. 실습 자료 확보와 명세 확인 — ZIP 3개 해시 대조, `STUDENT_GUIDE`·`BENCHMARK_ERRATA`·설계 키트 정독
      → `PROVENANCE.md`
- [x] 2. D01~D07 합의 → `PRD.md` · `DECISIONS.md` (D08·D09 는 이유와 함께 DEFERRED)
- [x] 3. 세 연결의 계약 + 구체적 계약 한 개(`write_file`) → `INTERFACES.md`
- [x] 4. A01~A12 상태표 + 내 시나리오 정상/실패 각 하나 → `ACCEPTANCE.md`
- [x] 5. 실행 환경·의존성·순서 → `IMPLEMENTATION_PLAN.md`, `pyproject.toml` + `uv.lock`
- [x] 6. 첫 수직 구현 (요청 → 실제 모델 → 읽기 도구 → 결과) → A01 · A02
- [x] 7. 실패 경로 (없는 파일 · 폴더 이탈 · 잘못된 인자 · 반복 상한) → A05 · A06 · A07
- [x] 8. 변경 제안 → diff 승인/거절 → 고정 테스트 → A03(FAIL, 원인 기록) · A04
- [x] 9. 세션 정책 (파일 영속, 설정 불일치 거부) → A08 · A09
- [x] 10. `harness-lab` 읽고 내 설계와 대조 → `EXPERIMENT_REPORT.md` 의 「제공 구현과의 차이」
- [x] 11. 벤치마크 준비 (`--prepare` 해시 대조) + 문항 1개 smoke 로 어댑터 연결 확인
- [x] 12. **기준 실행** `own-baseline` (10문항, attempts 1) → A11
- [x] 13. 실패 기록에서 **변경 가설 하나** 세우기 → `EXPERIMENT_REPORT.md`
- [x] 14. 코드·명세·검증 갱신 + 회귀 검사 (`pytest` + A03·A04 재실행)
- [x] 15. **개선 실행** `own-improved` (같은 모델·한도·문항) → A12
- [x] 16. `--compare` 비교 보고서 (`trials.csv` · `report.json` · `index.html` ×2)
- [x] 17. `EXPERIMENT_REPORT.md` (좋아진 점 · 나빠진 점 · 남은 한계 · 미측정 항목)
- [x] 18. 제출용 정리 (upstream·캐시·키 제외, 제외 경로와 이유 명시) → `PROVENANCE.md` · `results/`
- [ ] 19. LMS `제출하기 이동` — **사람이 한다**

## 고정한 실행 조건 (두 실행 공통)

| 항목 | 값 |
|---|---|
| 평가 | `terminal-bench-pro-local-port-v2`, port_version `2.0.0`, upstream `874af409…4d78784d` |
| 문항 | easy 2 · medium 4 · hard 4 = 10 (manifest 그대로) |
| provider · 모델 | `ollama` · `qwen3.5:2b` |
| 시도 수 | `--attempts 1` (분모 10) |
| 한도 | `--max-steps 20 --max-seconds 600 --max-output-tokens 4000 --command-timeout 10` |
| 샘플링 | `temperature 0.6` · `top_p 0.95` · `seed 7` |
| 바뀐 것 | **`my_harness/` 코드만** (`EXPERIMENT_REPORT.md` 의 변경 목록) |

기본값(40단계·300초·10,000토큰)을 쓰지 않은 이유는 `DECISIONS.md` 의 「결정 변경」에 적었다.
