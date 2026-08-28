import type { Corpus } from './corpus'

export type Hit = {
  index: number
  score: number
}

/**
 * 코사인 유사도 상위 k.
 *
 * 저장된 벡터와 질의 벡터가 **둘 다 L2 정규화**돼 있으므로 내적이 곧 코사인이다.
 * 정규화를 한쪽에서만 하면 값이 코사인이 아니게 되고, 임계값(S7)이 뜻을 잃는다.
 */
export function cosineTopK(corpus: Corpus, query: Float32Array, k: number): Hit[] {
  const { dim, count } = corpus.vectorMeta
  if (query.length !== dim) {
    throw new Error(`질의 벡터가 ${query.length}차원인데 스토어는 ${dim}차원이다`)
  }
  const hits: Hit[] = []
  for (let i = 0; i < count; i++) {
    let s = 0
    const off = i * dim
    for (let d = 0; d < dim; d++) s += query[d] * corpus.vectors[off + d]
    hits.push({ index: i, score: s })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

/** 두 정규화 벡터의 코사인. 동일 공간 검증에 쓴다 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let d = 0; d < a.length; d++) s += a[d] * b[d]
  return s
}

/** 저장된 i번째 벡터 */
export function storedVector(corpus: Corpus, i: number): Float32Array {
  const { dim } = corpus.vectorMeta
  return corpus.vectors.subarray(i * dim, (i + 1) * dim)
}
