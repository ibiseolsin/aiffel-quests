/**
 * 파이프라인 전체를 한 번 돌린다 — 질문 → 하이브리드 검색 → 프롬프트 → 엔진 → 인용 확인.
 *
 * 앱과 **같은 코드**를 쓴다 (`src/lib`). 실험(S11)도 이 스크립트로 돌린다 —
 * 브라우저에서 손으로 9문항을 돌리면 조건을 고정할 수 없다.
 *
 * 실행: node scripts/ask.mjs "질문" [top-k]
 *   엔진: 기본 Ollama. Gemini 는 GEMINI_API_KEY 환경변수가 있으면 그것을 쓴다
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearch, limitFamilies } from '../src/lib/search.ts'
import { buildPrompt, extractCitations } from '../src/lib/prompt.ts'
import { ENGINE_DEFAULTS, generate } from '../src/lib/engine.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')

const question = process.argv[2]
if (!question) {
  console.error('사용법: node scripts/ask.mjs "질문" [top-k]')
  process.exit(1)
}
const TOP_K = Number(process.argv[3] ?? 8)

const { chunks, ...meta } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(CORPUS, 'vectors.json'), 'utf8'))
const raw = readFileSync(resolve(CORPUS, 'vectors.bin'))
const corpus = {
  chunks,
  vectorMeta,
  vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
}
const model = MODELS[vectorMeta.modelKey]

const bm25 = buildBm25(chunks.map((c) => `${c.source} ${c.path} ${c.text}`))
const extractor = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

const t0 = Date.now()
const out = await extractor([model.query(question)], { pooling: 'mean', normalize: true })
const hits = limitFamilies(
  hybridSearch(corpus, new Float32Array(out.data), question, bm25, TOP_K * 3),
  (i) => chunks[i].text,
).slice(0, TOP_K)
const tSearch = Date.now() - t0

const dates = chunks.map((c) => c.effectiveDate).sort()
const labelled = hits.map((h, i) => ({ chunk: chunks[h.index], label: `S${i + 1}` }))
const prompt = buildPrompt({
  question,
  chunks: labelled,
  meta,
  effectiveFrom: dates[0],
  effectiveTo: dates.at(-1),
  now: new Date(),
})

console.log(`검색 ${tSearch}ms · 근거 ${hits.length}개 · 프롬프트 ${prompt.length}자\n`)
hits.forEach((h, i) => {
  const c = chunks[h.index]
  console.log(
    `  [S${i + 1}] ${h.score.toFixed(3)} ${h.via.padEnd(6)} ${c.source} ${c.path} (의미 ${h.denseRank ?? '밖'} / 표기 ${h.sparseRank ?? '밖'})`,
  )
})

const key = process.env.GEMINI_API_KEY
const config = key
  ? { ...ENGINE_DEFAULTS.gemini, apiKey: key }
  : { ...ENGINE_DEFAULTS.ollama, model: process.env.OLLAMA_MODEL ?? ENGINE_DEFAULTS.ollama.model }

console.log(`\n엔진 ${config.kind} (${config.model})\n${'-'.repeat(60)}`)

const t1 = Date.now()
let answer = ''
let firstToken = 0
await generate(
  config,
  prompt,
  (t) => {
    if (!firstToken) firstToken = Date.now() - t1
    answer += t
    process.stdout.write(t)
  },
  new AbortController().signal,
)

const cited = extractCitations(answer)
const valid = cited.filter((c) => labelled.some((l) => l.label === c))
console.log(`\n${'-'.repeat(60)}`)
console.log(`첫 토큰 ${firstToken}ms · 전체 ${Date.now() - t1}ms · ${answer.length}자`)
console.log(`인용 ${cited.length}개: ${cited.join(' ') || '없음'}`)
if (cited.length !== valid.length) {
  console.log(`⚠ 없는 자료를 인용했다: ${cited.filter((c) => !valid.includes(c)).join(' ')}`)
}
