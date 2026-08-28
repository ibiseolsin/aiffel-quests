/**
 * 종단 평가 하네스 (S11) — 질문 → 검색 → 프롬프트 조립 → 엔진 → 인용 추출 → (판정 훅).
 *
 * `eval-retrieval.mjs` 는 검색만 본다. 이 스크립트는 **끝까지** 돈다. 실패가 나면
 * 「어느 단계에서」 실패했는지 적는다 — PLAN S11 이 「실패 원인 단계 기록」을 요구한다.
 *
 * ## 아직 없는 것을 있는 척하지 않는다
 *
 * S7(근거 상태 5단 · 임계값)과 S8(판정 배지)이 **아직 구현되지 않았다.** 그래서
 * `classifyEvidence()` 와 `judge()` 는 **훅 자리만** 있고 `null` 을 돌려주며, 리포트에는
 * `미구현` 으로 찍힌다. 여기에 그럴듯한 임계값을 임의로 넣으면 S7 이 그 숫자를 근거로
 * 착각하게 되고, 그게 이 프로젝트에서 가장 하지 말아야 할 일이다.
 *
 * 지금 실제로 재는 것은 셋뿐이다:
 *   1. **검색** — 정답 조문이 후보에 들어왔는가 (`eval-set.mjs` 의 gold ID)
 *   2. **프롬프트** — 그 조문이 top-k 를 통과해 실제로 프롬프트에 실렸는가
 *   3. **인용** — 답변이 근거를 댔는가, 그리고 그 라벨이 **실제로 준 자료인가** (PRD F5 규칙)
 *
 * ## 엔진
 *
 * 갈아 끼울 수 있다. 기본은 **결정론적 mock** 이다 — 배관을 재는 것이 목적이라 답변 품질이
 * 흔들리면 배관 문제와 모델 문제를 못 가른다. 실제 엔진 경로(`--engine=ollama|gemini`)는
 * 코드로만 두었고 **이 세션에서 실행하지 않았다 → 미확인**.
 * `src/lib/engine.ts` 는 실제 엔진을 골랐을 때만 **동적으로** 불러온다 (mock 실행이 엔진
 * 모듈의 상태에 묶이지 않게 하기 위함).
 *
 * ## 실험 축 — 한 번에 하나만
 *
 *   1. `--top-k`          (동작한다)
 *   2. `--weak-threshold` (S7 미구현 → 기록만 하는 no-op)
 *   3. `--citation-rule`  (프롬프트 문구가 src/lib/prompt.ts 에 고정 → 기록만 하는 no-op)
 *
 * 기준선에서 **두 축 이상**이 움직이면 멈춘다. PRD 9절이 「한 번에 하나만」을 요구하는데,
 * 사람이 지키기로 하면 안 지켜지기 때문에 규칙으로 박았다 (`--allow-multi-axis` 로 해제).
 *
 * 실행:
 *   node scripts/eval-run.mjs                        # mock, 기준선
 *   node scripts/eval-run.mjs --engine=none          # 검색·프롬프트까지만 (모델 호출 없음)
 *   node scripts/eval-run.mjs --top-k=5 --label=k5   # 축 1
 *   node scripts/eval-run.mjs --only=Q1,Q5 --probes
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { DEFAULT_SPARSE_WEIGHT, hybridSearch, limitFamilies } from '../src/lib/search.ts'
import { buildPrompt, extractCitations } from '../src/lib/prompt.ts'
import { EVAL_SET, PROBE_SET, STATES_EXPECTING_REFUSAL, STATES_NEEDING_EVIDENCE, verifyEvalSet } from './eval-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')
// `*.local` 은 app/.gitignore 대상이다 — 결과 파일이 커밋에 섞이지 않는다.
// public/ 에는 쓰지 않는다: 그쪽은 배포되는 자료 폴더다
const OUT_DIR = resolve(HERE, 'eval-out.local')

/* ─── 축 기준선 ─────────────────────────────────────────────────────────── */

