import type { Chunk } from '../lib/corpus.ts'
import { isFutureEffective, locationLabel } from '../lib/evidence.ts'

/**
 * S6 — 출처 칩. 답변 바로 아래에서 **답변이 무엇을 근거로 삼았는지**를 한 줄로 보여 준다.
 *
 * 세 종류를 시각적으로 가른다:
 * 1. **인용됨** — 답변이 `[S2]` 로 지목한 근거. 진하게
 * 2. **실렸지만 인용 안 됨** — 프롬프트에는 들어갔는데 답변이 쓰지 않은 것. 흐리게.
 *    지우지 않는 이유: 모델이 좋은 근거를 흘렸을 수 있고, 그건 사용자가 봐야 안다
 * 3. **없는 자료 인용** — 실리지 않은 번호를 댄 것. 누를 곳이 없다(가리킬 조문이 없으니까).
 *    **이건 경고다** — 답변이 근거를 지어냈다는 뜻이다
 */

export type ChipItem = { label: string; chunk: Chunk; cited: boolean }

export function SourceChips({
  items,
  invalid,
  lenient,
  onOpen,
}: {
  items: ChipItem[]
  invalid: string[]
  /** 맨숫자 표기(`[2]`)까지 받아서 읽은 결과인가 */
  lenient: boolean
  onOpen: (label: string) => void
}) {
  const citedCount = items.filter((i) => i.cited).length
  return (
    <div className="chips-block">
      <p className="muted">
        <strong>출처 {items.length}개</strong> — 답변이 인용한 것 {citedCount}개. 누르면 조문
        원문과 law.go.kr 링크가 열립니다.
        {lenient && (
          <>
            {' '}
            <strong>표기 주의:</strong> 답변이 <code>[S2]</code> 가 아니라 <code>[2]</code> 처럼
            적어서 번호만으로 읽었습니다.
          </>
        )}
      </p>
      <div className="chips">
        {items.map(({ label, chunk, cited }) => (
          <button
            key={label}
            type="button"
            className={`srcchip${cited ? ' on' : ''}`}
            onClick={() => onOpen(label)}
            title={`${chunk.lawName} ${chunk.path}`}
          >
            <span className="chip-label">{label}</span>
            <span className="chip-src">{chunk.source}</span>
            <span className="chip-loc">{locationLabel(chunk)}</span>
            {isFutureEffective(chunk) && <span className="eff eff-future">시행 예정</span>}
          </button>
        ))}
        {invalid.map((label) => (
          <span key={label} className="srcchip bad" title="이 번호의 자료는 실리지 않았습니다">
            <span className="chip-label">{label}</span>
            <span className="chip-loc">없는 자료를 인용했습니다</span>
          </span>
        ))}
      </div>
    </div>
  )
}
