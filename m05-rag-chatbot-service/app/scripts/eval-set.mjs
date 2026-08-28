/**
 * 평가 세트 Q1~Q9 — **확정본. 기계가 읽는 단일 출처.**
 *
 * 여기가 유일한 정의다. PRD 9절의 표는 초안이고, S2·S4 를 거치며 정답 정의가 두 번 바뀌었다
 * (Q5 를 넓혔고 Q7 을 「일부 범위 밖」에서 「코퍼스 밖」으로 정정했다). 그 흔적이 문서 여러
 * 곳에 흩어져 있었으므로 S11 에서 하나로 모았다. **문서를 고치기 전에 여기를 고친다.**
 *
 * 질문 문구는 **판매채널에 식품을 올릴 때 실제로 부딪히는 말**로 썼다. 교과서 문장
 * (「영양성분 표시는 어떤 제품에 의무인가요」)은 검색에 유리하게 쓰인 말이라 측정이 쉬워지고,
 * 그래서 측정이 쓸모없어진다. 실제 판매자는 자기 제품·자기 채널을 주어로 말한다.
 *
 * ## 정답을 ID 로 적는 이유와 그 위험
 *
 * 퀘스트가 요구하는 것은 「근거 조문 ID 목록」이라서 실제 청크 ID 를 박았다. 그런데 ID 는
 * 코퍼스를 다시 만들면 밀린다 — S2 에서 청크 분할기를 다시 쓰면서 365 개로 바뀐 전례가 있다.
 * ID 만 박아 두면 그때 **조용히 다른 조문을 정답이라고 세게 된다.**
 *
 * 그래서 `goldCheck` 를 같이 둔다. 「이 ID 의 본문이 아직 내가 의도한 조문인가」를 재는
 * 정규식이고, `verifyEvalSet()` 이 이걸 확인한다. 어긋나면 **소리 내어 멈춘다.**
 *
 * ## 정답 정의를 늘려서 통과시키지 않는다
 *
 * `alsoRelevant` 는 「관련은 있지만 정답으로 세지 않는 조문」이다. Q1 이 실패하는 것을 보고
 * 여기 있는 것들을 `gold` 로 옮기면 점수가 올라가지만 측정은 무의미해진다
 * (FINDINGS 6절 「정답 정의가 좁았던 것을 하나 고쳤다」의 반대 함정).
 * `gold` 를 넓히는 것은 **그 조문이 질문에 실제로 답할 때만** 정당하다.
 */

/** PRD 7절 · PLAN S7 의 5단. 문자열을 여기서만 정의한다 */
export const EVIDENCE_STATES = ['근거충분', '근거약함', '일부범위밖', '코퍼스밖', '규범밖']

/** 근거 조문이 검색돼야 하는 상태 — 검색 적중을 재는 대상 */
export const STATES_NEEDING_EVIDENCE = ['근거충분', '근거약함', '일부범위밖']

/** 답하지 않고 범위를 안내해야 하는 상태 — 근거 0건이 기대값 */
export const STATES_EXPECTING_REFUSAL = ['코퍼스밖', '규범밖']

