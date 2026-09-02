# fundamentals m04 — 문서(OCR)와 사진(YOLO) 비교 실습

- 코스: AI의 이해와 사용_Agt1
- 강의노트: `../../AI-Study/notes/aiffel/fundamentals-m04-doc-and-vision.md`

## 과제 개요

제출물이 **두 갈래(A: 문서 OCR 비교 / B: 사진 YOLO 실습)** 다.
**모든 모델이 성공할 필요는 없다.** 실패한 경로에는 실행 명령, 패키지·모델 이름, 오류 메시지,
대체 결과 사용 여부가 있어야 한다.

## 제출물 A — 문서(OCR) 비교

`outputs/ocr` 폴더, 그 안의 `comparison.md`, **실행되는 `apps/ocr/app.py`**.

체크포인트 — 다음이 실제로 존재하면 마친다:

- [ ] 동일한 1~2쪽 PNG 와 입력 **SHA-256**
- [ ] Tesseract 와 PaddleOCR 의 **원시 결과·텍스트·좌표 시각화**
- [ ] PaddleOCR-VL 의 원시 결과와 페이지별 Markdown
- [ ] Claude 또는 ChatGPT 의 결과와 **표시 모델·실행일**
- [ ] 기준값 6개의 `comparison.md`
- [ ] 실패 또는 `[UNCLEAR]` 사례 한 가지
- [ ] 데이터가 로컬에 남았는지 외부로 나갔는지 기록
- [ ] 기존 결과를 읽는 **Gradio 비교 화면**

마지막에 네 줄을 채운다:

```
글자와 좌표가 필요할 때 고를 도구:
표·수식·읽기 순서가 중요할 때 고를 도구:
자연어 질문을 빠르게 시험할 때 고를 도구:
사람이 반드시 원문을 다시 볼 조건:
```

## 제출물 B — 사진(YOLO) 실습

- [ ] detection·segmentation·pose 결과 이미지 각 1장
- [ ] 작업별 **원시 JSON** 과 `summary.json`
- [ ] 모델명·패키지 버전·**입력 해시**·실행시간이 든 manifest
- [ ] 임계값 3개(0.15 / 0.25 / 0.60)에서 관찰한 변화
- [ ] 직접 추론 또는 **읽기 전용 fallback 모드**로 실행되는 `apps/yolo/app.py`
- [ ] `outputs/yolo/use_case_card.md` (**답은 사람이 작성**)
- [ ] 세 작업 중 업무 하나를 골라 "왜 이 자료형이 필요한가"를 설명한 **두 문장**

## 확장 (선택)

- **문서**: 짝과 바꾼 어려운 한 페이지에서 **두 경로만** 다시 실행하고, 처음 나타난 실패를
  `new_failure.md` 에 한 문장으로 + 어느 기술 단계와 관련 있는지 추정
- **사진**: 옆 사람 앱에 처음 보는 사진 한 장. **보기 좋은 결과보다 처음 드러난 실패 하나를 발표**

## 폴더 구조 (원문 기준)

```
outputs/
├── ocr/
│   └── comparison.md
└── yolo/
    ├── summary.json
    └── use_case_card.md
apps/
├── ocr/app.py
└── yolo/app.py
```

## 상태

미착수
