/**
 * 답변 안의 자료 인용을 뽑고, 그 인용이 실제로 있는 자료를 가리키는지 가른다.
 *
 * **S6(출처 칩)·S7(근거 상태 규칙)·S8(규칙 배지)이 전부 이 한 파일 위에 선다.**
 * 셋이 같은 것을 보게 하려고 `App.tsx` 인라인에서 여기로 뺐다 — 세 곳이 각자 세면
 * 화면의 「인용 S1 S3」과 배지의 판정이 어긋날 수 있고, 그 어긋남은 조용하다.
 */

/** `[S1]` · `(S1, S5)` — 프롬프트가 요구한 표기. 괄호 모양은 따지지 않는다 */
const LABELLED = /[[(]\s*(S\d+(?:\s*[,·]\s*S\d+)*)\s*[\])]/g
/** `[2]` · `[1, 3]` — `S` 는 빠졌지만 **대괄호**다 */
const SQUARE_BARE = /\[\s*(\d+(?:\s*[,·]\s*\d+)*)\s*\]/g
/** `(2)` · `(1, 3)` — 맨숫자에 **소괄호**. 가장 위험한 형태다 (아래 주석) */
const PAREN_BARE = /\(\s*(\d+(?:\s*[,·]\s*\d+)*)\s*\)/g

const byNumber = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))

function collect(answer: string, re: RegExp): string[] {
  const found = new Set<string>()
  for (const m of answer.matchAll(re)) {
    for (const one of m[1].matchAll(/\d+/g)) found.add(`S${one[0]}`)
  }
  return [...found].sort(byNumber)
}

export type Extraction = {
  ids: string[]
  /** 맨숫자 표기까지 받아 준 결과인가. **S11b 실험 축 3이 이 스위치를 잰다** */
  lenient: boolean
}

/**
 * 인용을 뽑는다. **괄호 모양에 따라 세 갈래다.**
 *
 * 프롬프트가 `[S1]` 을 요구하지만 실측은 그렇게 오지 않는다:
 *
 * - `qwen3.5:2b` 가 `(S1, S5)` 로 썼다 (S5 실측)
 * - **같은 모델이 같은 질문에서 한 번은 `[2]`, 다음엔 `[S2]`** 로 썼다 (S10 실측,
 *   FINDINGS 10절). 표기 흔들림은 모델 간 차이가 아니라 **같은 모델 안의 분산**이다
 * - **한 답변 안에서도 섞인다** — S6 검증에서 같은 답변이 `[S2][S5]` 와 `[4]` 를 같이
 *   썼다. 그러니 「S 표기가 하나라도 있으면 맨숫자는 무시」로는 진짜 인용을 흘린다
 *
 * 재려는 것은 「모델이 근거를 댔는가」이지 「대괄호를 썼는가」가 아니다. 그렇다고 맨숫자를
 * 다 받으면 반대로 틀린다 — 답변이 조문을 인용하며 「(2)」 같은 열거를 그대로 옮기면
 * 그게 인용으로 세어져 **없는 근거를 댄 것처럼** 보이고, 그 거짓 양성은 S7 의 근거 상태와
 * S8 의 규칙 배지를 조용히 밀어 올린다.
 *
 * **코퍼스를 세어서 갈랐다** (365청크 실측):
 *
 * | 형태 | 조문 원문에 등장 | 처리 |
 * |---|---|---|
 * | `[2]` 대괄호 맨숫자 | **0회** | 늘 인용으로 센다 — 이 도메인 글에 대괄호가 없다 |
 * | `(2)` 소괄호 맨숫자 | **297회** (「타) 주의사항(1) …」) | `S`·대괄호가 하나도 없을 때만 |
 *
 * 즉 위험한 것은 맨숫자 자체가 아니라 **소괄호**였다. 내려갔다는 사실은 `lenient` 로 밖에
 * 알린다 — 화면이 그걸 말할 수 있어야 한다.
 */
export function extractCitationsDetailed(answer: string): Extraction {
  const labelled = collect(answer, LABELLED)
  const square = collect(answer, SQUARE_BARE)
  const safe = [...new Set([...labelled, ...square])].sort(byNumber)
  if (safe.length) return { ids: safe, lenient: square.length > 0 }
  const paren = collect(answer, PAREN_BARE)
  return { ids: paren, lenient: paren.length > 0 }
}

/** 번호만 필요한 곳(스크립트·하네스)을 위한 얇은 겉면 */
export function extractCitations(answer: string): string[] {
  return extractCitationsDetailed(answer).ids
}

export type Citations = Extraction & {
  /** 실제로 실린 자료를 가리키는 인용 */
  valid: string[]
  /** 실리지 않은 번호를 가리키는 인용. **이게 있으면 답변을 그대로 믿으면 안 된다** */
  invalid: string[]
}

/**
 * 인용을 유효/무효로 가른다. `labels` 는 이 답변에 **실제로 실린** 자료 번호다.
 *
 * 답변이 들고 있는 라벨을 쓴다 — 화면의 현재 검색 결과가 아니라. 새 질문을 던져 근거가
 * 바뀌어도 앞 답변의 판정은 그 답변이 받았던 자료로 남아야 한다.
 */
export function splitCitations(answer: string, labels: string[]): Citations {
  const { ids, lenient } = extractCitationsDetailed(answer)
  const has = new Set(labels)
  return {
    ids,
    lenient,
    valid: ids.filter((c) => has.has(c)),
    invalid: ids.filter((c) => !has.has(c)),
  }
}
