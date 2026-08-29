import { bm25Search, type Bm25Index } from './bm25.ts'
import type { Corpus } from './corpus.ts'

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

/** 어느 경로로 들어온 근거인지. 화면에 그대로 드러낸다 (평가 문항 3) */
export type Via = 'dense' | 'sparse' | 'both'

export type HybridHit = {
  index: number
  /** 코사인 원점수. **S7 의 근거 충분/약함 임계값은 이 값을 쓴다** */
  dense: number
  /** BM25 원점수 */
  sparse: number
  /** 순위용 점수 — 각 경로를 그 검색의 최고점으로 정규화한 뒤 가중 합 */
  score: number
  via: Via
  /** 각 경로에서의 순위 (1부터). 경로에 없으면 null */
  denseRank: number | null
  sparseRank: number | null
}

/**
 * 각 경로에서 몇 개를 후보로 볼지. 실측으로 정했다 —
 * 30 이면 평가 문항 상위5 적중 7/8, 80 으로 넓히면 6/8 로 **떨어진다.**
 * 후보를 넓히면 합산 단계에 잡음이 더 들어와 좋은 근거를 밀어낸다.
 */
const CANDIDATES = 30

/**
 * 희소(BM25) 가중치 기본값. 0.15~0.4 구간에서 적중이 같아 그 중간을 골랐다 —
 * 칼날 위에 세운 값이 아니라는 뜻이다. S11 의 실험 축 하나가 이것이다.
 */
export const DEFAULT_SPARSE_WEIGHT = 0.3

/**
 * 밀집(코사인) + 희소(BM25) 하이브리드.
 *
 * 두 점수는 척도가 다르다 — 코사인은 e5 에서 0.8 대에 몰려 있고 BM25 는 상한이 없다.
 * 그래서 **각 검색의 최고점으로 나눠** 0~1 로 맞춘 뒤 합친다. 최고점 정규화는 순위를
 * 바꾸지 않으므로 경로 안의 서열은 그대로 남는다.
 *
 * 원점수(`dense`)를 따로 들고 다니는 이유: 정규화된 값은 **그 질문 안에서만** 뜻이 있어서
 * 「근거가 충분한가」의 절대 기준으로 쓸 수 없다. S7 임계값은 원 코사인을 봐야 한다.
 */
export function hybridSearch(
  corpus: Corpus,
  queryVector: Float32Array,
  queryText: string,
  bm25: Bm25Index,
  k: number,
  sparseWeight = DEFAULT_SPARSE_WEIGHT,
): HybridHit[] {
  return hybridSearchTraced(corpus, queryVector, queryText, bm25, k, sparseWeight).hits
}

/**
 * 검색이 **거쳐 온 단계의 숫자**. 화면이 「n개 조문 검색됨 · 방식」을 말하려면(PRD 5절)
 * 결과만으로는 부족하다 — 후보가 몇이었고 병합에서 몇이 남았는지가 있어야 사용자가
 * 파이프라인을 관찰할 수 있다 (평가 문항 3).
 */
export type SearchTrace = {
  corpusSize: number
  /** 각 경로가 후보로 본 개수 */
  candidates: number
  denseFound: number
  sparseFound: number
  /** 두 경로를 합친 뒤의 서로 다른 조문 수 */
  merged: number
  /** 두 경로 모두에 든 조문 수 */
  both: number
  sparseWeight: number
}

export function hybridSearchTraced(
  corpus: Corpus,
  queryVector: Float32Array,
  queryText: string,
  bm25: Bm25Index,
  k: number,
  sparseWeight = DEFAULT_SPARSE_WEIGHT,
): { hits: HybridHit[]; trace: SearchTrace } {
  const dense = cosineTopK(corpus, queryVector, CANDIDATES)
  const sparse = bm25Search(bm25, queryText, CANDIDATES)

  const denseMax = dense[0]?.score ?? 0
  const sparseMax = sparse[0]?.score ?? 0

  const merged = new Map<number, HybridHit>()
  const put = (index: number) =>
    merged.get(index) ??
    merged
      .set(index, {
        index,
        dense: 0,
        sparse: 0,
        score: 0,
        via: 'dense',
        denseRank: null,
        sparseRank: null,
      })
      .get(index)!

  dense.forEach(({ index, score }, i) => {
    const h = put(index)
    h.dense = score
    h.denseRank = i + 1
  })
  sparse.forEach(({ index, score }, i) => {
    const h = put(index)
    h.sparse = score
    h.sparseRank = i + 1
  })

  let both = 0
  for (const h of merged.values()) {
    const d = denseMax > 0 ? h.dense / denseMax : 0
    const s = sparseMax > 0 ? h.sparse / sparseMax : 0
    h.score = (1 - sparseWeight) * d + sparseWeight * s
    h.via = h.denseRank && h.sparseRank ? 'both' : h.sparseRank ? 'sparse' : 'dense'
    if (h.via === 'both') both++
  }

  return {
    hits: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k),
    trace: {
      corpusSize: corpus.vectorMeta.count,
      candidates: CANDIDATES,
      denseFound: dense.length,
      sparseFound: sparse.length,
      merged: merged.size,
      both,
      sparseWeight,
    },
  }
}

/** 앞부분이 같은 형제 무리에서 한 질문에 최대 몇 개까지 보여 줄지 */
const MAX_PER_FAMILY = 2
const FAMILY_PREFIX = 150

/**
 * 앞머리를 공유하는 형제 청크가 결과를 뒤덮는 것을 막는다.
 *
 * 「표시기준」은 식품유형마다 같은 표시사항 목록을 반복하므로, 앞 150자가 같은 청크가
 * 최대 20개까지 있다. 그것들이 상위를 다 차지하면 사용자는 같은 글을 스무 번 읽고
 * 프롬프트(S5)도 그걸로 찬다. 완전히 지우지는 않는다 — 식품유형이 서로 다르기 때문이다.
 */
export function limitFamilies<T extends { index: number }>(
  hits: T[],
  textOf: (index: number) => string,
): T[] {
  const seen = new Map<string, number>()
  const out: T[] = []
  for (const h of hits) {
    const key = textOf(h.index).replace(/\s+/g, '').slice(0, FAMILY_PREFIX)
    const n = seen.get(key) ?? 0
    if (n >= MAX_PER_FAMILY) continue
    seen.set(key, n + 1)
    out.push(h)
  }
  return out
}
