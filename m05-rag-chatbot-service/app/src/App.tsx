import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { loadCorpus, type Chunk, type Corpus } from './lib/corpus.ts'
import { embedPassage, embedQuery, loadEmbedder, type LoadProgress } from './lib/embedder.ts'
import { buildBm25, type Bm25Index } from './lib/bm25.ts'
import {
  API_FLAVOR_LABEL,
  DEFAULT_LOCATION,
  ENGINE_DEFAULTS,
  ENGINE_LABEL,
  EngineError,
  generate,
  geminiStatus,
  localEngineWarning,
  OLLAMA_BASE,
  OLLAMA_COLD_MS,
  ollamaStatus,
  probeOllama,
  warmOllama,
  type ApiFlavor,
  type EngineKind,
  type EngineStatus,
  type OllamaProbe,
  type StatusLevel,
} from './lib/engine.ts'
import {
  describeServiceAccount,
  parseServiceAccount,
  type ServiceAccount,
} from './lib/google-auth.ts'
import {
  clearFeedback,
  FeedbackError,
  forQuestion,
  loadFeedback,
  saveVote,
  VOTE_LABEL,
  whenLabel,
  type Evidence,
  type FeedbackRecord,
  type Vote,
} from './lib/feedback.ts'
import { buildPrompt } from './lib/prompt.ts'
import { splitCitations } from './lib/citations.ts'
import { isFutureEffective, locationLabel } from './lib/evidence.ts'
import {
  classify,
  preClassify,
  refusalText,
  STATE_HINT,
  type EvidenceState,
  type PreVerdict,
} from './lib/evidence-state.ts'
import { judge, ruleVerdicts, type JudgeOutcome, type RuleVerdict } from './lib/judge.ts'
import {
  loadDemo,
  loadDemoIndex,
  playTokens,
  resolveHits,
  type DemoEntry,
  type Recording,
} from './lib/demo.ts'
import { EvidenceModal, type EvidenceView } from './components/EvidenceModal.tsx'
import { SourceChips } from './components/SourceChips.tsx'
import {
  cosine,
  hybridSearchTraced,
  limitFamilies,
  storedVector,
  type HybridHit,
  type SearchTrace,
  type Via,
} from './lib/search.ts'

/**
 * S3·S4·S5 — 벡터스토어, 브라우저 질의 임베딩, 하이브리드 검색, 답변 생성.
 *
 * 여기까지는 **엔진(LLM) 없이** 돈다. 화면에 나오는 것은 검색 결과와 점수뿐이고,
 * 답변 생성은 S5 부터다. 순서를 이렇게 둔 이유는 근거 검색이 이 제품의 핵심이라서다 —
 * 검색이 틀리면 답변이 아무리 매끄러워도 쓸모가 없다.
 *
 * 근거마다 **어느 경로로 들어왔는지**를 화면에 드러낸다. 하이브리드를 붙인 이유가
 * 조문 번호 질문이었으므로, 그게 실제로 BM25 경로로 잡히는지 사용자도 볼 수 있어야 한다.
 */

const TOP_K = 8

const EXAMPLES = [
  '알레르기 유발물질은 어떻게 표시해야 하나요?',
  '"무첨가"라고 강조해서 표시해도 되나요?',
  '자율심의를 받아야 하는 광고는 어디까지인가요?',
  // 조문 번호를 그대로 묻는 질문. BM25 경로로 잡히는 것을 화면에서 볼 수 있다
  '제8조 제1항 제3호가 무슨 내용인가요?',
  '시행규칙 제6조 제2항 제3호에 뭐가 적혀 있나요?',
]

