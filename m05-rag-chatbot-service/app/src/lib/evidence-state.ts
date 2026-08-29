/**
 * S7 — 근거 상태 5단.
 *
 * # 먼저 알아야 할 것: **점수만으로는 안 갈린다** (실측)
 *
 * PRD 3절 F4 는 「상태를 가르는 신호는 검색 최고 점수의 두 임계값」이라고 썼다.
 * 평가 세트 Q1~Q9 와 도메인 밖 프로브 6개를 실제로 재 보니 **그 전제가 성립하지 않는다.**
 *
 * ```
 *                     밀집(코사인) 최고   희소(BM25) 상위5 합
 *   Q1 근거충분              0.8646              60.9
 *   Q2 근거약함              0.9024             115.7   ← 전체 최고인데 「약함」이다
 *   Q6 근거충분              0.8855             133.4
 *   Q5 일부범위밖            0.8473              50.7
 *   Q7 코퍼스밖              0.8474              47.4   ← Q5 와 밀집이 0.0001 차이
 *   Q9 규범밖                0.8392              41.6
 *   X5 「식당 위생등급?」     0.8738              27.6   ← Q1 보다 밀집이 높다
 * ```
 *
 * 밀집은 0.80~0.90 좁은 띠에 눌려 있고, 희소는 「표시·제품·상세페이지」 같은 공통어에서
 * 점수를 얻는다. **두 점수 어느 쪽도 코퍼스 안/밖을 가르지 못하고, 근거충분/약함은 더더욱
 * 못 가른다.** 그래서 임계값을 주 신호로 쓰지 않는다 — 쓰면 그럴듯한 숫자로 틀린다.
 *
 * # 그래서 실제로 무엇으로 가르는가
 *
 * | 신호 | 성격 | 무엇을 가르나 |
 * |---|---|---|
 * | **범위 밖 주제 목록** | 사람이 검수한 고정 목록 | 코퍼스밖 · 일부범위밖 |
 * | **법령 질문 신호어** | 고정 목록 | 코퍼스밖 ↔ 규범밖 |
 * | **가리키기만 하는 근거** | 코퍼스 사실 (별표 본문 0개) | 근거약함 |
 * | **인용 규칙** | 결정적 (PRD F4) | 근거충분 부정 |
 * | 희소 상위5 합 바닥 | 임계값 ① | 완전 도메인 밖만 |
 * | 인용된 근거의 코사인 | 임계값 ② | 근거충분 부정 |
 *
 * 임계값 둘은 **마지막 문지기**이지 첫 문지기가 아니다. 그 순서가 이 파일의 핵심이다.
 */

import type { Chunk, CorpusMeta } from './corpus.ts'
import type { Citations } from './citations.ts'
import type { HybridHit } from './search.ts'

export type EvidenceState = '근거충분' | '근거약함' | '일부범위밖' | '코퍼스밖' | '규범밖'

/** 답을 만들지 않고 범위만 안내하는 상태 */
export const REFUSING: EvidenceState[] = ['코퍼스밖', '규범밖']

/* ─── 임계값 ② 개 (PLAN 의 수치 표에 그대로 옮긴다) ───────────────────────── */

/**
 * **희소 상위5 합의 바닥.** 이 아래면 코퍼스에 이 질문과 표기가 겹치는 조문이 사실상 없다.
 *
 * 실측으로 정했다 — 도메인 밖 프로브: 날씨 0 · 파이썬 23.3 · 놀이공원 30.0 · 번역 36.1 ·
 * 식당 위생등급 27.6 · 음식점 영업신고 45.4. 코퍼스 안에서 답이 나오는 질문의 최저는
 * Q1 의 60.9 다. **50 은 그 사이이고, 아래로 15점 · 위로 11점의 여유가 있다.**
 *
 * 이 바닥이 잡는 것은 **완전히 다른 도메인**뿐이다. Q7·Q8·Q9 (47.4 / 56.9 / 41.6)는
 * 이 바닥으로 못 잡는다 — 그건 주제 목록과 신호어가 잡는다.
 */
export const SPARSE_FLOOR = 50

/**
 * **인용된 근거의 코사인 하한.** 답변이 댄 근거가 질문과 의미적으로 이만큼도 안 가까우면
 * 「근거 충분」이라고 쓰지 않는다.
 *
 * 코퍼스 안 질문의 최고 코사인이 0.847~0.902 에 몰려 있어 **여유가 거의 없는 값**이다.
 * 칼날 위에 세운 임계값이고, 그렇게 적어 둔다. S11b 실험 축 2가 이것이다.
 */
export const CITED_DENSE_MIN = 0.86

/* ─── 고정 목록 ①: 범위 밖 주제 ─────────────────────────────────────────── */

