/**
 * 국가법령정보센터 OPEN API → 사실 단위 청크 JSON.
 *
 *   node scripts/fetch-corpus.mjs
 *
 * 환경변수 LAW_OC 에 본인 OC(law.go.kr 회원 아이디 앞부분)를 넣는다. 없으면 'test' 로 돈다.
 * 산출물: public/corpus/chunks.json  (벡터는 S3 에서 별도 파일로 붙인다)
 *
 * 왜 스크립트인가 — 수집·파싱은 판단이 아니라 결정론적 작업이다. 빌드 시점에 끝내고
 * 브라우저는 질의만 임베딩한다. 그래서 API 키 없는 방문자도 검색까지 쓸 수 있다.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAWS, ADMRULS, OUT_OF_SCOPE } from './sources.mjs'

const OC = process.env.LAW_OC ?? 'test'
/**
 * 시행 예정 자료를 코퍼스에 넣을지. 기본은 제외다.
 *
 * API 의 `[현행]` 은 "지금 시행 중"을 뜻하지 않는다. 그대로 넣으면 시행 예정 기준을
 * 현행으로 답하게 되고, 그건 이 제품이 가장 하지 말아야 할 실수이며 배포 실패 조건이다
 * (PRD 8절). 화면에서 구분해 보여 줄 준비가 되기 전에는 넣지 않는다.
 *
 *   INCLUDE_FUTURE=1 node scripts/fetch-corpus.mjs   ← 조사·비교용으로만
 */
const INCLUDE_FUTURE = process.env.INCLUDE_FUTURE === '1'
const SERVICE = 'https://www.law.go.kr/DRF/lawService.do'
const SEARCH = 'https://www.law.go.kr/DRF/lawSearch.do'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/corpus/chunks.json')

/** 오늘 (KST). 시행 여부 판정 기준. */
const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) // YYYY-MM-DD

// ─────────────────────────────────────────────────────────────── 공통

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const isoDate = (yyyymmdd) => {
  const s = String(yyyymmdd ?? '')
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}
/** law.go.kr 인용 URL 은 법령명에서 공백을 뺀 형태여야 200 이 온다 (실측). */
const urlName = (name) => String(name ?? '').replace(/\s+/g, '')

/**
 * 너무 긴 본문을 하위 표기 계층으로 더 자른다.
 *
 * 법령의 목(가.), 고시의 1) · 가) · (1) 같은 계층이 있다. 한 청크가 수천 자면
 * 검색은 걸려도 "어느 문장이 근거인가"를 사용자가 짚을 수 없다 — 이 제품의 존재 이유가
 * 근거 확인이므로 긴 청크는 그 자체로 결함이다.
 *
 * 반대 방향의 결함도 같이 막아야 한다. 계층 끝까지 쪼개면 "아) 용기ㆍ포장 재질" 처럼
 * 11자 조각이 나오는데, 이건 검색에도 걸리지 않고 걸려도 답의 근거가 되지 못한다.
 * 그래서 세 가지를 지킨다:
 *
 *   1. 머리말(첫 마커 앞의 글)은 각 조각에 맥락으로 붙이되 **다시 쪼개지 않는다.**
 *      붙인 뒤 재귀하면 머리말 자신이 다음 계층의 마커로 잘려 나간다.
 *   2. 형제 조각은 MIN_CHARS 에 닿을 때까지 **묶는다.** 목록 항목들은 원래 같이 읽는 글이다.
 *   3. 마커는 앞이 공백이나 `)` 일 때만 인정한다. `[가-하]\)` 를 그냥 쓰면
 *      「열량 표시 제외)」의 "외)" 가 마커로 잡혀 단어가 두 동막이 난다.
 *
 * 자를 수 없으면 자르지 않고 그대로 둔다. 억지로 글자 수로 끊으면 문장이 반토막 난다.
 */
