/**
 * S12 — **키 없는 방문자용 녹화 데모를 만든다.**
 *
 * 왜 녹화인가. 이 앱은 답변 엔진에 키가 필요하고(Gemini) 로컬 Ollama 는 배포본에서
 * 막힌다(FINDINGS 9절). 그래서 처음 온 사람은 **파이프라인이 도는 것을 아예 못 본다** —
 * 검색까지는 브라우저 안에서 되지만 거기서 끊긴다. 실제로 받았던 응답을 그대로 다시
 * 틀어 주면, 키가 없어도 「질문 → 검색 → 근거 → 답변 → 판정」 전체를 볼 수 있다.
 *
 * **지어내지 않는다.** 여기 담기는 것은 전부 실행 결과다 — 토큰 하나하나와 그 도착
 * 시각까지 실제로 받은 것을 적는다. 재생은 그 타임라인을 다시 흘릴 뿐이다.
 *
 * **청크는 인덱스가 아니라 ID 로 적는다.** 코퍼스를 다시 만들면 인덱스는 조용히
 * 어긋나지만 ID 는 안 맞으면 안 맞는다고 티가 난다 — 재생 쪽이 그때 재생을 거부한다.
 *
 * 실행: node scripts/record-demo.mjs <slug> "질문"   (엔진은 ask.mjs 와 같은 규칙)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearchTraced, limitFamilies } from '../src/lib/search.ts'
import { buildPrompt } from '../src/lib/prompt.ts'
import { splitCitations } from '../src/lib/citations.ts'
import { classify, preClassify } from '../src/lib/evidence-state.ts'
import { judge, ruleVerdicts } from '../src/lib/judge.ts'
import { ENGINE_DEFAULTS, generate } from '../src/lib/engine.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')
const OUT_DIR = resolve(HERE, '../public/demo')
const TOP_K = 8

const [slug, question] = process.argv.slice(2)
if (!slug || !question) {
  console.error('사용법: node scripts/record-demo.mjs <slug> "질문"')
  process.exit(1)
}

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

/* ── 검색 — 앱의 search() 와 같은 순서 ─────────────────────────────────────── */
const tEmbed = Date.now()
const out = await extractor([model.query(question)], { pooling: 'mean', normalize: true })
const embedMs = Date.now() - tEmbed
const { hits: found, trace } = hybridSearchTraced(
  corpus, new Float32Array(out.data), question, bm25, TOP_K * 3,
)
const kept = limitFamilies(found, (i) => chunks[i].text)
const hits = kept.slice(0, TOP_K)
const labelled = hits.map((h, i) => ({ chunk: chunks[h.index], label: `S${i + 1}`, hit: h }))

const pre = preClassify(question, meta, trace.sparseTop5)
console.log(`검색 ${hits.length}개 · 사전판정 ${pre.refuse ?? '진행'}`)

/* ── 생성 — 범위 밖이면 앱과 똑같이 엔진을 안 부른다 ─────────────────────── */
const key = process.env.GEMINI_API_KEY
const config = key
  ? { ...ENGINE_DEFAULTS.gemini, apiKey: key }
  : { ...ENGINE_DEFAULTS.ollama, model: process.env.OLLAMA_MODEL ?? ENGINE_DEFAULTS.ollama.model }

/** `[{ms, s}]` — 토큰이 **도착한 시각**을 그대로 적는다. 재생이 이 간격을 다시 쓴다 */
const tokens = []
let answer = ''
let judgement = null

if (!pre.refuse) {
  const dates = chunks.map((c) => c.effectiveDate).sort()
  const prompt = buildPrompt({
    question,
    chunks: labelled.map(({ chunk, label }) => ({ chunk, label })),
    meta,
    effectiveFrom: dates[0],
    effectiveTo: dates.at(-1),
    now: new Date(),
  })
  const t1 = Date.now()
  await generate(config, prompt, (t) => {
    tokens.push({ ms: Date.now() - t1, s: t })
    answer += t
    process.stdout.write(t)
  }, new AbortController().signal)
  console.log(`\n생성 ${Date.now() - t1}ms · ${answer.length}자 · 토큰 ${tokens.length}개`)

  const r = await judge(config, {
    question,
    answer,
    evidence: labelled.map(({ chunk, label }) => ({ chunk, label })),
  }, new AbortController().signal)
  judgement = r.ok ? { ok: true, verdict: r.verdict, ms: r.ms, model: r.model } : null
  console.log(r.ok ? `판정 ${r.verdict.scoreOutOf100}/100` : `판정 실패 — ${r.message}`)
}

/* ── 녹화본 — 재생 쪽이 화면을 그대로 세울 수 있을 만큼만 ───────────────── */
const citations = splitCitations(answer, labelled.map((l) => l.label))
const verdict = pre.refuse
  ? { state: pre.refuse, why: pre.why, limits: [] }
  : classify({ pre, evidence: labelled, citations, cancelled: false })

mkdirSync(OUT_DIR, { recursive: true })
const recording = {
  version: 1,
  slug,
  recordedAt: new Date().toLocaleDateString('sv-SE'), // 현지 날짜. toISOString 은 UTC 라 자정 직후 어제가 박힌다
  corpusChunks: chunks.length,
  question,
  engine: config.kind,
  model: config.model,
  /** 앱이 `searchStages()` 로 같은 문장을 다시 만든다 — 문장을 굳혀 두면 코드와 갈린다 */
  stageInput: { trace, ranked: found.length, kept: kept.length, loaded: hits.length, embedMs, dim: vectorMeta.dim },
  pre,
  /** 인덱스가 아니라 ID. 코퍼스가 바뀌면 재생이 거부한다 */
  evidence: labelled.map(({ chunk, label, hit }) => ({
    label,
    chunkId: chunk.id,
    score: hit.score, dense: hit.dense, sparse: hit.sparse, via: hit.via,
    denseRank: hit.denseRank ?? null, sparseRank: hit.sparseRank ?? null,
  })),
  answer,
  tokens,
  firstTokenMs: tokens[0]?.ms ?? null,
  totalMs: tokens.at(-1)?.ms ?? null,
  verdict,
  rules: ruleVerdicts({ state: verdict.state, citations, cancelled: false }),
  judgement,
}

const path = resolve(OUT_DIR, `${slug}.json`)
writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
console.log(`\n→ ${path}  (상태 ${verdict.state})`)

/* 목록은 폴더를 훑어 다시 쓴다 — 손으로 관리하면 지운 녹화가 목록에 남는다 */
const demos = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort()
  .map((f) => {
    const r = JSON.parse(readFileSync(resolve(OUT_DIR, f), 'utf8'))
    return {
      slug: r.slug,
      question: r.question,
      state: r.verdict.state,
      engine: r.engine,
      model: r.model,
      recordedAt: r.recordedAt,
      corpusChunks: r.corpusChunks,
      calledEngine: r.tokens.length > 0,
    }
  })
writeFileSync(resolve(OUT_DIR, 'index.json'), `${JSON.stringify({ version: 1, demos }, null, 2)}\n`, 'utf8')
console.log(`목록 ${demos.length}개 갱신`)
