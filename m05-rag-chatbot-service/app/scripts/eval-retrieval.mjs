/**
 * 검색만 재는 하네스 — **LLM 없이** 돈다.
 *
 * 재는 것은 하나다: 평가 문항의 근거 조문이 상위 k 안에 들어오는가.
 * 정답 집합은 조문 내용으로 정의한다(사람이 청크 ID 를 손으로 고르지 않는다) —
 * 코퍼스를 다시 만들면 ID 는 밀리지만 이 정의는 그대로 유효하다.
 *
 * 실행: node scripts/eval-retrieval.mjs [모델키]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')

const { chunks } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
const meta = JSON.parse(readFileSync(resolve(CORPUS, 'vectors.json'), 'utf8'))
const key = process.argv[2] ?? meta.modelKey
if (key !== meta.modelKey) {
  console.error(`vectors.json 은 ${meta.modelKey} 로 만들어졌다. 먼저 embed-corpus.mjs ${key} 를 돌려라`)
  process.exit(1)
}
const model = MODELS[key]

const raw = readFileSync(resolve(CORPUS, 'vectors.bin'))
const store = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const { dim } = meta

/** 정답 집합은 조문 내용으로 정의한다 */
const QUESTIONS = [
  {
    id: 'Q1',
    text: '일반식품 상세페이지에 "면역력 강화"라고 써도 되나요?',
    gold: (c) => /질병의 예방/.test(c.text) || (/의약품/.test(c.text) && /인식/.test(c.text)),
  },
  { id: 'Q2', text: '알레르기 유발물질은 어떻게 표시해야 하나요?', gold: (c) => /알레르기/.test(c.text) },
  { id: 'Q3', text: '영양성분 표시는 어떤 제품에 의무인가요?', gold: (c) => /영양표시/.test(c.text) },
  {
    id: 'Q4',
    text: '"무첨가"라고 강조해서 표시해도 되나요?',
    gold: (c) => /무첨가|사용하지 아니하였다|첨가하지 아니/.test(c.text),
  },
  { id: 'Q5', text: 'SNS 협찬 광고도 이 법 적용을 받나요?', gold: (c) => /"광고"란/.test(c.text) },
  { id: 'Q6', text: '자율심의를 받아야 하는 광고는 어디까지인가요?', gold: (c) => /자율심의/.test(c.text) },
  // 조문 번호를 그대로 묻는 질문 — S4 하이브리드의 근거가 되는 사례다.
  // 임베딩만으로는 놓칠 것으로 예상한다. 놓치는 것을 여기서 관측해 둔다
  {
    id: 'N1',
    text: '제8조 제1항 제3호가 무슨 내용인가요?',
    gold: (c) => c.id.startsWith('FLA') && /^제8조/.test(c.path),
  },
]

const extractor = await pipeline('feature-extraction', model.id, { dtype: model.dtype })
const K = 5

console.log(`\n모델 ${key} (${model.id}, ${model.dtype}) · ${dim}차원 · 상위 ${K}\n`)
let hits = 0
const ranks = []
for (const q of QUESTIONS) {
  const out = await extractor([model.query(q.text)], { pooling: 'mean', normalize: true })
  const qv = out.data
  // 저장된 벡터도 정규화돼 있으므로 내적이 곧 코사인이다
  const scored = chunks.map((c, i) => {
    let s = 0
    for (let d = 0; d < dim; d++) s += qv[d] * store[i * dim + d]
    return { c, s }
  })
  scored.sort((a, b) => b.s - a.s)
  const top = scored.slice(0, K)
  const rank = scored.findIndex(({ c }) => q.gold(c)) + 1
  const hit = top.some(({ c }) => q.gold(c))
  if (hit) hits += 1
  ranks.push({ id: q.id, rank, hit })
  console.log(
    `${q.id} ${hit ? '적중' : '실패'} (정답 최초 순위 ${rank || '없음'})  ${q.text}`,
  )
  for (const { c, s } of top) {
    console.log(`   ${q.gold(c) ? '★' : ' '} ${s.toFixed(3)} ${c.id} ${c.source} ${c.path}`)
  }
  console.log()
}
console.log(`상위 ${K} 적중 ${hits}/${QUESTIONS.length}`)
console.log(`정답 최초 순위: ${ranks.map((r) => `${r.id}=${r.rank || '-'}`).join(' ')}`)