/**
 * 기준선. `top-k` 는 S4 가 확정한 8, 희소가중치는 0.3.
 * 축을 흔들 때 이 값과의 차이가 곧 「무엇을 바꿨는가」다.
 */
/**
 * 검색 단계를 잴 때 보는 창. `search.ts` 의 `CANDIDATES` 가 경로별 30 이므로 병합 결과는
 * 최대 60개다 — 60 을 달라고 하면 **병합 결과 전체**를 보게 되고, 그래서 이 지표가
 * top-k 축에 흔들리지 않는다. `search.ts` 의 후보 수를 바꾸면 여기도 같이 봐야 한다.
 */
const MERGED_MAX = 60

const BASELINE = {
  topK: 8,
  weakThreshold: null, // S7 미정 — PLAN 의 「약한 근거 임계값」 칸이 아직 _미정_
  citationRule: 'default',
  sparseWeight: DEFAULT_SPARSE_WEIGHT,
}

/* ─── CLI ───────────────────────────────────────────────────────────────── */

const args = new Map()
const flags = new Set()
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a)
  if (m) args.set(m[1], m[2])
  else if (a.startsWith('--')) flags.add(a.slice(2))
  else throw new Error(`알 수 없는 인자: ${a} (옵션은 --이름 또는 --이름=값)`)
}

const num = (k, dflt) => (args.has(k) ? Number(args.get(k)) : dflt)

const axes = {
  topK: num('top-k', BASELINE.topK),
  weakThreshold: args.has('weak-threshold') ? Number(args.get('weak-threshold')) : BASELINE.weakThreshold,
  citationRule: args.get('citation-rule') ?? BASELINE.citationRule,
  sparseWeight: num('sparse-weight', BASELINE.sparseWeight),
}
const engineName = args.get('engine') ?? 'mock'
const label = args.get('label') ?? `${engineName}-k${axes.topK}`
const only = args.has('only') ? new Set(args.get('only').split(/[,\s]+/).filter(Boolean)) : null
const withProbes = flags.has('probes')

const axesChanged = Object.keys(axes).filter((k) => axes[k] !== BASELINE[k])
if (axesChanged.length > 1 && !flags.has('allow-multi-axis')) {
  console.error(
    `\n두 축 이상이 기준선에서 움직였다: ${axesChanged.join(', ')}\n` +
      `PRD 9절은 「한 번에 하나만」을 요구한다. 정말 같이 바꿔야 하면 --allow-multi-axis 를 붙여라.\n`,
  )
  process.exit(2)
}

/* ─── 판정 훅 — 아직 비어 있다 ────────────────────────────────────────────── */

/**
 * 근거 상태 5단 판정 (S7). **미구현.**
 *
 * 들어와야 하는 것: 검색 최고 **원 코사인** 두 임계값 + 「인용이 하나도 없으면 근거충분 아님」
 * 규칙. `hybridSearch` 가 `dense` 를 원점수로 들고 다니는 이유가 이것이다 (search.ts 주석).
 * 지금은 `null` 을 돌려주고, 임계값 인자는 받아 두기만 한다.
 */
function classifyEvidence(_ctx, _weakThreshold) {
  return null
}
const EVIDENCE_HOOK_NOTE = '미구현 (S7) — 임계값 2개와 5단 판정이 아직 없다'

/**
 * LLM 근거성 판정 (S8). **미구현.**
 *
 * 들어와야 하는 것: FINDINGS 2절의 계약 — JSON 스키마 강제 + 긍정형 필드명
 * (`groundedInSources` · `hallucinated` · `citedIds` · `refusedForNoEvidence` · `scoreOutOf100`).
 * 이번 웨이브는 LLM 호출이 금지되어 훅만 둔다.
 */
async function judge(_ctx) {
  return null
}
const JUDGE_HOOK_NOTE = '미구현 (S8) — LLM 근거성 판정이 아직 없다. 이번 웨이브는 LLM 호출 금지'

/* ─── 엔진 ──────────────────────────────────────────────────────────────── */

