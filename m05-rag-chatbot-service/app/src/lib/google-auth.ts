/**
 * 서비스 계정 JSON 으로 Vertex AI 액세스 토큰을 받는다.
 *
 * API 키와는 **인증 방식이 다르다.** 키는 헤더에 그대로 실어 보내면 되지만, 서비스 계정은
 * 개인키로 JWT 를 서명해 구글 토큰 엔드포인트에서 액세스 토큰으로 바꿔야 한다.
 * 그래서 이 파일이 필요하다.
 *
 * ## 알고 쓸 것
 *
 * 서비스 계정 JSON 안에는 **개인키**가 들어 있고, 보통 API 키보다 권한이 넓다.
 * 브라우저에 그걸 올리는 것은 구글이 권하지 않는 방식이다 — 정적 배포에서 방문자마다
 * 자기 자격증명을 넣는 용도로는 **API 키가 맞는 모양**이고, 서비스 계정은 서버 쪽 물건이다.
 *
 * 그래서 여기서는 다음을 지킨다:
 * - 파일 내용을 **localStorage 에 저장하지 않는다.** 메모리에만 두고 새로고침하면 사라진다
 * - 개인키를 화면에 표시하지 않는다
 * - 토큰은 만료 1분 전까지만 재사용한다
 *
 * Node 와 브라우저가 같은 코드를 쓴다 (둘 다 WebCrypto 가 있다) — 그래야 스크립트로
 * 검증한 것이 배포본에서도 같게 동작한다.
 */

export type ServiceAccount = {
  type: string
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  token_uri: string
}

const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/** 필요한 필드가 다 있는지 본다. 없으면 무엇이 없는지 말해 준다 */
export function parseServiceAccount(text: string): ServiceAccount {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('JSON 으로 읽히지 않는다. 서비스 계정 키 파일인지 확인하세요')
  }
  if (json.type !== 'service_account') {
    throw new Error(
      `서비스 계정 파일이 아니다 (type=${String(json.type)}). Google Cloud 콘솔 → IAM → 서비스 계정 → 키 → JSON 으로 받은 파일이어야 합니다`,
    )
  }
  const missing = (['project_id', 'private_key', 'client_email'] as const).filter((k) => !json[k])
  if (missing.length) throw new Error(`서비스 계정 파일에 없는 항목: ${missing.join(', ')}`)
  return {
    type: 'service_account',
    project_id: String(json.project_id),
    private_key_id: String(json.private_key_id ?? ''),
    private_key: String(json.private_key),
    client_email: String(json.client_email),
    token_uri: String(json.token_uri ?? TOKEN_URI),
  }
}

const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlText = (text: string) => b64url(new TextEncoder().encode(text))

/** PEM(PKCS#8) → DER. 헤더·줄바꿈을 걷어내고 base64 를 푼다 */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  if (!body) throw new Error('private_key 가 PEM 형식이 아니다')
  const raw = atob(body)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** RS256 으로 서명한 JWT. 구글 토큰 엔드포인트가 이걸 액세스 토큰으로 바꿔 준다 */
export async function signJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key) as unknown as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id || undefined }
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URI,
    iat: now,
    exp: now + 3600,
  }
  const body = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claims))}`
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(body) as unknown as ArrayBuffer,
  )
  return `${body}.${b64url(new Uint8Array(sig))}`
}

type CachedToken = { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

/**
 * 액세스 토큰. 만료 1분 전까지 재사용한다 —
 * 질문마다 토큰을 새로 받으면 느리고 쿼터도 아깝다.
 */
export async function getAccessToken(sa: ServiceAccount, signal?: AbortSignal): Promise<string> {
  const cacheKey = `${sa.client_email}|${sa.private_key_id}`
  const hit = tokenCache.get(cacheKey)
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token

  const jwt = await signJwt(sa)
  const res = await fetch(sa.token_uri || TOKEN_URI, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    // 본문을 그대로 보여 준다. 여기서 나오는 오류는 원인이 갈린다 —
    // 시계가 틀렸거나(invalid_grant), 키가 폐기됐거나, IAM API 가 꺼져 있거나
    throw new Error(`토큰을 받지 못했다 (${res.status}): ${text.slice(0, 300)}`)
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error(`응답에 access_token 이 없다: ${text.slice(0, 200)}`)
  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  })
  return json.access_token
}

/** 파일에서 읽은 것을 그대로 들고 다니지 않도록, 화면에 보일 만한 것만 남긴다 */
export function describeServiceAccount(sa: ServiceAccount): string {
  return `${sa.client_email} · 프로젝트 ${sa.project_id}`
}
