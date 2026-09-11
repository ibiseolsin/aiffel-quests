# LangGraph로 에이전트 워크플로 설계하기

아이펠 AI 에이전트 1기 — **에이전트 팀 꾸리기_Agt1** (course 2244) 1번 노드 실습.
LMS: https://learn.modulabs.co.kr/camp/136/courses/2244/node-version/5752/steps/29287

State · Node · Edge 로 그래프를 만들고, 조건부 엣지·툴 루프·워크플로 다섯 패턴
(프롬프트 체이닝 · 라우팅 · 병렬화 · 오케스트레이터-워커 · 평가자-최적화자)을 구현한다.

## 환경

`uv` + 폴더 로컬 `.venv` (Python 3.13). 활성화 없이 `uv run` 으로 실행한다.

```bash
uv sync            # .venv 생성 + uv.lock 대로 설치
uv run python smoke.py
```

`smoke.py` 는 LLM 호출 없이 2노드 그래프를 돌려 설치를 확인한다.

의존성: `langgraph`, `langchain`, `langchain-openai`, `python-dotenv`.
추가할 때는 `uv add <패키지>` (pyproject·uv.lock 이 함께 갱신된다).

주피터로 실습하려면:

```bash
uv add --dev jupyterlab ipykernel && uv run jupyter lab
```

## API 키

`.env.example` 을 `.env` 로 복사하고 값을 채운다. `.env` 는 커밋하지 않는다.

```bash
cp .env.example .env
```

코드에서는 `from dotenv import load_dotenv; load_dotenv()`.

## 제출물 체크리스트

- [ ] 다섯 패턴 각각 실행 결과 확인
- [ ] 그래프 시각화 이미지
- [ ] LMS 퀴즈·제출 항목 완료
