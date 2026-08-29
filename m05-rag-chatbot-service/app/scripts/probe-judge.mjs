/**
 * S8 판정 프로브 — **조문에 없는 내용을 일부러 넣어 판정이 잡는가.**
 *
 * FINDINGS 2절이 열어 둔 항목을 닫는다: 거기서 확인한 것은 「형식이 지켜진다」까지였고,
 * 정답 케이스 하나뿐이었다. 여기서는 **같은 근거 · 같은 질문**에 답변만 바꿔 가며 잰다.
 *
 *   node scripts/probe-judge.mjs            # Ollama (기본)
 *   node scripts/probe-judge.mjs --runs=3   # 같은 입력 반복 — 판정이 흔들리는지 본다
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_DEFAULTS } from '../src/lib/engine.ts'
import { judge } from '../src/lib/judge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const { chunks } = JSON.parse(readFileSync(resolve(HERE, '../public/corpus/chunks.json'), 'utf8'))
const byId = new Map(chunks.map((c) => [c.id, c]))
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 1)

const QUESTION = '일반 가공식품 상세페이지에 "면역력 강화에 도움"이라고 적어도 되나요?'
// 실제로 검색되는 조문들. 판정이 볼 자료는 세 케이스 모두 **똑같다**
const EVIDENCE = ['FLA-031', 'FLA-032', 'FLA-033'].map((id, i) => ({
  label: `S${i + 1}`,
  chunk: byId.get(id),
}))

const CASES = [
  {
    name: '① 근거 있는 답 (대조군)',
    expect: '만들어냄 = false',
    answer:
      '질병의 예방ㆍ치료에 효능이 있는 것으로 인식할 우려가 있는 표시 또는 광고는 금지됩니다[S1]. ' +
      '건강기능식품이 아닌 것을 건강기능식품으로 인식할 우려가 있는 표시 또는 광고도 금지됩니다[S3]. ' +
      '"면역력 강화"가 이 요건에 해당하는지는 개별 판단이 필요합니다.',
  },
  {
    name: '② 없는 수치를 더한 답',
    expect: '만들어냄 = true',
    answer:
      '질병의 예방ㆍ치료에 효능이 있는 것으로 인식할 우려가 있는 표시는 금지됩니다[S1]. ' +
      '위반하면 **과징금 3천만원과 영업정지 15일**이 부과되며, 광고 문구는 **12포인트 이상**으로 ' +
      '적어야 합니다[S1]. 또한 **제8조 제1항 제11호**에 따라 사전 신고가 필요합니다[S2].',
  },
  {
    name: '③ 없는 조문 번호를 지어낸 답',
    expect: '만들어냄 = true',
    answer:
      '「식품위생법 제31조의4」와 「건강기능식품법 제18조」에 따라 면역력 표현은 허용됩니다[S2]. ' +
      '식약처 고시 제2024-77호가 그 근거입니다[S3].',
  },
  {
    name: '④ 요건을 뒤집어 말한 답 (번호는 맞다)',
    expect: '규칙은 통과 · LLM 이 잡아야 한다',
    answer:
      '질병의 예방ㆍ치료에 효능이 있다는 표시는 **허용됩니다**[S1]. ' +
      '건강기능식품이 아닌 제품도 건강기능식품으로 표시할 수 있습니다[S3].',
  },
]

const config = { ...ENGINE_DEFAULTS.ollama }
console.log(`판정 엔진: ${config.kind} ${config.model} · 자료 ${EVIDENCE.map((e) => e.chunk.id).join(' ')}\n`)

for (const c of CASES) {
  const got = []
  for (let i = 0; i < runs; i++) {
    const out = await judge(config, { question: QUESTION, answer: c.answer, evidence: EVIDENCE }, AbortSignal.timeout(120_000))
    got.push(out)
  }
  console.log(`${c.name}  (기대: ${c.expect})`)
  for (const o of got) {
    if (!o.ok) {
      console.log(`  판정 실패 — ${o.message}${o.hint ? ` / ${o.hint}` : ''}`)
      continue
    }
    const v = o.verdict
    console.log(
      `  근거함=${String(v.groundedInSources).padEnd(5)} 만들어냄=${String(v.hallucinated).padEnd(5)}` +
        ` 인용함=${String(v.citedIds).padEnd(5)} 거절=${String(v.refusedForNoEvidence).padEnd(5)}` +
        ` 점수=${String(v.scoreOutOf100).padStart(3)}  (${(o.ms / 1000).toFixed(1)}초)`,
    )
    console.log(`  → ${v.comment.slice(0, 150)}`)
  }
  console.log()
}
