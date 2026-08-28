/**
 * 청크를 임베딩해 정적 벡터스토어를 만든다.
 *
 * 브라우저는 **질의만** 임베딩한다 (PLAN 결정). 그래서 이 산출물은 커밋 대상이다 —
 * 정적 배포에 필요하고, 키 없는 방문자도 검색·근거까지 쓸 수 있게 하는 근거가 이것이다.
 *
 * 형식: `vectors.bin` = Float32 리틀엔디언 연속 배열 (count × dim), 정규화된 값.
 *       `vectors.json` = 어떤 모델·접두어로 만든 것인지. 브라우저가 이걸 읽어 같은 설정을 쓴다.
 * JSON 에 숫자로 넣지 않는 이유: 365×384 = 14만 개 숫자가 텍스트로는 3MB 가 넘는다.
 *
 * 실행: node scripts/embed-corpus.mjs [모델키]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from '@huggingface/transformers'
import { MODELS, DEFAULT_MODEL } from './embed-models.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, '../public/corpus')

const key = process.argv[2] ?? DEFAULT_MODEL
const model = MODELS[key]
if (!model) {
  console.error(`모델키가 없다: ${key}\n쓸 수 있는 것: ${Object.keys(MODELS).join(', ')}`)
  process.exit(1)
}

const { chunks } = JSON.parse(readFileSync(resolve(CORPUS, 'chunks.json'), 'utf8'))
console.log(`${key} (${model.id}, ${model.dtype}) 로 ${chunks.length} 청크 임베딩`)

const extractor = await pipeline('feature-extraction', model.id, { dtype: model.dtype })

/**
 * **한 건씩** 임베딩한다. 묶어서 넣으면 배치 안에서 가장 긴 글에 맞춰 패딩이 붙고,
 * 그 패딩이 mean pooling 에 섞여 들어간다 — 실측으로 확인했다:
 * 같은 청크를 16개 배치로 넣은 벡터와 단건으로 넣은 벡터의 코사인이 **0.977** 이었다.
 *
 * 즉 배치로 만들면 청크 벡터가 **같은 배치에 우연히 들어간 다른 청크들에 의존**하게 된다.
 * 브라우저는 질의를 언제나 한 건씩 임베딩하므로, 빌드도 한 건씩 해야 같은 공간이 된다.
 * 느리지만(수백 건 수준) 조용히 틀리는 것보다 낫다.
 */
const vectors = []
let dim = 0
for (let i = 0; i < chunks.length; i++) {
  const out = await extractor([model.passage(chunks[i].text)], {
    pooling: 'mean',
    normalize: true,
  })
  dim = out.dims.at(-1)
  vectors.push(new Float32Array(out.data))
  if (i % 20 === 0 || i === chunks.length - 1) {
    process.stdout.write(`\r  ${i + 1}/${chunks.length}`)
  }
}
process.stdout.write('\n')

const flat = new Float32Array(vectors.length * dim)
vectors.forEach((v, i) => flat.set(v, i * dim))
writeFileSync(resolve(CORPUS, 'vectors.bin'), Buffer.from(flat.buffer))

// 검증용으로 청크 하나를 지목해 둔다. 브라우저가 이 청크를 다시 임베딩해
// 저장된 벡터와 코사인 ≈ 1 인지 본다 — 같은 공간인지 확인하는 유일한 방법이다
const probeIndex = Math.floor(chunks.length / 2)

writeFileSync(
  resolve(CORPUS, 'vectors.json'),
  `${JSON.stringify(
    {
      modelKey: key,
      modelId: model.id,
      dtype: model.dtype,
      approxMB: model.approxMB,
      dim,
      count: chunks.length,
      pooling: 'mean',
      normalized: true,
      // 브라우저가 질의에 붙일 접두어. 문서 접두어는 검증에만 쓴다
      queryPrefix: model.query(''),
      passagePrefix: model.passage(''),
      probe: { index: probeIndex, id: chunks[probeIndex].id },
      builtAt: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  )}\n`,
)

const mb = (flat.byteLength / 1024 / 1024).toFixed(2)
console.log(`완료 — ${chunks.length} × ${dim}차원, vectors.bin ${mb}MB`)

// 재현성 자체 점검. 같은 글을 다시 넣어 저장된 벡터가 나오지 않으면 벡터스토어가
// 결정적이지 않다는 뜻이고, 브라우저의 동일 공간 검증도 통과할 수 없다.
// 배치 패딩 같은 문제가 조용히 다시 들어오는 것을 여기서 막는다
const again = await extractor([model.passage(chunks[probeIndex].text)], {
  pooling: 'mean',
  normalize: true,
})
let self = 0
for (let d = 0; d < dim; d++) self += again.data[d] * flat[probeIndex * dim + d]
console.log(`재현성 점검 — [${probeIndex}] ${chunks[probeIndex].id} 코사인 ${self.toFixed(6)}`)
if (self < 0.9999) {
  console.error('재현되지 않는다. 이 벡터스토어는 쓸 수 없다')
  process.exit(1)
}