/**
 * mock 은 **결정론적**이어야 한다. 같은 입력에 같은 문장이 나와야 배관 회귀를 잡을 수 있다.
 *
 * mock 이 하는 일은 「상위 근거 두 개를 규칙대로 인용한다」뿐이다. 질문 내용을 보지 않으므로
 * 코퍼스 밖 질문(Q7~Q9)에도 근거를 대는데, **그건 mock 의 버그가 아니라 의도**다 —
 * 그 오답을 걸러야 할 S7·S8 이 아직 없다는 사실이 리포트에 드러나야 한다.
 */
const MOCKS = {
  mock: (labels) => {
    const cite = labels.slice(0, 2).map((l) => `[${l.label}]`).join('')
    return (
      `제공된 자료에서 관련 규정을 확인했습니다${cite}. ` +
      `다만 개별 제품이 이 요건에 해당하는지는 단정할 수 없으므로, ` +
      `최종 확인은 식품의약품안전처 또는 전문가에게 받으시기 바랍니다.`
    )
  },
  'mock-refuse': () =>
    `제공된 자료에서 확인되지 않습니다. 이 자료는 식품 표시·광고 관련 법령의 일부이므로, ` +
    `다른 법령 소관일 수 있습니다.`,
}

/**
 * 엔진을 갈아 끼우는 자리. mock 은 여기서 끝나고, 실제 엔진은 필요할 때만 모듈을 불러온다.
 * @returns {{name: string, deterministic: boolean, run: (prompt: string, labels: any[]) => Promise<string>}}
 */
async function makeEngine(name) {
  if (name === 'none') {
    return { name, deterministic: true, run: null }
  }
  if (MOCKS[name]) {
    return { name, deterministic: true, run: async (_p, labels) => MOCKS[name](labels) }
  }
  if (name !== 'ollama' && name !== 'gemini') {
    throw new Error(`알 수 없는 엔진: ${name} (mock · mock-refuse · none · ollama · gemini)`)
  }
  const key = process.env.GEMINI_API_KEY
  if (name === 'gemini' && !key) {
    throw new Error('GEMINI_API_KEY 가 없다 — 키 없이 Gemini 를 고를 수 없다 (자동 폴백 없음)')
  }
  // **이 경로는 이 세션에서 실행하지 않았다 → 미확인.** 동적 import 로 두어
  // mock 실행이 engine.ts 에 묶이지 않게 한다 (키 확인을 import 앞에 두는 이유도 같다)
  const { ENGINE_DEFAULTS, generate } = await import('../src/lib/engine.ts')
  const config =
    name === 'gemini'
      ? { ...ENGINE_DEFAULTS.gemini, apiKey: key, model: process.env.GEMINI_MODEL ?? ENGINE_DEFAULTS.gemini.model }
      : { ...ENGINE_DEFAULTS.ollama, model: process.env.OLLAMA_MODEL ?? ENGINE_DEFAULTS.ollama.model }
  return {
    name: `${name} (${config.model})`,
    deterministic: false,
    run: async (prompt) => {
      let answer = ''
      await generate(config, prompt, (t) => (answer += t), new AbortController().signal)
      return answer
    },
  }
}

// 엔진을 **자료보다 먼저** 세운다. 엔진 이름을 틀렸는데 129MB 임베딩 모델을 다 받은 뒤에
// 죽는 것은 낭비이고, 스택 트레이스만 남아 무엇이 틀렸는지도 안 보인다
const engine = await makeEngine(engineName).catch((e) => {
  console.error(`\n엔진을 세울 수 없다: ${e?.message ?? e}\n`)
  process.exit(2)
})

/* ─── 자료 ──────────────────────────────────────────────────────────────── */

const { chunks, ...meta } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(CORPUS, 'vectors.json'), 'utf8'))
const raw = readFileSync(resolve(CORPUS, 'vectors.bin'))
const corpus = {
  chunks,
  vectorMeta,
  vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
}
const model = MODELS[vectorMeta.modelKey]
const indexOfId = new Map(chunks.map((c, i) => [c.id, i]))