export const EVAL_SET = [
  {
    id: 'Q1',
    channel: '쿠팡 상세페이지',
    question: '일반 가공식품인데 쿠팡 상세페이지에 "면역력 강화에 도움"이라고 적어도 되나요?',
    expected: '근거충분',
    gold: ['FLA-031'],
    goldCheck: /질병의 예방ㆍ치료에 효능이 있는 것으로 인식할 우려/,
    why: '금지 유형이 조문 본문에 그대로 있다 — 요건("인식할 우려")까지 자료로 말할 수 있다',
    // 관련은 있으나 정답으로 세지 않는다. 「면역력 강화」를 의약품 오인(제2호)이나
    // 건강기능식품 오인(제3호)으로 볼 여지도 있지만, 이 문항이 재려는 것은
    // **제1호를 찾아오는가**다. 넓히면 아래 `known` 의 실패가 그냥 사라진다
    alsoRelevant: ['FLA-032', 'FLA-033', 'UNF-002'],
    known:
      '알려진 실패 (S4) — 어느 희소가중치에서도 상위 5에 안 들어온다. ' +
      '「면역력 강화」와 「질병의 예방ㆍ치료」가 어휘를 하나도 공유하지 않아 BM25 가 못 잡고, ' +
      'e5-small 이 의미로도 못 잇는다. **하네스는 이 실패를 그대로 드러내야 한다.**',
  },
  {
    id: 'Q2',
    channel: '네이버 스마트스토어 상품정보 고시',
    question: '수제 쿠키에 우유와 대두가 들어가는데 알레르기 유발물질을 어떻게 표시해야 하나요?',
    // PRD 9절은 Q2 를 「정상(근거 조문 + 출처)」으로 뒀다. **S11 에서 근거약함으로 내렸다.**
    // 코퍼스를 실제로 뒤져 보면 포장식품의 알레르기 표시 *방법*은 시행규칙 **별표 2** 에 있고,
    // 코퍼스에는 그 별표를 가리키는 FLR-020 만 있다(별표 본문 없음). ALG 고시는 어린이
    // 기호식품을 **조리·판매**하는 영업자용이라 스마트스토어 포장식품에 그대로 대지 못한다.
    // PRD 가 근거로 든 「알레르기 27청크」는 키워드 등장 수이고, 그 대부분은
    // 표시기준의 식품유형별 표시사항 목록에 「알레르기 유발물질(해당 경우에 한함)」로
    // 한 줄 적힌 것이다 — 의무의 존재는 세우지만 방법은 말하지 않는다
    expected: '근거약함',
    gold: ['LBL-037', 'FLR-020'],
    goldCheck: /알레르기 유발물질|소비자 안전을 위한 주의사항/,
    why: '표시 의무와 근거 조문은 자료에 있으나 **방법**(시행규칙 별표 2)은 자료 밖 → 한계를 명시해야 한다',
    alsoRelevant: ['ALG-008', 'ALG-009', 'ALG-010', 'FLR-023'],
    known:
      '코퍼스 한계 확인됨 — 시행규칙 별표 2·별표 3 본문이 수집 대상 밖이다(S2 는 조문만 받았다). ' +
      '「어떻게」를 끝까지 답할 근거가 없다',
  },
  {
    id: 'Q3',
    channel: '스마트스토어 상품등록 (포장 인쇄 직전)',
    question: '과자류로 품목보고한 쿠키인데 포장에 영양성분표를 꼭 넣어야 하나요?',
    expected: '근거충분',
    gold: ['LBL-037', 'FLA-023'],
    goldCheck: /영양성분|영양표시를 하여야 한다/,
    why: '표시기준이 과자류의 표시사항에 「영양성분」을 직접 열거한다 — 식품유형을 특정하면 자료가 답한다',
    alsoRelevant: ['FLR-024', 'FLA-024', 'FLA-025'],
    known: null,
  },
  {
    id: 'Q4',
    channel: '쿠팡 썸네일 문구',
    question: '썸네일에 "합성보존료 무첨가"라고 크게 강조해도 되나요?',
    expected: '근거약함',
    gold: ['UNF-005', 'UNF-008', 'UNF-015'],
    goldCheck: /보존료가 없거나 사용하지 않았다는|무방부제|사용하지 않은 원재료/,
    why:
      '「조건이 붙는다」까지는 고시 본문으로 말할 수 있으나, 예외 조건의 세부가 ' +
      '시행령 별표 1·표시기준 별지 1 에 있고 그 둘은 자료 밖이다',
    alsoRelevant: ['FLA-035', 'FLD-007'],
    known: null,
  },
  {
    id: 'Q5',
    channel: '인스타그램 협찬 리뷰',
    question:
      '인스타그램에 협찬 보내고 올리는 리뷰도 이 법 적용을 받나요? 대가를 받았다는 표시도 해야 하나요?',
    // S4 에서 정답을 넓힌 문항이다. 처음에는 「광고」 정의(제2조제10호)만 정답으로 뒀는데,
    // 검색이 1위로 가져온 제3조(다른 법률과의 관계)가 「적용을 받나요」에 더 직접적인
    // 답이었다 — 검색이 틀린 게 아니라 정답 정의가 좁았다 (FINDINGS 6절)
    expected: '일부범위밖',
    gold: ['FLA-011', 'FLA-014'],
    goldCheck: /"광고"란|다른 법률과의 관계/,
    why:
      '적용 여부는 자료 안(광고 정의 + 다른 법률과의 관계). ' +
      '협찬 대가관계 표시 의무는 공정거래위원회 소관이라 자료 밖 — **두 부분을 분리해 말해야 한다**',
    alsoRelevant: ['FLA-031', 'FLA-034'],
    outOfScopeTopic: '협찬·대가관계 표시 등 일반 부당광고',
    known: null,
  },
  {
    id: 'Q6',
    channel: '상세페이지 업로드 전 검토',
    question: '온라인 상세페이지 광고 문구도 올리기 전에 자율심의를 먼저 받아야 하나요?',
    // PRD 9절은 Q6 을 「경계(코퍼스 범위만, 한계 명시)」로 뒀다. **S11 에서 근거충분으로 올렸다.**
    // 법률 제10조①이 심의 의무와 제외 경우를, 시행규칙 제10조가 심의 대상 식품등 4종을
    // 열거해 「어디까지인가」에 자료만으로 답이 닫힌다. 일반 과자류는 그 4종에 없다
    expected: '근거충분',
    gold: ['FLA-052', 'FLR-077', 'FLR-078', 'FLR-079', 'FLR-080'],
    goldCheck: /자율심의기구|표시 또는 광고 심의 대상 식품등/,
    why: '심의 의무 조문 + 심의 대상 식품등 열거가 둘 다 자료에 있어 범위가 닫힌다',
    alsoRelevant: ['FLD-009', 'FLD-010', 'FLD-011', 'REV-002'],
    known: null,
  },
  {
    id: 'Q7',
    channel: '아마존 미국 리스팅',
    question: '아마존 미국에 수출하려는데 영문 라벨에 뭘 넣어야 하나요?',
    // S2 에서 「일부 범위 밖」 → 「코퍼스 밖」으로 **정정된** 문항이다.
    // 「수출」이 든 청크는 5개뿐이고 전부 다른 내용(비방광고 예시, 재포장, GMO 정부증명서 등)
    expected: '코퍼스밖',
    gold: [],
    goldCheck: null,
    why:
      '근거 0건이 기대값이다 — 코퍼스에 수출 라벨 요건이 없다(S2 확인). ' +
      '규정은 분명히 존재하므로 「법령에 없다」고 답하면 **배포 실패**다',
    alsoRelevant: [],
    outOfScopeTopic: '수출 라벨 요건',
    known: 'S2 검증: 「수출」 키워드 5건은 전부 무관 (UNF-014 · LBL-023 · LBL-025 · LBL-029 · GMO-005)',
  },
  {
    id: 'Q8',
    channel: '같은 스마트스토어의 화장품 카테고리',
    question: '같은 스토어에서 화장품도 파는데 상세페이지에 "주름 개선"이라고 써도 되나요?',
    expected: '코퍼스밖',
    gold: [],
    goldCheck: null,
    why: '근거 0건이 기대값이다 — 코퍼스에 「화장품」·「주름」이 든 청크가 하나도 없다',
    alsoRelevant: [],
    outOfScopeTopic: '화장품 표시·광고',
    known:
      'S2·S11 검증: 「화장품」 0건, 「주름」 0건. ' +
      '소관 법령 이름(화장품법)은 **모델이 대면 안 되고** 고정 안내 목록에서만 나온다',
  },
  {
    id: 'Q9',
    channel: '쿠팡 수수료 정산 화면',
    question: '쿠팡 수수료 빼면 남는 게 없어요. 이 제품 원가를 어떻게 낮출 수 있을까요?',
    // 5단 중 「규범 밖」을 재는 유일한 문항이다. 이게 없으면 S7 의 마지막 칸을 검증할 수 없다.
    // 「코퍼스 밖」과 다른 실패를 잡는다 — 여기에 「다른 법령에 규정이 있을 수 있다」를 붙이면
    // **없는 규제를 시사하는 오답**이 된다
    expected: '규범밖',
    gold: [],
    goldCheck: null,
    why: '법령 질문 자체가 아니다 — 목적 밖임만 안내하고 **다른 법령 언급을 붙이지 않아야** 한다',
    alsoRelevant: [],
    outOfScopeTopic: null,
    known:
      'S11 검증: 「원가」·「마진」 0건. 「수수료」는 FLA-059(자율심의 수수료) 하나가 걸리는데 ' +
      '질문과 무관하다 — 이 문항에서 검색이 근거를 「찾는」 것 자체가 위험 신호다',
  },
]