/**
 * **소관 법령 이름은 모델이 대면 안 된다** (PRD 4절·A3). 이름 자체는 코퍼스 메타의
 * `outOfScope` 에서 오고, 여기 있는 것은 **그 주제를 알아보는 말**뿐이다.
 * 키워드도 사람이 검수한 고정 목록이며, `topic` 으로 코퍼스 메타와 맞물린다.
 *
 * 넓게 잡지 않았다 — 예를 들어 「건강기능식품」 한 단어로는 걸지 않는다. 이 코퍼스는
 * 「건강기능식품이 아닌 것을 건강기능식품으로 인식할 우려」(제8조①제3호)를 **다루기**
 * 때문이다. 범위 밖인 것은 **기능성 표시의 허용 범위**쪽이라 그 말이 같이 있어야 건다.
 */
export const OUT_OF_SCOPE_KEYWORDS: { topic: string; test: RegExp }[] = [
  { topic: '수출 라벨 요건', test: /수출|해외\s*판매|수입국|아마존|영문\s*라벨|FDA/i },
  { topic: '화장품 표시·광고', test: /화장품|주름\s*개선|미백|기능성\s*화장품/ },
  { topic: '의약품 표시·광고', test: /의약품|약사법|처방|일반의약품|전문의약품/ },
  {
    topic: '건강기능식품의 기능성 표시 허용 범위',
    test: /(건강기능식품|건기식)[^.?!]{0,20}(기능성|인정|허용)|기능성\s*원료|개별인정/,
  },
  { topic: '축산물 개별 표시기준', test: /축산물|식육|도축|유가공품|축산물\s*위생/ },
  { topic: '주류 표시', test: /주류\s*표시|주세법|소주|맥주|위스키|막걸리/ },
  {
    topic: '협찬·대가관계 표시 등 일반 부당광고',
    test: /협찬|뒷광고|대가를?\s*받|체험단|인플루언서|경제적\s*이해관계/,
  },
]

/* ─── 고정 목록 ②: 법령 질문인가 ────────────────────────────────────────── */

/**
 * **법령·규정을 묻는 질문인가.** 코퍼스밖(법령 질문)과 규범밖(법령 질문 아님)을 가른다.
 *
 * 이 구분이 필요한 이유는 PRD 3절이 못 박았다 — 「원가를 어떻게 낮추나」에
 * 「다른 법령에 규정이 있을 수 있다」를 붙이면 **없는 규제를 시사하는 오답**이 된다.
 */
const LEGAL_SIGNALS =
  /법령|법률|시행령|시행규칙|고시|규정|조문|제\d+조|기준|의무|위반|과태료|처벌|신고|허가|심의|표시|광고|라벨|표기|적어도\s*되|써도\s*되|해도\s*되|넣어야|해야\s*하나|받아야/

/**
 * **이 법의 적용 자체를 묻고 있는가.** 범위 밖 주제가 걸렸을 때 「코퍼스밖」과
 * 「일부범위밖」을 가른다 — 질문이 이 법 얘기도 같이 하고 있으면 답할 수 있는 절반이 있다.
 */
const IN_SCOPE_ANCHORS = /이\s*법|식품\s*표시|표시광고법|적용을?\s*받|적용\s*대상|표시사항|자율심의/

/* ─── 고정 목록 ③: 가리키기만 하는 근거 ─────────────────────────────────── */

/**
 * **「별표 N과 같다」로 끝나는 조문.** 이 코퍼스에 12개 있고, **별표 본문은 0개다**
 * (S2 는 조문만 받았다 — FINDINGS 11절).
 *
 * 이런 근거만 있으면 자료는 「어디를 보라」까지만 말할 수 있고 「무엇을 어떻게」는 못
 * 말한다. **이게 Q2(알레르기 표시 방법)가 근거약함인 진짜 이유**이고, 점수로는 절대
 * 안 보인다 — Q2 의 점수는 아홉 문항 중 가장 높다.
 */
const POINTER_ONLY = /별표\s*\d+[^.]{0,20}(같다|따른다|의하[여며]|정하는)/

export function isPointerOnly(chunk: Chunk): boolean {
  return POINTER_ONLY.test(chunk.text)
}

/** 그 조문이 가리키는 별표 이름 (「별표 2」). 한계 문장에 그대로 쓴다 */
export function pointedTable(chunk: Chunk): string | null {
  return chunk.text.match(/별표\s*\d+/)?.[0] ?? null
}

/* ─── 1단계: 답을 만들기 전의 문지기 ────────────────────────────────────── */

export type ScopeNote = { topic: string; owner: string }