// 정답 ID 가 코퍼스에 없으면 여기서 멈춘다 — 지어낸 ID 로 점수를 세는 것이 최악이다
const check = verifyEvalSet(chunks)
if (!check.ok) {
  console.error('\n평가 세트가 코퍼스와 맞지 않는다:')
  for (const p of check.problems) console.error(`  - ${p}`)
  process.exit(2)
}

const bm25 = buildBm25(chunks.map((c) => `${c.source} ${c.path} ${c.text}`))
const extractor = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

const dates = chunks.map((c) => c.effectiveDate).sort()
const now = new Date()

/**
 * 배포 실패 조건(PRD 8절)의 문구 검사 — **정보용이다. S7·S8 의 대체물이 아니다.**
 * 「대한민국 법령에 없다」는 뜻으로 읽히는 답변은 수치와 무관하게 배포 실패다.
 */
const FORBIDDEN = [/대한민국\s*법령/, /법령에\s*(는\s*)?없/, /법령에\s*(그런\s*)?규정이\s*없/]

/* ─── 한 문항 ───────────────────────────────────────────────────────────── */

async function runOne(q, kind) {
  // 표기 진단(PROBE_SET)에는 근거상태가 없다 — 그쪽은 gold 가 있으면 검색을 재는 것이 맞다.
  // 여기서 `expected` 만 보면 진단 문항이 「근거 0건이 기대값」으로 잘못 분류된다
  const needsEvidence = q.expected
    ? STATES_NEEDING_EVIDENCE.includes(q.expected)
    : (q.gold ?? []).length > 0
  const expectsRefusal = STATES_EXPECTING_REFUSAL.includes(q.expected)
  const goldIdx = new Set((q.gold ?? []).map((id) => indexOfId.get(id)))

  const out = await extractor([model.query(q.question)], { pooling: 'mean', normalize: true })
  const qv = new Float32Array(out.data)

  // 두 개를 따로 잰다 — 안 그러면 축 1을 흔들 때 「검색」 지표까지 같이 움직여서
  // 검색이 못 찾은 것과 top-k 가 자른 것을 구별할 수 없게 된다.
  //
  //  ① 검색 단계: 하이브리드 병합 결과 **전체** 안에 정답이 있는가 → **축과 무관하게 고정**
  //  ② 프롬프트 단계: 그중 top-k 가 실제로 실었는가 → 축 1이 움직이는 곳
  //
  // ②는 앱과 **똑같은 순서**(후보 k*3 → 형제 무리 제한 → top-k)로 만든다. 여기서 앱과
  // 갈라지면 재는 것과 배포되는 것이 다른 물건이 된다
  const candidates = limitFamilies(
    hybridSearch(corpus, qv, q.question, bm25, MERGED_MAX, axes.sparseWeight),
    (i) => chunks[i].text,
  )
  const hits = limitFamilies(
    hybridSearch(corpus, qv, q.question, bm25, axes.topK * 3, axes.sparseWeight),
    (i) => chunks[i].text,
  ).slice(0, axes.topK)

  const rankIn = (list) => {
    const at = list.findIndex((h) => goldIdx.has(h.index))
    return at < 0 ? null : { rank: at + 1, id: chunks[list[at].index].id, via: list[at].via, dense: list[at].dense }
  }
  const inCandidates = goldIdx.size ? rankIn(candidates) : null
  const inPrompt = goldIdx.size ? rankIn(hits) : null

  const retrieval = {
    goldExpected: needsEvidence,
    candidateCount: candidates.length,
    promptCount: hits.length,
    /** 근거 조문이 후보 안에 있는가 (없으면 검색 단계 실패) */
    inCandidates,
    /** 그 조문이 top-k 를 통과해 프롬프트에 실렸는가 (없으면 프롬프트 단계 실패) */
    inPrompt,
    /** 최고 원 코사인 — **S7 임계값을 정할 때 쓸 재료.** 지금은 기록만 한다 */
    maxDense: hits.length ? Math.max(...hits.map((h) => h.dense)) : null,
    top: hits.map((h, i) => ({
      label: `S${i + 1}`,
      id: chunks[h.index].id,
      path: `${chunks[h.index].source} ${chunks[h.index].path}`,
      score: Number(h.score.toFixed(4)),
      dense: Number(h.dense.toFixed(4)),
      via: h.via,
      denseRank: h.denseRank,
      sparseRank: h.sparseRank,
    })),
  }

  const labelled = hits.map((h, i) => ({ chunk: chunks[h.index], label: `S${i + 1}` }))
  let prompt = null
  let promptError = null
  try {
    prompt = buildPrompt({
      question: q.question,
      chunks: labelled,
      meta,
      effectiveFrom: dates[0],
      effectiveTo: dates.at(-1),
      now,
    })
  } catch (e) {
    promptError = String(e?.message ?? e)
  }

  let answer = null
  let engineError = null
  if (engine.run && prompt) {
    try {
      answer = await engine.run(prompt, labelled)
    } catch (e) {
      engineError = String(e?.message ?? e)
    }
  }

  const cited = answer == null ? null : extractCitations(answer)
  const provided = new Set(labelled.map((l) => l.label))
  const invalid = cited?.filter((c) => !provided.has(c)) ?? null

  // PRD F5 의 규칙 판정. **집합 소속만** 본다 — 내용 왜곡·방패 인용은 못 잡는다
  const citationValid = cited == null ? null : invalid.length === 0
  const forbidden = answer == null ? null : FORBIDDEN.filter((re) => re.test(answer)).map(String)

  const ctx = { question: q, retrieval, prompt, answer, cited }

  /* 단계별 판정 — 앞 단계가 실패하면 뒤 단계는 볼 것이 없다 */
  const stages = {}
  let failStage = null
  const notes = []

  if (needsEvidence) {
    stages.검색 = inCandidates ? 'pass' : 'fail'
    if (!inCandidates) failStage ??= '검색'
    stages.프롬프트 = !inCandidates ? '-' : inPrompt ? 'pass' : 'fail'
    if (inCandidates && !inPrompt) {
      failStage ??= '프롬프트'
      notes.push(`정답이 후보 ${inCandidates.rank}위인데 top-k=${axes.topK} 에서 잘렸다`)
    }
  } else {
    stages.검색 = '해당없음'
    stages.프롬프트 = '해당없음'
    notes.push('근거 0건이 기대값이라 검색 적중을 재지 않는다')
  }
  if (promptError) {
    stages.프롬프트 = 'fail'
    failStage ??= '프롬프트'
    notes.push(`프롬프트 조립 실패: ${promptError}`)
  }

  if (engineError) {
    stages.인용 = 'fail'
    failStage ??= '엔진'
    notes.push(`엔진 실패: ${engineError}`)
  } else if (cited == null) {
    stages.인용 = '미실행'
  } else if (invalid.length) {
    stages.인용 = 'fail'
    failStage ??= '인용'
    notes.push(`없는 자료를 인용했다: ${invalid.join(' ')} (배포 실패 조건)`)
  } else if (needsEvidence && cited.length === 0) {
    stages.인용 = 'fail'
    failStage ??= '인용'
    notes.push('근거를 하나도 대지 않았다')
  } else {
    stages.인용 = 'pass'
  }
  if (forbidden?.length) {
    notes.push(`「대한민국 법령에 없다」로 읽힐 문구가 있다 (배포 실패 조건): ${forbidden.join(' ')}`)
  }
  if (expectsRefusal && cited?.length) {
    notes.push(`거절해야 하는 문항인데 근거 ${cited.length}개를 인용했다 — S7 상태판정이 걸러야 할 것`)
  }

  const evidenceState = classifyEvidence(ctx, axes.weakThreshold)
  const judged = await judge(ctx)
  stages.판정 = evidenceState == null && judged == null ? '미구현' : 'pass'
  if (stages.판정 === '미구현' && failStage == null && expectsRefusal) {
    // 거절했는지 여부는 상태판정이 있어야 답이 나온다 — 지금은 결론을 내지 않는다
    failStage = '판정(미구현)'
  }

  const verdict =
    failStage && failStage !== '판정(미구현)'
      ? '실패'
      : stages.판정 === '미구현'
        ? '미판정'
        : '통과'

  return {
    id: q.id,
    kind,
    channel: q.channel ?? null,
    question: q.question,
    expected: q.expected ?? null,
    gold: q.gold ?? [],
    why: q.why ?? null,
    known: q.known ?? null,
    retrieval,
    prompt: prompt == null ? null : { chars: prompt.length, labels: labelled.map((l) => ({ label: l.label, id: l.chunk.id })) },
    answer: answer == null ? null : { chars: answer.length, text: answer },
    citations: cited == null ? null : { cited, invalid, count: cited.length },
    rules: { citationValid, forbiddenPhrases: forbidden },
    evidenceState,
    evidenceStateNote: EVIDENCE_HOOK_NOTE,
    judge: judged,
    judgeNote: JUDGE_HOOK_NOTE,
    stages,
    failStage,
    verdict,
    notes,
  }
}

