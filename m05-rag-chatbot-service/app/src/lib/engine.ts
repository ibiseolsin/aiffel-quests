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
  gemini: { kind: 'gemini', flavor: 'vertex-sa', model: 'gemini-3.7-flash' },
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
function explainGeminiError(flavor: ApiFlavor, body: string): string {
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

async function generateGemini(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  // 창구마다 경로와 인증이 다르다
  const flavor = config.flavor ?? 'vertex-sa'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url: string
  let who: string

  if (flavor === 'vertex-sa') {
    const sa = config.serviceAccount
    if (!sa) throw new EngineError('서비스 계정 JSON 이 없다', '화면에서 JSON 파일을 고르세요')
    const loc = config.location?.trim() || DEFAULT_LOCATION
    // 리전을 지정하면 호스트도 그 리전으로 간다. global 은 리전 없는 호스트를 쓴다
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`
    url = `https://${host}/v1/projects/${sa.project_id}/locations/${loc}/publishers/google/models/${config.model}:streamGenerateContent?alt=sse`
    let token: string
    try {
      token = await getAccessToken(sa, signal)
    } catch (e) {
      if (signal.aborted) return
      throw new EngineError(`액세스 토큰을 받지 못했다: ${(e as Error).message}`)
    }
    headers.authorization = `Bearer ${token}`
    who = `${API_FLAVOR_LABEL[flavor]} · ${describeServiceAccount(sa)} · ${loc}`
  } else {
    if (!config.apiKey) throw new EngineError('API 키가 없다', '화면에서 API 키를 입력하세요')
    headers['x-goog-api-key'] = config.apiKey
    url =
      flavor === 'vertex'
        ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${config.model}:streamGenerateContent?alt=sse`
        : `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?alt=sse`
    who = API_FLAVOR_LABEL[flavor]
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
      `${explainGeminiError(flavor, body)}${body.slice(0, 400) || '응답 본문이 비어 있다'}`,
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

/** 이 페이지에서 이 주소를 부를 때 브라우저가 막을 가능성이 있는지 미리 본다 */
export function localEngineWarning(baseUrl: string): string | null {
  if (typeof location === 'undefined') return null
  if (location.protocol !== 'https:') return null
  if (!baseUrl.startsWith('http://')) return null
  return `이 페이지는 https(${location.origin})인데 Ollama 는 ${baseUrl} 입니다. 그대로는 브라우저나 Ollama 가 요청을 막습니다.`
}

/** 답을 만들기 전에 연결만 확인한다. 실패 원인을 질문 없이 알 수 있게 */
export async function pingOllama(
  baseUrl: string,
): Promise<{ ok: true; version: string } | { ok: false; message: string; hint?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/version`)
    if (!res.ok) return { ok: false, message: `Ollama 가 ${res.status} 를 돌려줬다` }
    const json = await res.json()
    return { ok: true, version: String(json.version ?? '알 수 없음') }
  } catch (e) {
    return {
      ok: false,
      message: `연결하지 못했다: ${(e as Error).message}`,
      hint:
        localEngineWarning(baseUrl) ??
        'Ollama 가 켜져 있는지 확인하세요 (`ollama serve`). 켜져 있는데도 안 되면 OLLAMA_ORIGINS 설정이 필요합니다',
    }
  }
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
