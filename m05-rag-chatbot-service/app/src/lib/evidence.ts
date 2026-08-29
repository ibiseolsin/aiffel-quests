/**
 * 근거를 **화면에 어떻게 적을 것인가**. 출처 칩·근거 목록·근거 모달이 같은 함수를 쓴다.
 *
 * 이 파일이 있는 이유는 S11a 가 찾아낸 것 하나다 (FINDINGS 11절):
 * Q3(쿠키 영양성분표)의 상위 6개가 **전부 다른 식품유형** 청크인데 경로 라벨이 다
 * `식품등의 표시기준 본문` 이라 **화면에서 구별이 되지 않았다.** 사용자가 검증할 수
 * 없는 출처 표기는 출처가 아니다.
 */

import type { Chunk } from './corpus.ts'

/** `path` 가 위치를 말해 주지 않는 값들. 고시 청크 66개가 여기 걸린다 */
const MUTE_PATH = /^(본문|)$/

/**
 * 본문 첫머리에서 위치를 읽는다.
 *
 * 청크 분할기(S2)가 고시 본문의 계층 머리말을 **텍스트 앞에 남겨 두었다** —
 * 「Ⅰ. 총 칙 1. 식품 가. 과자류, 빵류 또는 떡류 …」. `path` 가 비어도 이 머리말이
 * 식품유형까지 구분해 준다. **없는 구조를 지어내지 않고 있는 글자를 그대로 자른다.**
 */
export function textHead(text: string, max = 46): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/** 칩과 목록에 쓸 위치 표기. `path` 가 말해 주지 않으면 본문 첫머리로 대신한다 */
export function locationLabel(chunk: Chunk): string {
  return MUTE_PATH.test(chunk.path) ? textHead(chunk.text) : chunk.path
}

/** `path` 를 못 쓰고 본문 첫머리로 대신했는가. 모달이 그 사실을 밝힌다 */
export function locationIsDerived(chunk: Chunk): boolean {
  return MUTE_PATH.test(chunk.path)
}

/**
 * 이 조문이 **아직 시행되지 않았는가.**
 *
 * 두 가지를 다 본다: 수집 때 계산한 `inForce` 와, 오늘 날짜로 다시 잰 시행일. 앞의
 * 것만 믿으면 **코퍼스가 오래될수록 조용히 틀린다** — 수집 시점엔 시행 중이 아니었던
 * 조문이 오늘은 시행 중일 수 있고, 그 반대도 있다. 이 제품이 가장 하지 말아야 할 실수가
 * 시행 예정 기준을 현행으로 제시하는 것이다 (PRD 5절 규칙 6, FINDINGS 함정 ③).
 */
export function isFutureEffective(chunk: Chunk, today = new Date()): boolean {
  const iso = today.toISOString().slice(0, 10)
  return !chunk.inForce || chunk.effectiveDate > iso
}

export type LawLink = {
  href: string
  /** 링크가 **그 조문까지** 가는가, 법령·고시 전체로만 가는가 */
  exact: boolean
}

/**
 * law.go.kr 링크와 그 링크가 어디까지 데려다 주는지.
 *
 * 법령은 `/법령/<법령명>/제8조` 로 **조문까지** 간다. 고시는 조문 단위 앵커가 없어
 * **고시 전체**로만 간다. 「누르면 그 조문이 나온다」와 「누르면 그 고시가 나온다」는
 * 다른 말이고, 검증 경로를 파는 화면에서 그 차이를 뭉개면 안 된다.
 */
export function lawLink(chunk: Chunk): LawLink {
  return { href: chunk.url, exact: /\/법령\/.+\/제/.test(chunk.url) }
}