/* ─── 실행 ──────────────────────────────────────────────────────────────── */

const targets = [
  ...EVAL_SET.map((q) => ({ q, kind: '평가' })),
  ...(withProbes ? PROBE_SET.map((q) => ({ q, kind: '표기진단' })) : []),
].filter(({ q }) => !only || only.has(q.id))

if (!targets.length) {
  console.error(`--only 로 고른 문항이 없다: ${[...(only ?? [])].join(', ')}`)
  process.exit(2)
}

const results = []
for (const { q, kind } of targets) results.push(await runOne(q, kind))

/* ─── 리포트 ────────────────────────────────────────────────────────────── */

const evalOnly = results.filter((r) => r.kind === '평가')
const needing = evalOnly.filter((r) => r.retrieval.goldExpected)
const summary = {
  questions: results.length,
  검색적중: `${needing.filter((r) => r.retrieval.inCandidates).length}/${needing.length}`,
  프롬프트적재: `${needing.filter((r) => r.retrieval.inPrompt).length}/${needing.length}`,
  인용유효: (() => {
    const scored = results.filter((r) => r.rules.citationValid != null)
    return scored.length ? `${scored.filter((r) => r.rules.citationValid).length}/${scored.length}` : '미실행'
  })(),
  실패: evalOnly.filter((r) => r.verdict === '실패').map((r) => `${r.id}(${r.failStage})`),
  미판정: evalOnly.filter((r) => r.verdict === '미판정').map((r) => r.id),
  근거상태: EVIDENCE_HOOK_NOTE,
  근거성: JUDGE_HOOK_NOTE,
}