/**
 * 표기 검색(BM25) 진단용 질문. **평가 세트가 아니다** — 루브릭 지표에 넣지 않는다.
 *
 * 하이브리드를 붙인 근거가 이 두 개다 (PLAN S4). 사용자가 조문 번호를 그대로 치는 경우를
 * 재고, 코사인만으로는 못 잡히는 것을 확인한다.
 */
export const PROBE_SET = [
  {
    id: 'N1',
    question: '제8조 제1항 제3호가 무슨 내용인가요?',
    gold: ['FLA-033'],
    goldCheck: /건강기능식품이 아닌 것을 건강기능식품으로 인식할 우려/,
    why: '조문 번호를 그대로 묻는 질문 — 표기 검색 경로가 살아 있는지 본다',
  },
  {
    id: 'N2',
    question: '시행규칙 제6조 제2항 제3호에 뭐가 적혀 있나요?',
    gold: ['FLR-027'],
    goldCheck: /표시 대상 영양성분/,
    why: 'S4 에서 의미 20위 · 표기 2위 → 하이브리드 1위로 뒤집힌 사례',
  },
]

/**
 * 정답 ID 가 코퍼스에 실제로 있는지, 그리고 그 본문이 아직 의도한 조문인지 확인한다.
 *
 * **지어낸 ID 를 조용히 통과시키지 않는 것이 이 함수의 존재 이유다.** 코퍼스를 다시 만들면
 * ID 가 밀리는데, 그때 여기서 멈추지 않으면 하네스는 엉뚱한 조문을 정답으로 세면서
 * 「점수가 올랐다」고 보고한다.
 *
 * @param {{id: string, text: string}[]} chunks
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyEvalSet(chunks, sets = [EVAL_SET, PROBE_SET]) {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const problems = []

  for (const set of sets) {
    for (const q of set) {
      const seen = new Set()
      for (const id of q.gold ?? []) {
        if (seen.has(id)) problems.push(`${q.id}: gold 에 ${id} 가 중복이다`)
        seen.add(id)
        if (!byId.has(id)) {
          problems.push(`${q.id}: gold ${id} 가 코퍼스에 없다 — 코퍼스가 바뀌었거나 ID 를 잘못 적었다`)
        }
      }
      for (const id of q.alsoRelevant ?? []) {
        if (!byId.has(id)) problems.push(`${q.id}: alsoRelevant ${id} 가 코퍼스에 없다`)
      }
      // 본문 확인 — ID 는 맞는데 내용이 다른 조문으로 밀린 경우를 잡는다
      if (q.goldCheck) {
        const hit = (q.gold ?? []).some((id) => byId.has(id) && q.goldCheck.test(byId.get(id).text))
        if (!hit) {
          problems.push(
            `${q.id}: gold [${(q.gold ?? []).join(', ')}] 중 goldCheck(${q.goldCheck}) 에 걸리는 본문이 없다 — 청크가 밀렸을 수 있다`,
          )
        }
      }
      if (q.expected && !EVIDENCE_STATES.includes(q.expected)) {
        problems.push(`${q.id}: 기대 근거상태 "${q.expected}" 는 5단에 없다`)
      }
      const needs = STATES_NEEDING_EVIDENCE.includes(q.expected)
      if (needs && (q.gold ?? []).length === 0) {
        problems.push(`${q.id}: ${q.expected} 인데 gold 가 비어 있다`)
      }
      if (STATES_EXPECTING_REFUSAL.includes(q.expected) && (q.gold ?? []).length > 0) {
        problems.push(`${q.id}: ${q.expected} 인데 gold 가 있다 — 근거 0건이 기대값이어야 한다`)
      }
    }
  }

  // 5단이 모두 한 번 이상 나오는지. 안 나오는 칸은 S7 을 검증할 수 없다
  const covered = new Set(EVAL_SET.map((q) => q.expected))
  for (const s of EVIDENCE_STATES) {
    if (!covered.has(s)) problems.push(`근거상태 "${s}" 를 재는 문항이 없다 — S7 의 그 칸을 검증할 수 없다`)
  }

  return { ok: problems.length === 0, problems }
}
