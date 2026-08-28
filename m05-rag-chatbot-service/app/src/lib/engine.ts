/**
 * 답변 생성 엔진.
 *
 * 두 어댑터가 **같은 인터페이스**를 쓴다. 그래야 프롬프트·인용·판정이 엔진과 무관하게
 * 한 벌만 있고, 엔진을 바꿔도 답변 품질 차이만 남는다 (그 비교가 확장 항목이다).
 *
 * **자동 폴백은 없다.** 한쪽이 죽으면 실패로 보여 준다 — 조용히 다른 엔진으로 넘어가면
 * 사용자는 자기가 어느 엔진의 답을 읽고 있는지 모른다.
 */

export type EngineKind = 'gemini' | 'ollama'

export type EngineConfig = {
  kind: EngineKind
  /** Gemini 만 쓴다. **브라우저 안에만 있고 저장소·배포본에 들어가지 않는다** */
  apiKey?: string
  /** Ollama 만 쓴다 */
  baseUrl?: string
  model: string
}

export const ENGINE_DEFAULTS: Record<EngineKind, EngineConfig> = {
  // 정적 배포에는 키를 넣을 수 없다(공개된다). 방문자가 자기 키를 화면에서 넣는다
  gemini: { kind: 'gemini', model: 'gemini-2.5-flash' },
  // 콜드 스타트 43초를 측정해 두었다 (FINDINGS 1절) — 첫 답변이 늦은 것은 고장이 아니다
  ollama: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:2b' },
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
 * Gemini — 브라우저에서 직접 호출한다. CORS 가 임의 origin 을 허용하는 것을
 * 실측으로 확인했다 (`x-goog-api-key` 헤더 사용, PLAN 결정 D5).
 *
 * **이 경로는 아직 실행 확인되지 않았다** — 키가 없으면 확인할 수 없기 때문이다.
 * Ollama 경로로 프롬프트·스트리밍·취소·인용을 검증했고, 여기는 같은 코드를 쓴다.
 */
async function generateGemini(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  if (!config.apiKey) throw new EngineError('API 키가 없다', '화면에서 Gemini API 키를 입력하세요')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?alt=sse`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
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
    throw new EngineError(
      `Gemini 오류 ${res.status}`,
      res.status === 400 || res.status === 403
        ? '키가 올바른지, 그 키로 이 모델을 쓸 수 있는지 확인하세요'
        : body.slice(0, 200),
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
 * 배포된 페이지(https)에서 `http://127.0.0.1` 을 부르는 것은 브라우저가 허용하지만,
 * Ollama 쪽에서 origin 을 막는다. 그래서 `OLLAMA_ORIGINS` 설정이 필요하다 (README).
 */
async function generateOllama(
  config: EngineConfig,
  prompt: string,
  onToken: OnToken,
  signal: AbortSignal,
): Promise<void> {
  const base = config.baseUrl ?? ENGINE_DEFAULTS.ollama.baseUrl
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
    throw new EngineError(
      `Ollama 에 연결하지 못했다: ${(e as Error).message}`,
      'Ollama 가 켜져 있는지, 그리고 이 페이지 주소가 OLLAMA_ORIGINS 에 있는지 확인하세요',
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
