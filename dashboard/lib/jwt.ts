/**
 * Edge-compatible JWT Implementation using Web Crypto API.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const SESSION_ISSUER = 'qa-dashboard'
const JWT_ALGORITHM = 'HS256'

export interface Session {
  userId: string
  email: string
}

interface SessionTokenHeader {
  alg: typeof JWT_ALGORITHM
  typ: 'JWT'
}

interface SessionTokenPayload {
  sub: string
  email: string
  iss: string
  iat: number
  exp: number
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.jwt_secret
  if (!secret) {
    throw new Error('JWT_SECRET is not set')
  }
  return secret
}

// Edge-compatible base64url encode/decode using purely Web APIs
function base64UrlEncode(str: string): string {
  // Use btoa safely for unicode by encoding to URI component first, then escaping
  const base64 = btoa(unescape(encodeURIComponent(str)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return decodeURIComponent(escape(atob(base64)))
}

function encodeJson(value: SessionTokenHeader | SessionTokenPayload) {
  return base64UrlEncode(JSON.stringify(value))
}

function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(base64UrlDecode(value)) as T
  } catch {
    return null
  }
}

async function getCryptoKey() {
  const secret = getJwtSecret()
  const encoder = new TextEncoder()
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function createSignature(unsignedToken: string): Promise<string> {
  const key = await getCryptoKey()
  const encoder = new TextEncoder()
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(unsignedToken))
  return base64UrlEncodeBytes(new Uint8Array(signatureBytes))
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [encodedHeader, encodedPayload, signatureStr] = parts
  const header = decodeJson<SessionTokenHeader>(encodedHeader)
  const payload = decodeJson<SessionTokenPayload>(encodedPayload)

  if (!header || !payload) return null
  if (header.alg !== JWT_ALGORITHM || header.typ !== 'JWT') return null
  if (payload.iss !== SESSION_ISSUER) return null
  if (!payload.sub || !payload.email) return null

  const key = await getCryptoKey()
  const encoder = new TextEncoder()
  
  // Reconstruct bytes from base64url signature
  let base64 = signatureStr.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) base64 += '='
  const binary = atob(base64)
  const signatureBytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    signatureBytes[i] = binary.charCodeAt(i)
  }

  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  )

  if (!isValid) return null

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp <= now) return null
  if (payload.iat > now + 60) return null

  return {
    userId: payload.sub,
    email: payload.email,
  }
}

export async function createSessionToken(userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header: SessionTokenHeader = {
    alg: JWT_ALGORITHM,
    typ: 'JWT',
  }
  const payload: SessionTokenPayload = {
    sub: userId,
    email,
    iss: SESSION_ISSUER,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }

  const encodedHeader = encodeJson(header)
  const encodedPayload = encodeJson(payload)
  const unsignedToken = `${encodedHeader}.${encodedPayload}`
  const signature = await createSignature(unsignedToken)

  return `${unsignedToken}.${signature}`
}
