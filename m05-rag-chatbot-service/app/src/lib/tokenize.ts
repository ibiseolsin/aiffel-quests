/**
 * 법령 검색용 토크나이저.
 *
 * 이 도메인에 맞춰 세 가지를 한다:
 *
 * 1. **조문 참조를 하나의 토큰으로 뽑는다** (`제8조` `제1항` `제3호` `별표1`).
 *    사용자가 조문 번호를 그대로 묻기 때문이다 — 임베딩이 놓치는 것이 정확히 이것이고,
 *    BM25 를 붙이는 이유가 이것이다 (PLAN 하이브리드 근거).
 * 2. **동그라미 숫자를 항 표기로 펴 준다.** 본문은 `①` 로 오고 사람은 「제1항」이라 쓴다.
 *    이걸 안 맞추면 같은 조항을 가리키는 두 표기가 서로 만나지 못한다.
 * 3. **한국어는 2글자 n-gram 도 함께 넣는다.** 조사가 붙어 「광고를」 「광고가」 「광고는」이
 *    다 다른 토큰이 되는데, 형태소 분석기를 브라우저에 넣을 수는 없다. n-gram 이
 *    그 자리를 메운다 — 「광고」가 세 경우 모두에서 나온다.
 */

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

/** `①` → ` 제1항 `. 붙어 있는 표기를 떼어 놓아야 토큰이 된다 */
export function normalize(text: string): string {
  let out = ''
  for (const ch of text) {
    const i = CIRCLED.indexOf(ch)
    out += i >= 0 ? ` 제${i + 1}항 ` : ch
  }
  return out
    .replace(/[ㆍ·]/g, ' ')
    .replace(/[「」『』（）()[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 조문 참조 — 이 형태는 통째로 하나의 토큰이어야 뜻이 있다 */
const REFERENCE = /제\d+조(?:의\d+)?|제\d+항|제\d+호|제\d+목|별표\s*\d+/g

/** 낱말 — 한글·영숫자 덩어리 */
const WORD = /[가-힣]+|[A-Za-z][A-Za-z0-9]*|\d+/g

export function tokenize(text: string, ngrams = true): string[] {
  const t = normalize(text)
  const tokens: string[] = []

  for (const m of t.matchAll(REFERENCE)) tokens.push(m[0].replace(/\s+/g, ''))

  // 참조로 이미 잡은 부분은 낱말에서 빼야 「제」 「8」 「조」 같은 조각이 늘지 않는다
  const rest = t.replace(REFERENCE, ' ')
  for (const m of rest.matchAll(WORD)) {
    const w = m[0]
    tokens.push(w)
    // 한글만 n-gram 을 만든다. 영숫자는 조사가 붙지 않는다
    if (ngrams && /^[가-힣]+$/.test(w) && w.length > 2) {
      for (let i = 0; i + 2 <= w.length; i++) tokens.push(w.slice(i, i + 2))
    }
  }
  return tokens
}
