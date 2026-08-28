import type { Chunk, CorpusMeta } from './corpus.ts'

/**
 * 프롬프트 조립.
 *
 * 순서를 PLAN 이 정해 두었다: 자료가 무엇인지 → 근거 원칙 → `[ID]` 인용 요구 →
 * **법령 시행일과 현재 시각** → 자료 → 질문. 시각을 자료 앞에 두는 이유는,
 * 모델이 「최신 법령」을 자기 학습 시점 기준으로 말하는 것을 막기 위함이다.
 *
 * 청크는 **법령명·조문 위치·시행일**을 잃지 않고 들어간다. 이게 없으면 모델이
 * 「관련 법령에 따르면」 같은 말로 뭉개고, 사용자는 어느 조문인지 확인할 수 없다.
 */

export type PromptInput = {
  question: string
  chunks: { chunk: Chunk; label: string }[]
  meta: CorpusMeta
  /** 코퍼스에 든 조문의 시행일 범위 */
  effectiveFrom: string
  effectiveTo: string
  now: Date
}

/**
 * 「법령에 없다」와 「이 챗봇의 범위에 없다」를 가르는 것이 이 프롬프트의 가장 중요한 일이다.
 *
 * 코퍼스는 대한민국 법령의 **일부**다. 그래서 자료에 없는 것을 「법령에 없습니다」라고
 * 말하면 정당한 거절이 아니라 **틀린 답**이다 — 규정은 분명히 있고 이 자료에 없을 뿐이다.
 * PRD 는 이걸 배포 실패 조건으로 두었다.
 */
const PRINCIPLES = `[답변 원칙]
1. 아래 [자료]에 있는 내용만 근거로 답한다. 자료에 없는 조문 번호·수치·문구를 만들지 않는다.
2. 근거로 쓴 자료마다 문장 끝에 자료 번호를 **대괄호로** 적는다.
   예: "영양표시를 하여야 한다[S2]." / 여러 개면 "…한다[S1][S3]."
   소괄호로 (S1, S3) 처럼 쓰지 않는다.
3. 자료에 없으면 "제공된 자료에서 확인되지 않습니다"라고 말한다.
   **"법령에 없습니다"라고 말하지 않는다** — 이 자료는 대한민국 법령의 일부일 뿐이므로,
   자료에 없다는 것과 법령에 없다는 것은 전혀 다른 말이다.
4. 개별 제품이 위반인지 아닌지 **단정하지 않는다**. 조문의 요건이 "인식할 우려가 있는"처럼
   평가적일 때는 특히 그렇다. 요건이 무엇인지 알려 주고, 판단 기준을 설명하는 데서 멈춘다.
5. 법률 자문이 아니다. 최종 확인은 식품의약품안전처 또는 전문가에게 받도록 안내한다.
6. 한국어로, 실무자가 바로 쓸 수 있게 답한다. 조문을 그대로 베끼지 말고 뜻을 풀어 쓴다.`

export function buildPrompt(input: PromptInput): string {
  const { question, chunks, meta, effectiveFrom, effectiveTo, now } = input

  const sources = chunks
    .map(
      ({ chunk, label }) =>
        `[${label}] ${chunk.source} ${chunk.path} (${chunk.sourceKind}, 시행 ${chunk.effectiveDate})\n${chunk.text}`,
    )
    .join('\n\n')

  const outOfScope = meta.outOfScope.map((o) => `- ${o.topic} → ${o.owner}`).join('\n')

  return `당신은 식품 표시·광고 규정 안내를 돕는 도우미다. 대한민국 「식품 등의 표시·광고에 관한 법률」과
그 시행령·시행규칙, 그리고 식품의약품안전처 고시 일부가 자료로 주어진다.

${PRINCIPLES}

[이 자료가 다루지 않는 것]
아래 주제는 이 자료의 범위 밖이다. 질문이 여기 해당하면 **소관 법령을 알려 주고 그 내용은 말하지 않는다.**
${outOfScope}

[기준 시점]
- 자료의 법령 시행일: ${effectiveFrom} ~ ${effectiveTo} (모두 오늘 기준 시행 중)
- 자료 수집일: ${meta.collectedAt}
- 지금: ${now.toISOString().slice(0, 10)}
당신이 학습한 시점의 법령이 아니라 **위 자료에 적힌 내용**을 기준으로 답한다.

[자료]
${sources}

[질문]
${question}`
}

/**
 * 답변 안의 자료 인용을 뽑는다. 판정(S8)과 출처 강조(S6)가 이걸 쓴다.
 *
 * **표기 형태에 관대하다.** 프롬프트가 `[S1]` 을 요구하지만 2B 모델은 `(S1, S5)` 로도 쓴다
 * (실측). 여기서 재려는 것은 「모델이 근거를 댔는가」이지 「대괄호를 썼는가」가 아니므로,
 * 형태가 달라도 인용으로 센다. 인용의 **유효성**(그 자료가 실제로 있는가)은 판정이 따로 본다.
 */
export function extractCitations(answer: string): string[] {
  const found = new Set<string>()
  // [S1] · (S1) · [S1, S3] · (S1,S5) · S1 뒤에 구두점이 오는 경우까지
  for (const m of answer.matchAll(/[[(]\s*(S\d+(?:\s*[,·]\s*S\d+)*)\s*[\])]/g)) {
    for (const one of m[1].matchAll(/S\d+/g)) found.add(one[0])
  }
  return [...found].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}
