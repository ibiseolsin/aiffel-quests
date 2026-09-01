# aiffel-quests

아이펠 AI 에이전트 과정의 과제(퀘스트) 구현 리포.

커리큘럼 요약과 강의노트는 별도 리포 `AI-Study` 에 있고, 여기에는 **코드와 제출물만** 둔다.
경계와 작업 규칙은 [CLAUDE.md](CLAUDE.md) 참고.

## 퀘스트 목록

| 모듈 | 과제 | 상태 | 배포 |
|---|---|---|---|
| [m04](m04-tool-design/) | 도구 설계 — 식품 표시·광고 사전검토 안내 에이전트 | 슬라이스 1~6 완료 (2026-08-31) | 없음 — 설계 문서 과제 |
| [m05](m05-rag-chatbot-service/) | Main Quest 3 — 식품 표시·광고 규정 안내 RAG 챗봇 | S0~S13 완료 (2026-08-30). 구글폼 제출만 남음 | [배포](https://ibiseolsin.github.io/aiffel-quests/m05/) |

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
mkdir m<NN>-<slug> && cd m<NN>-<slug>
```

그다음 `PRD.md` → `PLAN.md` 순으로 만들고 구현에 들어간다. 모듈 번호는
`AI-Study/notes/aiffel/` 의 노트 파일과 맞춘다.