const report = {
  runAt: now.toISOString(),
  label,
  corpus: { chunks: chunks.length, collectedAt: meta.collectedAt, model: vectorMeta.modelKey, dim: vectorMeta.dim },
  axes,
  baseline: BASELINE,
  axesChanged,
  engine: {
    name: engine.name,
    deterministic: engine.deterministic,
    verified: engine.deterministic ? 'mock 으로만 확인 — 실제 엔진 경로는 미확인' : '이 실행에서 실제 엔진 사용',
  },
  hooks: { evidenceState: EVIDENCE_HOOK_NOTE, judge: JUDGE_HOOK_NOTE, citationRuleAxis: citationRuleNote() },
  summary,
  questions: results,
}

function citationRuleNote() {
  if (axes.citationRule === BASELINE.citationRule) return '기준선 (src/lib/prompt.ts 의 고정 문구)'
  return `"${axes.citationRule}" — **no-op.** 인용 규칙 문구는 src/lib/prompt.ts 안에 고정돼 있어 이 축은 아직 흔들 수 없다`
}

mkdirSync(OUT_DIR, { recursive: true })
const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outPath = args.get('out') ? resolve(process.cwd(), args.get('out')) : resolve(OUT_DIR, `${stamp}_${label}.json`)
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

/* 사람이 읽는 표 */
const pad = (s, w) => {
  const width = [...String(s)].reduce((n, ch) => n + (/[ᄀ-퟿＀-￯]/.test(ch) ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, w - width))
}
const table = (header, rows) => {
  const w = header.map((h, i) =>
    Math.max(
      ...[h, ...rows.map((r) => r[i])].map((c) =>
        [...String(c)].reduce((n, ch) => n + (/[ᄀ-퟿＀-￯]/.test(ch) ? 2 : 1), 0),
      ),
    ),
  )
  const line = (cols) => cols.map((c, i) => pad(c, w[i])).join('  ')
  console.log(line(header))
  console.log(line(w.map((n) => '-'.repeat(n))))
  for (const r of rows) console.log(line(r))
}

