# aiffel-quests

아이펠 AI 에이전트 과정의 과제(퀘스트) 구현 리포.

커리큘럼 요약과 강의노트는 별도 리포 `AI-Study` 에 있고, 여기에는 **코드와 제출물만** 둔다.
경계와 작업 규칙은 [CLAUDE.md](CLAUDE.md) 참고.

## 퀘스트 목록

| 모듈 | 과제 | 상태 | 배포 |
|---|---|---|---|
| [vibeweb1-m02](vibeweb1-m02-web-layers-game/) | 한 화면짜리 웹 게임 만들어 Pages 배포 | 미착수 | — |
| [vibeweb2-m02](vibeweb2-m02-backend/) | 내 서비스에 백엔드 붙이기 (튜토리얼 / 내 서비스 택1) | 미착수 | — |
| [vibeweb2-m04](vibeweb2-m04-agent-tools/) | 내가 실제로 쓸 스킬 하나, GitHub 에 올리기 | 미착수 | — |
| [vibeweb2-m05](vibeweb2-m05-main-quest-product/) | **Main Quest 01** — 내 도메인으로 웹 서비스 | 미착수 | — |
| [fundamentals-m04](fundamentals-m04-doc-and-vision/) | 문서(OCR)·사진(YOLO) 비교 실습 + Gradio 앱 | 미착수 | — |
| [fundamentals-m05](fundamentals-m05-image-generation/) | ControlNet Pose 조건 이미지 생성 도구 (Colab 노트) | 미착수 | — |
| [fundamentals-m07](fundamentals-m07-spatial-ai/) | 공개 가능한 공간 3D 스플랫 → Pages 배포 | 미착수 | — |
| [fundamentals-m09](fundamentals-m09-main-quest/) | **Main Quest** — 내 업무의 AI 적용 지점 PoC | 미착수 | — |
| [m04](m04-tool-design/) | 프롬프트 m04 도구 설계 — 식품 표시·광고 사전검토 안내 에이전트 | 슬라이스 1~6 완료 (2026-08-31) | 없음 — 설계 문서 과제 |
| [m05](m05-rag-chatbot-service/) | 프롬프트 m05 Main Quest 3 — 식품 표시·광고 규정 안내 RAG 챗봇 | **제출 완료 (2026-09-01)** — S0~S13 + 구글폼 | [배포](https://ibiseolsin.github.io/aiffel-quests/m05/) |
| [agent-m02](agent-m02-harness-teardown/) | 하네스 개선 실험 보고서 — 완료 단계를 접으면 후속 세션이 덜 틀리는가 | **실험 완료 (2026-09-07)** — 12셀 실측, 판정 **기각**. LMS 제출만 남음 | 없음 — 보고서 과제 |
| [agent-m03](agent-m03-multi-agent/) | 멀티에이전트 A/B/C 비교 실험 → 채택·축소·폐기 판정문 | 미착수 | 없음 — 보고서 과제 |

> `m04`/`m05` 두 폴더만 코스 슬러그 접두어가 없다. AI-Study 가 코스 슬러그 명명을 도입하기 전에
> 만들어졌고 이미 배포된 Pages 경로가 걸려 있어 그대로 둔다 (노트의 `quest:` 도 이 이름을 가리킨다).

## 배포

`main` 에 push 하면 Actions 가 각 퀘스트 앱을 빌드해 Pages 하위 경로로 올린다.

| 퀘스트 | 경로 |
|---|---|
| m05 | https://ibiseolsin.github.io/aiffel-quests/m05/ |

> **주의: 워크플로우 파일은 CLI 로 push 할 수 없다.** 현재 `gh` 토큰에 `workflow` 스코프가
> 없어 `.github/workflows/` 변경이 거부된다. 고쳐야 하면 GitHub 웹 에디터를 쓰거나
> `gh auth refresh -h github.com -s workflow` 를 먼저 통과시킨다.
>
> 이 리포는 git 자격증명을 `gh` 토큰으로 쓰도록 로컬 설정돼 있다
> (`credential.https://github.com.helper = !gh auth git-credential`) — Windows Git
> Credential Manager 에 다른 계정이 잡혀 있어서다.

## 새 퀘스트 시작하기

```bash
mkdir <코스슬러그>-m<NN>-<slug> && cd <코스슬러그>-m<NN>-<slug>
```

폴더 이름은 **AI-Study 노트 파일명에서 `.md` 를 뗀 것 그대로**다 — 두 리포를 잇는 유일한 키라
줄이거나 다르게 짓지 않는다 (예: `notes/aiffel/fundamentals-m07-spatial-ai.md` →
`fundamentals-m07-spatial-ai/`).

그다음 `PRD.md` → `PLAN.md` 순으로 만들고 구현에 들어간다.
