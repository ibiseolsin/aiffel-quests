# f2-full-r1

## 프롬프트 (조건 간 동일)

```
이 폴더의 PLAN.md 를 읽고, 현재 단계에 적힌 결정에 따라 src/emit.py 의 emit 를 구현하라.

- 테스트는 주어지지 않는다. PLAN.md 가 유일한 명세다.
- src/emit.py 만 고친다. 다른 파일을 만들거나 고치지 마라.
- 끝나면 무엇을 구현했는지 한 줄로 답하라.
```

## before — src/emit.py

```python
"""검색 결과 출력. 형식은 PLAN.md 의 현재 단계에 있다."""


def emit(rows: list[dict]) -> str:
    """행 목록을 PLAN.md 가 정한 출력 형식의 문자열 하나로 만든다."""
    raise NotImplementedError

```

## after — src/emit.py

```python
"""검색 결과 출력. 형식은 PLAN.md 의 현재 단계에 있다."""

import json


def emit(rows: list[dict]) -> str:
    """행 목록을 PLAN.md 가 정한 출력 형식의 문자열 하나로 만든다."""
    return "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)

```

## 모델 최종 응답

```
PLAN.md D8(S16) 규칙대로 `emit`을 NDJSON 직렬화(`json.dumps(row, ensure_ascii=False)`를 `"\n"`으로 연결, 마지막 개행 없음, 빈 목록은 빈 문자열)로 구현했고 PLAN.md 예시 입출력으로 실행 검증함.
```

## 채점 (pytest, 실행 뒤 투입)

```
.....                                                                    [100%]
5 passed in 0.03s

```
