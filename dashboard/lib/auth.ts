/**
 * Session management using cookies + DB user lookup.
 * Passwords are stored as bcrypt hashes in MongoDB.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { createUserRecord, findUserByEmail } from './data'

const SESSION_COOKIE = 'qa_session'
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

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf-8')
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

function createSignature(unsignedToken: string) {
  return createHmac('sha256', getJwtSecret()).update(unsignedToken).digest('base64url')
}

function verifySessionToken(token: string): Session | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [encodedHeader, encodedPayload, signature] = parts
  const header = decodeJson<SessionTokenHeader>(encodedHeader)
  const payload = decodeJson<SessionTokenPayload>(encodedPayload)

  if (!header || !payload) return null
  if (header.alg !== JWT_ALGORITHM || header.typ !== 'JWT') return null
  if (payload.iss !== SESSION_ISSUER) return null
  if (!payload.sub || !payload.email) return null

  const expectedSignature = createSignature(`${encodedHeader}.${encodedPayload}`)
  const actualBuffer = Buffer.from(signature, 'utf-8')
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8')
  if (actualBuffer.length !== expectedBuffer.length) return null
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp <= now) return null
  if (payload.iat > now + 60) return null

  return {
    userId: payload.sub,
    email: payload.email,
  }
}

function getBearerToken(headers: Headers) {
  const authorization = headers.get('authorization')
  if (!authorization) return null

  const [scheme, token] = authorization.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    return null
  }

  return token.trim()
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    return verifySessionToken(token)
  } catch {}
  return null
}

export function createSessionToken(userId: string, email: string) {
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
  const signature = createSignature(unsignedToken)

  return `${unsignedToken}.${signature}`
}

export async function getRequestSession(req: { headers: Headers }): Promise<Session | null> {
  const bearerToken = getBearerToken(req.headers)
  if (bearerToken) {
    try {
      return verifySessionToken(bearerToken)
    } catch {
      return null
    }
  }

  return getSession()
}

export async function checkCredentials(email: string, password: string): Promise<{ userId: string; email: string } | null> {
  const user = await findUserByEmail(email)
  if (!user) return null
  const valid = await bcrypt.compare(password, user.passwordHash)
  return valid ? { userId: user.id, email: user.email } : null
}

export async function createUser(email: string, password: string): Promise<{ userId: string; email: string }> {
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await createUserRecord(email, passwordHash)
  return { userId: user.id, email: user.email }
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS }
