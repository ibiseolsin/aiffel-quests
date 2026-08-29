/**
 * 답변 생성 엔진.
 *
 * 두 어댑터가 **같은 인터페이스**를 쓴다. 그래야 프롬프트·인용·판정이 엔진과 무관하게
 * 한 벌만 있고, 엔진을 바꿔도 답변 품질 차이만 남는다 (그 비교가 확장 항목이다).
 *
 * **자동 폴백은 없다.** 한쪽이 죽으면 실패로 보여 준다 — 조용히 다른 엔진으로 넘어가면
 * 사용자는 자기가 어느 엔진의 답을 읽고 있는지 모른다.
 */

import { describeServiceAccount, getAccessToken, type ServiceAccount } from './google-auth.ts'

export type EngineKind = 'gemini' | 'ollama'

/**
 * 같은 Gemini 모델을 부르는 두 가지 창구. **키 종류가 다르므로 둘을 갈라야 한다.**
 *
 * - `studio`: AI Studio 키 → `generativelanguage.googleapis.com`
 * - `vertex`: Vertex AI 키(익스프레스 모드) → `aiplatform.googleapis.com`
 *
 * 응답 형식은 같아서(`candidates[0].content.parts`) 파서는 한 벌로 쓴다.
 * 어느 쪽이든 키는 **헤더**로 보낸다 — 쿼리스트링에 넣으면 주소창·로그·리퍼러에 남는다.
 */
export type ApiFlavor = 'studio' | 'vertex' | 'vertex-sa'

export const API_FLAVOR_LABEL: Record<ApiFlavor, string> = {
  'vertex-sa': 'Vertex AI 서비스 계정 JSON',
  vertex: 'Vertex AI 키 (익스프레스)',
  studio: 'AI Studio 키',
}

/**
 * Vertex 표준 경로의 리전. 서비스 계정으로 부를 때 필요하다.
 * `global` 이 기본이고, 리전을 지정하면 호스트도 그 리전으로 바뀐다.
 */
export const DEFAULT_LOCATION = 'global'

export type EngineConfig = {
  kind: EngineKind
  /** Gemini 만 쓴다. **브라우저 안에만 있고 저장소·배포본에 들어가지 않는다** */
  apiKey?: string
  /** Gemini 만 쓴다 */
  flavor?: ApiFlavor
  /** `vertex-sa` 만 쓴다. **개인키가 들어 있으므로 저장하지 않는다** */
  serviceAccount?: ServiceAccount
  /** `vertex-sa` 만 쓴다 */
  location?: string
  /** Ollama 만 쓴다 */
  baseUrl?: string
  model: string
}

/** 기본 Ollama 주소. 선택적 필드가 아니라 상수여야 곳곳에서 `!` 를 붙이지 않는다 */
export const OLLAMA_BASE = 'http://127.0.0.1:11434'

export const ENGINE_DEFAULTS: Record<EngineKind, EngineConfig> = {
  // 정적 배포에는 키를 넣을 수 없다(공개된다). 방문자가 자기 키를 화면에서 넣는다.
  // 모델 ID 는 화면에서 바꿀 수 있게 두었다 — 모델 이름은 자주 바뀌고,
  // 틀린 이름 하나 때문에 코드를 고쳐야 하는 것은 사용자 쪽 낭비다
  // 기본 창구는 **실제로 답변이 온 것이 확인된** AI Studio 키다 (2026-08-29, 배포본).
  // 서비스 계정 JSON 은 개인키가 브라우저에 올라가고 권한도 넓어 기본으로 둘 것이 아니다
  gemini: { kind: 'gemini', flavor: 'studio', model: 'gemini-3.7-flash' },
  // 콜드 스타트 43초를 측정해 두었다 (FINDINGS 1절) — 첫 답변이 늦은 것은 고장이 아니다
  ollama: { kind: 'ollama', baseUrl: OLLAMA_BASE, model: 'qwen3.5:2b' },
}

export const ENGINE_LABEL: Record<EngineKind, string> = {
  gemini: 'Gemini (API 키 필요)',
  ollama: 'Ollama (내 컴퓨터)',
}

export class EngineError extends Error {
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

/** 토큰이 도착할 때마다 부른다. 취소는 `signal` 로 한다 */
export type OnToken = (text: string) => void

export async function generate(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  if (config.kind === 'gemini') return generateGemini(config, prompt, onToken, signal)
  return generateOllama(config, prompt, onToken, signal)
}

/* ─── 스키마를 강제하는 한 방 호출 (S8 판정) ────────────────────────────── */

/**
 * JSON 스키마를 **엔진에 넘겨서** 구조를 강제하고, 결과를 파싱해 돌려준다.
 *
 * 프롬프트로 「JSON 으로 답해」라고 부탁하지 않는다 — FINDINGS 2절이 그게 안 된다는 것을
 * 실측으로 보였다: `format:"json"` + 프롬프트 지시로는 `noHalluc` 이 `"No Hallucination"`
 * 으로 변조되는 일이 3/3 재현됐다. 두 엔진 다 **스키마를 받는 자리**가 따로 있다.
 *
 * 스트리밍하지 않는다. 판정은 한 덩어리로 와야 파싱되고, 사람이 읽으며 기다릴 글도 아니다.
 */
export async function generateJson(
  config: EngineConfig,
  prompt: string,
  schema: JsonSchema,
  signal: AbortSignal,
): Promise<unknown> {
  const text =
    config.kind === 'gemini'
      ? await jsonGemini(config, prompt, schema, signal)
      : await jsonOllama(config, prompt, schema, signal)
  try {
    return JSON.parse(text)
  } catch {
    // 스키마를 줬는데도 JSON 이 아니면 판정 실패다. **답변은 그대로 둔다** (PRD 5절 규칙 3)
    throw new EngineError('판정 응답이 JSON 이 아니다', text.slice(0, 300))
  }
}

/** 우리가 쓰는 만큼의 JSON 스키마. 두 엔진이 받는 교집합만 둔다 */
export type JsonSchema = {
  type: 'object'
  properties: Record<
    string,
    { type: 'boolean' | 'integer' | 'string'; description: string; minLength?: number }
  >
  required: string[]
}

/**
 * Gemini 의 `responseSchema` 는 OpenAPI Schema 방언이라 **타입 이름이 대문자**이고
 * `minLength` 같은 제약을 다 받지는 않는다. 그래서 여기서 갈아 준다 — 스키마 하나를
 * 두 엔진에 그대로 밀어 넣으면 한쪽에서 400 이 난다.
 */
function toGeminiSchema(schema: JsonSchema) {
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [
        k,
        { type: v.type.toUpperCase(), description: v.description },
      ]),
    ),
    required: schema.required,
    // 필드 순서를 고정한다. 순서가 흔들리면 모델이 근거를 쓰기 전에 점수를 먼저 뱉는다
    propertyOrdering: schema.required,
  }
}

/**
 * 줄 단위로 오는 스트림을 읽는다. 청크 경계가 줄 경계와 맞지 않으므로
 * 남는 조각을 들고 다녀야 한다 — 이걸 빼먹으면 JSON 이 반토막 난 채 파싱된다.
 */
async function* lines(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new EngineError('응답 본문이 스트림이 아니다')
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) yield line
    }
    if (buffer.trim()) yield buffer
  } finally {
    // 취소 시 남은 응답을 흘려보내지 않고 연결을 끊는다
    reader.cancel().catch(() => {})
  }
}

/**
 * Gemini — 브라우저에서 직접 호출한다 (`x-goog-api-key` 헤더 또는 `Bearer` 토큰, PLAN 결정 D5).
 *
 * ## CORS 는 세 창구 모두 뚫려 있다 (2026-08-29 실측, origin `https://ibiseolsin.github.io`)
 *
 * 배포본 콘솔에서 **일부러 틀린 자격증명**으로 불러 봤다. CORS 가 막히면 브라우저가
 * 응답을 읽기 전에 `TypeError` 를 던지므로, **HTTP 상태와 본문이 읽혔다는 것 자체가
 * CORS 통과의 증거**다. 넷 다 본문이 읽혔다:
 *
 * | 호스트 | 상태 | 본문 |
 * |---|---|---|
 * | `oauth2.googleapis.com/token` | 400 | `invalid_request` |
 * | `generativelanguage.googleapis.com` (AI Studio) | 400 | `API key not valid` |
 * | `aiplatform.googleapis.com` + `Bearer` (서비스 계정) | 401 | `invalid authentication credentials` |
 * | `aiplatform.googleapis.com` + API 키 (익스프레스) | 401 | **`API keys are not supported by this API`** |
 *
 * ## 그래서 갈린 것: 익스프레스 키 창구는 다른 셋과 실패 이유가 다르다
 *
 * 앞의 셋은 **「이 자격증명이 틀렸다」** 고 답한다 — 맞는 것을 넣으면 통과한다는 뜻이다.
 * 익스프레스 키만 **「이 API 는 API 키를 안 받는다」** 고 답하는데, 이건 키의 유효성이
 * 아니라 **엔드포인트의 성질**에 대한 말이다. 헤더·쿼리스트링, 스트리밍·비스트리밍
 * 네 조합 모두 같은 401 이었다.
 *
 * 그래도 창구를 지우지 않았다 — 익스프레스 모드로 **발급된** 키는 이 호스트에
 * 등록돼 있어서 다르게 갈릴 수 있고, 그건 그런 키가 있어야 확인된다.
 * 대신 이 401 이 뜨면 무엇을 봐야 하는지 화면에서 짚어 준다.
 *
 * **아직 확인되지 않은 것**: 유효한 자격증명으로 실제 답변이 오는가, 그리고 모델 이름이
 * 실재하는가. 401·400 은 모델 이름을 보기 전에 나온다 — 그래서 이름을 화면에서 바꿀 수 있게 두었다.
 *
 * Ollama 경로로 프롬프트·스트리밍·취소·인용을 검증했고, 여기는 같은 파서를 쓴다.
 */
/**
 * 자주 갈리는 실패에만 한 줄을 앞에 붙인다. **본문은 늘 그대로 이어 붙인다** —
 * 우리가 알아본 실패에 대한 설명이 원문을 가리면, 알아보지 못한 실패에서 단서가 사라진다.
 */
function explainGeminiError(flavor: ApiFlavor, status: number, body: string): string {
  // 다시 눌러 볼 만한 실패와 그렇지 않은 실패를 가른다. 이게 안 갈리면 사용자는
  // 잠깐 몰린 것을 두고 키·모델명·권한을 다 뒤지게 된다 (실측: 503 UNAVAILABLE)
  if (status === 503 || body.includes('UNAVAILABLE')) {
    return (
      '구글 쪽이 지금 이 모델에 몰려 있습니다. 키·모델 이름·권한 문제가 아니라 ' +
      '**일시적인 것**이니 잠시 뒤 다시 눌러 보세요. 급하면 모델 ID 를 다른 이름으로 ' +
      '바꿔 보십시오 — 모델마다 혼잡도가 다릅니다.\n\n'
    )
  }
  if (status === 429 || body.includes('RESOURCE_EXHAUSTED')) {
    return (
      '요청 한도에 걸렸습니다. AI Studio 무료 등급은 분당·하루 요청 수에 제한이 있습니다 — ' +
      '조금 기다렸다 다시 누르거나, 한도가 다른 모델 ID 로 바꿔 보세요.\n\n'
    )
  }
  if (body.includes('API keys are not supported by this API')) {
    return (
      '이 호스트(aiplatform.googleapis.com)는 API 키를 받지 않는다고 답했습니다. ' +
      '틀린 키가 아니라 키라는 방식 자체를 거절한 것입니다 — 익스프레스 모드로 발급한 키가 ' +
      '아니라면 「AI Studio 키」 창구를 쓰거나 「Vertex AI 서비스 계정 JSON」 으로 바꾸세요.\n\n'
    )
  }
  if (flavor === 'studio' && body.includes('API key not valid')) {
    return 'AI Studio 가 키를 인식하지 못했습니다. aistudio.google.com 에서 발급한 키가 맞는지 확인하세요.\n\n'
  }
  if (body.includes('was not found') || body.includes('is not found')) {
    return '모델 ID 를 찾지 못했습니다. 아래 모델 ID 칸을 바꿔 보세요 — 창구마다 쓸 수 있는 이름이 다릅니다.\n\n'
  }
  return ''
}

/**
 * 창구마다 경로와 인증이 다르다. **스트리밍 호출과 판정 호출이 같은 곳을 보게** 여기로 모았다 —
 * 두 벌로 두면 창구 하나를 고칠 때 한쪽만 고쳐지고, 그 어긋남은 유효한 키가 있어야 드러난다.
 */
async function geminiEndpoint(
  config: EngineConfig,
  method: 'streamGenerateContent?alt=sse' | 'generateContent',
  signal: AbortSignal,
): Promise<{ url: string; headers: Record<string, string>; who: string; flavor: ApiFlavor }> {
  const flavor = config.flavor ?? 'vertex-sa'
  const headers: Record<string, string> = { 'content-type': 'application/json' }

  if (flavor === 'vertex-sa') {
    const sa = config.serviceAccount
    if (!sa) throw new EngineError('서비스 계정 JSON 이 없다', '화면에서 JSON 파일을 고르세요')
    const loc = config.location?.trim() || DEFAULT_LOCATION
    // 리전을 지정하면 호스트도 그 리전으로 간다. global 은 리전 없는 호스트를 쓴다
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`
    let token: string
    try {
      token = await getAccessToken(sa, signal)
    } catch (e) {
      throw new EngineError(`액세스 토큰을 받지 못했다: ${(e as Error).message}`)
    }
    headers.authorization = `Bearer ${token}`
    return {
      url: `https://${host}/v1/projects/${sa.project_id}/locations/${loc}/publishers/google/models/${config.model}:${method}`,
      headers,
      who: `${API_FLAVOR_LABEL[flavor]} · ${describeServiceAccount(sa)} · ${loc}`,
      flavor,
    }
  }

  if (!config.apiKey) throw new EngineError('API 키가 없다', '화면에서 API 키를 입력하세요')
  headers['x-goog-api-key'] = config.apiKey
  return {
    url:
      flavor === 'vertex'
        ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${config.model}:${method}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:${method}`,
    headers,
    who: API_FLAVOR_LABEL[flavor],
    flavor,
  }
}

async function generateGemini(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  let url: string
  let headers: Record<string, string>
  let who: string
  let flavor: ApiFlavor
  try {
    ;({ url, headers, who, flavor } = await geminiEndpoint(config, 'streamGenerateContent?alt=sse', signal))
  } catch (e) {
    if (signal.aborted) return
    throw e
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    })
  } catch (e) {
    if (signal.aborted) return
    throw new EngineError(`Gemini 에 연결하지 못했다: ${(e as Error).message}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 오류 본문을 그대로 보여 준다. 「키를 확인하세요」만 띄우면 실제 원인
    // (모델 이름이 틀렸다 · 그 프로젝트에 권한이 없다 · 키 종류가 다르다)을 알 수 없다
    throw new EngineError(
      `Gemini 오류 ${res.status} (${who}, ${config.model})`,
      `${explainGeminiError(flavor, res.status, body)}${body.slice(0, 400) || '응답 본문이 비어 있다'}`,
    )
  }

  for await (const line of lines(res, signal)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const json = JSON.parse(payload)
      for (const part of json.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === 'string') onToken(part.text)
      }
    } catch {
      // 조각난 줄은 건너뛴다. 스트림 전체를 여기서 죽이지 않는다
    }
  }
}

async function jsonGemini(
  config: EngineConfig,
  prompt: string,
  schema: JsonSchema,
  signal: AbortSignal,
): Promise<string> {
  const { url, headers, who, flavor } = await geminiEndpoint(config, 'generateContent', signal)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          // 판정은 재현 가능해야 한다 — 같은 답변을 두 번 재서 배지가 달라지면 배지가 아니다
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      }),
    })
  } catch (e) {
    throw new EngineError(`Gemini 판정에 연결하지 못했다: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EngineError(
      `Gemini 판정 오류 ${res.status} (${who}, ${config.model})`,
      `${explainGeminiError(flavor, res.status, body)}${body.slice(0, 400) || '응답 본문이 비어 있다'}`,
    )
  }
  const json = await res.json()
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? '')
    .join('')
}

async function jsonOllama(
  config: EngineConfig,
  prompt: string,
  schema: JsonSchema,
  signal: AbortSignal,
): Promise<string> {
  const base = config.baseUrl ?? OLLAMA_BASE
  let res: Response
  try {
    res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        think: false,
        // Ollama 는 `format` 에 `"json"` 대신 **스키마 객체**를 받는다 (FINDINGS 2절 시도 B)
        format: schema,
        options: { temperature: 0 },
      }),
    })
  } catch (e) {
    throw new EngineError(`Ollama 판정에 연결하지 못했다: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EngineError(`Ollama 판정 오류 ${res.status}`, body.slice(0, 300))
  }
  const json = await res.json()
  if (json.error) throw new EngineError(`Ollama 판정: ${json.error}`)
  return String(json.response ?? '')
}

/**
 * Ollama — 사용자의 컴퓨터에서 돈다.
 *
 * **배포된 https 페이지에서 부르려면 두 관문을 넘어야 한다.** 실측으로 확인한 것:
 *
 * | origin | Ollama 프리플라이트 |
 * |---|---|
 * | `http://localhost:4175` | 204 (기본 허용) |
 * | `https://ibiseolsin.github.io` | **403** — `OLLAMA_ORIGINS` 미설정 |
 *
 * ① Ollama 의 CORS — `OLLAMA_ORIGINS` 에 그 주소를 넣어야 한다.
 * ② 브라우저의 사설망 접근 제한 — 공개 origin 에서 loopback 으로 가는 요청을 크롬이
 *    따로 막을 수 있고, Ollama 는 `Access-Control-Allow-Private-Network` 를 보내지 않는다.
 *    **①을 고쳐도 ②가 남을 수 있다** — 확인되지 않았다.
 *
 * 그래서 로컬 엔진은 `localhost` 에서 여는 것이 확실한 길이다.
 */

/**
 * 콜드 스타트 실측값 (FINDINGS 1절, 2026-08-28). 첫 요청에서 모델을 메모리에 올리는 시간.
 * **진행 표시의 눈금으로만 쓴다** — 이 값을 넘겼다고 실패가 아니고, 기계마다 다르다.
 */
export const OLLAMA_COLD_MS = 43_000

/**
 * 화면에 상시 붙는 연결 상태. **확인하지 않은 것을 「연결됨」이라고 쓰지 않는다** —
 * 그래서 단계가 다섯이다. `warn` 은 "자격증명은 있는데 아직 불러 보지 않았다" 이고,
 * 이 구분이 없으면 사용자가 키를 넣은 것과 그 키가 통하는 것을 같은 것으로 읽는다.
 */
export type StatusLevel = 'ok' | 'warn' | 'bad' | 'checking' | 'unknown'

export type EngineStatus = {
  level: StatusLevel
  /** 한 줄 요약. 배지에 그대로 들어간다 */
  label: string
  /** 요약 옆에 붙는 사실 (버전·계정·모델 등) */
  detail?: string
  /** 무엇을 하면 되는지 */
  hint?: string
}

/**
 * Gemini 는 **부르지 않고는 확인할 수 없다** — 그리고 확인용으로 부르면 사용자 쿼터를 쓴다.
 * 그래서 여기서는 자격증명의 유무만 정직하게 말하고, 실제 응답이 한 번 온 뒤에만 `ok` 가 된다.
 */
export function geminiStatus(args: {
  flavor: ApiFlavor
  apiKey: string
  serviceAccount: ServiceAccount | null
  /** 이 창구·모델로 실제 응답을 받은 적이 있는가 (이번 세션에서) */
  answered: boolean
}): EngineStatus {
  const { flavor, apiKey, serviceAccount, answered } = args
  const who = API_FLAVOR_LABEL[flavor]
  if (flavor === 'vertex-sa') {
    if (!serviceAccount) {
      return { level: 'bad', label: '서비스 계정 JSON 없음', detail: who, hint: 'JSON 파일을 고르세요' }
    }
    const detail = `${who} · ${describeServiceAccount(serviceAccount)}`
    return answered
      ? { level: 'ok', label: '응답 확인됨', detail }
      : { level: 'warn', label: '자격증명 있음 (미확인)', detail, hint: '실제로 통하는지는 질문을 한 번 던져야 압니다' }
  }
  if (!apiKey.trim()) {
    return { level: 'bad', label: '키 없음', detail: who, hint: 'API 키를 입력하세요' }
  }
  return answered
    ? { level: 'ok', label: '응답 확인됨', detail: who }
    : {
        level: 'warn',
        label: '키 있음 (미확인)',
        detail: who,
        hint: '키가 통하는지는 질문을 한 번 던져야 압니다 — 확인만 하려고 부르면 사용자 쿼터를 씁니다',
      }
}

/** 이 페이지에서 이 주소를 부를 때 브라우저가 막을 가능성이 있는지 미리 본다 */
export function localEngineWarning(baseUrl: string): string | null {
  if (typeof location === 'undefined') return null
  if (location.protocol !== 'https:') return null
  if (!baseUrl.startsWith('http://')) return null
  return `이 페이지는 https(${location.origin})인데 Ollama 는 ${baseUrl} 입니다. 그대로는 브라우저나 Ollama 가 요청을 막습니다.`
}

/**
 * 답을 만들기 전에 연결을 확인한다. **셋을 한 번에 본다** — 버전(켜져 있는가) ·
 * 모델 목록(받아 뒀는가) · 실행 중 목록(**메모리에 올라 있는가**).
 *
 * 마지막 것이 콜드 43초의 정체다. `/api/ps` 가 이 모델을 들고 있으면 웜이고,
 * 비어 있으면 다음 첫 질문이 콜드다. 이걸 화면에 적어 두면 사용자가 43초를 고장으로 읽지 않는다.
 */
export type OllamaProbe = {
  version: string
  /** 이 모델을 pull 해 뒀는가 */
  hasModel: boolean
  /** 받아 둔 모델 이름들 — 없을 때 무엇을 pull 해야 하는지 보이려고 */
  models: string[]
  /** 지금 메모리에 올라 있는가 (= 예열됨) */
  warm: boolean
  /** 예열이 언제까지 유지되는가 (`/api/ps` 의 `expires_at`) */
  warmUntil?: string
}

export async function probeOllama(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ ok: true; probe: OllamaProbe } | { ok: false; message: string; hint?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal })
    if (!res.ok) {
      return {
        ok: false,
        message: `Ollama 가 ${res.status} 를 돌려줬다`,
        // 403 은 Ollama 자신이 origin 을 거절한 것이다 — 꺼져 있는 것과 원인이 다르다
        hint:
          res.status === 403
            ? `Ollama 가 이 페이지의 origin(${typeof location === 'undefined' ? '?' : location.origin})을 거절했습니다. OLLAMA_ORIGINS 에 이 주소를 넣고 Ollama 를 다시 시작해야 합니다`
            : undefined,
      }
    }
    const version = String((await res.json()).version ?? '알 수 없음')

    // 모델 목록과 실행 중 목록은 없어도 치명적이지 않다 — 버전이 왔으면 연결은 된 것이다
    const models: string[] = await fetch(`${baseUrl}/api/tags`, { signal })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) => (j.models ?? []).map((m: { name?: string }) => String(m.name ?? '')))
      .catch(() => [])
    const running: { name?: string; expires_at?: string }[] = await fetch(`${baseUrl}/api/ps`, {
      signal,
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) => j.models ?? [])
      .catch(() => [])
    const live = running.find((m) => m.name === model)

    return {
      ok: true,
      probe: {
        version,
        models,
        hasModel: models.includes(model),
        warm: !!live,
        warmUntil: live?.expires_at,
      },
    }
  } catch (e) {
    if (signal?.aborted) return { ok: false, message: '확인을 중단했다' }
    return {
      ok: false,
      message: `연결하지 못했다: ${(e as Error).message}`,
      hint:
        localEngineWarning(baseUrl) ??
        'Ollama 가 켜져 있는지 확인하세요 (`ollama serve`). 켜져 있는데도 안 되면 OLLAMA_ORIGINS 설정이 필요합니다',
    }
  }
}

