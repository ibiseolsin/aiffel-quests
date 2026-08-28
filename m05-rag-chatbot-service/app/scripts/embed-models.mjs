/**
 * 임베딩 모델 후보. **빌드와 브라우저가 같은 항목을 써야 한다** — 모델·pooling·정규화·
 * 프롬프트 접두어 중 하나만 달라도 두 벡터는 다른 공간에 있게 되고, 코사인 값이 뜻을 잃는다.
 * 그래서 접두어까지 여기 한 곳에 둔다 (S3 동일 공간 검증이 이걸 실제로 확인한다).
 *
 * `dim` 은 참고용이다. 실제 차원은 빌드 결과에서 읽어 `vectors.json` 에 기록한다.
 */
export const MODELS = {
  /** 384차원. 실측 다운로드 ~120MB — 방문자가 첫 접속에서 기다리는 시간이 이 선택의 값이다 */
  'e5-small': {
    id: 'Xenova/multilingual-e5-small',
    dtype: 'q8',
    dim: 384,
    approxMB: 120,
    // e5 계열은 접두어가 학습에 포함돼 있다. 빼면 성능이 눈에 띄게 떨어진다
    query: (t) => `query: ${t}`,
    passage: (t) => `passage: ${t}`,
  },
  /** 768차원. 실측 다운로드 282MB — 파라미터 278M × 1바이트(q8)가 그대로 크기다 */
  'e5-base': {
    id: 'Xenova/multilingual-e5-base',
    dtype: 'q8',
    dim: 768,
    approxMB: 282,
    query: (t) => `query: ${t}`,
    passage: (t) => `passage: ${t}`,
  },
  /**
   * 768차원. q4 로 ~205MB (그래프 + 외부 가중치 + 토크나이저 19MB).
   * WASM ONNX Runtime 이 `GatherBlockQuantized` 를 지원하지 않아 브라우저에서는
   * `model_no_gather_q4.onnx` 를 써야 한다 (FINDINGS 1절).
   */
  'gemma-300m': {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    dtype: 'q4',
    dim: 768,
    approxMB: 205,
    query: (t) => `task: search result | query: ${t}`,
    passage: (t) => `title: none | text: ${t}`,
  },
}

/**
 * **e5-small 로 확정 (S3).** 셋 다 평가 문항 상위5 적중이 5/7 로 같았다 —
 * 품질이 동률이면 방문자가 기다리는 시간이 결정한다. e5-small 이 e5-base 의 0.43배,
 * gemma 의 0.59배다. e5-small 의 유일한 약점은 조문 번호를 그대로 묻는 질문(N1: 4위 vs
 * e5-base 1위)인데, 그건 **S4 의 BM25 가 잡기로 계획된 바로 그 사례**다.
 *
 * 측정 조건: 청크 365개, 상위 5, 정답 집합은 조문 내용으로 정의 (scripts/eval-retrieval.mjs).
 * 정답 최초 순위 — e5-small Q1=19 Q5=12 N1=4 / e5-base Q1=11 Q5=20 N1=1 / gemma Q1=8 Q5=55 N1=5
 */
export const DEFAULT_MODEL = 'e5-small'