/**
 * 마커 판별은 **공백이 아니라 순번**으로 한다.
 *
 * 고시 원문은 마커가 앞 단어에 붙어서 온다 — `식품가.` `떡류1)` `제품명나)`.
 * 그래서 "앞이 공백일 때만 마커"로 잡으면 정작 진짜 계층을 통째로 놓친다.
 * 반대로 조건을 풀면 「열량 표시 제외)」의 `외)` 가 마커가 되어 단어가 두 동막이 난다.
 *
 * 실제 구분자는 **목록이 1부터 순서대로 오른다**는 것이다. `외` 는 순번 글자가 아니고,
 * 날짜 「2025. 8. 29.」의 `8.` 은 1 로 시작하지 않는다. 그래서 순번이 기대값과 맞는
 * 마커만 인정한다. 이건 계층 혼동도 같이 막아 준다 — 항목 2 안에 든 `1)` 은
 * 그 계층의 기대값(3)과 다르므로 형제로 오인되지 않는다.
 * 여는 괄호는 배제해야 한다 — `(3)` 안의 `3)` 이 형제로 잡히면 위치 표기가 한 칸 틀린다.
 */
const KO_ORD = [
  ...'가나다라마바사아자차카타파하',
  ...'거너더러머버서어저처커터퍼허',
  ...'고노도로모보소오조초코토포호',
]
const koOrd = (ch) => KO_ORD.indexOf(ch) + 1 // 순번 글자가 아니면 0

const LEVELS = [
  { re: /(?<![제항호조\d])(\d+)\.\s/g, ord: (m) => Number(m[1]) },
  { re: /([가-힣])\.\s/g, ord: (m) => koOrd(m[1]) },
  { re: /(?<!\()(\d+)\)\s?/g, ord: (m) => Number(m[1]) },
  { re: /(?<!\()([가-힣])\)\s?/g, ord: (m) => koOrd(m[1]) },
  { re: /\((\d+)\)\s?/g, ord: (m) => Number(m[1]) },
]

/** 이 계층에서 1 부터 순서대로 오르는 마커의 위치만 돌려준다 */
function markerCuts(text, level) {
  const cuts = []
  let expect = 1
  for (const m of text.matchAll(level.re)) {
    if (level.ord(m) !== expect) continue
    cuts.push(m.index)
    expect += 1
  }
  return cuts
}

const MAX_CHARS = 1200
const MIN_CHARS = 250 // 이보다 짧은 조각은 형제와 붙인다
const HEAD_MAX = 300 // 이보다 긴 머리말은 맥락이 아니라 그 자체로 하나의 청크다

/** 마커 계층 하나로 자른다. 항목이 둘 미만이면 나눌 의미가 없으므로 null */
function cutAt(text, level) {
  const at = markerCuts(text, level)
  if (at.length < 2) return null
  const items = []
  for (let i = 0; i < at.length; i++) items.push(text.slice(at[i], at[i + 1]).trim())
  return { head: text.slice(0, at[0]).trim(), items: items.filter(Boolean) }
}

/** 연속 조각을 MIN_CHARS 이상 budget 이하로 묶는다 */
function pack(items, budget) {
  const out = []
  for (const it of items) {
    const last = out.at(-1)
    if (last && last.length < MIN_CHARS && last.length + 1 + it.length <= budget) {
      out[out.length - 1] = `${last} ${it}`
    } else {
      out.push(it)
    }
  }
  // 꼬리 조각이 홀로 남으면 앞 묶음에 붙인다
  if (out.length > 1 && out.at(-1).length < MIN_CHARS) {
    const tail = out.pop()
    if (out.at(-1).length + 1 + tail.length <= budget) out[out.length - 1] += ` ${tail}`
    else out.push(tail)
  }
  return out
}

