/** D8 후보 고르기 — 검색과 범위 판정만 돌린다 (엔진을 안 부른다) */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS } from './embed-models.mjs'
import { buildBm25 } from '../src/lib/bm25.ts'
import { hybridSearchTraced, limitFamilies } from '../src/lib/search.ts'
import { preClassify } from '../src/lib/evidence-state.ts'
import { lawLink } from '../src/lib/evidence.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const C = resolve(HERE, '../public/corpus')
const { chunks, ...meta } = JSON.parse(readFileSync(resolve(C, 'chunks.json'), 'utf8'))
const vectorMeta = JSON.parse(readFileSync(resolve(C, 'vectors.json'), 'utf8'))
const raw = readFileSync(resolve(C, 'vectors.bin'))
const corpus = { chunks, vectorMeta, vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) }
const model = MODELS[vectorMeta.modelKey]
const bm25 = buildBm25(chunks.map((c) => `${c.source} ${c.path} ${c.text}`))
const ex = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

for (const q of process.argv.slice(2)) {
  const o = await ex([model.query(q)], { pooling: 'mean', normalize: true })
  const { hits: f, trace } = hybridSearchTraced(corpus, new Float32Array(o.data), q, bm25, 24)
  const top = limitFamilies(f, (i) => chunks[i].text).slice(0, 8)
  const pre = preClassify(q, meta, trace.sparseTop5)
  const exact = top.filter((h) => lawLink(chunks[h.index]).exact)
  console.log(`\n■ ${q}`)
  console.log(`  판정 ${pre.refuse ?? '진행'}${pre.partial ? ' (일부범위밖)' : ''} · 희소상위5 ${trace.sparseTop5.toFixed(1)}`)
  console.log(`  조문링크 정확 ${exact.length}/${top.length}`)
  top.slice(0, 3).forEach((h, i) => {
    const c = chunks[h.index]
    console.log(`   S${i + 1} ${lawLink(c).exact ? '🔗' : '  '} ${c.source} ${c.path} (코사인 ${h.dense.toFixed(3)})`)
  })
  if (pre.outside.length) console.log(`  안내: ${pre.outside.map((x) => `${x.topic}→${x.owner}`).join(' · ')}`)
}
