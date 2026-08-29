/**
 * S8 — 자동 판정. **두 층이고, 섞지 않는다** (PRD 3절 F5).
 *
 * | 층 | 방식 | 왜 |
 * |---|---|---|
 * | 규칙 | 결정적·무료 | 조문 오인용이 이 도메인에서 가장 치명적인 실패다 |
 * | LLM | 확률적 | 「문장이 조문에서 나왔는가」는 규칙으로 못 잰다 |
 *
 * **규칙이 잡는 범위를 과장하지 않는다.** 인용 유효성 규칙이 보는 것은 **집합 소속**뿐이다:
 * 답변이 든 번호가 실제로 실린 자료인가. 번호는 맞는데 내용을 왜곡했거나, 무관한 조문을
 * 방패로 인용한 것은 **통과한다**. FINDINGS 11절에서 그 경로가 실제로 재현됐다
 * (Q2 의 1위가 어린이 기호식품 **조리·판매** 영업자용 고시인데 포장식품 질문에 걸린다).
 * 그래서 화면이 「규칙이 못 잡는 것」을 같이 말해야 한다.
 */

import { generateJson, type EngineConfig, type JsonSchema } from './engine.ts'
import type { Citations } from './citations.ts'
import type { Chunk } from './corpus.ts'
import { REFUSING, type EvidenceState } from './evidence-state.ts'

/* ─── 규칙 층 — 결정적 ──────────────────────────────────────────────────── */

export type RuleVerdict = {
  /** 통과 / 걸림 / 잴 것이 없음 */
  pass: boolean | null
  label: string
  detail: string
}

export type RuleVerdicts = {
  citation: RuleVerdict
  refusal: RuleVerdict
}

export function ruleVerdicts(input: {
  state: EvidenceState
  citations: Citations
  cancelled: boolean
}): RuleVerdicts {
  const { state, citations, cancelled } = input
  const refused = REFUSING.includes(state)

  const citation: RuleVerdict = refused
    ? { pass: null, label: '해당 없음', detail: '답을 만들지 않았으므로 인용할 것이 없습니다.' }
    : !citations.ids.length
      ? { pass: false, label: '인용 없음', detail: '답변이 자료 번호를 하나도 달지 않았습니다.' }
      : citations.invalid.length
        ? {
            pass: false,
            label: '무효 인용',
            detail: `실리지 않은 번호를 인용했습니다 — ${citations.invalid.join(' ')}. 이건 답변이 근거를 지어냈다는 뜻입니다.`,
          }
        : {
            pass: true,
            label: `인용 ${citations.valid.length}개 유효`,
            detail: `${citations.valid.join(' ')} 전부 실제로 실린 자료입니다.${
              citations.lenient ? ' (표기가 흔들려 번호만으로 읽었습니다)' : ''
            }`,
          }

  const refusal: RuleVerdict = refused
    ? {
        pass: true,
        label: '정당한 거절',
        detail: `근거가 없어 답을 만들지 않았습니다 (${state}). 지어내지 않은 것이므로 경계가 작동한 증거로 셉니다.`,
      }
    : {
        pass: null,
        label: cancelled ? '중단됨' : '거절 안 함',
        detail: cancelled
          ? '답변이 중간에 끊겨 판정 대상이 아닙니다.'
          : '근거를 받아 답을 만들었습니다.',
      }

  return { citation, refusal }
}

/* ─── LLM 층 — 확률적 ──────────────────────────────────────────────────── */

/**
 * **FINDINGS 2절의 계약을 그대로 지킨다.** 2B 모델로 세 번 시도해서 얻은 결론이고,
 * 넷 다 지켜야 답이 맞게 온다:
 *
 * 1. `format` 에 **JSON 스키마**를 넘긴다 (`format:"json"` 만으로는 필드명이 변조된다)
 * 2. **긍정형 필드명** — `noHalluc` 은 참/거짓이 뒤집혀 돌아온다
 * 3. **척도를 필드명에 박는다** — 스키마의 `maximum` 만으로는 안 지켜진다
 * 4. **모든 필드에 `description`**
 *
 * 필드 이름을 강의노트와 다르게 쓴다. 퀘스트 명세는 필드명을 강제하지 않고
 * (「근거성과 거절 여부 등을 자동 판정」), 의미가 맞는 쪽을 택했다.
 */
