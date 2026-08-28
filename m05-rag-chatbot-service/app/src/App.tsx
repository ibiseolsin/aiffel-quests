import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { loadCorpus, type Corpus } from './lib/corpus.ts'
import { embedPassage, embedQuery, loadEmbedder, type LoadProgress } from './lib/embedder.ts'
import { buildBm25, type Bm25Index } from './lib/bm25.ts'
import {
  cosine,
  hybridSearch,
  limitFamilies,
  storedVector,
  type HybridHit,
  type Via,
} from './lib/search.ts'

/**
 * S3·S4 — 벡터스토어, 브라우저 질의 임베딩, 하이브리드 검색.
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

type Probe = { cosine: number; ok: boolean } | null

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

  const [bm25, setBm25] = useState<Bm25Index | null>(null)

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
    setSearching(true)
    try {
      const extractor = await loadEmbedder(corpus.vectorMeta)
      const t0 = performance.now()
      const v = await embedQuery(extractor, q.trim(), corpus.vectorMeta)
      const found = hybridSearch(corpus, v, q.trim(), bm25, TOP_K * 3)
      // 앞머리가 같은 형제 청크가 결과를 뒤덮지 않게 무리마다 개수를 제한한다
      setHits(limitFamilies(found, (i) => corpus.chunks[i].text).slice(0, TOP_K))
      setElapsed(performance.now() - t0)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const effective = useMemo(() => {
    if (!corpus) return null
    const dates = corpus.chunks.map((c) => c.effectiveDate).sort()
    return { from: dates[0], to: dates.at(-1) }
  }, [corpus])

  return (
    <div className="page">
      <header className="header">
        <h1>식품 표시·광고 규정 안내</h1>
        <p className="lede">
          내가 만든 식품을 판매채널에 올릴 때, <strong>표시사항과 광고 문구가 규정에 맞는가</strong>를
          실제 법령 조문을 근거로 답합니다.
        </p>

        <div className="slots">
          <span className="slot">엔진 — 미연결 (S5)</span>
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

        {ready && (
          <section>
            <h2>질문</h2>
            <form
              className="ask"
              onSubmit={(e) => {
                e.preventDefault()
                search(query)
              }}
            >
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="예: 일반식품에 «면역력 강화»라고 써도 되나요?"
                aria-label="질문"
              />
              <button className="primary" type="submit" disabled={searching || !query.trim()}>
                {searching ? '찾는 중…' : '근거 찾기'}
              </button>
            </form>
            <div className="examples">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  className="chip"
                  onClick={() => {
                    setQuery(q)
                    search(q)
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <p className="muted">
              지금은 <strong>검색까지만</strong> 동작합니다. 답변 생성과 판정은 다음
              단계(S5·S8)입니다 — 아래 점수는 모델이 요약한 것이 아니라 조문 원문과 질문을
              직접 비교한 값입니다. <strong>의미 검색</strong>은 뜻이 가까운 조문을,{' '}
              <strong>표기 검색</strong>은 「제8조 제1항 제3호」처럼 적은 표기가 그대로 맞는
              조문을 찾습니다. 근거마다 <strong>두 경로에서 각각 몇 위였는지</strong>를 함께
              적었습니다 — 한쪽에서 「후보 밖」인 근거는 다른 경로가 건져 올린 것입니다.
            </p>
          </section>
        )}

        {hits && corpus && (
          <section>
            <h2>
              근거 후보 {hits.length}개{' '}
              {elapsed != null && (
                <span className="muted">· 질의 임베딩+검색 {elapsed.toFixed(0)}ms</span>
              )}
            </h2>
            <ol className="hits">
              {hits.map(({ index, score, via, dense, sparse, denseRank, sparseRank }) => {
                const c = corpus.chunks[index]
                return (
                  <li key={c.id}>
                    <div className="hit-head">
                      <span className="score">{score.toFixed(3)}</span>
                      <span className={`via via-${via}`}>{VIA_LABEL[via]}</span>
                      <span className="kind">{c.sourceKind}</span>
                      <span className="src">{c.source}</span>
                      <span className="loc">{c.path}</span>
                    </div>
                    <p className="hit-text">{c.text}</p>
                    <div className="hit-foot">
                      <span className="muted">시행 {c.effectiveDate}</span>
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
      </main>

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
