"""두 조건의 PLAN.md 를 만들고, 현재 단계 절이 바이트 단위로 같은지 검사한다.

조작 항목은 「완료 절 본문의 유무」 하나뿐이다. 현재 단계 절이 조금이라도 다르면
그 차이가 결과를 설명해 버리므로, 여기서 실패시켜 실험을 못 돌리게 한다.
"""
import pathlib, sys, hashlib

sys.stdout.reconfigure(encoding="utf-8")

d = pathlib.Path(__file__).parent
read = lambda n: (d / n).read_text(encoding="utf-8")

head, cur = read("_head.md"), read("_current.md")
full = head + read("_completed-full.md") + read("_memos-full.md") + read("_appendix-full.md") + cur
folded = head + read("_completed-folded.md") + cur

(d / "PLAN-full.md").write_text(full, encoding="utf-8")
(d / "PLAN-folded.md").write_text(folded, encoding="utf-8")

# 검사 1 — 현재 절이 두 파일에 바이트 단위로 같게 들어갔다
for name, text in (("PLAN-full.md", full), ("PLAN-folded.md", folded)):
    if text.count(cur) != 1:
        sys.exit(f"FAIL: {name} 에 현재 절이 정확히 1회 들어가지 않았다")
# 검사 2 — 폐기된 옛 규칙이 full 에만 있고 folded 에는 없다
stale = ["{doc}-p{page}` 로 쓴다", "JSON 배열 하나**로 출력", "`OLLAMA_URL` 에서 읽는다"]
for s in stale:
    if s not in full:
        sys.exit(f"FAIL: full 에 옛 규칙이 없다: {s}")
    if s in folded:
        sys.exit(f"FAIL: folded 에 옛 규칙이 남았다: {s}")
# 검사 3 — 새 규칙은 양쪽에 있다
fresh = ["{doc}-p{page}-c{idx}` 다", "NDJSON** 이다", "**`LLM_BASE_URL`** 에서 읽는다"]
for s in fresh:
    for name, text in (("full", full), ("folded", folded)):
        if s not in text:
            sys.exit(f"FAIL: {name} 에 새 규칙이 없다: {s}")

for n, t in (("PLAN-full.md", full), ("PLAN-folded.md", folded)):
    print(f"{n:18} {len(t.encode()):7,} bytes  {t.count(chr(10)):4} lines  "
          f"sha256={hashlib.sha256(t.encode()).hexdigest()[:16]}")
print(f"{'현재 절 (공통)':18} {len(cur.encode()):7,} bytes  {cur.count(chr(10)):4} lines  "
      f"sha256={hashlib.sha256(cur.encode()).hexdigest()[:16]}")
print("OK — 검사 3종 통과")