export type PreVerdict = {
  /** 답을 만들지 않고 끝낼 상태. `null` 이면 생성으로 넘어간다 */
  refuse: '코퍼스밖' | '규범밖' | null
  /** 답하되 밖인 부분을 분리해 밝혀야 하는가 */
  partial: boolean
  /** 고정 목록에서 꺼낸 소관 안내. **여기 없는 법령 이름은 화면에 나오지 않는다** */
  outside: ScopeNote[]
  /** 왜 그렇게 판정했는지. 화면에 그대로 적는다 */
  why: string[]
  sparseTop5: number
}

/**
 * 검색 결과와 질문 문구만으로 판정한다. **엔진을 부르지 않는다** — 키 없는 방문자도
 * 「이 질문은 범위 밖입니다」까지는 볼 수 있어야 하고, 판정이 모델의 변덕을 타면 안 된다.
 */
export function preClassify(
  question: string,
  meta: CorpusMeta,
  sparseTop5: number,
): PreVerdict {
  const why: string[] = []
  const owners = new Map(meta.outOfScope.map((o) => [o.topic, o.owner]))
  const outside: ScopeNote[] = OUT_OF_SCOPE_KEYWORDS.filter((r) => r.test.test(question))
    .flatMap((r) => {
      const owner = owners.get(r.topic)
      return owner ? [{ topic: r.topic, owner }] : []
    })

  const legal = LEGAL_SIGNALS.test(question)
  const anchored = IN_SCOPE_ANCHORS.test(question)

  if (!legal) {
    why.push('법령·규정을 묻는 말이 질문에 없습니다.')
    // 규범 밖에서는 **밖 주제도 말하지 않는다** — 없는 규제를 시사하게 된다 (PRD 7절)
    return { refuse: '규범밖', partial: false, outside: [], why, sparseTop5 }
  }

  if (outside.length) {
    why.push(`범위 밖 주제가 걸렸습니다 — ${outside.map((o) => o.topic).join(' · ')}`)
    if (anchored) {
      why.push('그런데 이 법의 적용·표시사항도 함께 묻고 있어 답할 수 있는 부분이 있습니다.')
      return { refuse: null, partial: true, outside, why, sparseTop5 }
    }
    return { refuse: '코퍼스밖', partial: false, outside, why, sparseTop5 }
  }

  if (sparseTop5 < SPARSE_FLOOR) {
    why.push(
      `표기가 겹치는 조문이 거의 없습니다 (희소 상위5 합 ${sparseTop5.toFixed(1)} < ${SPARSE_FLOOR}).`,
    )
    // 법령 질문이긴 한데 **어느 법 소관인지 모른다.** 모르면 말하지 않는다 (A3)
    return { refuse: '코퍼스밖', partial: false, outside: [], why, sparseTop5 }
  }

  return { refuse: null, partial: false, outside, why, sparseTop5 }
}

/* ─── 2단계: 답이 나온 뒤의 최종 상태 ───────────────────────────────────── */

export type Verdict = {
  state: EvidenceState
  /** 이 상태가 된 이유. 화면에 그대로 적는다 — 판정이 블랙박스면 볼 이유가 없다 */
  why: string[]
  /** 답변에 덧붙일 한계 문장 (근거약함·일부범위밖) */
  limits: string[]
  outside: ScopeNote[]
}

