import { useEffect, useRef } from 'react'
import type { Chunk } from '../lib/corpus.ts'
import { isFutureEffective, lawLink, locationIsDerived } from '../lib/evidence.ts'
import type { HybridHit, Via } from '../lib/search.ts'

/**
 * S6 — 근거 모달. **출처 칩은 장식이 아니라 클릭 가능한 검증 경로다** (PRD 5절 규칙 2).
 *
 * 그래서 여기 있어야 할 것은 「요약」이 아니라 **검증에 필요한 것 전부**다:
 * 줄이지 않은 법령명, 조문 위치, 조문 원문, 시행일, law.go.kr 링크, 그리고 이 조문이
 * 어느 검색 경로로 몇 위에 들어왔는가. 사용자가 화면을 안 믿어도 원문까지 갈 수 있어야 한다.
 *
 * 네이티브 `<dialog>` 를 쓴다 — Escape 로 닫기와 포커스 가둠을 직접 짜면 틀리기 쉽고,
 * 브라우저가 이미 맞게 해 준다.
 */

export type EvidenceView = {
  chunk: Chunk
  /** 이 답변에서의 자료 번호 (`S3`). 근거 목록에서 열면 없다 */
  label?: string
  /** 답변이 실제로 이 근거를 인용했는가 */
  cited?: boolean
  hit?: HybridHit
}

const VIA_LABEL: Record<Via, string> = {
  dense: '의미 검색',
  sparse: '표기 검색',
  both: '의미+표기',
}

export function EvidenceModal({ view, onClose }: { view: EvidenceView | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (view && !el.open) el.showModal()
    if (!view && el.open) el.close()
  }, [view])

  /**
   * **상태가 유일한 진실이고, `<dialog>` 는 그것을 따라간다.** 반대로 두면 안 된다.
   *
   * 처음엔 `close` 이벤트로 부모 상태를 비우려 했다. **그런데 실측에서 `close` 가 아예
   * 오지 않았다** — `dialog.close()` 로 `open` 은 `false` 가 되는데 직접 붙인
   * `addEventListener('close', …)` 도 한 번도 안 불렸다(검증 크롬). 그 위에 동기화를
   * 세웠으면 「닫혔는데 열려 있다고 생각하는」 상태가 남는다.
   *
   * 그래서 닫는 길을 전부 `onClose()` 한 곳으로 모았다: 닫기 버튼 · 바깥 클릭 · Escape.
   * Escape 만 브라우저가 혼자 처리하므로 `cancel` 을 가로채 같은 곳으로 보낸다
   * (`cancel` 은 `close` 와 달리 취소 가능한 별개 이벤트다).
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onCancel = (e: Event) => {
      e.preventDefault() // 브라우저가 혼자 닫게 두지 않는다 — 상태를 거쳐 닫는다
      onClose()
    }
    el.addEventListener('cancel', onCancel)
    return () => el.removeEventListener('cancel', onCancel)
  }, [onClose])

  const { chunk, label, cited, hit } = view ?? {}
  const future = chunk ? isFutureEffective(chunk) : false
  const link = chunk ? lawLink(chunk) : null

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label="근거 조문"
      // 바깥을 눌러도 닫힌다. `<dialog>` 의 클릭은 백드롭까지 자기 자신이 받으므로
      // **대상이 dialog 자신일 때만** 닫는다 — 안쪽을 누른 것은 그대로 둔다
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {chunk && (
        <>
          <div className="modal-head">
            <div>
              {label && <span className="chip-label">{label}</span>}
              <span className="kind">{chunk.sourceKind}</span>
              {/* 규칙 6 — 시행 예정은 현행과 **시각적으로** 구분한다 */}
              <span className={future ? 'eff eff-future' : 'eff eff-now'}>
                {future ? `시행 예정 · ${chunk.effectiveDate}` : `시행 중 · ${chunk.effectiveDate}`}
              </span>
              {cited != null && (
                <span className={cited ? 'cited-yes' : 'cited-no'}>
                  {cited ? '답변이 인용함' : '답변이 인용하지 않음'}
                </span>
              )}
            </div>
            <button className="ghost" type="button" onClick={onClose}>
              닫기
            </button>
          </div>

          {/* 규칙 7 — 법령명을 임의로 줄이지 않는다. 칩은 짧은 이름을 쓰지만 여기서는 원래 이름 */}
          <h3 className="modal-law">{chunk.lawName}</h3>
          <p className="muted modal-loc">
            {chunk.path}
            {locationIsDerived(chunk) && (
              <>
                {' '}
                — <strong>자료에 조문 번호가 없습니다.</strong> 아래 본문 첫머리의 계층
                표기(「Ⅰ. 총 칙 …」)가 위치를 대신합니다
              </>
            )}
            {' · '}
            <code>{chunk.id}</code>
          </p>

          {future && (
            <p className="disclaimer" role="note">
              <strong>이 조문은 아직 시행되지 않았습니다.</strong> 지금 판매채널에 등록하는
              제품에는 <strong>현행 기준</strong>이 적용됩니다.
            </p>
          )}

          <p className="modal-text">{chunk.text}</p>

          {hit && (
            <p className="muted">
              이 근거가 들어온 경로 — <span className={`via via-${hit.via}`}>{VIA_LABEL[hit.via]}</span>{' '}
              · 의미 {hit.denseRank ? `${hit.denseRank}위` : '후보 밖'} (코사인{' '}
              {hit.dense.toFixed(3)}) · 표기 {hit.sparseRank ? `${hit.sparseRank}위` : '후보 밖'}{' '}
              (BM25 {hit.sparse.toFixed(2)}) · 합산 {hit.score.toFixed(3)}
            </p>
          )}

          {link && (
            <p>
              <a href={link.href} target="_blank" rel="noreferrer">
                law.go.kr 에서 원문 보기 →
              </a>
              <br />
              <span className="muted">
                {link.exact
                  ? '이 링크는 해당 조문으로 바로 갑니다.'
                  : '고시에는 조문 단위 주소가 없어 이 링크는 고시 전체로 갑니다 — 위 위치 표기로 찾으세요.'}
              </span>
            </p>
          )}

          <p className="disclaimer" role="note">
            <strong>법률 자문이 아닙니다.</strong> 위 원문과 law.go.kr 을 직접 확인하세요.
          </p>
        </>
      )}
    </dialog>
  )
}