function splitLong(text, prefix = '', depth = 0) {
  const glue = (s) => (prefix ? `${prefix} ${s}` : s)
  if (glue(text).length <= MAX_CHARS) return [glue(text)]

  for (let d = depth; d < LEVELS.length; d++) {
    const cut = cutAt(text, LEVELS[d])
    if (!cut) continue

    // 짧은 머리말은 모든 조각이 물고 간다. 긴 머리말은 따로 떼어 그것도 재귀로 자른다
    const short = cut.head && cut.head.length <= HEAD_MAX
    const carry = short ? glue(cut.head) : prefix
    const lead = cut.head && !short ? splitLong(cut.head, prefix, d + 1) : []

    const budget = MAX_CHARS - (carry ? carry.length + 1 : 0)
    if (budget < MIN_CHARS) continue // 머리말이 너무 커서 이 계층으로는 못 나눈다

    const groups = pack(cut.items, budget)
    if (groups.length < 2 && !lead.length) continue

    return [
      ...lead,
      ...groups.flatMap((g) =>
        g.length > budget ? splitLong(g, carry, d + 1) : [carry ? `${carry} ${g}` : g],
      ),
    ]
  }

  // 계층으로 못 자를 때의 마지막 수단 — **문장 경계**로 묶는다.
  // 글자 수로 끊지는 않는다. 반토막 난 문장은 근거로 쓸 수 없기 때문이다.
  // 한국어 법령문은 거의 모두 「…다.」로 끝나므로 이 하나로 문장이 갈린다.
  const sents = text
    .split(/(?<=다\.)\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (sents.length > 1) {
    const budget = MAX_CHARS - (prefix ? prefix.length + 1 : 0)
    if (budget >= MIN_CHARS) {
      const groups = pack(sents, budget)
      if (groups.length > 1) return groups.map((g) => (prefix ? `${prefix} ${g}` : g))
    }
  }
  return [glue(text)]
}

async function fetchJson(base, params) {
  const url = `${base}?${new URLSearchParams({ OC, type: 'JSON', ...params })}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  const body = await res.text()
  // 잘못된 target·필수 파라미터 누락은 200 에 로그인 HTML 이나 빈 응답으로 온다
  if (!body.trim().startsWith('{')) {
    throw new Error(`JSON 이 아닌 응답 (${body.length}B) — ${url}`)
  }
  return JSON.parse(body)
}

/**
 * `기본정보.조문시행일자문자열` · `별표시행일자문자열` 을 파싱한다.
 *
 * 형태: "20260212:제47조의3제1항, 제92조제1항  20260621:제27조의2"
 * 한 법령 안에서 일부 조문만 나중에 시행되는 경우가 여기 드러난다.
 * `조문단위[].조문시행일자` 로는 알 수 없다 — 스냅샷 안에서는 항상 단일값이다.
 */
function futureTargets(str) {
  const out = []
  for (const m of String(str ?? '').matchAll(/(\d{8})\s*:([^\d]*(?:\d(?!\d{7}:)[^\d]*)*)/g)) {
    const date = isoDate(m[1])
    if (date && date > TODAY) out.push({ date, targets: squash(m[2]) })
  }
  return out
}

/**
 * 고시의 "오늘 적용 판" 을 판 목록에서 고른다.
 *
 * 시행일 기준 조회 API 가 없어서 직접 골라야 한다. 규칙은
 *   시행일자 <= 오늘 인 판 중 발령일자가 가장 늦은 것
 * 이다. `현행여부` 를 믿으면 안 되고(시행 2028 판에도 Y 가 붙는다),
 * `max(시행일자)` 로 골라도 안 된다(판이 발령일자 순으로 누적되므로 오래된 본문이 뽑힌다).
 */
async function resolveAdmRulVersion(meta) {
  const versions = []
  for (let page = 1; page <= 5; page++) {
    const json = await fetchJson(SEARCH, {
      target: 'admrul', nw: '2', search: '1', display: '100', page: String(page),
      query: meta.shortNameForSearch ?? meta.searchName,
    })
    const rows = arr(json['AdmRulSearch']?.['admrul'])
    if (!rows.length) break
    for (const r of rows) {
      if (String(r['행정규칙ID']) !== meta.ruleId) continue
      versions.push({
        seq: String(r['행정규칙일련번호']),
        effective: isoDate(r['시행일자']),
        promulgated: isoDate(r['발령일자']),
        current: squash(r['현행연혁구분'] ?? r['현행여부']),
      })
    }
    const total = Number(json['AdmRulSearch']?.['totalCnt'] ?? 0)
    if (page * 100 >= total) break
  }
  if (!versions.length) throw new Error(`판 목록을 못 찾음: ${meta.shortName} (ruleId=${meta.ruleId})`)

  const live = versions.filter((v) => v.effective && v.effective <= TODAY)
  const pick = live.sort((a, b) =>
    a.promulgated === b.promulgated ? a.seq.localeCompare(b.seq) : a.promulgated.localeCompare(b.promulgated),
  ).at(-1)
  const apiCurrent = versions.find((v) => v.current === '현행')
  return {
    versions,
    picked: pick ?? null,
    apiCurrent,
    // API 가 현행이라 부르는 판이 아직 시행 전이면, 오늘 본문은 그 판이 아니다
    pendingAmendment:
      apiCurrent && apiCurrent.effective > TODAY
        ? { seq: apiCurrent.seq, effective: apiCurrent.effective }
        : null,
  }
}

// ─────────────────────────────────────────────────────────── 법령 파서

/**
 * 조 → 항 → 호 → 목 중첩 구조를 사실 단위로 자른다.
 *
 * 자르는 단위는 "호"다. 단 호만 떼면 주어가 사라진다 —
 *   "1. 질병의 예방·치료에 효능이 있는 것으로 인식할 우려가 있는 표시 또는 광고"
 * 이것만으로는 무엇이 금지되는지, 누구에게 적용되는지 알 수 없다. 그래서 청크 본문에
 * **항의 앞머리(stem)를 항상 함께 넣는다.** 단독으로 읽어도 맥락이 서야 한다는 규칙(PRD 4절).
 */
function chunksFromLaw(json, meta) {
  const root = json['법령']
  const basic = root['기본정보']
  const lawName = squash(basic['법령명_한글'])
  const lawEff = isoDate(basic['시행일자'])
  const out = []
  let seq = 0

  // 인용 URL 은 조 단위까지만 성립한다. 항·호를 붙이면 404 가 아니라 엉뚱한 곳으로 간다.
  const push = ({ artLabel, path, text, effective }) => {
    if (!text || text.length < 10) return
    for (const body of splitLong(text)) {
      out.push({
        id: `${meta.code}-${String(++seq).padStart(3, '0')}`,
        source: meta.shortName,
        sourceKind: meta.kind,
        lawName,
        path,
        text: body,
        url: `https://www.law.go.kr/법령/${urlName(lawName)}/${artLabel}`,
        effectiveDate: effective ?? lawEff,
      })
    }
  }

  for (const art of arr(root['조문']?.['조문단위'])) {
    // 편·장·절 머리글은 조문이 아니다. 제목이 없고 본문이 "제1장 총칙" 같은 형태다.
    const title = squash(art['조문제목'])
    if (!title) continue

    const no = String(art['조문번호'])
    // 범위 밖 조문은 애초에 넣지 않는다 (sources.mjs 의 maxArticle)
    if (meta.maxArticle != null && Number(no) > meta.maxArticle) continue
    const branch = art['조문가지번호'] // 제8조 vs 제8조의2 를 가르는 유일한 필드
    const artLabel = branch ? `제${no}조의${branch}` : `제${no}조`
    const artEff = isoDate(art['조문시행일자'])
    const paras = arr(art['항'])

    if (paras.length === 0) {
      // 항이 없는 조 — 조문내용 하나가 곧 사실 단위다 (예: 제1조 목적)
      push({ artLabel, path: artLabel, text: squash(art['조문내용']), effective: artEff })
      continue
    }

    for (const para of paras) {
      const paraLabel = squash(para['항번호']) // ① ② …
      const paraStem = squash(para['항내용'])
      const items = arr(para['호'])

      if (items.length === 0) {
        push({
          artLabel,
          path: `${artLabel}${paraLabel}`,
          text: `${artLabel}(${title}) ${paraStem}`,
          effective: artEff,
        })
        continue
      }

      for (const item of items) {
        const itemNo = squash(item['호번호']).replace(/\.$/, '')
        const subs = arr(item['목'])
          .map((m) => squash(m['목내용']))
          .filter(Boolean)
        const body = [squash(item['호내용']), ...subs].join(' ')
        push({
          artLabel,
          path: `${artLabel}${paraLabel}제${itemNo}호`,
          // 항 stem 을 함께 넣는 이유는 위 주석 참고
          text: `${artLabel}(${title}) ${paraStem} ${body}`,
          effective: artEff,
        })
      }
    }
  }

  return {
    chunks: out,
    lawName,
    effectiveDate: lawEff,
    mst: String(basic['법령키'] ?? basic['법령일련번호'] ?? ''),
    futureArticles: futureTargets(basic['조문시행일자문자열']),
    futureTables: futureTargets(basic['별표시행일자문자열']),
  }
}