export function classify(input: {
  pre: PreVerdict
  /** 답변에 실린 근거와 그 검색 점수 */
  evidence: { label: string; chunk: Chunk; hit?: HybridHit }[]
  citations: Citations
  cancelled: boolean
}): Verdict {
  const { pre, evidence, citations, cancelled } = input
  const why = [...pre.why]
  const limits: string[] = []

  if (pre.refuse) return { state: pre.refuse, why, limits, outside: pre.outside }

  const base: EvidenceState = pre.partial ? '일부범위밖' : '근거충분'
  let sufficient = true

  // PRD F4 의 규칙 — 점수가 아무리 높아도 이건 못 넘는다
  if (!citations.ids.length) {
    why.push('답변이 조문 인용을 하나도 달지 않았습니다.')
    sufficient = false
  }
  if (citations.invalid.length) {
    why.push(`실리지 않은 자료를 인용했습니다 — ${citations.invalid.join(' ')}`)
    sufficient = false
  }
  if (cancelled) {
    why.push('답변이 중간에 중단되었습니다.')
    sufficient = false
  }

  const cited = evidence.filter((e) => citations.valid.includes(e.label))

  /* 가리키기만 하는 근거 — 점수로는 안 보이는 코퍼스 사실.
     **하나라도 인용되면 근거충분이 아니다.** 답의 일부가 이 자료에 없는 글에 기대고 있다는
     뜻이기 때문이다. 실측에서 실제로 그랬다: 「소비자 안전을 위한 주의사항은 어떻게
     표시해야 하나요」에 모델이 S1(별표 2 를 가리키는 조문)을 포함해 6개를 인용했고,
     **모델 스스로 「별표의 내용이 명시되어 있지 않습니다」라고 답 안에 적었다.** 그런데도
     상태가 「근거충분」으로 나왔다 — 처음엔 「인용이 전부 가리키기만 할 때」만 내렸기
     때문이다. 이 도메인에서 확신의 방향을 그렇게 두면 안 된다 (PRD 1절). */
  const pointers = cited.filter((e) => isPointerOnly(e.chunk))
  if (pointers.length) {
    const tables = [...new Set(pointers.flatMap((p) => pointedTable(p.chunk) ?? []))]
    const named = tables.join(' · ') || '별표'
    const all = pointers.length === cited.length
    why.push(
      all
        ? '인용된 근거가 전부 다른 문서를 가리키기만 합니다.'
        : `인용된 근거 중 ${pointers.map((p) => p.label).join(' ')} 이(가) 다른 문서를 가리키기만 합니다.`,
    )
    limits.push(
      all
        ? `이 자료에는 ${named} 의 본문이 없습니다. 조문은 "거기에 정해져 있다"까지만 말하고 구체적인 방법은 담고 있지 않습니다 — law.go.kr 에서 그 별표를 직접 확인하세요.`
        : `근거 중 ${pointers.map((p) => p.label).join(' ')} 은(는) ${named} 을(를) 가리키기만 하고, 그 본문은 이 자료에 없습니다. 구체적인 방법은 law.go.kr 에서 ${named} 를 직접 확인하세요.`,
    )
    sufficient = false
  }

  // 임계값 ② — 마지막 문지기
  const bestCitedDense = Math.max(0, ...cited.map((e) => e.hit?.dense ?? 0))
  if (cited.length && bestCitedDense < CITED_DENSE_MIN) {
    why.push(
      `인용된 근거가 질문과 그리 가깝지 않습니다 (코사인 ${bestCitedDense.toFixed(3)} < ${CITED_DENSE_MIN}).`,
    )
    sufficient = false
  }

  if (citations.lenient) {
    why.push('답변의 인용 표기가 흔들려 번호만으로 읽었습니다.')
  }

  if (base === '일부범위밖') {
    limits.push(
      `아래 주제는 이 자료의 범위 밖이라 답에 포함하지 않았습니다 — ${pre.outside
        .map((o) => `${o.topic} (${o.owner} 소관)`)
        .join(' · ')}`,
    )
    return { state: '일부범위밖', why, limits, outside: pre.outside }
  }

  if (sufficient) why.push('인용이 유효하고, 근거가 질문에 충분히 가깝습니다.')
  return { state: sufficient ? '근거충분' : '근거약함', why, limits, outside: pre.outside }
}

/* ─── 화면 문구 — **전부 고정 문자열이다** ──────────────────────────────── */

/**
 * 거절 안내는 **모델이 쓰지 않는다.** PRD 8절 A3 가 요구하는 것이 이것이다 —
 * 코퍼스 밖 법령의 *내용*이 들어가면 안 되고, 소관 안내는 고정 목록에서만 와야 한다.
 */
export function refusalText(state: '코퍼스밖' | '규범밖', outside: ScopeNote[]): string[] {
  if (state === '규범밖') {
    return [
      '이 챗봇은 식품의 표시사항과 광고 문구가 규정에 맞는지를 조문 근거로 안내합니다.',
      '이 질문은 그 목적 밖이라 답하지 않습니다.',
    ]
  }
  const lines = outside.length
    ? [
        '이 질문은 이 자료의 범위 밖입니다.',
        ...outside.map((o) => `· ${o.topic} — ${o.owner} 소관입니다.`),
        '이 챗봇은 다른 법령의 내용을 답하지 않습니다. 소관만 알려 드립니다.',
      ]
    : [
        '법령에 관한 질문으로 보이지만, 이 자료에는 답할 근거가 없습니다.',
        '어느 법령 소관인지는 이 자료로 알 수 없어 말하지 않습니다.',
      ]
  // 「자료에 없다」와 「법령에 없다」는 전혀 다른 말이다. 이 문장이 그 경계를 지킨다
  lines.push(
    '이 자료는 대한민국 법령의 일부입니다 — 범위 밖이라는 것은 규정이 없다는 뜻이 아닙니다.',
  )
  return lines
}

export const STATE_HINT: Record<EvidenceState, string> = {
  근거충분: '조문이 있고 답이 그 안에 있습니다. 다만 개별 제품의 해당 여부는 단정하지 않습니다.',
  근거약함: '조문이 직접 말하지 않는 부분이 있습니다. 아래 한계를 함께 읽으세요.',
  일부범위밖: '질문이 경계에 걸쳤습니다. 범위 안인 부분만 답했습니다.',
  코퍼스밖: '규정은 있을 수 있으나 이 자료 밖입니다.',
  규범밖: '이 챗봇의 목적 밖입니다.',
}
