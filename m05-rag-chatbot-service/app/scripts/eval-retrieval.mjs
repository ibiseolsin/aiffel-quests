/**
 * 검색만 재는 하네스 — **LLM 없이** 돈다. 재는 축은 **희소(BM25) 가중치** 하나다.
 *
 * 재는 것: 평가 문항의 근거 조문이 상위 k 안에 들어오는가.
 *
 * **앱과 같은 코드를 쓴다.** Node 가 `.ts` 를 바로 읽으므로 `src/lib` 를 그대로 import 한다 —
 * 검색 로직을 스크립트에 다시 적으면 재는 것과 배포되는 것이 갈라진다.
 *
 * ## S11 에서 바뀐 것 — 질문과 정답이 여기 있지 않다
 *
 * 문항 정의는 **`eval-set.mjs` 하나로 모았다.** 예전에는 이 파일 안에 질문 문구와
 * 정답 판정 정규식이 따로 살아 있었고, PRD 9절의 초안 표와 조용히 어긋나 있었다.
 *
 * 그래서 **S4 가 기록한 「상위5 적중 7/8」은 이제 이 명령으로 재현되지 않는다.** 이유가 둘이다:
 *
 *   1. 질문 문구를 **판매채널에서 실제로 부딪히는 말**로 바꿨다 (PLAN S11 요구)
 *   2. 정답을 **조문 ID 로 못 박았다.** 예전의 내용 정규식은 너무 넓었다 —
 *      Q2 의 `/알레르기/` 는 청크 **36개**에 걸려서 무엇이 걸리든 적중으로 셌고,
 *      Q3 의 `/영양표시/` 는 20개에 걸렸다. 즉 옛 7/8 에는 **자동 통과가 섞여 있었다.**
 *
 * 옛 숫자를 되살리려고 정답을 다시 넓히지 않는다 — 그건 측정을 버리고 숫자를 지키는 것이다.
 *
 * 실행: node scripts/eval-retrieval.mjs [희소가중치...]
 *   예: node scripts/eval-retrieval.mjs 0 0.3 0.5 0.7   (가중치 축을 훑는다)
 *
 * 종단(프롬프트·엔진·인용·판정)은 `eval-run.mjs` 가 본다.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearch, limitFamilies } from '../src/lib/search.ts'
import { EVAL_SET, PROBE_SET, verifyEvalSet } from './eval-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')

const { chunks } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(CORPUS, 'vectors.json'), 'utf8'))
const model = MODELS[vectorMeta.modelKey]

const indexOfId = new Map(chunks.map((c, i) => [c.id, i]))

// 정답 ID 가 코퍼스와 어긋나면 여기서 멈춘다. 조용히 엉뚱한 조문을 정답으로 세는 것이 최악이다
const check = verifyEvalSet(chunks)
if (!check.ok) {
  console.error('')
  console.error('평가 세트가 코퍼스와 맞지 않는다:')
  for (const p of check.problems) console.error(`  - ${p}`)
  process.exit(2)
}

const raw = readFileSync(resolve(CORPUS, 'vectors.bin'))
const corpus = {
  chunks,
  vectorMeta,
  vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
}

/**
 * 문항은 `eval-set.mjs` 에서 온다 — **여기서 다시 정의하지 않는다.**
 * 표기 진단(N1·N2)까지 같이 훑는다: 희소가중치 축이 실제로 무엇을 사는지 그 둘이 보여 준다.
 */
const QUESTIONS = [...EVAL_SET, ...PROBE_SET]
  .filter((q) => (q.gold ?? []).length > 0) // 근거 0건이 기대값인 Q7~Q9 는 적중을 잴 대상이 아니다
  .map((q) => ({ ...q, goldIndex: new Set(q.gold.map((id) => indexOfId.get(id))) }))

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
  const out = await extractor([model.query(q.question)], { pooling: 'mean', normalize: true })
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
      hybridSearch(corpus, qv.get(q.id), q.question, bm25, 40, w),
      (i) => chunks[i].text,
    ).slice(0, K)
    const at = hits.findIndex((h) => q.goldIndex.has(h.index))
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