// ─────────────────────────────────────────────────────── 행정규칙 파서

/**
 * 고시는 구조가 없다. `조문내용` 이 문자열 배열이고, 항·호·목이 한 문자열에 뭉쳐 온다:
 *
 *   "제2조(부당한 표시 또는 광고의 내용) … 다음 각 호와 같다.1. 식품등을 의약품으로 …
 *    가. 한약의 처방명 또는 별표 1의 … 2. 건강기능식품이 아닌 것을 …"
 *
 * 그래서 정규식으로 호(`1. `) 경계를 찾아 자른다. 자를 때도 조의 앞머리를 함께 넣는다.
 * 목(`가. `)은 호에 붙여 둔다 — 목만 떼면 무엇에 대한 예시인지 사라진다.
 */
/**
 * 조 번호가 없는 고시(「식품등의 표시기준」 등)의 위치 표기를 만든다.
 *
 * 이 고시는 「Ⅰ. 총칙 → 1. 표시방법 → 가. → 1) → 가)」 처럼 로마숫자 계층을 쓴다.
 * 제N조가 없으니 `본문제1호` 같은 표기가 나오는데, 그건 출처 칩에 띄울 수 없다 —
 * 칩은 장식이 아니라 사용자가 원문에서 그 자리를 찾아가는 경로다 (PRD 5절 규칙 2).
 * 그래서 청크 본문 맨 앞의 계층 표기를 그대로 읽어 위치로 쓴다.
 */
