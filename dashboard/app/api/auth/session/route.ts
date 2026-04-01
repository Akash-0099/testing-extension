import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    ok: true,
    user: {
      userId: session.userId,
      email: session.email,
    },
  })
}
