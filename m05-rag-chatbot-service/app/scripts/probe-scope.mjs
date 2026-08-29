/** S7 판정을 평가 세트 + 도메인 밖 프로브로 돌려 본다. FINDINGS 15절의 13/14 를 만든 스크립트 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearchTraced, limitFamilies } from '../src/lib/search.ts'
import { preClassify, classify } from '../src/lib/evidence-state.ts'
import { EVAL_SET } from './eval-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const C = resolve(HERE, '../public/corpus')
const raw = JSON.parse(readFileSync(`${C}/chunks.json`, 'utf8'))
const { chunks, ...meta } = raw
const vectorMeta = JSON.parse(readFileSync(`${C}/vectors.json`, 'utf8'))
const vectors = new Float32Array(readFileSync(`${C}/vectors.bin`).buffer.slice(0))
const corpus = { chunks, vectors, vectorMeta }
const model = MODELS[vectorMeta.modelKey]
const extractor = await pipeline('feature-extraction', model.id, { dtype: vectorMeta.dtype })
const bm25 = buildBm25(chunks.map((x) => `${x.source} ${x.path} ${x.text}`))

const OFF = [
  { id: 'X1', expected: '규범밖', question: '오늘 서울 날씨 어때요?' },
  { id: 'X2', expected: '규범밖', question: '파이썬으로 리스트를 정렬하는 방법 알려줘' },
  { id: 'X3', expected: '규범밖', question: '주말에 아이랑 갈 만한 놀이공원 추천해줘' },
  { id: 'X5', expected: '코퍼스밖', question: '식당 위생등급은 어떻게 신고해서 받나요?' },
  { id: 'X6', expected: '코퍼스밖', question: '음식점 영업신고는 어디에 하나요?' },
]

// 답변은 만들지 않는다. 「인용을 제대로 단 답」을 가정해 최종 상태까지 본다
const TOP_K = 8
let ok = 0
const rows = [...EVAL_SET, ...OFF]
console.log('문항  기대          판정          희소5   맞음  이유')
for (const q of rows) {
  const out = await extractor([model.query(q.question)], { pooling: 'mean', normalize: true })
  const { hits: found, trace } = hybridSearchTraced(corpus, new Float32Array(out.data), q.question, bm25, TOP_K * 3)
  const hits = limitFamilies(found, (i) => chunks[i].text).slice(0, TOP_K)
  const pre = preClassify(q.question, meta, trace.sparseTop5)
  const evidence = hits.map((h, i) => ({ label: `S${i + 1}`, chunk: chunks[h.index], hit: h }))
  // 「모든 근거를 유효하게 인용한 이상적인 답변」을 가정한다 — 판정의 상한을 본다
  const ideal = { ids: evidence.map((e) => e.label), valid: evidence.map((e) => e.label), invalid: [], lenient: false }
  const v = classify({ pre, evidence, citations: ideal, cancelled: false })
  const hit = v.state === q.expected
  if (hit) ok++
  console.log(
    q.id.padEnd(5),
    q.expected.padEnd(12),
    v.state.padEnd(12),
    String(trace.sparseTop5.toFixed(1)).padEnd(7),
    (hit ? 'O' : 'X').padEnd(5),
    v.why[v.why.length - 1] ?? '',
  )
}
console.log(`\n일치 ${ok}/${rows.length}`)