const PATH_MAX = 44
const HEADING_MAX = 30 // 이보다 긴 조각은 제목이 아니라 본문이다

/**
 * 계층 표기와 그 깊이. `(3)` 안의 `3)` 과 「제2조」의 숫자는 표기가 아니다.
 * 한글 표기는 **순번 글자만** 인정한다 — 그러지 않으면 「…하여야 함.」의 `함.` 이
 * 표기로 잡혀 위치가 「함.」 으로 나온다.
 */
const SECTION_LEVELS = [
  { d: 0, re: /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\.\s?/g, ok: () => true },
  { d: 1, re: /(?<![제항호조\d])\d+\.\s/g, ok: () => true },
  { d: 2, re: /(?<!\()([가-힣])\.\s/g, ok: (m) => koOrd(m[1]) > 0 },
  { d: 3, re: /(?<!\()\d+\)\s?/g, ok: () => true },
  { d: 4, re: /(?<!\()([가-힣])\)\s?/g, ok: (m) => koOrd(m[1]) > 0 },
  { d: 5, re: /\(\d+\)\s?/g, ok: () => true },
]

/**
 * 청크가 고시 본문의 어디인지를 **계층 표기에서 읽어** 위치로 쓴다.
 * 고시는 조 번호가 없고 구조 없는 문자열로 오기 때문에 다른 단서가 없다.
 *
 * 규칙은 하나다 — **애매해지는 깊이에서 멈춘다.** 어떤 깊이의 표기가 청크 안에 둘 이상
 * 있으면 그 청크는 그 계층의 형제 여럿에 걸쳐 있다는 뜻이므로, 그중 하나를 위치로 적으면
 * 거짓이 된다. 그 위 계층까지가 이 청크에 대해 참인 가장 깊은 위치다.
 *
 * 형제를 남기고 조상을 접으면 안 된다. 「나) 식품유형 다) 영업소… 마)」 같은 것은
 * 위치가 아니라 목록의 일부다. 못 읽거나 줄여도 안 맞으면 「본문」으로 남긴다 —
 * 없는 위치를 지어내지 않는 것이 이 함수의 유일한 목적이다.
 */
function sectionPath(text, fallback) {
  const t = squash(String(text))
  const hits = []
  for (const lv of SECTION_LEVELS) {
    for (const m of t.matchAll(lv.re)) {
      if (!lv.ok(m)) continue
      hits.push({ i: m.index, d: lv.d, len: m[0].length })
    }
  }
  if (!hits.length) return fallback
  hits.sort((a, b) => a.i - b.i || a.d - b.d)

  const seen = new Map()
  for (const h of hits) seen.set(h.d, (seen.get(h.d) ?? 0) + 1)

  const segs = []
  for (const lv of SECTION_LEVELS) {
    const n = seen.get(lv.d) ?? 0
    if (n === 0) continue // 이 계층을 쓰지 않는 고시도 있다
    if (n > 1) break // 형제 여럿에 걸쳐 있다 — 여기부터는 단정할 수 없다
    const k = hits.findIndex((h) => h.d === lv.d)
    const stop = hits[k + 1]?.i ?? t.length
    const seg = squash(t.slice(hits[k].i, stop))
    // 라벨이 길면 본문이 이어진 것이다. 번호만 남긴다
    segs.push(seg.length <= HEADING_MAX ? seg : squash(t.slice(hits[k].i, hits[k].i + hits[k].len)))
  }

  // 길면 위쪽 조상을 조각째로 접는다. 남는 것은 항상 실제 사슬의 뒷부분이다
  let keep = segs
  while (keep.length > 1 && keep.join(' ').length > PATH_MAX) keep = keep.slice(1)
  const path = keep.join(' ')
  if (!path || path.length > PATH_MAX) return fallback
  return keep.length < segs.length ? `… ${path}` : path
}

function chunksFromAdmRul(json, meta) {
  const root = json['AdmRulService'] ?? json
  const basic = root['행정규칙기본정보'] ?? {}
  const ruleName = squash(basic['행정규칙명'])
  const eff = isoDate(basic['시행일자'])
  const promulgated = isoDate(basic['발령일자'])
  const url = `https://www.law.go.kr/행정규칙/${urlName(ruleName)}`
  const out = []
  let seq = 0

  const push = (path, text) => {
    if (!text || text.length < 10) return
    for (const body of splitLong(text)) {
      out.push({
        id: `${meta.code}-${String(++seq).padStart(3, '0')}`,
        // path 는 사용자가 출처 칩에서 읽는 위치 표기다. 아래 sectionPath 참고
        __rawPath: path,
        source: meta.shortName,
        sourceKind: meta.kind,
        lawName: ruleName,
        path,
        text: body,
        url,
        effectiveDate: eff,
      })
    }
  }

  for (const raw of arr(root['조문내용'])) {
    const body = squash(raw)
    if (!body) continue

    const head = body.match(/^(제\d+조(?:의\d+)?)\s*(?:\(([^)]*)\))?/)
    const artLabel = head?.[1] ?? '본문'
    // 첫 호 앞까지가 조의 앞머리(stem)
    const firstItem = body.search(/(?<!제)\d+\.\s/)
    if (firstItem < 0) {
      push(artLabel, body)
      continue
    }

    const stem = squash(body.slice(0, firstItem))
    const rest = body.slice(firstItem)
    // "1. …", "2. …" 경계로 자른다. "제8조제1항" 같은 조문 참조는 위 lookbehind 로 걸러진다.
    const parts = rest.split(/(?=(?<![제항호조])\b\d+\.\s)/).filter((p) => p.trim())

    if (parts.length <= 1) {
      push(artLabel, body)
      continue
    }
    for (const part of parts) {
      const n = part.match(/^(\d+)\.\s/)?.[1]
      push(n ? `${artLabel}제${n}호` : artLabel, `${stem} ${squash(part)}`)
    }
  }

  // 별표 — 실제 표시 방법이 여기 있다. 다만 ASCII 표가 섞여 있어 통째로는 검색이 어렵다.
  // S2 에서는 제목과 본문을 보존해 두고, 청킹 전략은 크기를 보고 정한다.
  const tables = []
  for (const t of arr(root['별표']?.['별표단위'])) {
    const lines = arr(t['별표내용']).flat().map(squash).filter(Boolean)
    tables.push({
      title: squash(t['별표제목']),
      no: squash(t['별표번호']),
      chars: lines.join('\n').length,
      pdf: t['별표서식PDF파일링크'] ? `https://www.law.go.kr${t['별표서식PDF파일링크']}` : null,
      lines,
    })
  }

  // 조 번호가 없는 고시는 청크 본문에서 위치를 읽어 path 를 만든다
  for (const c of out) {
    // 계층 표기를 못 찾으면 '본문' 으로 둔다. '본문제1호' 는 없는 호 번호를 만들어 내는 것이라
    // 오히려 사용자를 오인시킨다 — 정확히 어디인지 모르면 모른다고 표기한다.
    if (c.__rawPath?.startsWith('본문')) c.path = sectionPath(c.text, '본문')
    delete c.__rawPath
  }

  return { chunks: out, ruleName, effectiveDate: eff, promulgated, tables }
}

