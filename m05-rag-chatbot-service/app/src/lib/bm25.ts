import { tokenize } from './tokenize.ts'

/**
 * BM25. 365개 문서라 브라우저에서 색인을 만들어도 순식간이다 —
 * 빌드 산출물로 굽지 않는 이유는 코퍼스를 다시 만들 때 어긋날 여지를 없애기 위함이다.
 */

const K1 = 1.2
const B = 0.75

export type Bm25Index = {
  /** 토큰 → (문서번호 → 등장 횟수) */
  postings: Map<string, Map<number, number>>
  /** 문서별 토큰 수 */
  lengths: number[]
  avgLength: number
  count: number
  /** 색인과 질의는 반드시 같은 토크나이저 설정을 써야 한다 */
  ngrams: boolean
}

export function buildBm25(docs: string[], ngrams = true): Bm25Index {
  const postings = new Map<string, Map<number, number>>()
  const lengths: number[] = []

  docs.forEach((doc, i) => {
    const tokens = tokenize(doc, ngrams)
    lengths.push(tokens.length)
    for (const t of tokens) {
      let p = postings.get(t)
      if (!p) postings.set(t, (p = new Map()))
      p.set(i, (p.get(i) ?? 0) + 1)
    }
  })

  const total = lengths.reduce((a, b) => a + b, 0)
  return {
    postings,
    lengths,
    avgLength: docs.length ? total / docs.length : 0,
    count: docs.length,
    ngrams,
  }
}

export type SparseHit = { index: number; score: number }

/**
 * 질의 토큰으로 BM25 점수를 계산한다.
 *
 * 같은 토큰이 질의에 두 번 나와도 한 번으로 센다 — 「제8조 제1항 제3호가 무슨 내용인가요」
 * 에서 「제」가 여러 번 나오는 것에 가중치를 더 줄 이유가 없다.
 */
export function bm25Search(idx: Bm25Index, query: string, k: number): SparseHit[] {
  const terms = new Set(tokenize(query, idx.ngrams))
  const scores = new Map<number, number>()

  for (const term of terms) {
    const p = idx.postings.get(term)
    if (!p) continue
    const df = p.size
    const idf = Math.log(1 + (idx.count - df + 0.5) / (df + 0.5))
    for (const [doc, tf] of p) {
      const norm = 1 - B + (B * idx.lengths[doc]) / (idx.avgLength || 1)
      const add = (idf * (tf * (K1 + 1))) / (tf + K1 * norm)
      scores.set(doc, (scores.get(doc) ?? 0) + add)
    }
  }

  return [...scores]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
