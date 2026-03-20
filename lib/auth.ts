/**
 * Session management using cookies + DB user lookup.
 * Passwords are stored as bcrypt hashes in the users table.
 */
import { cookies } from 'next/headers'
import { prisma } from './prisma'
import bcrypt from 'bcryptjs'

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
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return null
  const valid = await bcrypt.compare(password, user.passwordHash)
  return valid ? { userId: user.id, email: user.email } : null
}

export async function createUser(email: string, password: string): Promise<{ userId: string; email: string }> {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) throw new Error('An account with this email already exists')
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({ data: { email, passwordHash } })
  return { userId: user.id, email: user.email }
}

export { SESSION_COOKIE }