const VIA_LABEL: Record<Via, string> = {
  dense: '의미 검색',
  sparse: '표기 검색',
  both: '의미+표기',
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`

/** 키를 이 브라우저에 남길지는 사용자가 정한다. 기본은 남기지 않는다 */
const KEY_STORE = 'm05.geminiKey'
/** 창구·모델·리전은 민감하지 않으므로 그냥 기억한다 — 매번 다시 고르게 할 이유가 없다.
 *  **서비스 계정 JSON 은 저장하지 않는다** — 개인키가 들어 있다 (google-auth.ts 주석) */
const FLAVOR_STORE = 'm05.apiFlavor'
const MODEL_STORE = 'm05.geminiModel'
const LOCATION_STORE = 'm05.vertexLocation'

type Answer = {
  /** 이 답변을 낳은 질문. 입력창은 그새 바뀔 수 있으므로 답변이 스스로 들고 있어야 한다 */
  question: string
  text: string
  /** 이 답변이 어느 근거를 받고 쓰였는지. 근거가 바뀐 뒤에도 답변은 그대로 남아야 한다 */
  labels: string[]
  /** 라벨이 가리키는 실제 조문. 피드백 기록(S10)이 이걸 같이 남긴다 — 라벨만으로는
   *  나중에 「무엇을 보고 그렇게 눌렀는지」가 복원되지 않는다 */
  evidence: Evidence[]
  engine: EngineKind
  model: string
  done: boolean
  cancelled: boolean
  firstTokenMs: number | null
  totalMs: number | null
}

type Probe = { cosine: number; ok: boolean } | null

/**
 * S6 — 검색이 거쳐 온 단계. PRD 5절의 「[검색 단계] n개 조문 검색됨 · 방식」이다.
 *
 * 결과만 보여 주면 사용자는 상위 8개가 **어디서 왔는지** 모른다. 하이브리드를 붙인 이유가
 * 두 경로였으므로, 두 경로가 각각 몇 개를 보고 병합에서 몇이 남았는지가 화면에 있어야
 * 파이프라인이 관찰된다 (평가 문항 3).
 */
type Stage = { title: string; detail: string }

function searchStages(
  trace: SearchTrace,
  ranked: number,
  kept: number,
  loaded: number,
  embedMs: number,
  dim: number,
): Stage[] {
  return [
    {
      title: '질의 임베딩',
      detail: `질문을 ${dim}차원 벡터로 (브라우저 안에서, ${embedMs.toFixed(0)}ms)`,
    },
    {
      title: '의미 검색',
      detail: `조문 ${trace.corpusSize}개와 코사인 비교 → 상위 ${trace.denseFound}개 후보`,
    },
    {
      title: '표기 검색',
      detail: `BM25 로 표기가 겹치는 조문 → 상위 ${trace.sparseFound}개 후보 (한글 2-gram)`,
    },
    {
      title: '병합',
      detail: `각 경로의 최고점으로 정규화한 뒤 가중합 (표기 ${trace.sparseWeight}) → 서로 다른 ${trace.merged}개, 그중 ${trace.both}개는 두 경로 모두에서`,
    },
    {
      title: '형제 무리 제한',
      detail:
        ranked === kept
          ? `앞머리가 같은 조문이 없어 ${kept}개 그대로`
          : `앞 150자를 공유하는 무리는 2개까지 → ${ranked}개에서 ${ranked - kept}개 제외`,
    },
    { title: '프롬프트 적재', detail: `상위 ${loaded}개를 [S1]~[S${loaded}] 로 실었습니다` },
  ]
}

/**
 * S9 — 연결 상태 배지. **색만으로 말하지 않는다** (색을 못 보는 사람이 있고, 「연결됨」과
 * 「미확인」의 차이가 이 제품에서는 중요하다). 그래서 모양·글자·색 셋이 같은 말을 한다.
 */
const LEVEL_MARK: Record<StatusLevel, string> = {
  ok: '●',
  warn: '◐',
  bad: '○',
  checking: '◌',
  unknown: '○',
}

function StatusBadge({ status }: { status: EngineStatus }) {
  return (
    <span className={`conn conn-${status.level}`}>
      <span aria-hidden="true">{LEVEL_MARK[status.level]}</span>
      {status.label}
    </span>
  )
}

/**
 * 마운트된 순간부터 흐르는 경과 시간. **43초의 침묵을 고장으로 읽지 않게 하는 것**이
 * 유일한 목적이므로 값은 실제로 흘러야 한다 (가짜 진행률을 그리지 않는다).
 *
 * 별도 컴포넌트로 뺀 이유: 이 물건은 쓰이는 동안만 살아 있어야 한다. 부모의 상태로
 * 들고 있으면 다음 대기의 첫 프레임에 지난번 숫자가 잠깐 보이고, 시간 표시에서 그건 거짓이다.
 */
function Elapsed({ children }: { children: (ms: number) => React.ReactNode }) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    const t0 = performance.now()
    const id = window.setInterval(() => setMs(performance.now() - t0), 200)
    return () => window.clearInterval(id)
  }, [])
  return <>{children(ms)}</>
}

/**
 * S7 — 근거 상태 배지. 다섯 단계를 **색만으로 말하지 않는다**: 기호·글자·색이 같은 말을 한다.
 * 「근거 충분」과 「근거 약함」의 차이가 이 제품에서 가장 중요한 차이이기 때문이다.
 */
const STATE_MARK: Record<EvidenceState, string> = {
  근거충분: '✓',
  근거약함: '⚠',
  일부범위밖: '◐',
  코퍼스밖: '○',
  규범밖: '—',
}

const STATE_CLASS: Record<EvidenceState, string> = {
  근거충분: 'st-ok',
  근거약함: 'st-warn',
  일부범위밖: 'st-partial',
  코퍼스밖: 'st-out',
  규범밖: 'st-none',
}

/** 규칙 판정 한 줄. **각진 상자**로 그린다 — 옆의 LLM 알약과 모양이 달라야 한다 */
function RuleChip({ name, v }: { name: string; v: RuleVerdict }) {
  const mark = v.pass === true ? '✓' : v.pass === false ? '✗' : '–'
  const cls = v.pass === true ? 'rule-ok' : v.pass === false ? 'rule-bad' : 'rule-na'
  return (
    <p className="rule-line">
      <span className={`rule ${cls}`}>
        <span aria-hidden="true">{mark}</span> {name} — {v.label}
      </span>
      <span className="muted small">{v.detail}</span>
    </p>
  )
}

function StateBadge({ state }: { state: EvidenceState }) {
  return (
    <span className={`state ${STATE_CLASS[state]}`}>
      <span aria-hidden="true">{STATE_MARK[state]}</span> {state}
    </span>
  )
}

/** 콜드 스타트 실측값을 눈금으로 쓴 진행 막대. **예상이고 상한이 아니다** */
function ColdBar({ ms }: { ms: number }) {
  const ratio = Math.min(ms / OLLAMA_COLD_MS, 1)
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(ratio * 100)}>
      <div className="bar-fill" style={{ width: `${ratio * 100}%` }} />
    </div>
  )
}

export default function App() {
  const [corpus, setCorpus] = useState<Corpus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<HybridHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [probe, setProbe] = useState<Probe>(null)
  const started = useRef(false)

  // ── S6: 출처 공개 ──────────────────────────────────────────────────────────
  const [stages, setStages] = useState<Stage[] | null>(null)
  /** 열려 있는 근거 모달. `null` 이면 닫혀 있다 */
  const [evidenceView, setEvidenceView] = useState<EvidenceView | null>(null)

  // ── S7: 근거 상태 5단 ─────────────────────────────────────────────────────
  /** 답을 만들기 전의 범위 판정. **엔진을 부르지 않고** 검색 결과와 문구만으로 낸다 */
  const [scope, setScope] = useState<PreVerdict | null>(null)

  // ── S8: LLM 근거성 판정 ───────────────────────────────────────────────────
  const [judgment, setJudgment] = useState<JudgeOutcome | null>(null)
  const [judging, setJudging] = useState(false)
  /** 어느 답변을 판정했는지. 답변이 바뀌면 지난 판정이 남아 있으면 안 된다 */
  const judgedFor = useRef<string | null>(null)
  const judgeAbort = useRef<AbortController | null>(null)

  // 기본은 Gemini (결정 D5). 방문자는 Ollama 를 깔고 있지 않다 —
  // 링크만 받은 사람에게 더 가벼운 준비를 요구하는 쪽이 기본이어야 한다
  const [engine, setEngine] = useState<EngineKind>('gemini')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORE) ?? '')
  const [rememberKey, setRememberKey] = useState(() => !!localStorage.getItem(KEY_STORE))
  const [flavor, setFlavor] = useState<ApiFlavor>(
    () => (localStorage.getItem(FLAVOR_STORE) as ApiFlavor) || ENGINE_DEFAULTS.gemini.flavor!,
  )
  const [geminiModel, setGeminiModel] = useState(
    () => localStorage.getItem(MODEL_STORE) || ENGINE_DEFAULTS.gemini.model,
  )
  const [location_, setLocation] = useState(
    () => localStorage.getItem(LOCATION_STORE) || DEFAULT_LOCATION,
  )
  // 새로고침하면 사라진다. 개인키를 브라우저 저장소에 남기지 않기 위해 일부러 그렇게 둔다
  const [serviceAccount, setServiceAccount] = useState<ServiceAccount | null>(null)
  const [saError, setSaError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [engineError, setEngineError] = useState<{ message: string; hint?: string } | null>(null)
  const abort = useRef<AbortController | null>(null)

  const [bm25, setBm25] = useState<Bm25Index | null>(null)

  // ── S12: 녹화 데모 ────────────────────────────────────────────────────────
  /** 재생 중인 녹화. `null` 이면 평소 화면이다. **키 없이 볼 수 있는 유일한 답변 경로** */
  const [demo, setDemo] = useState<Recording | null>(null)
  const [demoList, setDemoList] = useState<DemoEntry[] | null>(null)
  const [demoError, setDemoError] = useState<string | null>(null)
  const demoStop = useRef<(() => void) | null>(null)

  /**
   * 지금 고른 엔진의 설정. **답변 생성과 판정이 같은 것을 본다** — PRD 3절 F5 가
   * 「LLM 판정은 현재 선택된 엔진으로 돌린다」이고, 두 벌로 두면 화면이 말하는 엔진과
   * 실제로 부른 엔진이 조용히 갈릴 수 있다.
   */
  const engineConfig = useMemo(
    () =>
      engine === 'gemini'
        ? {
            ...ENGINE_DEFAULTS.gemini,
            apiKey,
            flavor,
            model: geminiModel.trim(),
            serviceAccount: serviceAccount ?? undefined,
            location: location_,
          }
        : { ...ENGINE_DEFAULTS.ollama },
    [engine, apiKey, flavor, geminiModel, serviceAccount, location_],
  )

  // ── S10: 사람 피드백 ────────────────────────────────────────────────────────
  // 첫 렌더에서 바로 읽는다 — 새로고침 직후에도 「남긴 피드백」이 보여야 하고,
  // 그게 브라우저 로컬 저장의 요점이다
  const [log, setLog] = useState<FeedbackRecord[]>(() => loadFeedback())
  /** 지금 보고 있는 답변에 남긴 평가의 id. 👍 → 👎 는 새 기록이 아니라 정정이다 */
  const [voteId, setVoteId] = useState<string | null>(null)
  const [fbError, setFbError] = useState<string | null>(null)
  /** 지우기는 되돌릴 수 없다. `confirm()` 대신 화면 안에서 두 번 누르게 한다 */
  const [confirmClear, setConfirmClear] = useState(false)

  // ── S9: 연결 상태와 콜드 스타트 ───────────────────────────────────────────
  const [ollamaProbe, setOllamaProbe] = useState<OllamaProbe | null>(null)
  const [ollamaFail, setOllamaFail] = useState<{ message: string; hint?: string } | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const [warming, setWarming] = useState(false)
  const [warmNote, setWarmNote] = useState<string | null>(null)
  const warmAbort = useRef<AbortController | null>(null)

  const ollamaModel = ENGINE_DEFAULTS.ollama.model

  const checkOllama = useCallback(async () => {
    setOllamaChecking(true)
    const r = await probeOllama(OLLAMA_BASE, ollamaModel)
    if (r.ok) {
      setOllamaProbe(r.probe)
      setOllamaFail(null)
    } else {
      setOllamaProbe(null)
      setOllamaFail({ message: r.message, hint: r.hint })
    }
    setOllamaChecking(false)
  }, [ollamaModel])


  // S12 — 녹화 목록. 실패해도 앱은 그대로 돈다 (데모는 덤이다)
  useEffect(() => {
    loadDemoIndex().then(setDemoList, () => setDemoList([]))
  }, [])

  useEffect(() => {
    loadCorpus().then((c) => {
      setCorpus(c)
      // 365개라 브라우저에서 색인해도 순식간이다. 위치 표기를 함께 넣는 것이 핵심 —
      // `제8조①제3호` 가 정규화로 「제8조 제1항 제3호」가 되어 사용자 표기와 만난다
      setBm25(buildBm25(c.chunks.map((x) => `${x.source} ${x.path} ${x.text}`)))
    }, (e: Error) => setError(e.message))
  }, [])

  /** 모델은 사용자가 누를 때 받는다 — 100MB 넘는 것을 묻지 않고 내려받지 않는다 */
  const prepare = async () => {
    if (!corpus || started.current) return
    started.current = true
    try {
      const extractor = await loadEmbedder(corpus.vectorMeta, setProgress)
      setReady(true)

      // 동일 공간 검증 — 저장된 벡터와 지금 만든 벡터가 같은 공간인지 본다.
      // 이걸 건너뛰면 검색이 조용히 무의미해진다 (접두어 하나만 달라도 그렇게 된다)
      const { probe: p } = corpus.vectorMeta
      const v = await embedPassage(extractor, corpus.chunks[p.index].text, corpus.vectorMeta)
      const c = cosine(v, storedVector(corpus, p.index))
      setProbe({ cosine: c, ok: c > 0.99 })
    } catch (e) {
      started.current = false
      setError((e as Error).message)
    }
  }

  const search = async (q: string) => {
    if (!corpus || !bm25 || !q.trim()) return
    // 녹화를 보는 중에 실제 질문을 던지면 재생부터 끝낸다 — 두 화면이 섞이면 안 된다
    if (demo) stopDemo()
    setSearching(true)
    setEngineError(null)
    setAnswer(null)
    setScope(null)
    try {
      const extractor = await loadEmbedder(corpus.vectorMeta)
      const t0 = performance.now()
      const v = await embedQuery(extractor, q.trim(), corpus.vectorMeta)
      const embedMs = performance.now() - t0
      const { hits: found, trace } = hybridSearchTraced(corpus, v, q.trim(), bm25, TOP_K * 3)
      // 앞머리가 같은 형제 청크가 결과를 뒤덮지 않게 무리마다 개수를 제한한다
      const kept = limitFamilies(found, (i) => corpus.chunks[i].text)
      const limited = kept.slice(0, TOP_K)
      setHits(limited)
      setStages(searchStages(trace, found.length, kept.length, limited.length, embedMs, corpus.vectorMeta.dim))
      setElapsed(performance.now() - t0)
      // S7 — 엔진을 부르기 **전에** 범위를 가린다. 범위 밖이면 답을 만들지 않는다
      const pre = preClassify(q.trim(), corpus.meta, trace.sparseTop5)
      setScope(pre)
      return { hits: limited, pre }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  /** 검색 → 프롬프트 → 엔진. 근거 없이 답을 만들지 않는다 */
  const ask = async (q: string) => {
    if (!corpus) return
    const result = await search(q)
    if (!result?.hits.length) return
    const { hits: found, pre } = result

    /* S7 — **코퍼스 밖·규범 밖이면 엔진을 부르지 않는다.**
       모델에게 「범위 밖이라고 말해 줘」를 시키지 않는 이유는 PRD 8절 A3 이다: 그러면
       모델이 다른 법령의 *내용*을 지어내고, 인용 규칙은 그걸 못 잡는다. 범위 안내는
       고정 문자열로만 나간다. 덤으로 **키 없는 방문자도 이 판정까지는 볼 수 있다.** */
    if (pre.refuse) return

    const labelled = found.map((h, i) => ({ chunk: corpus.chunks[h.index], label: `S${i + 1}` }))
    // 새 답변에는 아직 평가가 없다. 앞 답변의 평가가 이어 보이면 그게 거짓이 된다
    setVoteId(null)
    setFbError(null)
    const dates = corpus.chunks.map((c) => c.effectiveDate).sort()
    const prompt = buildPrompt({
      question: q.trim(),
      chunks: labelled,
      meta: corpus.meta,
      effectiveFrom: dates[0],
      effectiveTo: dates.at(-1) ?? dates[0],
      now: new Date(),
    })

    const config = engineConfig

    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller

    const t0 = performance.now()
    let first: number | null = null
    setAnswer({
      question: q.trim(),
      text: '',
      labels: labelled.map((l) => l.label),
      evidence: labelled.map(({ chunk, label }) => ({
        label,
        chunkId: chunk.id,
        source: chunk.source,
        path: chunk.path,
      })),
      engine,
      model: config.model,
      done: false,
      cancelled: false,
      firstTokenMs: null,
      totalMs: null,
    })

    try {
      await generate(
        config,
        prompt,
        (token) => {
          if (first === null) first = performance.now() - t0
          setAnswer((a) =>
            a ? { ...a, text: a.text + token, firstTokenMs: a.firstTokenMs ?? first } : a,
          )
        },
        controller.signal,
      )
      setAnswer((a) =>
        a ? { ...a, done: true, cancelled: controller.signal.aborted, totalMs: performance.now() - t0 } : a,
      )
    } catch (e) {
      if (controller.signal.aborted) {
        setAnswer((a) => (a ? { ...a, done: true, cancelled: true, totalMs: performance.now() - t0 } : a))
      } else if (e instanceof EngineError) {
        setEngineError({ message: e.message, hint: e.hint })
        setAnswer(null)
      } else {
        setEngineError({ message: (e as Error).message })
        setAnswer(null)
      }
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  const cancel = () => {
    abort.current?.abort()
    setAnswer((a) => (a ? { ...a, done: true, cancelled: true } : a))
  }

  /* ── S12: 녹화 데모 ────────────────────────────────────────────────────── */

  /** 재생을 끝내고 평소 화면으로 돌아간다. 녹화가 남긴 화면을 **전부** 치운다 —
   *  근거만 남아 있으면 그 다음 질문의 근거로 읽힌다 */
  const stopDemo = useCallback(() => {
    demoStop.current?.()
    demoStop.current = null
    setDemo(null)
    setAnswer(null)
    setHits(null)
    setStages(null)
    setScope(null)
    setJudgment(null)
    setElapsed(null)
  }, [])

  useEffect(() => () => demoStop.current?.(), [])

  /**
   * 녹화본을 평소 자리에 넣고 토큰을 다시 흘린다.
   *
   * **베껴 그리지 않는다** — 넣는 것은 검색 결과·범위 판정·답변 글자뿐이고, 근거 상태와
   * 규칙 배지는 `verdict`·`rules` 가 평소처럼 다시 계산한다. LLM 판정만 녹화본에서
   * 꺼내 온다 (그건 다시 부를 수 없는 값이라서다).
   */
  const playDemo = async (slug: string) => {
    stopDemo()
    setDemoError(null)
    if (!corpus) return setDemoError('조문 자료를 아직 읽지 못했습니다.')
    try {
      const rec = await loadDemo(slug)
      const found = resolveHits(rec, corpus)
      const { trace, ranked, kept, loaded, embedMs, dim } = rec.stageInput

      setQuery(rec.question)
      setEngineError(null)
      setVoteId(null)
      setFbError(null)
      setHits(found)
      setStages(searchStages(trace, ranked, kept, loaded, embedMs, dim))
      // 녹화는 브라우저가 아니라 Node 스크립트에서 떴다. 검색 총 시간을 여기 넣으면
      // 방문자의 브라우저에서 잰 값처럼 읽히므로 비워 둔다 (배너가 그 사실을 말한다)
      setElapsed(null)
      setScope(rec.pre)
      setDemo(rec)

      // 거절 녹화 — 엔진을 안 불렀으니 재생할 답변도 없다. 화면은 거절 문구를 세운다
      if (rec.pre.refuse) return

      setAnswer({
        question: rec.question,
        text: '',
        labels: rec.evidence.map((e) => e.label),
        evidence: rec.evidence.map((e) => {
          const c = corpus.chunks[found[rec.evidence.indexOf(e)].index]
          return { label: e.label, chunkId: e.chunkId, source: c.source, path: c.path }
        }),
        engine: rec.engine as EngineKind,
        model: rec.model,
        done: false,
        cancelled: false,
        firstTokenMs: null,
        totalMs: null,
      })

      demoStop.current = playTokens(
        rec,
        (t) =>
          setAnswer((a) =>
            a ? { ...a, text: a.text + t, firstTokenMs: a.firstTokenMs ?? rec.firstTokenMs } : a,
          ),
        () => {
          // 타이머가 밀려 토큰을 놓쳤더라도 최종 글자는 녹화본 그대로여야 한다
          setAnswer((a) => (a ? { ...a, text: rec.answer, done: true, totalMs: rec.totalMs } : a))
          if (rec.judgement) setJudgment(rec.judgement as unknown as JudgeOutcome)
        },
      )
    } catch (e) {
      setDemo(null)
      setDemoError((e as Error).message)
    }
  }

  /**
   * S10 — 이 답변에 대한 평가를 남긴다. 서버로 가지 않는다.
   * 같은 답변에 다시 누르면 **정정**이고(기록이 늘지 않는다), 같은 버튼을 다시 누르면 취소가
   * 아니라 그대로다 — 「평가를 지웠다」와 「아직 안 눌렀다」를 구분해 둘 이유가 없다.
   */
  const vote = (v: Vote) => {
    if (!answer) return
    const { ids: cited, invalid } = splitCitations(answer.text, answer.labels)
    try {
      const { list, record } = saveVote({
        id: voteId,
        vote: v,
        question: answer.question,
        answerText: answer.text,
        cancelled: answer.cancelled,
        evidence: answer.evidence,
        cited,
        invalidCited: invalid,
        engine: answer.engine,
        model: answer.model,
        flavor: answer.engine === 'gemini' ? flavor : undefined,
        /* A6 — **누른 순간 화면에 있던 판정**을 같이 남긴다. 나중에 다시 판정하면 그건
           그때의 값이지 사람이 이 표를 눌렀을 때 본 값이 아니다 (S10 이 `cited` 를 남길 때
           같이 계산한 것과 같은 이유) */
        verdicts: verdict
          ? {
              state: verdict.state,
              citationPass: rules?.citation.pass ?? null,
              refusalPass: rules?.refusal.pass ?? null,
              grounded: judgment?.ok ? judgment.verdict.groundedInSources : null,
              hallucinated: judgment?.ok ? judgment.verdict.hallucinated : null,
              scoreOutOf100: judgment?.ok ? judgment.verdict.scoreOutOf100 : null,
              judgeModel: judgment?.ok ? judgment.model : null,
              failed: judgment && !judgment.ok ? judgment.message : null,
            }
          : null,
      })
      setLog(list)
      setVoteId(record.id)
      setFbError(null)
    } catch (e) {
      setFbError(e instanceof FeedbackError ? e.message : (e as Error).message)
    }
  }

  /** 키를 이 브라우저에 남길지 반영한다 */
  const applyRemember = (on: boolean) => {
    setRememberKey(on)
    if (on && apiKey) localStorage.setItem(KEY_STORE, apiKey)
    else localStorage.removeItem(KEY_STORE)
  }

  /** 답변이 흘러오는 중 */
  const busy = !!answer && !answer.done

  /**
   * 누를 때만 확인하면 「현재 엔진의 연결 상태」가 화면에 없는 시간이 생긴다 (수용 기준 A9).
   * 그래서 Ollama 를 고르는 순간 확인하고, 그 뒤로도 주기적으로 다시 본다 —
   * **예열은 시간이 지나면 풀린다**(`keep_alive`). 한 번 본 「예열됨」을 계속 띄우면 거짓이 된다.
   */
  useEffect(() => {
    if (engine !== 'ollama') return
    // 첫 확인을 0ms 뒤로 미루는 이유는 하나다 — 렌더 도중에 상태를 바꾸지 않는 것
    const first = window.setTimeout(checkOllama, 0)
    const id = window.setInterval(() => {
      if (!document.hidden) checkOllama()
    }, 20_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
    // `busy` 가 deps 에 있는 이유: 답변이 끝난 직후 다시 확인해야 한다. 콜드였던 모델이
    // 방금 올라왔는데 배지가 20초 동안 「콜드」로 남아 있으면 화면이 사실보다 늦다
  }, [engine, busy, checkOllama])

  /** 첫 글자가 아직 안 온 구간 — 콜드 스타트가 숨어 있는 곳이 정확히 여기다 */
  const waitingFirst = !!answer && !answer.done && answer.firstTokenMs == null

  /**
   * Gemini 를 「응답 확인됨」으로 올리는 근거는 **화면에 실제로 도착해 있는 답변**이다.
   * 지난 성공을 기억해 두지 않는다 — 키를 바꿨거나 쿼터가 끊긴 뒤에도 「확인됨」이 남으면
   * 그게 바로 이 슬라이스가 없애려던 거짓말이다. 새 질문을 던지면 다시 「미확인」이 된다.
   */
  const geminiAnswered =
    answer?.engine === 'gemini' && !!answer.text && answer.model === geminiModel.trim()

  /** 청크를 ID 로 찾는다. 출처 칩은 답변이 저장해 둔 `chunkId` 로 조문을 되찾는다 —
   *  라벨(`S3`)은 그 답변 안에서만 유효한 이름이라 조문의 신원이 되지 못한다 */
  const chunkById = useMemo(() => {
    const m = new Map<string, Chunk>()
    for (const c of corpus?.chunks ?? []) m.set(c.id, c)
    return m
  }, [corpus])

  /** 지금 화면의 근거가 어느 검색 경로로 몇 위에 들어왔는지. 모달이 이걸 같이 보여 준다 */
  const hitByChunkId = useMemo(() => {
    const m = new Map<string, HybridHit>()
    for (const h of hits ?? []) if (corpus) m.set(corpus.chunks[h.index].id, h)
    return m
  }, [hits, corpus])

  /**
   * 지금 답변의 인용. **화면·피드백·(S8 의) 판정이 같은 값을 본다** — 세 곳이 각자 세면
   * 「인용 S1 S3」과 배지가 조용히 어긋난다 (citations.ts 주석)
   */
  const citations = answer ? splitCitations(answer.text, answer.labels) : null

  /** 출처 칩 항목. 답변이 받은 근거 순서 그대로 두고, 인용 여부만 표시로 가른다 */
  const chipItems = (answer?.evidence ?? []).flatMap((e) => {
    const chunk = chunkById.get(e.chunkId)
    return chunk ? [{ label: e.label, chunk, cited: !!citations?.valid.includes(e.label) }] : []
  })

  /**
   * S7 — 최종 근거 상태. 답이 끝난 뒤에 낸다 (인용을 봐야 하므로).
   * 답이 없고 범위 판정만 있으면 그 판정이 곧 상태다.
   */
  const verdict =
    scope && answer?.done && citations
      ? classify({
          pre: scope,
          evidence: chipItems.map((c) => ({
            label: c.label,
            chunk: c.chunk,
            hit: hitByChunkId.get(c.chunk.id),
          })),
          citations,
          cancelled: answer.cancelled,
        })
      : scope?.refuse
        ? { state: scope.refuse as EvidenceState, why: scope.why, limits: [], outside: scope.outside }
        : null

  /** S8 규칙 층 — 결정적이므로 엔진 없이 즉시 나온다 */
  const rules =
    verdict && citations
      ? ruleVerdicts({ state: verdict.state, citations, cancelled: !!answer?.cancelled })
      : verdict
        ? ruleVerdicts({
            state: verdict.state,
            citations: { ids: [], valid: [], invalid: [], lenient: false },
            cancelled: false,
          })
        : null

  const runJudge = useCallback(async () => {
    if (!answer?.done || !corpus) return
    judgeAbort.current?.abort()
    const controller = new AbortController()
    judgeAbort.current = controller
    setJudging(true)
    const evidence = answer.evidence.flatMap((e) => {
      const chunk = chunkById.get(e.chunkId)
      return chunk ? [{ label: e.label, chunk }] : []
    })
    const out = await judge(
      engineConfig,
      { question: answer.question, answer: answer.text, evidence },
      controller.signal,
    )
    if (controller.signal.aborted) return
    setJudgment(out)
    setJudging(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, corpus, chunkById, engineConfig])

  /**
   * A5 — **모든 응답에 판정 배지가 붙는다.** 그래서 사람이 누르기를 기다리지 않고
   * 답이 끝나는 즉시 돈다. 중단된 답변은 판정하지 않는다 (잴 문장이 온전하지 않다).
   *
   * `judgedFor` 로 한 답변당 한 번만 돈다 — 스트리밍 중 매 토큰마다 부르면 안 되고,
   * 재렌더로 다시 부르면 같은 답에 다른 배지가 붙는다.
   */
  useEffect(() => {
    if (!answer?.done || answer.cancelled || !answer.text) return
    // S12 — 녹화 재생 중에는 엔진을 부르지 않는다. 판정도 녹화본의 값을 쓴다
    if (demo) return
    const key = `${answer.question}::${answer.text.length}::${answer.model}`
    if (judgedFor.current === key) return
    judgedFor.current = key
    setJudgment(null)
    runJudge()
  }, [answer, runJudge, demo])

  /** 새 질문이 시작되면 지난 판정을 지운다 — 앞 답변의 배지가 남으면 그게 거짓이 된다 */
  useEffect(() => {
    if (!answer) {
      judgedFor.current = null
      setJudgment(null)
      setJudging(false)
    }
  }, [answer])

  const openEvidence = (label: string) => {
    const item = chipItems.find((c) => c.label === label)
    if (!item) return
    setEvidenceView({ ...item, hit: hitByChunkId.get(item.chunk.id) })
  }

  /** 지금 답변에 남긴 평가(있으면). 기록 자체를 보여 준다 — 「눌렸다」는 화면 상태가 아니라 저장된 사실이다 */
  const currentVote = voteId ? (log.find((r) => r.id === voteId) ?? null) : null
  /** 같은 질문을 다시 물었을 때 보이는 지난 평가. 지금 평가는 세지 않는다 */
  const priorSame = answer ? forQuestion(log, answer.question, voteId) : null

  /** 예열 — 콜드 43초를 질문 *전에* 치른다 */
  const warmUp = async () => {
    setWarmNote(null)
    setWarming(true)
    const controller = new AbortController()
    warmAbort.current = controller
    const t0 = performance.now()
    try {
      await warmOllama(OLLAMA_BASE, ollamaModel, controller.signal)
      setWarmNote(
        controller.signal.aborted
          ? '예열을 중단했습니다.'
          : `모델을 올렸습니다 · ${((performance.now() - t0) / 1000).toFixed(1)}초 걸렸습니다.`,
      )
    } catch (e) {
      const err = e as EngineError
      setWarmNote(`예열 실패 — ${err.message}${err.hint ? ` (${err.hint})` : ''}`)
    } finally {
      setWarming(false)
      warmAbort.current = null
      checkOllama()
    }
  }

  /** 현재 엔진의 연결 상태. 헤더와 엔진 섹션이 **같은 값**을 본다 */
  const status: EngineStatus =
    engine === 'gemini'
      ? geminiStatus({ flavor, apiKey, serviceAccount, answered: geminiAnswered })
      : ollamaStatus(ollamaProbe, ollamaModel, ollamaFail ?? undefined, ollamaChecking)

  const effective = useMemo(() => {
    if (!corpus) return null
    const dates = corpus.chunks.map((c) => c.effectiveDate).sort()
    return { from: dates[0], to: dates.at(-1) }
  }, [corpus])

  return (
    <div className="page" data-demo={demo ? 'on' : undefined}>
      <header className="header">
        <h1>식품 표시·광고 규정 안내</h1>
        <p className="lede">
          내가 만든 식품을 판매채널에 올릴 때, <strong>표시사항과 광고 문구가 규정에 맞는가</strong>를
          실제 법령 조문을 근거로 답합니다.
        </p>

        <div className="slots">
          {/* A9 — 현재 엔진과 그 연결 상태는 **항상** 보여야 한다. 엔진 섹션이 화면
              밖으로 스크롤돼도 헤더에 남는다 */}
          <span className="slot">
            엔진 — {ENGINE_LABEL[engine]} <StatusBadge status={status} />
          </span>
          {effective && (
            <span className="slot" title="코퍼스에 든 조문의 시행일 범위">
              시행 중 법령 기준 · {effective.from} ~ {effective.to}
            </span>
          )}
          {corpus && (
            <span className="slot">
              {corpus.chunks.length}개 조문 · {corpus.vectorMeta.dim}차원
            </span>
          )}
        </div>

        <p className="disclaimer" role="note">
          <strong>법률 자문이 아닙니다.</strong> 조문을 찾아 보여 주는 안내이며, 개별 제품의
          적법성 최종 판단은 하지 않습니다. 최종 확인은 식품의약품안전처 또는 전문가에게
          받으세요.
        </p>
      </header>

      <main className="main">
        {/* S12 — **재생 중이라는 사실이 화면에서 사라지면 안 된다.** 스크롤을 내려도
            따라오고, 모양·색·글자 셋이 같은 말을 한다 (S9 배지와 같은 원칙) */}
        {demo && (
          <div className="demo-bar" role="status">
            <div>
              <strong>▶ 녹화 데모 재생 중</strong> — 지금 계산하는 것이 아니라{' '}
              <strong>{demo.recordedAt} 에 실제로 받았던 응답</strong>을 그대로 다시 틀고
              있습니다 ({demo.engine} {demo.model}).
              <span className="muted">
                {' '}
                답변 글자와 도착 간격은 녹화 그대로이고, <strong>근거 상태와 규칙 배지는
                지금 이 코드가 다시 계산합니다.</strong> 검색 단계 시간은 녹화를 뜬
                스크립트에서 잰 값이라 화면에 넣지 않았습니다.
              </span>
            </div>
            <button type="button" className="ghost" onClick={stopDemo}>
              나가기
            </button>
          </div>
        )}

        {error && (
          <section className="notice error">
            <h2>자료를 불러오지 못했습니다</h2>
            <p>{error}</p>
          </section>
        )}

        {!ready && !error && (
          <section className="notice">
            <h2>근거 검색 준비</h2>
            <p>
              검색은 <strong>브라우저 안에서</strong> 돌기 때문에 API 키가 필요 없습니다. 대신 처음
              한 번 임베딩 모델을 받아야 합니다
              {corpus && ` (약 ${corpus.vectorMeta.approxMB}MB)`}. 다음 접속부터는 캐시에서
              씁니다.
            </p>
            {progress && !progress.done ? (
              <>
                <div
                  className="bar"
                  role="progressbar"
                  aria-valuenow={Math.round(progress.ratio * 100)}
                >
                  <div className="bar-fill" style={{ width: `${progress.ratio * 100}%` }} />
                </div>
                <p className="muted">
                  {Math.round(progress.ratio * 100)}% · {mb(progress.loadedBytes)} /{' '}
                  {mb(progress.totalBytes)} · 파일 {progress.files}개
                </p>
              </>
            ) : (
              <button className="primary" onClick={prepare} disabled={!corpus}>
                {corpus ? '모델 받고 검색 켜기' : '자료 읽는 중…'}
              </button>
            )}
          </section>
        )}

        {/* S12 — **키가 없어도 볼 수 있는 유일한 답변 경로.** 그래서 모델을 받기 전
            화면에 둔다. 답변 엔진(Gemini)에는 키가 필요하고 로컬 Ollama 는 배포본에서
            막히므로(FINDINGS 9절), 이게 없으면 처음 온 사람은 파이프라인 절반에서 끊긴다 */}
        {!!demoList?.length && !demo && (
          <section className="demo-pick">
            <h2>
              키 없이 보기 <span className="muted">· 녹화 데모 {demoList.length}개</span>
            </h2>
            <p className="muted">
              API 키가 없어도 <strong>질문 → 검색 → 근거 → 답변 → 판정</strong> 전체를 볼 수
              있습니다. 실제로 받았던 응답을 그대로 다시 틀어 주며,{' '}
              <strong>재생 중에는 화면이 눈에 띄게 달라집니다.</strong>
            </p>
            <p className="muted">
              <strong>한 번의 실행 기록입니다.</strong> 같은 질문이라도 모델이 매번 같은 답을
              주지 않습니다 — 인용을 달았다가 안 달았다가 하고, 그에 따라 근거 상태 배지도
              바뀝니다. 좋게 나온 실행을 골라 담지 않았습니다.
            </p>
            <ul className="demo-list">
              {demoList.map((d) => (
                <li key={d.slug}>
                  <button type="button" className="ghost" onClick={() => playDemo(d.slug)}>
                    ▶ {d.question}
                  </button>
                  <span className="muted">
                    {STATE_MARK[d.state]} {d.state}
                    {d.calledEngine ? '' : ' · 엔진을 부르지 않은 응답'} · {d.recordedAt} ·{' '}
                    {d.model}
                  </span>
                </li>
              ))}
            </ul>
            {demoError && <p className="bad">{demoError}</p>}
          </section>
        )}

        {ready && (
          <section className="engine">
            <h2>답변 엔진</h2>
            <div className="engine-pick">
              {(['gemini', 'ollama'] as EngineKind[]).map((k) => (
                <label key={k} className={engine === k ? 'on' : ''}>
                  <input
                    type="radio"
                    name="engine"
                    checked={engine === k}
                    onChange={() => setEngine(k)}
                  />
                  {ENGINE_LABEL[k]}
                </label>
              ))}
            </div>

            {/* 두 엔진이 같은 자리에서 같은 형식으로 상태를 말한다.
                **확인하지 않은 것을 「연결됨」이라고 쓰지 않는다** — Gemini 는 부르지 않고
                확인할 방법이 없으므로 「키 있음(미확인)」에서 멈춘다 */}
            <p className="conn-line">
              <StatusBadge status={status} />
              {status.detail && <span className="muted">{status.detail}</span>}
            </p>
            {status.hint && <p className="muted conn-hint">{status.hint}</p>}

            {engine === 'gemini' ? (
              <>
                <div className="engine-pick">
                  {(['vertex-sa', 'vertex', 'studio'] as ApiFlavor[]).map((f) => (
                    <label key={f} className={flavor === f ? 'on' : ''}>
                      <input
                        type="radio"
                        name="flavor"
                        checked={flavor === f}
                        onChange={() => {
                          setFlavor(f)
                          localStorage.setItem(FLAVOR_STORE, f)
                        }}
                      />
                      {API_FLAVOR_LABEL[f]}
                    </label>
                  ))}
                </div>

                {flavor === 'vertex-sa' ? (
                  <>
                    <input
                      className="key"
                      type="file"
                      accept="application/json,.json"
                      aria-label="서비스 계정 JSON 파일"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        setSaError(null)
                        setServiceAccount(null)
                        if (!file) return
                        try {
                          setServiceAccount(parseServiceAccount(await file.text()))
                        } catch (err) {
                          setSaError((err as Error).message)
                        }
                      }}
                    />
                    {serviceAccount && (
                      <p className="muted">
                        읽었습니다 — <strong>{describeServiceAccount(serviceAccount)}</strong>
                      </p>
                    )}
                    {saError && (
                      <p className="disclaimer" role="note">
                        {saError}
                      </p>
                    )}
                    <input
                      className="key"
                      value={location_}
                      onChange={(e) => {
                        setLocation(e.target.value)
                        localStorage.setItem(LOCATION_STORE, e.target.value)
                      }}
                      placeholder={`리전 (기본 ${DEFAULT_LOCATION})`}
                      aria-label="리전"
                    />
                  </>
                ) : (
                  <input
                    className="key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value)
                      if (rememberKey) localStorage.setItem(KEY_STORE, e.target.value)
                    }}
                    placeholder={
                      flavor === 'vertex'
                        ? 'Vertex AI API 키 (익스프레스 모드)'
                        : 'AI Studio API 키 (aistudio.google.com)'
                    }
                    aria-label="Gemini API 키"
                  />
                )}

                <input
                  className="key"
                  value={geminiModel}
                  onChange={(e) => {
                    setGeminiModel(e.target.value)
                    localStorage.setItem(MODEL_STORE, e.target.value)
                  }}
                  placeholder="모델 ID"
                  aria-label="모델 ID"
                />
                {flavor !== 'vertex-sa' && (
                  <label className="remember">
                    <input
                      type="checkbox"
                      checked={rememberKey}
                      onChange={(e) => applyRemember(e.target.checked)}
                    />
                    이 브라우저에 키를 저장 (이 기기에만 남고 서버로 가지 않습니다)
                  </label>
                )}
                <p className="muted">
                  자격증명은 브라우저에서 Google 로 <strong>직접</strong> 갑니다. 이 사이트에는
                  서버가 없어 받아 둘 곳도 없습니다.
                  <br />
                  {flavor === 'vertex-sa' ? (
                    <>
                      <strong>서비스 계정 JSON 은 저장하지 않습니다</strong> — 개인키가 들어 있어서
                      새로고침하면 다시 골라야 합니다. 참고로 서비스 계정은 원래 서버 쪽
                      자격증명이고 보통 API 키보다 권한이 넓습니다. 이 페이지를 남에게 공유할
                      계획이라면 <strong>API 키 창구를 쓰는 쪽이 맞습니다.</strong>
                    </>
                  ) : (
                    <>
                      키는 헤더로 보내므로 주소에 남지 않습니다.
                    </>
                  )}
                  <br />
                  <strong>모델 ID 를 바꿀 수 있게 둔 이유:</strong> 모델 이름은 자주 바뀌고, 이름이
                  틀리면 오류 본문이 아래에 그대로 표시됩니다.
                </p>
              </>
            ) : (
              <>
                {localEngineWarning(OLLAMA_BASE) && (
                  <p className="disclaimer" role="note">
                    <strong>이 주소에서는 로컬 Ollama 가 막힙니다.</strong>{' '}
                    {localEngineWarning(OLLAMA_BASE)} Ollama 쪽에{' '}
                    <code>OLLAMA_ORIGINS</code> 를 설정해도 크롬의 사설망 접근 제한이 남을 수
                    있습니다. <strong>로컬 엔진은 개발 서버(localhost)에서 쓰는 쪽이 확실하고</strong>,
                    배포본에서는 위의 Gemini 를 쓰세요.
                  </p>
                )}
                <p className="muted">
                  내 컴퓨터의 Ollama(<code>{OLLAMA_BASE}</code>, <code>{ollamaModel}</code>)를
                  씁니다. 키가 필요 없지만 Ollama 가 켜져 있어야 합니다(<code>ollama serve</code>).{' '}
                  <strong>
                    콜드 스타트에서 첫 답변은 모델을 올리느라 40초쯤 걸립니다
                  </strong>{' '}
                  (실측 {(OLLAMA_COLD_MS / 1000).toFixed(0)}초). 위 상태가 「예열됨」이면 그
                  시간이 이미 치러진 것이고, 「콜드」면 다음 첫 질문이 그 시간을 냅니다.
                </p>
                <div className="conn-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={checkOllama}
                    disabled={ollamaChecking}
                  >
                    {ollamaChecking ? '확인 중…' : '다시 확인'}
                  </button>
                  {/* 예열 — 43초를 질문 전에 치른다. 모델이 없으면 누를 수 없다 (pull 이 먼저) */}
                  <button
                    className="ghost"
                    type="button"
                    onClick={warmUp}
                    disabled={warming || busy || !ollamaProbe?.hasModel || ollamaProbe.warm}
                  >
                    {warming ? (
                      <Elapsed>{(ms) => `모델 올리는 중… ${(ms / 1000).toFixed(0)}초`}</Elapsed>
                    ) : ollamaProbe?.warm ? (
                      '이미 올라와 있습니다'
                    ) : (
                      '미리 올려두기 (예열)'
                    )}
                  </button>
                  {warming && (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => warmAbort.current?.abort()}
                    >
                      예열 중단
                    </button>
                  )}
                </div>
                {warming && (
                  <>
                    <Elapsed>{(ms) => <ColdBar ms={ms} />}</Elapsed>
                    <p className="muted">
                      눈금은 실측 콜드 스타트 {(OLLAMA_COLD_MS / 1000).toFixed(0)}초입니다 —{' '}
                      <strong>예상이고 상한이 아닙니다.</strong> 다 차도 아직 올리는 중일 수
                      있습니다.
                    </p>
                  </>
                )}
                {warmNote && <p className="muted">{warmNote}</p>}
              </>
            )}

            {/* 콜드 스타트 진행 표시 — 첫 글자가 오기 전 구간에만 뜬다.
                43초의 침묵을 고장으로 읽지 않게 하는 것이 목적이므로, 경과 시간은
                **실제로 흐르는 값**이어야 한다 (가짜 진행률을 그리지 않는다) */}
            {waitingFirst && answer && (
              <div className="wait">
                <Elapsed>
                  {(ms) => (
                    <>
                      <p className="muted">
                        {ENGINE_LABEL[answer.engine]} 에 물었고{' '}
                        <strong>첫 글자를 기다립니다</strong> · {(ms / 1000).toFixed(1)}초 경과
                        {answer.engine === 'ollama' &&
                          (ollamaProbe?.warm
                            ? ' · 모델은 이미 메모리에 있습니다'
                            : ' · 모델을 메모리에 올리는 중일 수 있습니다')}
                      </p>
                      {answer.engine === 'ollama' && !ollamaProbe?.warm && <ColdBar ms={ms} />}
                    </>
                  )}
                </Elapsed>
              </div>
            )}
          </section>
        )}

        {ready && (
          <section>
            <h2>질문</h2>
            {/* PRD 5절 규칙 5 — 멀티턴을 안 하는 것과 숨기는 것은 다르다.
                앞 질문을 기억한다고 믿으면 「그럼 그 경우는요?」 같은 후속 질문이
                엉뚱한 근거를 받는다 */}
            <p className="muted" role="note">
              ⓘ <strong>질문은 하나씩 독립적으로 처리됩니다.</strong> 앞 질문의 내용을 기억하지
              않으므로, 후속 질문도 그 자체로 완결된 문장으로 적어 주세요. 근거 추적이 흐려지는
              것을 막으려고 일부러 이렇게 두었습니다.
            </p>
            <form
              className="ask"
              onSubmit={(e) => {
                e.preventDefault()
                ask(query)
              }}
            >
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="예: 일반식품에 «면역력 강화»라고 써도 되나요?"
                aria-label="질문"
              />
              <button
                className="primary"
                type="submit"
                disabled={searching || busy || !query.trim()}
              >
                {searching ? '근거 찾는 중…' : busy ? '답하는 중…' : '물어보기'}
              </button>
              {busy && (
                <button className="ghost" type="button" onClick={cancel}>
                  중단
                </button>
              )}
            </form>
            <div className="examples">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  className="chip"
                  onClick={() => {
                    setQuery(q)
                    ask(q)
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <p className="muted">
              <strong>엔진 없이도 근거 검색은 됩니다.</strong> 아래 점수는 모델이 요약한 것이 아니라 조문 원문과 질문을
              직접 비교한 값입니다. <strong>의미 검색</strong>은 뜻이 가까운 조문을,{' '}
              <strong>표기 검색</strong>은 「제8조 제1항 제3호」처럼 적은 표기가 그대로 맞는
              조문을 찾습니다. 근거마다 <strong>두 경로에서 각각 몇 위였는지</strong>를 함께
              적었습니다 — 한쪽에서 「후보 밖」인 근거는 다른 경로가 건져 올린 것입니다.
            </p>
          </section>
        )}

        {/* S7 — 범위 밖. **답변 자리를 이것이 대신한다** (PRD 3절 F4: 답변 없음 + 범위 안내).
            아래 문장은 전부 고정 문자열이고 모델이 쓴 것이 아니다 — 그래야 코퍼스 밖 법령의
            *내용*이 새어 들어오지 않는다 (A3) */}
        {scope?.refuse && (
          <section className="scope-out">
            <h2>
              답하지 않았습니다 <StateBadge state={scope.refuse} />
            </h2>
            {refusalText(scope.refuse, scope.outside).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="muted">{STATE_HINT[scope.refuse]}</p>

            {/* A5 — 판정 배지는 **모든 응답**에 붙는다. 답변만이 아니라 범위 안내에도.
                거절은 규칙으로 판정되고, LLM 은 잴 문장이 없으므로 「해당 없음」이다 */}
            {rules && (
              <div className="verdicts">
                <div className="verdict verdict-rule">
                  <h3>
                    규칙 판정 <span className="muted">· 결정적 · 엔진 없이</span>
                  </h3>
                  <RuleChip name="거절 여부" v={rules.refusal} />
                  <RuleChip name="인용 유효성" v={rules.citation} />
                </div>
                <div className="verdict verdict-llm">
                  <h3>
                    LLM 판정 <span className="muted">· 확률적</span>
                  </h3>
                  <p className="pill pill-na">해당 없음</p>
                  <p className="muted small">
                    답을 만들지 않아 근거성을 잴 문장이 없습니다. <strong>엔진을 부르지
                    않았습니다</strong> — 키가 없어도 이 판정까지는 보입니다.
                  </p>
                </div>
              </div>
            )}

            <details>
              <summary className="muted">이 판정의 근거 보기</summary>
              <ul className="why">
                {scope.why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="muted">
                이 판정은 <strong>검색 결과와 질문 문구만으로</strong> 냅니다 — 모델을 부르지
                않았습니다. 소관 법령 이름은 <strong>사람이 검수한 고정 목록</strong>에서만
                나오고, 목록에 없으면 아무 법령도 말하지 않습니다.
              </p>
            </details>
          </section>
        )}

        {engineError && (
          <section className="notice error">
            <h2>답변을 만들지 못했습니다</h2>
            <p>{engineError.message}</p>
            {/* 오류 본문은 여러 줄짜리 JSON 이고, 앞에 붙는 설명과도 줄로 갈린다.
                한 덩어리로 뭉개면 원인을 짚어 주려던 것이 오히려 읽기 어려워진다 */}
            {engineError.hint && <p className="muted preline">{engineError.hint}</p>}
            <p className="muted">
              근거 검색은 그대로 동작합니다 — 아래 조문 목록은 엔진 없이 찾은 것입니다.
              <strong> 다른 엔진으로 조용히 넘어가지 않습니다.</strong>
            </p>
          </section>
        )}

        {answer && (
          <section>
            <h2>
              답변{' '}
              <span className="muted">
                {demo && <strong className="demo-chip">녹화</strong>}
                · {ENGINE_LABEL[answer.engine]} {answer.model}
                {answer.engine === 'gemini' && ` · ${API_FLAVOR_LABEL[flavor]}`}
                {answer.firstTokenMs != null && ` · 첫 글자 ${answer.firstTokenMs.toFixed(0)}ms`}
                {answer.totalMs != null && ` · 전체 ${(answer.totalMs / 1000).toFixed(1)}초`}
              </span>
            </h2>
            <div className="answer">
              {answer.text || <span className="muted">기다리는 중…</span>}
              {busy && <span className="caret" />}
            </div>
            {/* S7 — 근거 상태. **답변 바로 아래**에 둔다: 답을 읽자마자 「이 답을 얼마나
                믿어도 되는가」가 붙어야 한다. 한계 문장은 배지 옆이 아니라 아래 줄에 —
                「⚠ 근거 약함」만 보고 넘기면 무엇이 약한지가 사라진다 */}
            {answer.done && verdict && (
              <div className={`verdict-state ${STATE_CLASS[verdict.state]}`}>
                <p className="state-line">
                  <StateBadge state={verdict.state} />
                  <span className="muted">{STATE_HINT[verdict.state]}</span>
                </p>
                {verdict.limits.map((l) => (
                  <p key={l} className="limit">
                    {l}
                  </p>
                ))}
                <details>
                  <summary className="muted">이 판정의 근거 보기</summary>
                  <ul className="why">
                    {verdict.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}

            {answer.done && citations && (
              <p className="muted">
                {answer.cancelled && <strong>중단했습니다. </strong>}
                {citations.ids.length
                  ? `인용 ${citations.ids.join(' ')}${
                      citations.invalid.length
                        ? ` · 없는 자료를 인용했습니다: ${citations.invalid.join(' ')}`
                        : ''
                    }`
                  : '답변이 근거 번호를 달지 않았습니다.'}
              </p>
            )}

            {/* S6 — 출처 칩. **답변 바로 아래**에 둔다: 답을 읽은 직후가 「무엇을 근거로
                했나」를 묻는 자리이고, 근거 목록까지 스크롤해야 알 수 있으면 검증 경로가
                아니라 부록이 된다 (PRD 5절 규칙 2) */}
            {answer.done && citations && chipItems.length > 0 && (
              <SourceChips
                items={chipItems}
                invalid={citations.invalid}
                lenient={citations.lenient}
                onOpen={openEvidence}
              />
            )}
            {/* ── 판정 영역 ────────────────────────────────────────────────────
                A6 은 「피드백을 남기면 **판정 결과와 함께** 보인다」다. 그래서 사람 피드백을
                답변 본문이 아니라 **판정과 같은 층**에 둔다 (PRD 5절 규칙 1: 답변과 판정은
                서로 다른 시각적 층).

                **S8 은 이 줄의 왼쪽에 카드를 두 장 끼우면 된다** — 규칙 배지(결정적)와
                LLM 배지(확률적). 지금 자리를 잡아 두는 이유가 그것이고, 셋이 나란히 서는
                레이아웃은 아래 `.verdicts` 하나로 이미 성립한다. 배지 모양은 서로 달라야
                한다(PRD 5절 규칙 4) — 그 구분은 S8 이 정한다. */}
            {answer.done && (
              <div className="verdicts">
                {/* ── S8 규칙 층 — 결정적. 각진 상자로 그린다 (PRD 5절 규칙 4) ── */}
                <div className="verdict verdict-rule">
                  <h3>
                    규칙 판정 <span className="muted">· 결정적 · 엔진 없이</span>
                  </h3>
                  {rules && (
                    <>
                      <RuleChip name="인용 유효성" v={rules.citation} />
                      <RuleChip name="거절 여부" v={rules.refusal} />
                      <p className="muted small">
                        <strong>이 규칙이 보는 것은 집합 소속뿐입니다.</strong> 번호는 맞고
                        내용을 왜곡한 답, 무관한 조문을 방패로 든 답은 <strong>통과합니다</strong>
                        — 그건 옆의 LLM 판정과 사람이 봅니다.
                      </p>
                    </>
                  )}
                </div>

                {/* ── S8 LLM 층 — 확률적. 둥근 알약으로 그려 규칙과 모양을 가른다 ── */}
                <div className="verdict verdict-llm">
                  <h3>
                    LLM 판정{' '}
                    <span className="muted">
                      {/* 녹화 재생 중에는 **녹화 당시 엔진**을 적는다. 지금 고른 엔진을
                          쓰면 「Gemini · qwen3.5:2b」 같은 거짓 조합이 화면에 뜬다 */}
                      · 확률적 · {ENGINE_LABEL[demo ? (demo.engine as EngineKind) : engine]}
                      {judgment && ` ${judgment.model}`}
                    </span>
                  </h3>
                  {judging && <p className="muted">근거성을 재는 중…</p>}
                  {!judging && !judgment && (
                    <p className="muted">답변이 끝나면 자동으로 판정합니다.</p>
                  )}
                  {judgment?.ok === false && (
                    <>
                      {/* 판정이 실패해도 **답변과 나머지 UI 는 그대로 둔다** (PRD 5절 규칙 3) */}
                      <p className="pill pill-fail">판정 실패</p>
                      <p className="muted preline">
                        {judgment.message}
                        {judgment.hint ? `\n${judgment.hint}` : ''}
                      </p>
                      <p className="muted small">답변과 근거는 그대로 둡니다.</p>
                    </>
                  )}
                  {judgment?.ok && (
                    <>
                      <div className="pills">
                        <span
                          className={`pill ${judgment.verdict.groundedInSources ? 'pill-ok' : 'pill-bad'}`}
                        >
                          {judgment.verdict.groundedInSources ? '자료에 근거함' : '자료 밖 내용 있음'}
                        </span>
                        <span
                          className={`pill ${judgment.verdict.hallucinated ? 'pill-bad' : 'pill-ok'}`}
                        >
                          {judgment.verdict.hallucinated ? '만들어 낸 내용 있음' : '만들어 낸 내용 없음'}
                        </span>
                        <span className="pill pill-score">
                          근거성 {judgment.verdict.scoreOutOf100}/100
                        </span>
                      </div>
                      {judgment.verdict.comment && (
                        <p className="muted preline judge-comment">
                          {judgment.verdict.comment.trim()}
                        </p>
                      )}
                      <p className="muted small">
                        {(judgment.ms / 1000).toFixed(1)}초 · 온도 0 · 스키마 강제.{' '}
                        <strong>확률적 판정입니다</strong> — 규칙 배지와 달리 같은 답변에 다른
                        결과가 나올 수 있습니다.
                      </p>
                    </>
                  )}
                  {!judging && judgment && !demo && (
                    <button className="ghost" type="button" onClick={runJudge}>
                      다시 판정
                    </button>
                  )}
                </div>

                <div className="verdict verdict-human">
                  <h3>
                    사람 피드백{' '}
                    <span className="muted">· 이 브라우저에만 남습니다</span>
                  </h3>
                  <div className="votes">
                    {(['up', 'down'] as Vote[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="vote"
                        aria-pressed={currentVote?.vote === v}
                        disabled={!!demo}
                        onClick={() => vote(v)}
                      >
                        {VOTE_LABEL[v]}
                      </button>
                    ))}
                  </div>
                  {demo && (
                    <p className="muted">
                      녹화 데모에는 평가를 남길 수 없습니다 — 기록에 들어가면 「사람이 실제로
                      받은 답변에 누른 평가」가 아니게 됩니다.
                    </p>
                  )}
                  {currentVote ? (
                    <p className="muted">
                      {VOTE_LABEL[currentVote.vote]} 로 남겼습니다 ·{' '}
                      {whenLabel(currentVote.at)} · 근거 {currentVote.evidence.length}개
                      {currentVote.cited.length
                        ? ` · 인용 ${currentVote.cited.join(' ')}`
                        : ' · 인용 없음'}
                    </p>
                  ) : (
                    <p className="muted">
                      이 답변이 근거를 제대로 댔는지 평가해 주세요. 서버로 보내지 않습니다.
                    </p>
                  )}
                  {/* 같은 질문을 다시 물었을 때 지난 평가가 보인다 — 새로고침을 건너
                      살아남는 것이 이 기능의 요점이다 */}
                  {priorSame && (priorSame.up > 0 || priorSame.down > 0) && (
                    <p className="muted">
                      이 질문에 남긴 지난 평가 — 👍 {priorSame.up} · 👎 {priorSame.down}
                      {priorSame.latest && (
                        <>
                          {' '}
                          (마지막 {whenLabel(priorSame.latest.at)} · {priorSame.latest.engine}{' '}
                          {priorSame.latest.model})
                        </>
                      )}
                    </p>
                  )}
                  {fbError && (
                    <p className="disclaimer" role="note">
                      {fbError}
                    </p>
                  )}
                </div>
              </div>
            )}
            <p className="disclaimer" role="note">
              <strong>법률 자문이 아닙니다.</strong> 아래 조문 원문을 직접 확인하세요.
            </p>
          </section>
        )}

        {/* S6 — 검색 단계. 결과만 보여 주면 상위 8개가 어디서 왔는지 알 수 없다 */}
        {stages && (
          <section>
            <h2>
              검색 단계{' '}
              {elapsed != null && (
                <span className="muted">· 질의 임베딩+검색 {elapsed.toFixed(0)}ms</span>
              )}
            </h2>
            <ol className="steps">
              {stages.map((s, i) => (
                <li key={s.title}>
                  <span className="step-n">{i + 1}</span>
                  <span className="step-t">{s.title}</span>
                  <span className="muted">{s.detail}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {hits && corpus && (
          <section className={scope?.refuse ? 'dimmed' : undefined}>
            <h2>
              {scope?.refuse ? '검색이 가져온 조문' : '근거'} {hits.length}개{' '}
              <span className="muted">· 줄을 누르면 조문 원문과 링크가 열립니다</span>
            </h2>
            {/* 범위 밖 질문에서 이 목록을 「근거」라고 부르면 안 된다. 검색은 무엇에든
                8개를 돌려주므로, 그걸 근거로 내놓으면 **없는 규정을 시사**하게 된다.
                지우지도 않는다 — 판정이 무엇을 보고 나왔는지 확인할 수 있어야 한다 */}
            {scope?.refuse && (
              <p className="disclaimer" role="note">
                <strong>이것들은 이 질문의 근거가 아닙니다.</strong> 검색은 어떤 질문에도 가장
                가까운 조문을 돌려주므로, 범위 밖 질문에도 목록이 비지 않습니다. 판정이 무엇을
                보고 나왔는지 확인하시라고 남겨 둡니다.
              </p>
            )}
            {/* 규칙 6 — 시행 예정 조문은 현행과 구분한다. 지금 코퍼스에 몇 개인지를
                말해 두면, 구분 표시가 안 보일 때 그게 「기능이 없어서」가 아니라
                「해당 조문이 없어서」임이 화면에서 확인된다 */}
            <p className="muted">
              {hits.some((h) => isFutureEffective(corpus.chunks[h.index])) ? (
                <>
                  <strong>시행 예정 조문이 섞여 있습니다</strong> — 아래에서 주황색{' '}
                  <span className="eff eff-future">시행 예정</span> 표시가 붙은 것은 지금
                  적용되지 않습니다.
                </>
              ) : (
                <>
                  이 결과의 조문은 <strong>전부 오늘 기준 시행 중</strong>입니다. 시행 예정
                  조문이 걸리면 <span className="eff eff-future">시행 예정</span> 으로 따로
                  표시됩니다.
                </>
              )}
            </p>
            <ol className="hits">
              {hits.map((h) => {
                const { index, score, via, dense, sparse, denseRank, sparseRank } = h
                const c = corpus.chunks[index]
                const future = isFutureEffective(c)
                const label = answer?.evidence.find((e) => e.chunkId === c.id)?.label
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="hit-open"
                      onClick={() =>
                        setEvidenceView({
                          chunk: c,
                          hit: h,
                          label,
                          cited: label ? citations?.valid.includes(label) : undefined,
                        })
                      }
                    >
                      <span className="hit-head">
                        {label && <span className="chip-label">{label}</span>}
                        <span className="score">{score.toFixed(3)}</span>
                        <span className={`via via-${via}`}>{VIA_LABEL[via]}</span>
                        <span className="kind">{c.sourceKind}</span>
                        <span className="src">{c.source}</span>
                        <span className="loc">{locationLabel(c)}</span>
                        <span className={future ? 'eff eff-future' : 'eff eff-now'}>
                          {future ? `시행 예정 ${c.effectiveDate}` : `시행 ${c.effectiveDate}`}
                        </span>
                      </span>
                    </button>
                    <p className="hit-text">{c.text}</p>
                    <div className="hit-foot">
                      <span className="muted">
                        의미 {denseRank ? `${denseRank}위` : '후보 밖'} (코사인{' '}
                        {dense.toFixed(3)}) · 표기 {sparseRank ? `${sparseRank}위` : '후보 밖'}{' '}
                        (BM25 {sparse.toFixed(2)})
                      </span>
                      <a href={c.url} target="_blank" rel="noreferrer">
                        law.go.kr 에서 원문 보기 →
                      </a>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        {/* S10 — 남긴 피드백 목록. **답변이 없어도 보인다**: 새로고침하면 대화는 사라지지만
            평가는 남고, 남는다는 사실을 확인할 수 있는 곳이 여기다.
            S11 이 사람 평가로 쓰는 것도 이 목록이다 (JSON 으로 그대로 복사해 갈 수 있다) */}
        {log.length > 0 && (
          <section>
            <h2>
              남긴 피드백 {log.length}개{' '}
              <span className="muted">
                · 👍 {log.filter((r) => r.vote === 'up').length} · 👎{' '}
                {log.filter((r) => r.vote === 'down').length}
              </span>
            </h2>
            <p className="muted">
              이 기기의 브라우저 저장소(<code>localStorage</code>)에만 있습니다. 서버로 보내지
              않으므로 <strong>다른 사람의 피드백은 모이지 않습니다</strong> (PRD 6절).
            </p>
            <ol className="fb-log">
              {[...log].reverse().map((r) => (
                <li key={r.id}>
                  <div className="fb-head">
                    <span className={`fb-vote fb-${r.vote}`}>{VOTE_LABEL[r.vote]}</span>
                    <span className="muted">{whenLabel(r.at)}</span>
                    <span className="muted">
                      {r.engine} {r.model}
                      {r.flavor ? ` · ${r.flavor}` : ''}
                    </span>
                    {r.cancelled && <span className="muted">중단된 답변</span>}
                  </div>
                  <p className="fb-q">{r.question}</p>
                  <p className="muted">
                    근거 {r.evidence.length}개 —{' '}
                    {r.evidence.map((e) => `${e.label} ${e.source} ${e.path}`).join(' / ')}
                  </p>
                  <p className="muted">
                    {r.cited.length ? `인용 ${r.cited.join(' ')}` : '인용 없음'}
                    {r.invalidCited.length ? ` · 없는 자료 인용 ${r.invalidCited.join(' ')}` : ''}
                  </p>
                  {/* A6 — 사람 피드백이 **판정 결과와 함께** 보인다. 남길 때의 판정을
                      그대로 되살린다. `null` 은 「그때 판정이 없었다」이지 「깨끗했다」가 아니다 */}
                  <p className="muted">
                    {r.verdicts ? (
                      <>
                        판정 — {r.verdicts.state}
                        {' · 규칙 '}
                        {r.verdicts.citationPass === true
                          ? '인용 유효'
                          : r.verdicts.citationPass === false
                            ? '인용 문제'
                            : '해당 없음'}
                        {r.verdicts.failed
                          ? ` · LLM 판정 실패 (${r.verdicts.failed})`
                          : r.verdicts.grounded == null
                            ? ' · LLM 판정 없음'
                            : ` · LLM ${r.verdicts.grounded ? '자료에 근거함' : '자료 밖 내용'}${
                                r.verdicts.hallucinated ? ' · 만들어 낸 내용 있음' : ''
                              } · ${r.verdicts.scoreOutOf100}/100 (${r.verdicts.judgeModel})`}
                      </>
                    ) : (
                      '이 기록에는 자동 판정이 없습니다 (판정 전에 남겼거나 옛 기록입니다)'
                    )}
                  </p>
                  <details>
                    <summary className="muted">저장된 답변 전문 보기</summary>
                    <p className="fb-answer">
                      {r.answerText}
                      {r.answerTruncated && ' …(이후 생략)'}
                    </p>
                  </details>
                </li>
              ))}
            </ol>
            <div className="conn-row">
              {confirmClear ? (
                <>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setLog(clearFeedback())
                      setVoteId(null)
                      setConfirmClear(false)
                    }}
                  >
                    정말 지웁니다 ({log.length}개)
                  </button>
                  <button className="ghost" type="button" onClick={() => setConfirmClear(false)}>
                    취소
                  </button>
                </>
              ) : (
                <button className="ghost" type="button" onClick={() => setConfirmClear(true)}>
                  이 브라우저의 피드백 모두 지우기
                </button>
              )}
            </div>
          </section>
        )}
      </main>

      {/* S6 — 근거 모달. 화면 어디서 열든 하나만 있으면 된다 */}
      <EvidenceModal view={evidenceView} onClose={() => setEvidenceView(null)} />

      <footer className="footer">
        {corpus && (
          <p className="muted">
            벡터스토어 {corpus.vectorMeta.modelKey} ({corpus.vectorMeta.modelId},{' '}
            {corpus.vectorMeta.dtype}, {corpus.vectorMeta.dim}차원) · 빌드{' '}
            {corpus.vectorMeta.builtAt} · 수집 {corpus.meta.collectedAt}
            {probe && (
              <>
                {' · '}
                <span className={probe.ok ? 'ok' : 'bad'}>
                  동일 공간 검증 {probe.ok ? '통과' : '실패'} (코사인 {probe.cosine.toFixed(4)})
                </span>
              </>
            )}
          </p>
        )}
        <p>
          아이펠 AI 에이전트 과정 Main Quest 3 ·{' '}
          <a href="https://github.com/ibiseolsin/aiffel-quests" target="_blank" rel="noreferrer">
            저장소
          </a>{' '}
          · 자료 출처: 국가법령정보센터 (law.go.kr) 공개 API
        </p>
      </footer>
    </div>
  )
}
