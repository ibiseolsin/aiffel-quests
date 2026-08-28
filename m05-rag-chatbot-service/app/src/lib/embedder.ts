import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import type { VectorMeta } from './corpus.ts'

/**
 * 브라우저는 **질의만** 임베딩한다. 청크 벡터는 빌드 시 만들어 정적 파일로 온다.
 * 그래서 API 키가 없는 방문자도 질문 → 조문 검색 → 근거 확인까지 쓸 수 있다.
 *
 * 빌드와 같은 것을 써야 하는 것 넷: **모델 · dtype · pooling · 접두어.**
 * 하나라도 다르면 두 벡터는 다른 공간에 있고 코사인 값이 뜻을 잃는다.
 * 그래서 넷 모두 `vectors.json` 에서 읽는다 — 코드에 다시 적지 않는다.
 */

// 로컬 모델 폴더를 찾지 않는다 (없으면 404 를 한 번씩 맞고 느려진다)
env.allowLocalModels = false

export type LoadProgress = {
  /** 0~1. 파일별 진행을 합친 값 */
  ratio: number
  loadedBytes: number
  totalBytes: number
  files: number
  done: boolean
}

type ProgressEvent = {
  status: string
  file?: string
  loaded?: number
  total?: number
}

let cached: Promise<FeatureExtractionPipeline> | null = null

/**
 * 모델을 받아 둔다. 두 번째 호출부터는 같은 것을 돌려준다.
 * 파일은 브라우저 Cache API 에 남으므로 재접속 시 다운로드가 없다 —
 * 진행률이 실제로 보이는 것은 캐시를 지운 첫 접속뿐이다 (A8 확인 방법).
 */
export function loadEmbedder(
  meta: VectorMeta,
  onProgress?: (p: LoadProgress) => void,
): Promise<FeatureExtractionPipeline> {
  if (cached) return cached

  // 파일마다 따로 오는 진행 이벤트를 합쳐 하나의 비율로 만든다
  const seen = new Map<string, { loaded: number; total: number }>()
  const report = (done: boolean) => {
    let loaded = 0
    let total = 0
    for (const v of seen.values()) {
      loaded += v.loaded
      total += v.total
    }
    onProgress?.({
      ratio: total > 0 ? Math.min(1, loaded / total) : 0,
      loadedBytes: loaded,
      totalBytes: total,
      files: seen.size,
      done,
    })
  }

  cached = pipeline('feature-extraction', meta.modelId, {
    dtype: meta.dtype,
    progress_callback: (e: unknown) => {
      const ev = e as ProgressEvent
      if (!ev.file || typeof ev.total !== 'number') return
      if (ev.status === 'progress' || ev.status === 'download') {
        seen.set(ev.file, { loaded: ev.loaded ?? 0, total: ev.total })
        report(false)
      } else if (ev.status === 'done') {
        seen.set(ev.file, { loaded: ev.total, total: ev.total })
        report(false)
      }
    },
  }).then((p) => {
    report(true)
    return p as FeatureExtractionPipeline
  })

  // 실패하면 다음 시도에서 다시 받을 수 있게 캐시를 비운다
  cached.catch(() => {
    cached = null
  })
  return cached
}

async function embed(
  extractor: FeatureExtractionPipeline,
  text: string,
  meta: VectorMeta,
): Promise<Float32Array> {
  const out = await extractor([text], { pooling: meta.pooling, normalize: meta.normalized })
  const dim = out.dims.at(-1) as number
  if (dim !== meta.dim) throw new Error(`모델이 ${dim}차원을 냈는데 스토어는 ${meta.dim}차원이다`)
  return new Float32Array(out.data as Float32Array)
}

/** 질의 임베딩. 접두어는 스토어가 기록한 것을 쓴다 */
export function embedQuery(
  extractor: FeatureExtractionPipeline,
  text: string,
  meta: VectorMeta,
): Promise<Float32Array> {
  return embed(extractor, meta.queryPrefix + text, meta)
}

/** 청크 임베딩 — **동일 공간 검증에만** 쓴다. 평소에 브라우저가 할 일이 아니다 */
export function embedPassage(
  extractor: FeatureExtractionPipeline,
  text: string,
  meta: VectorMeta,
): Promise<Float32Array> {
  return embed(extractor, meta.passagePrefix + text, meta)
}