/** 프로브 결과를 화면 배지 하나로 접는다 */
export function ollamaStatus(
  probe: OllamaProbe | null,
  model: string,
  failure?: { message: string; hint?: string },
  checking?: boolean,
): EngineStatus {
  if (checking) return { level: 'checking', label: '확인 중…' }
  if (failure) return { level: 'bad', label: '연결 안 됨', detail: failure.message, hint: failure.hint }
  if (!probe) return { level: 'unknown', label: '미확인', hint: '「다시 확인」을 누르세요' }
  if (!probe.hasModel) {
    return {
      level: 'warn',
      label: `연결됨 · 모델 없음`,
      detail: `Ollama ${probe.version} · 받아 둔 모델 ${probe.models.length ? probe.models.join(', ') : '없음'}`,
      hint: `ollama pull ${model}`,
    }
  }
  if (probe.warm) {
    return {
      level: 'ok',
      label: '연결됨 · 예열됨',
      detail: `Ollama ${probe.version} · ${model} 이 메모리에 있음`,
      hint: probe.warmUntil ? `${probe.warmUntil.slice(0, 19).replace('T', ' ')} 까지 유지` : undefined,
    }
  }
  return {
    level: 'warn',
    label: '연결됨 · 콜드',
    detail: `Ollama ${probe.version} · ${model} 은 아직 메모리에 없음`,
    hint: '첫 답변에서 모델을 올리느라 40초쯤 걸립니다 — 「미리 올려두기」로 지금 올려 둘 수 있습니다',
  }
}

/**
 * 예열 — **빈 프롬프트로 부르면 Ollama 가 모델만 메모리에 올린다.** 토큰을 만들지 않으므로
 * 답변 품질에 영향이 없고, 콜드 43초를 사용자가 질문을 던지기 *전에* 치르게 옮기는 것이 전부다.
 *
 * `keep_alive` 를 길게 준다 — 기본 5분이면 데모 중에 다시 식는다.
 */
export async function warmOllama(
  baseUrl: string,
  model: string,
  signal: AbortSignal,
  keepAlive = '30m',
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: keepAlive }),
    })
  } catch (e) {
    if (signal.aborted) return
    throw new EngineError(
      `예열하지 못했다: ${(e as Error).message}`,
      localEngineWarning(baseUrl) ?? 'Ollama 가 켜져 있는지 확인하세요 (`ollama serve`)',
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EngineError(`예열 실패 ${res.status}`, body.slice(0, 200))
  }
  // 본문을 끝까지 읽어야 모델 로딩이 끝난 시점을 안다 (stream:false 라 한 덩어리로 온다)
  await res.json().catch(() => null)
}
async function generateOllama(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  const base = config.baseUrl ?? OLLAMA_BASE
  let res: Response
  try {
    res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: true,
        think: false,
        options: { temperature: 0.2 },
      }),
    })
  } catch (e) {
    if (signal.aborted) return
    const warn = localEngineWarning(base)
    throw new EngineError(
      `Ollama 에 연결하지 못했다: ${(e as Error).message}`,
      warn
        ? `${warn} OLLAMA_ORIGINS 에 이 주소를 넣어도 크롬의 사설망 접근 제한이 남을 수 있습니다 — 로컬 엔진은 localhost 에서 열어 쓰는 쪽이 확실합니다.`
        : 'Ollama 가 켜져 있는지 확인하세요 (`ollama serve`). 켜져 있는데도 안 되면 OLLAMA_ORIGINS 설정이 필요합니다',
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EngineError(`Ollama 오류 ${res.status}`, body.slice(0, 200))
  }

  for await (const line of lines(res, signal)) {
    const t = line.trim()
    if (!t) continue
    try {
      const json = JSON.parse(t)
      if (typeof json.response === 'string') onToken(json.response)
      if (json.error) throw new EngineError(`Ollama: ${json.error}`)
    } catch (e) {
      if (e instanceof EngineError) throw e
    }
  }
}
