/** 코퍼스와 벡터스토어를 읽는다. 둘은 같은 순서를 공유한다 — 인덱스가 곧 대응 관계다. */

export type Chunk = {
  id: string
  source: string
  sourceKind: string
  lawName: string
  path: string
  text: string
  url: string
  effectiveDate: string
  inForce: boolean
}

export type CorpusMeta = {
  collectedAt: string
  today: string
  outOfScope: { topic: string; owner: string }[]
}

export type VectorMeta = {
  modelKey: string
  modelId: string
  dtype: 'q8' | 'q4' | 'fp32'
  /** 브라우저가 첫 접속에 받는 대략 크기(MB). 화면에 그대로 쓴다 */
  approxMB: number
  dim: number
  count: number
  pooling: 'mean'
  normalized: boolean
  queryPrefix: string
  passagePrefix: string
  probe: { index: number; id: string }
  builtAt: string
}

export type Corpus = {
  chunks: Chunk[]
  meta: CorpusMeta
  vectors: Float32Array
  vectorMeta: VectorMeta
}

// base: './' 로 빌드하므로 자료도 상대 경로로 받는다 (모노리포 → Pages 하위 경로)
const url = (name: string) => new URL(`corpus/${name}`, document.baseURI).href

export async function loadCorpus(): Promise<Corpus> {
  const [corpusRes, metaRes, binRes] = await Promise.all([
    fetch(url('chunks.json')),
    fetch(url('vectors.json')),
    fetch(url('vectors.bin')),
  ])
  for (const r of [corpusRes, metaRes, binRes]) {
    if (!r.ok) throw new Error(`자료를 받지 못했다: ${r.url} (${r.status})`)
  }

  const { chunks, ...meta } = await corpusRes.json()
  const vectorMeta: VectorMeta = await metaRes.json()
  const vectors = new Float32Array(await binRes.arrayBuffer())

  // 벡터스토어와 청크가 어긋나면 검색 결과가 조용히 엉뚱한 조문을 가리킨다.
  // 조용히 틀리는 것이 이 제품에서 가장 나쁜 실패이므로 여기서 멈춘다
  if (chunks.length !== vectorMeta.count) {
    throw new Error(`청크 ${chunks.length}개인데 벡터는 ${vectorMeta.count}개다 — 벡터스토어를 다시 만들어야 한다`)
  }
  if (vectors.length !== vectorMeta.count * vectorMeta.dim) {
    throw new Error(`vectors.bin 크기가 ${vectorMeta.count}×${vectorMeta.dim}과 맞지 않는다`)
  }

  return { chunks, meta: meta as CorpusMeta, vectors, vectorMeta }
}