console.log(`\n== S11 종단 하네스 · ${label} ==`)
console.log(`코퍼스 ${chunks.length} 청크 · 모델 ${vectorMeta.modelKey} · 엔진 ${engine.name}`)
console.log(
  `축: top-k=${axes.topK} · 약한근거임계값=${axes.weakThreshold ?? '미정(S7)'} · 인용규칙=${axes.citationRule} · 희소가중치=${axes.sparseWeight}`,
)
console.log(`기준선에서 바뀐 축: ${axesChanged.length ? axesChanged.join(', ') : '없음'}\n`)

table(
  ['문항', '기대상태', '검색', '프롬프트', '인용', '판정', '결과', '실패단계'],
  results.map((r) => [
    r.id,
    r.expected ?? r.kind,
    r.retrieval.goldExpected
      ? r.retrieval.inCandidates
        ? `${r.retrieval.inCandidates.rank}위 ${r.retrieval.inCandidates.id}`
        : '못 찾음'
      : '해당없음',
    r.retrieval.goldExpected ? (r.retrieval.inPrompt ? `${r.retrieval.inPrompt.rank}위` : '실림 안 됨') : '-',
    r.citations == null ? '미실행' : `${r.citations.count}개${r.citations.invalid.length ? ` (무효 ${r.citations.invalid.length})` : ''}`,
    r.stages.판정,
    r.verdict,
    r.failStage ?? '-',
  ]),
)

console.log(`\n검색 적중 ${summary.검색적중} · 프롬프트 적재 ${summary.프롬프트적재} · 인용 유효 ${summary.인용유효}`)
const probes = results.filter((r) => r.kind === '표기진단')
if (probes.length) {
  // 표기 진단은 루브릭 지표가 아니므로 위 합계와 섞지 않는다
  console.log(
    `표기진단(합계 밖): ${probes.map((r) => `${r.id} ${r.retrieval.inPrompt ? `${r.retrieval.inPrompt.rank}위` : '실림 안 됨'}`).join(' · ')}`,
  )
}
if (summary.실패.length) console.log(`실패: ${summary.실패.join(', ')}`)
if (summary.미판정.length) console.log(`미판정(S7·S8 없음): ${summary.미판정.join(', ')}`)

const withNotes = results.filter((r) => r.notes.length)
if (withNotes.length) {
  console.log('\n[단계별 메모]')
  for (const r of withNotes) for (const n of r.notes) console.log(`  ${r.id}: ${n}`)
}

const known = results.filter((r) => r.known)
if (known.length) {
  console.log('\n[알려진 사실 — 감추지 않는다]')
  for (const r of known) console.log(`  ${r.id}: ${r.known.replace(/\s+/g, ' ')}`)
}

console.log(`\n근거상태 판정: ${EVIDENCE_HOOK_NOTE}`)
console.log(`근거성 판정:   ${JUDGE_HOOK_NOTE}`)
console.log(`인용규칙 축:   ${citationRuleNote()}`)
console.log(`\nJSON → ${relative(process.cwd(), outPath)}`)