export const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    groundedInSources: {
      type: 'boolean',
      description: '답변의 주장이 전부 아래 [자료]의 조문에서 나왔으면 true. 하나라도 자료 밖 내용이면 false.',
    },
    hallucinated: {
      type: 'boolean',
      description: '자료에 없는 조문 번호·수치·문구를 답변이 만들어 냈으면 true. 만들어 내지 않았으면 false.',
    },
    citedIds: {
      type: 'boolean',
      description: '답변이 근거로 쓴 자료 번호([S1] 같은 것)를 실제로 달았으면 true.',
    },
    refusedForNoEvidence: {
      type: 'boolean',
      description: '자료에 근거가 없다고 밝히며 답을 미룬 부분이 있으면 true.',
    },
    scoreOutOf100: {
      type: 'integer',
      description: '답변이 자료에 근거한 정도를 0~100 으로. 100 이 만점이다.',
    },
    comment: {
      type: 'string',
      description: '위 판정의 이유를 한국어 한두 문장으로. 어느 문장이 문제인지 짚어라.',
      minLength: 10,
    },
  },
  required: [
    'groundedInSources',
    'hallucinated',
    'citedIds',
    'refusedForNoEvidence',
    'scoreOutOf100',
    'comment',
  ],
}

export type LlmVerdict = {
  groundedInSources: boolean
  hallucinated: boolean
  citedIds: boolean
  refusedForNoEvidence: boolean
  scoreOutOf100: number
  comment: string
}

export function buildJudgePrompt(input: {
  question: string
  answer: string
  evidence: { label: string; chunk: Chunk }[]
}): string {
  const sources = input.evidence
    .map(({ label, chunk }) => `[${label}] ${chunk.source} ${chunk.path}\n${chunk.text}`)
    .join('\n\n')

  return `당신은 채점자다. 아래 [답변]이 [자료]에 근거했는지만 판정한다.
답변의 문장이 매끄러운지, 법적으로 옳은지는 보지 않는다. **자료에 있는가만 본다.**

판정 규칙:
- 자료에 없는 조문 번호·수치·문구가 답변에 있으면 hallucinated = true
- 답변의 주장이 전부 자료에서 나왔으면 groundedInSources = true
- 자료를 요약·재구성한 것은 만들어 낸 것이 아니다. **없는 사실을 더한 것**만 만들어 낸 것이다

[자료]
${sources}

[답변]
${input.answer}

[원래 질문]
${input.question}`
}

/** 판정 결과 또는 판정 실패. **실패해도 답변은 그대로 둔다** (PRD 5절 규칙 3) */
export type JudgeOutcome =
  | { ok: true; verdict: LlmVerdict; ms: number; model: string }
  | { ok: false; message: string; hint?: string; ms: number; model: string }

export async function judge(
  config: EngineConfig,
  input: { question: string; answer: string; evidence: { label: string; chunk: Chunk }[] },
  signal: AbortSignal,
): Promise<JudgeOutcome> {
  const t0 = performance.now()
  try {
    const raw = await generateJson(config, buildJudgePrompt(input), JUDGE_SCHEMA, signal)
    return {
      ok: true,
      verdict: normalize(raw),
      ms: performance.now() - t0,
      model: config.model,
    }
  } catch (e) {
    const err = e as { message: string; hint?: string }
    return { ok: false, message: err.message, hint: err.hint, ms: performance.now() - t0, model: config.model }
  }
}

/**
 * 스키마를 강제해도 **값이 계약대로 온다는 보장은 없다.** 척도를 무시한 사례가 실측에
 * 있다(스키마에 `maximum:100` 을 줬는데 `score: 5`). 그래서 받은 뒤에 한 번 더 본다 —
 * 다만 **고쳐 쓰지 않고 경계로만 자른다.** 5를 50으로 늘려 주면 그건 우리가 만든 점수다.
 */
function normalize(raw: unknown): LlmVerdict {
  const o = (raw ?? {}) as Record<string, unknown>
  const bool = (v: unknown) => v === true
  const n = Number(o.scoreOutOf100)
  return {
    groundedInSources: bool(o.groundedInSources),
    hallucinated: bool(o.hallucinated),
    citedIds: bool(o.citedIds),
    refusedForNoEvidence: bool(o.refusedForNoEvidence),
    scoreOutOf100: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0,
    comment: typeof o.comment === 'string' ? o.comment : '',
  }
}
