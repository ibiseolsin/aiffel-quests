/**
 * 검색만 재는 하네스 — **LLM 없이** 돈다.
 *
 * 재는 것은 하나다: 평가 문항의 근거 조문이 상위 k 안에 들어오는가.
 * 정답 집합은 조문 내용으로 정의한다(사람이 청크 ID 를 손으로 고르지 않는다) —
 * 코퍼스를 다시 만들면 ID 는 밀리지만 이 정의는 그대로 유효하다.
 *
 * **앱과 같은 코드를 쓴다.** Node 가 `.ts` 를 바로 읽으므로 `src/lib` 를 그대로 import 한다 —
 * 검색 로직을 스크립트에 다시 적으면 재는 것과 배포되는 것이 갈라진다.
 *
 * 실행: node scripts/eval-retrieval.mjs [희소가중치...]
 *   예: node scripts/eval-retrieval.mjs 0 0.3 0.5 0.7   (가중치 축을 훑는다)
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearch, limitFamilies } from '../src/lib/search.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')

const { chunks } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(CORPUS, 'vectors.json'), 'utf8'))
const model = MODELS[vectorMeta.modelKey]

const raw = readFileSync(resolve(CORPUS, 'vectors.bin'))
const corpus = {
  chunks,
  vectorMeta,
  vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
}

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
  {
    id: 'Q5',
    text: 'SNS 협찬 광고도 이 법 적용을 받나요?',
    // 적용 범위를 묻는 질문이므로 **「광고」의 정의**(제2조제10호) 또는
    // **다른 법률과의 관계**(제3조) 둘 다 정당한 근거다. 처음에는 정의 조항만 정답으로
    // 뒀는데, 검색이 1위로 가져온 제3조가 오히려 더 직접적인 답이었다 — 정답 정의가 좁았다
    gold: (c) => /"광고"란/.test(c.text) || /다른 법률과의 관계/.test(c.text),
  },
  { id: 'Q6', text: '자율심의를 받아야 하는 광고는 어디까지인가요?', gold: (c) => /자율심의/.test(c.text) },
  // 조문 번호를 그대로 묻는 질문 — 하이브리드를 붙이는 근거가 이 사례다
  {
    id: 'N1',
    text: '제8조 제1항 제3호가 무슨 내용인가요?',
    gold: (c) => c.id.startsWith('FLA') && /^제8조.*제3호$/.test(c.path),
  },
  {
    id: 'N2',
    text: '시행규칙 제6조 제2항 제3호에 뭐가 적혀 있나요?',
    gold: (c) => c.id.startsWith('FLR') && /^제6조.*제3호$/.test(c.path),
  },
]

// BM25 색인 대상에 위치 표기를 넣는다. `제8조①제3호` 가 정규화로 「제8조 제1항 제3호」가
// 되어 사용자가 쓰는 표기와 만난다 — 이게 조문 번호 질문이 걸리는 경로다
const NGRAMS = process.env.NGRAMS !== '0'
const bm25 = buildBm25(
  chunks.map((c) => `${c.source} ${c.path} ${c.text}`),
  NGRAMS,
)

const extractor = await pipeline('feature-extraction', model.id, { dtype: model.dtype })
const K = 5

const weights = process.argv.slice(2).map(Number)
const AXIS = weights.length ? weights : [0, 0.3, 0.5, 0.7, 1]

// 질의 임베딩은 가중치와 무관하므로 한 번만 한다
const qv = new Map()
for (const q of QUESTIONS) {
  const out = await extractor([model.query(q.text)], { pooling: 'mean', normalize: true })
  qv.set(q.id, new Float32Array(out.data))
}

console.log(
  `\n모델 ${vectorMeta.modelKey} · ${vectorMeta.dim}차원 · 청크 ${chunks.length} · 상위 ${K}`,
)
console.log('희소가중치 0 = 코사인만, 1 = BM25 만\n')

const header = ['가중치', '적중', ...QUESTIONS.map((q) => q.id)]
const rows = []

for (const w of AXIS) {
  let hitCount = 0
  const cells = []
  for (const q of QUESTIONS) {
    const hits = limitFamilies(
      hybridSearch(corpus, qv.get(q.id), q.text, bm25, 40, w),
      (i) => chunks[i].text,
    ).slice(0, K)
    const at = hits.findIndex((h) => q.gold(chunks[h.index]))
    if (at >= 0) hitCount += 1
    const via = at >= 0 ? hits[at].via : ''
    cells.push(at >= 0 ? `${at + 1}${via === 'sparse' ? 'S' : via === 'both' ? 'B' : 'D'}` : '-')
  }
  rows.push([String(w), `${hitCount}/${QUESTIONS.length}`, ...cells])
}

const width = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
const line = (cols) => cols.map((c, i) => c.padEnd(width[i])).join('  ')
console.log(line(header))
for (const r of rows) console.log(line(r))
console.log('\n순위 뒤 글자 = 들어온 경로: D 코사인만 · S BM25만 · B 둘 다 · - 상위 밖')
