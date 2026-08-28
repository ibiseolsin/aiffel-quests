import './App.css'

/**
 * S1 — 껍데기와 배포 파이프라인.
 *
 * 아직 기능이 없다. 이 화면의 목적은 배포 경로가 실제로 뚫렸는지 확인하는 것뿐이다.
 * 헤더 구조는 PRD 5절을 따라 미리 잡아 둔다 — 엔진 선택 / 시행일 / 법률 자문 아님 안내가
 * 들어갈 자리를 지금 만들어 두면 뒤 슬라이스에서 레이아웃을 다시 짜지 않는다.
 */

const SLICES = [
  { id: 'S2', label: '법령 수집과 청크' },
  { id: 'S3', label: '벡터스토어 · 브라우저 질의 임베딩' },
  { id: 'S4', label: '하이브리드 검색' },
  { id: 'S5', label: '프롬프트 조립 · 답변 스트리밍' },
  { id: 'S6', label: '출처 칩 · 근거 모달' },
  { id: 'S7', label: '근거 상태 5단 · 범위 밖 안내' },
  { id: 'S8', label: '판정 — 규칙 배지 · LLM 배지' },
  { id: 'S9', label: '엔진 전환 (로컬 / API)' },
  { id: 'S10', label: '사람 피드백' },
]

export default function App() {
  return (
    <div className="page">
      <header className="header">
        <h1>식품 표시·광고 규정 안내</h1>
        <p className="lede">
          내가 만든 식품을 판매채널에 올릴 때, <strong>표시사항과 광고 문구가 규정에 맞는가</strong>를
          실제 법령 조문을 근거로 답합니다.
        </p>

        <div className="slots" aria-label="아직 동작하지 않는 자리">
          <span className="slot">엔진 — 미연결</span>
          <span className="slot">시행 중 법령 기준 — 미설정</span>
        </div>

        <p className="disclaimer" role="note">
          <strong>법률 자문이 아닙니다.</strong> 조문을 찾아 보여 주는 안내이며, 개별 제품의
          적법성 최종 판단은 하지 않습니다. 최종 확인은 식품의약품안전처 또는 전문가에게
          받으세요.
        </p>
      </header>

      <main className="main">
        <section className="notice">
          <h2>아직 준비 중입니다</h2>
          <p>
            지금 이 페이지는 <strong>배포 경로가 뚫렸는지 확인하기 위한 껍데기</strong>입니다.
            질문에 답하는 기능은 아직 없습니다.
          </p>
        </section>

        <section>
          <h2>남은 작업</h2>
          <ol className="slices">
            {SLICES.map((s) => (
              <li key={s.id}>
                <code>{s.id}</code> {s.label}
              </li>
            ))}
          </ol>
          <p className="muted">
            근거 검색은 브라우저에서 돌기 때문에, 완성 후에는 <strong>API 키 없이도</strong> 질문
            → 조문 검색 → 출처 확인까지 쓸 수 있습니다. 엔진이 필요한 것은 답변 생성과 판정뿐입니다.
          </p>
        </section>
      </main>

      <footer className="footer">
        <p>
          아이펠 AI 에이전트 과정 Main Quest 3 ·{' '}
          <a href="https://github.com/ibiseolsin/aiffel-quests" target="_blank" rel="noreferrer">
            저장소
          </a>
        </p>
        <p className="muted">
          자료 출처: 국가법령정보센터 (law.go.kr) 공개 API
        </p>
      </footer>
    </div>
  )
}