// ─────────────────────────────────────────────────────────────── 실행

const report = { collectedAt: TODAY, oc: OC === 'test' ? 'test (본인 OC 미설정)' : 'set', sources: [] }
const chunks = []
const tablesByCode = {}

// ── 법령: eflaw&ID = 오늘 시행 중인 본문 (efYd 를 주지 않는다)
for (const law of LAWS) {
  const json = await fetchJson(SERVICE, { target: 'eflaw', ID: law.lawId })
  const r = chunksFromLaw(json, law)
  chunks.push(...r.chunks)

  // 시행 예정 개정이 있는지 확인 (코퍼스에는 넣지 않고 알림만)
  let pending = null
  try {
    const nw2 = await fetchJson(SEARCH, { target: 'eflaw', LID: law.lawId, nw: '2' })
    const rows = arr(nw2['LawSearch']?.['law']).filter((x) => squash(x['현행연혁코드']) === '시행예정')
    if (rows.length) pending = rows.map((x) => isoDate(x['시행일자'])).filter(Boolean)
  } catch {
    /* 시행예정이 없으면 빈 응답이 온다 */
  }

  report.sources.push({
    code: law.code, kind: law.kind, name: r.lawName, effectiveDate: r.effectiveDate,
    inForce: r.effectiveDate ? r.effectiveDate <= TODAY : null,
    chunks: r.chunks.length,
    futureArticles: r.futureArticles,
    futureTables: r.futureTables,
    pendingEffective: pending,
  })
}

