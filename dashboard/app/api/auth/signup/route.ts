import { NextRequest, NextResponse } from 'next/server'
import { createUser, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }

  try {
    const user = await createUser(email, password)
    const token = createSessionToken(user.userId, user.email)
    const response = NextResponse.json({
      ok: true,
      token,
      user: {
        userId: user.userId,
        email: user.email,
      },
    })
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    })
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create user'
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
