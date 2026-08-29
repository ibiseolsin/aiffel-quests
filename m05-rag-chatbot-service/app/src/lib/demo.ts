/**
 * S12 — **키 없는 방문자용 녹화 데모.** 재생 쪽.
 *
 * 이 앱은 검색까지는 브라우저 안에서 돌지만 답변에는 키가 필요하다(Gemini). 로컬 Ollama 는
 * 배포본에서 막힌다(FINDINGS 9절). 그래서 처음 온 사람은 파이프라인 절반에서 끊긴다.
 * 녹화본은 그 절반을 **실제로 받았던 응답으로** 채운다.
 *
 * **재생은 화면을 흉내 내지 않는다.** 근거·상태·판정을 녹화본에서 베껴 그리는 대신,
 * 검색 결과와 답변 글자만 원래 자리에 넣고 **나머지는 앱의 평소 코드가 다시 계산한다**.
 * 그래야 데모가 「이렇게 보였다」가 아니라 「이 코드가 이렇게 한다」의 증거가 된다.
 * 다시 계산한 상태가 녹화 당시와 다르면 그건 코드가 바뀐 것이고, 화면이 그렇다고 말한다.
 */
import type { Chunk, Corpus } from './corpus.ts'
import type { HybridHit, SearchTrace, Via } from './search.ts'
import type { EvidenceState, PreVerdict } from './evidence-state.ts'

export type DemoEntry = {
  slug: string
  question: string
  state: EvidenceState
  engine: string
  model: string
  recordedAt: string
  corpusChunks: number
  /** 거절 녹화는 엔진을 부르지 않았다 — 재생도 토큰을 흘리지 않는다 */
  calledEngine: boolean
}

export type Recording = {
  version: number
  slug: string
  question: string
  recordedAt: string
  corpusChunks: number
  engine: string
  model: string
  stageInput: {
    trace: SearchTrace
    ranked: number
    kept: number
    loaded: number
    embedMs: number
    dim: number
  }
  pre: PreVerdict
  evidence: {
    label: string
    chunkId: string
    score: number
    dense: number
    sparse: number
    via: Via
    denseRank: number | null
    sparseRank: number | null
  }[]
  answer: string
  /** 토큰이 **도착한 시각**. 재생이 이 간격을 그대로 쓴다 */
  tokens: { ms: number; s: string }[]
  firstTokenMs: number | null
  totalMs: number | null
  verdict: { state: EvidenceState; why: string[]; limits: string[] }
  judgement: { ok: true; verdict: unknown; ms: number; model: string } | null
}

// corpus.ts 와 같은 규칙 — base: './' 로 빌드하므로 문서 기준 상대 경로로 받는다
const url = (name: string) => new URL(`demo/${name}`, document.baseURI).href

export async function loadDemoIndex(): Promise<DemoEntry[]> {
  const r = await fetch(url('index.json'))
  if (!r.ok) throw new Error(`녹화 목록을 읽지 못했습니다 (${r.status})`)
  return ((await r.json()) as { demos: DemoEntry[] }).demos
}

export async function loadDemo(slug: string): Promise<Recording> {
  const r = await fetch(url(`${encodeURIComponent(slug)}.json`))
  if (!r.ok) throw new Error(`녹화를 읽지 못했습니다 (${r.status})`)
  return (await r.json()) as Recording
}

export class StaleDemoError extends Error {}

/**
 * 녹화본의 청크 **ID** 를 지금 코퍼스의 인덱스로 되돌린다.
 *
 * ID 로 적어 둔 이유가 여기서 값을 한다 — 코퍼스를 다시 만들어 순서가 밀렸다면 인덱스는
 * 조용히 엉뚱한 조문을 가리키지만, ID 는 **없으면 없다고 걸린다.** 하나라도 못 찾으면
 * 재생을 거절한다. 어긋난 근거로 「이게 그때 그 조문입니다」라고 말하는 쪽이 훨씬 나쁘다.
 */
export function resolveHits(rec: Recording, corpus: Corpus): HybridHit[] {
  const index = new Map<string, number>()
  corpus.chunks.forEach((c: Chunk, i: number) => index.set(c.id, i))

  return rec.evidence.map((e) => {
    const i = index.get(e.chunkId)
    if (i === undefined) {
      throw new StaleDemoError(
        `녹화본의 조문 ${e.chunkId} 가 지금 코퍼스에 없습니다. 코퍼스가 바뀐 뒤 녹화를 다시 뜨지 않은 것입니다 — 틀린 근거를 보여 주느니 재생하지 않습니다.`,
      )
    }
    return {
      index: i,
      score: e.score,
      dense: e.dense,
      sparse: e.sparse,
      via: e.via,
      denseRank: e.denseRank,
      sparseRank: e.sparseRank,
    }
  })
}

/**
 * 녹화된 타임라인대로 토큰을 흘린다. `onToken` 은 재생 중 여러 번, `onDone` 은 한 번.
 * 돌려주는 함수를 부르면 중간에 멈춘다 (나가기 버튼과 언마운트가 쓴다).
 *
 * **속도를 올리지 않는다.** 8.7초를 2초로 줄이면 방문자가 보는 것은 이 앱의 응답 속도가
 * 아니게 된다. 첫 글자까지 걸린 시간이 이 제품에서 실제로 아픈 지점이라 더 그렇다.
 */
export function playTokens(
  rec: Recording,
  onToken: (s: string) => void,
  onDone: () => void,
): () => void {
  let i = 0
  let timer = 0
  let stopped = false
  const t0 = performance.now()

  const step = () => {
    if (stopped) return
    const now = performance.now() - t0
    // 한 번 깨어난 김에 그때까지 도착했어야 할 토큰을 모두 낸다 — 타이머가 밀려도
    // 글자가 밀리지 않는다
    while (i < rec.tokens.length && rec.tokens[i].ms <= now) onToken(rec.tokens[i++].s)
    if (i >= rec.tokens.length) return onDone()
    timer = window.setTimeout(step, Math.max(0, rec.tokens[i].ms - (performance.now() - t0)))
  }

  if (!rec.tokens.length) {
    // 거절 녹화 — 흘릴 것이 없다
    onDone()
    return () => {}
  }
  timer = window.setTimeout(step, rec.tokens[0].ms)
  return () => {
    stopped = true
    window.clearTimeout(timer)
  }
}
