/** FINDINGS 19절 결정용 — 「인용된 포인터」 대신 「실린 포인터」로 규칙을 넓히면
 *  근거약함이 얼마나 더 자주 뜨는가. 엔진을 부르지 않는다 (검색만 결정적으로 본다). */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearchTraced, limitFamilies } from '../src/lib/search.ts'
import { isPointerOnly, preClassify } from '../src/lib/evidence-state.ts'
import { EVAL_SET } from './eval-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const C = resolve(HERE, '../public/corpus')
const { chunks, ...meta } = JSON.parse(readFileSync(resolve(C, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(C, 'vectors.json'), 'utf8'))
const raw = readFileSync(resolve(C, 'vectors.bin'))
const corpus = { chunks, vectorMeta, vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) }
const model = MODELS[vectorMeta.modelKey]
const bm25 = buildBm25(chunks.map((c) => `${c.source} ${c.path} ${c.text}`))
const ex = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

const G = [
  ['G1', '부당한 표시·광고를 하면 어떤 처벌을 받나요?'],
  ['G2', '소비자 안전을 위한 주의사항은 어떻게 표시해야 하나요?'],
  ['G3', '막걸리 라벨에 도수랑 원재료를 어떻게 적어야 하나요?'],
]
const rows = [...EVAL_SET.map((q) => [q.id, q.question]), ...G]

console.log(`포인터 청크 ${chunks.filter(isPointerOnly).length}개 / 전체 ${chunks.length}개\n`)
let hitCount = 0, gen = 0
for (const [id, q] of rows) {
  const o = await ex([model.query(q)], { pooling: 'mean', normalize: true })
  const { hits: f, trace } = hybridSearchTraced(corpus, new Float32Array(o.data), q, bm25, 24)
  const top = limitFamilies(f, (i) => chunks[i].text).slice(0, 8)
  const pre = preClassify(q, meta, trace.sparseTop5)
  const ptr = top.map((h, i) => [i + 1, chunks[h.index]]).filter(([, c]) => isPointerOnly(c))
  if (!pre.refuse) { gen++; if (ptr.length) hitCount++ }
  console.log(
    `${id.padEnd(3)} ${(pre.refuse ?? '진행').padEnd(5)} 실린 포인터 ${String(ptr.length).padStart(2)}개` +
    (ptr.length ? ` — ${ptr.map(([r, c]) => `S${r}:${c.id}`).join(' ')}` : ''),
  )
}
console.log(`\n생성으로 넘어가는 ${gen}개 중 ${hitCount}개가 포인터를 싣고 있다`)
