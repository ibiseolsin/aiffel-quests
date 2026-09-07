# f3-folded-r2

## 프롬프트 (조건 간 동일)

```
이 폴더의 PLAN.md 를 읽고, 현재 단계에 적힌 결정에 따라 src/config.py 의 load_config 를 구현하라.

- 테스트는 주어지지 않는다. PLAN.md 가 유일한 명세다.
- src/config.py 만 고친다. 다른 파일을 만들거나 고치지 마라.
- 끝나면 무엇을 구현했는지 한 줄로 답하라.
```

## before — src/config.py

```python
"""엔진 설정 로드. 환경변수 이름은 PLAN.md 의 현재 단계에 있다."""


def load_config(env: dict) -> dict:
    """매핑 env 에서 엔진 주소를 읽어 설정 딕셔너리를 돌려준다."""
    raise NotImplementedError

```

## after — src/config.py

```python
"""엔진 설정 로드. 환경변수 이름은 PLAN.md 의 현재 단계에 있다."""


def load_config(env: dict) -> dict:
    """매핑 env 에서 엔진 주소를 읽어 설정 딕셔너리를 돌려준다."""
    return {"base_url": env["LLM_BASE_URL"]}

```

## 모델 최종 응답

```
`src/config.py`의 `load_config(env)`를 PLAN.md D9대로 구현: `env["LLM_BASE_URL"]`만 읽어 `{"base_url": ...}`을 반환하고, 키가 없으면 폴백 없이 `KeyError`를 내도록 했다 — 실행해 두 경우(정상값, 누락 시 KeyError) 모두 확인함.
```

## 채점 (pytest, 실행 뒤 투입)

```
....                                                                     [100%]
4 passed in 0.02s

```