// ── 고시: 판 목록에서 오늘 적용 판을 직접 고른다
for (const rule of ADMRULS) {
  const v = await resolveAdmRulVersion({ ...rule, searchName: rule.shortNameForSearch ?? rule.searchName })
  if (!v.picked) throw new Error(`오늘 시행 중인 판이 없음: ${rule.shortName}`)

  const json = await fetchJson(SERVICE, { target: 'admrul', ID: v.picked.seq })
  const r = chunksFromAdmRul(json, rule)
  chunks.push(...r.chunks)
  tablesByCode[rule.code] = r.tables

  report.sources.push({
    code: rule.code, kind: rule.kind, name: r.ruleName,
    effectiveDate: r.effectiveDate, promulgated: r.promulgated,
    inForce: r.effectiveDate ? r.effectiveDate <= TODAY : null,
    chunks: r.chunks.length,
    tables: r.tables.length,
    tableChars: r.tables.reduce((a, t) => a + t.chars, 0),
    pickedSeq: v.picked.seq,
    versionCount: v.versions.length,
    apiCurrentSeq: v.apiCurrent?.seq ?? null,
    pendingAmendment: v.pendingAmendment,
  })
}

// 시행 여부를 청크마다 계산해 둔다. 이 필드가 없으면 화면이 시행 예정 기준을
// 현행으로 보여 주게 되고, 그건 배포 실패 조건이다 (PRD 8절).
for (const c of chunks) {
  c.inForce = c.effectiveDate ? c.effectiveDate <= TODAY : null
}

