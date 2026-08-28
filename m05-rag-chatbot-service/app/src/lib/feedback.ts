/**
 * S10 — 사람 피드백. **브라우저 로컬에만 남는다** (PRD 6절 비목표: 로그인·서버 없음).
 * 서버로 보내지 않으므로 타인의 피드백은 수집되지 않는다 — 이 한계는 PRD 가 명시한 것이다.
 *
 * 저장 목적이 둘이다:
 *   ① A6 — 남긴 평가를 화면에서 다시 볼 수 있어야 한다
 *   ② S11 — 이 기록이 **사람 평가**로 쓰인다 (PRD 9절 루브릭의 「판정 출처: 사람」 행들과
 *      실패 분석의 「어느 단계가 원인인가」)
 *
 * ②가 스키마를 규정한다. 👍/👎 만 남기면 나중에 왜 그렇게 눌렀는지 복원할 수 없으므로,
 * **그 판단을 낳은 입력**(질문·실린 근거·엔진·모델)을 같이 적는다.
 */

export type Vote = 'up' | 'down'

/** 답변에 실제로 실린 근거 하나. 라벨(S1)만으로는 나중에 무엇이었는지 알 수 없다 */
export type Evidence = {
  label: string
  /** 청크 ID — 코퍼스가 갱신돼도 어느 조문이었는지 추적할 수 있는 유일한 열쇠 */
  chunkId: string
  /** 법령명 (줄이지 않은 것 — PRD 5절 규칙 7) */
  source: string
  /** 조문 위치. 예: 제8조 제1항 제3호 */
  path: string
}

export type FeedbackRecord = {
  id: string
  /** ISO 8601. 표시는 로컬 시각으로 하되 저장은 절대 시각으로 */
  at: string
  vote: Vote
  question: string
  /** 답변 전문. 아래 ANSWER_CAP 까지만 (자른 경우 answerTruncated=true) */
  answerText: string
  answerTruncated: boolean
  /** 취소된 답변에 대한 평가는 완주한 답변의 평가와 같이 셀 수 없다 */
  cancelled: boolean
  evidence: Evidence[]
  /** 답변이 실제로 인용한 라벨 / 그 중 근거 집합에 없던 것 (규칙 판정의 재료) */
  cited: string[]
  invalidCited: string[]
  engine: string
  model: string
  /** Gemini 창구 (studio / vertex / vertex-sa). Ollama 면 없다 */
  flavor?: string
  /**
   * S8 의 자동 판정을 나중에 여기 붙인다. 지금은 판정이 없으므로 **null 로 정직하게 둔다** —
   * 빈 객체를 넣으면 「판정했는데 아무것도 안 걸렸다」와 구분되지 않는다.
   */
  verdicts: null
  /** 스키마 판(版). 나중에 필드가 바뀌면 이 값으로 갈라 읽는다 */
  v: 1
}

const STORE = 'm05.feedback.v1'
/** 답변 전문은 길 수 있다. 5MB 한도를 혼자 먹지 않게 자른다 */
const ANSWER_CAP = 4000
/** 오래된 것부터 버린다. 200개면 S11 실험 한 바퀴를 충분히 담는다 */
const MAX = 200

function read(): FeedbackRecord[] {
  try {
    const raw = localStorage.getItem(STORE)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 손상된 항목 하나가 목록 전체를 못 읽게 만들지 않는다
    return parsed.filter(
      (r): r is FeedbackRecord =>
        !!r && typeof r === 'object' && typeof (r as FeedbackRecord).id === 'string',
    )
  } catch {
    return []
  }
}

export function loadFeedback(): FeedbackRecord[] {
  return read()
}

export type SaveInput = {
  /** 이미 남긴 평가를 바꾸는 경우 그 id. 👍 → 👎 는 새 기록이 아니라 **정정**이다 */
  id?: string | null
  vote: Vote
  question: string
  answerText: string
  cancelled: boolean
  evidence: Evidence[]
  cited: string[]
  invalidCited: string[]
  engine: string
  model: string
  flavor?: string
}

/** 저장 실패(용량 초과·프라이빗 모드)는 조용히 삼키지 않는다 — 남았다고 거짓말하게 된다 */
export class FeedbackError extends Error {}

export function saveVote(input: SaveInput): { list: FeedbackRecord[]; record: FeedbackRecord } {
  const list = read()
  const record: FeedbackRecord = {
    id: input.id || `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    vote: input.vote,
    question: input.question.trim(),
    answerText: input.answerText.slice(0, ANSWER_CAP),
    answerTruncated: input.answerText.length > ANSWER_CAP,
    cancelled: input.cancelled,
    evidence: input.evidence,
    cited: input.cited,
    invalidCited: input.invalidCited,
    engine: input.engine,
    model: input.model,
    ...(input.flavor ? { flavor: input.flavor } : {}),
    verdicts: null,
    v: 1,
  }

  const at = list.findIndex((r) => r.id === record.id)
  if (at >= 0) list[at] = record
  else list.push(record)

  const kept = list.slice(-MAX)
  try {
    localStorage.setItem(STORE, JSON.stringify(kept))
  } catch (e) {
    throw new FeedbackError(
      `이 브라우저에 저장하지 못했습니다 — ${(e as Error).message}. 프라이빗 모드이거나 저장 공간이 찼을 수 있습니다.`,
    )
  }
  return { list: kept, record }
}

export function clearFeedback(): FeedbackRecord[] {
  try {
    localStorage.removeItem(STORE)
  } catch {
    /* 지우지 못해도 화면은 계속 돌아야 한다 */
  }
  return read()
}

/** 같은 질문에 예전에 남긴 평가. `exceptId` 는 지금 보고 있는 평가(중복 계수 방지) */
export function forQuestion(
  list: FeedbackRecord[],
  question: string,
  exceptId?: string | null,
): { up: number; down: number; latest: FeedbackRecord | null } {
  const q = question.trim()
  const mine = list.filter((r) => r.question === q && r.id !== exceptId)
  return {
    up: mine.filter((r) => r.vote === 'up').length,
    down: mine.filter((r) => r.vote === 'down').length,
    latest: mine.at(-1) ?? null,
  }
}

export const VOTE_LABEL: Record<Vote, string> = { up: '👍 도움됐다', down: '👎 아니다' }

/** 저장은 ISO, 표시는 로컬 — 「언제 눌렀는지」는 사람의 시계로 읽어야 한다 */
export function whenLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR')
}
