/**
 * Session management using cookies + DB user lookup.
 * Passwords are stored as bcrypt hashes in MongoDB.
 */
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { createUserRecord, findUserByEmail } from './data'

const SESSION_COOKIE = 'qa_session'

export interface Session {
  userId: string
  email: string
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const [userId, email] = decoded.split(':')
    if (userId && email) return { userId, email }
  } catch {}
  return null
}

export function createSessionToken(userId: string, email: string) {
  return Buffer.from(`${userId}:${email}`).toString('base64')
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

export { SESSION_COOKIE }