const dropped = INCLUDE_FUTURE ? [] : chunks.filter((c) => c.inForce === false)
const kept = INCLUDE_FUTURE ? chunks : chunks.filter((c) => c.inForce !== false)

await mkdir(dirname(OUT), { recursive: true })
await writeFile(
  OUT,
  JSON.stringify(
    {
      collectedAt: TODAY,
      today: TODAY,
      includesFutureEffective: INCLUDE_FUTURE,
      outOfScope: OUT_OF_SCOPE,
      chunks: kept,
    },
    null,
    2,
  ),
  'utf8',
)

// ─────────────────────────────────────────────────────────── 보고

const w = (s, n) => String(s).padEnd(n)
console.log(`\n수집일 ${TODAY} · OC=${report.oc}\n`)
console.log(w('code', 6) + w('종류', 9) + w('시행일', 12) + w('시행중', 8) + w('청크', 6) + '별표')
for (const s of report.sources) {
  console.log(
    w(s.code, 6) + w(s.kind, 9) + w(s.effectiveDate ?? '?', 12) +
    w(s.inForce === null ? '?' : s.inForce ? '예' : '아니오 ⚠', 8) +
    w(s.chunks, 6) + (s.tables != null ? `${s.tables}개 ${Math.round((s.tableChars ?? 0) / 1024)}KB` : '-'),
  )
}
const future = report.sources.filter((s) => s.inForce === false)
console.log(`\n총 ${kept.length} 청크 → ${OUT}`)

const pendingRules = report.sources.filter((s) => s.pendingAmendment)
if (pendingRules.length) {
  console.log('\n⚠ 시행 예정 개정이 대기 중인 고시 — 본문은 오늘 판을 썼다:')
  for (const s of pendingRules) {
    console.log(`   ${s.name}: 오늘 판 ${s.pickedSeq} (시행 ${s.effectiveDate}) / API 현행 ${s.apiCurrentSeq} (시행 ${s.pendingAmendment.effective})`)
  }
}

const pendingLaws = report.sources.filter((s) => s.pendingEffective?.length)
if (pendingLaws.length) {
  console.log('\n⚠ 시행 예정 개정이 대기 중인 법령:')
  for (const s of pendingLaws) console.log(`   ${s.name}: 시행 ${s.pendingEffective.join(', ')}`)
}

const partial = report.sources.filter((s) => s.futureArticles?.length || s.futureTables?.length)
if (partial.length) {
  console.log('\n⚠ 일부 조문·별표가 미시행인 법령:')
  for (const s of partial) {
    for (const f of s.futureArticles ?? []) console.log(`   ${s.name} 조문 ${f.date}: ${f.targets.slice(0, 90)}`)
    for (const f of s.futureTables ?? []) console.log(`   ${s.name} 별표 ${f.date}: ${f.targets.slice(0, 90)}`)
  }
}

if (future.length) {
  const verb = INCLUDE_FUTURE ? '포함됨 (INCLUDE_FUTURE=1)' : `제외됨 (${dropped.length} 청크)`
  console.log(`\n⚠ 본문 자체가 시행 예정인 자료 ${future.length}건 — ${verb}`)
  for (const s of future) console.log(`   ${s.name} (시행 ${s.effectiveDate})`)
}
await writeFile(resolve(HERE, '../public/corpus/collection-report.json'), JSON.stringify(report, null, 2), 'utf8')
await writeFile(resolve(HERE, '../public/corpus/tables.json'), JSON.stringify(tablesByCode, null, 2), 'utf8')
