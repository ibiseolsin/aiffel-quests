# f1-full-r2

## 프롬프트 (조건 간 동일)

```
이 폴더의 PLAN.md 를 읽고, 현재 단계에 적힌 결정에 따라 src/chunk_id.py 의 make_chunk_id 를 구현하라.

- 테스트는 주어지지 않는다. PLAN.md 가 유일한 명세다.
- src/chunk_id.py 만 고친다. 다른 파일을 만들거나 고치지 마라.
- 끝나면 무엇을 구현했는지 한 줄로 답하라.
```

## before — src/chunk_id.py

```python
"""청크 ID 생성. 규칙은 PLAN.md 의 현재 단계에 있다."""


def make_chunk_id(doc: str, page: int, idx: int) -> str:
    """문서 슬러그·페이지·청크 순번으로 청크 ID 문자열을 만든다."""
    raise NotImplementedError

```

## after — src/chunk_id.py

```python
"""청크 ID 생성. 규칙은 PLAN.md 의 현재 단계에 있다."""


def make_chunk_id(doc: str, page: int, idx: int) -> str:
    """문서 슬러그·페이지·청크 순번으로 청크 ID 문자열을 만든다."""
    return f"{doc}-p{page}-c{idx}"

```

## 모델 최종 응답

```
PLAN.md의 S15/D7 규칙대로 `make_chunk_id(doc, page, idx)`가 `f"{doc}-p{page}-c{idx}"`를 반환하도록 구현했고, `make_chunk_id("hr-guide", 3, 5)` → `"hr-guide-p3-c5"` 실행으로 확인함.
```

## 채점 (pytest, 실행 뒤 투입)

```
...                                                                      [100%]
3 passed in 0.02s

```
