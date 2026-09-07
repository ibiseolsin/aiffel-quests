# f3-folded-r1

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
`load_config`가 `env["LLM_BASE_URL"]`만 읽어 `{"base_url": ...}`을 돌려주도록 구현했고(폴백 없음, 옛 이름 미지원, 키 없으면 `KeyError`), 실행해서 정상 케이스와 `KeyError` 케이스 모두 확인했다.
```

## 채점 (pytest, 실행 뒤 투입)

```
....                                                                     [100%]
4 passed in 0.02s

```
