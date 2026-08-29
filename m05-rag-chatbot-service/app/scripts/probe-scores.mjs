/** S7 임계값 재료 — 문항별 밀집·희소 최고점 분포. FINDINGS 15절의 표를 만든 스크립트 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25, bm25Search } from '../src/lib/bm25.ts'
import { cosineTopK } from '../src/lib/search.ts'
import { EVAL_SET } from './eval-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const C = resolve(HERE, '../public/corpus')
const { chunks } = JSON.parse(readFileSync(`${C}/chunks.json`, 'utf8'))
const vectorMeta = JSON.parse(readFileSync(`${C}/vectors.json`, 'utf8'))
const vectors = new Float32Array(readFileSync(`${C}/vectors.bin`).buffer.slice(0))
const corpus = { chunks, vectors, vectorMeta }
const model = MODELS[vectorMeta.modelKey]
const extractor = await pipeline('feature-extraction', model.id, { dtype: vectorMeta.dtype })
const bm25 = buildBm25(chunks.map((x) => `${x.source} ${x.path} ${x.text}`))

const OFF = [
  { id: 'X1', expected: '완전밖', question: '오늘 서울 날씨 어때요?' },
  { id: 'X2', expected: '완전밖', question: '파이썬으로 리스트를 정렬하는 방법 알려줘' },
  { id: 'X3', expected: '완전밖', question: '주말에 아이랑 갈 만한 놀이공원 추천해줘' },
  { id: 'X4', expected: '완전밖', question: '이 문장을 영어로 번역해줘: 안녕하세요' },
  { id: 'X5', expected: '인접밖', question: '식당 위생등급은 어떻게 받나요?' },
  { id: 'X6', expected: '인접밖', question: '음식점 영업신고는 어디에 하나요?' },
]

console.log('문항  기대상태     밀집1   밀집3   희소1    희소3    희소합5')
for (const q of [...EVAL_SET, ...OFF]) {
  const out = await extractor([model.query(q.question)], { pooling: 'mean', normalize: true })
  const d = cosineTopK(corpus, new Float32Array(out.data), 5)
  const s = bm25Search(bm25, q.question, 5)
  const f = (n, w = 6) => String(n ?? 0).slice(0, w).padEnd(w)
  console.log(
    q.id.padEnd(5),
    q.expected.padEnd(11),
    f(d[0]?.score.toFixed(4)),
    f(d[2]?.score.toFixed(4)),
    f(s[0]?.score.toFixed(2), 7),
    f(s[2]?.score.toFixed(2), 7),
    f(s.slice(0, 5).reduce((a, b) => a + b.score, 0).toFixed(2), 7),
  )
}
