/** A4 결정성 검사 — G2 의 배지가 **모델이 무엇을 인용하든** 근거약함인지 본다.
 *  엔진을 부르지 않는다. 실측된 세 가지 인용 행동을 그대로 넣어 본다 (FINDINGS 19절). */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearchTraced, limitFamilies } from '../src/lib/search.ts'
import { classify, preClassify } from '../src/lib/evidence-state.ts'
import { splitCitations } from '../src/lib/citations.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const C = resolve(HERE, '../public/corpus')
const { chunks, ...meta } = JSON.parse(readFileSync(resolve(C, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(C, 'vectors.json'), 'utf8'))
const raw = readFileSync(resolve(C, 'vectors.bin'))
const corpus = { chunks, vectorMeta, vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) }
const model = MODELS[vectorMeta.modelKey]
const bm25 = buildBm25(chunks.map((c) => `${c.source} ${c.path} ${c.text}`))
const ex = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

const G2 = '소비자 안전을 위한 주의사항은 어떻게 표시해야 하나요?'
const o = await ex([model.query(G2)], { pooling: 'mean', normalize: true })
const { hits: f, trace } = hybridSearchTraced(corpus, new Float32Array(o.data), G2, bm25, 24)
const top = limitFamilies(f, (i) => chunks[i].text).slice(0, 8)
const evidence = top.map((h, i) => ({ label: `S${i + 1}`, chunk: chunks[h.index], hit: h }))
const pre = preClassify(G2, meta, trace.sparseTop5)
const labels = evidence.map((e) => e.label)

// 실측된 세 실행의 인용 행동 (19절 표) + 극단 하나
const cases = [
  ['① 포인터 포함 대괄호 6개', '주의사항은[S1] 이렇게[S2] 한다[S3][S4][S5][S6].'],
  ['② 포인터 빼고 소괄호 6개', '주의사항은 (S3), (S4, S5), (S6), (S7), (S8) 에 따른다.'],
  ['③ 인용 없음', '주의사항은 별표에 따라 표시합니다.'],
  ['④ 포인터만 하나', '주의사항은[S1] 별표 2 에 따른다.'],
]
console.log(`G2 검색 상위 8: ${evidence.map((e) => `${e.label}:${e.chunk.id}`).join(' ')}\n`)
for (const [name, answer] of cases) {
  const v = classify({ pre, evidence, citations: splitCitations(answer, labels), cancelled: false })
  console.log(`${name.padEnd(22)} → ${v.state}`)
  v.why.forEach((w) => console.log(`     · ${w}`))
}
