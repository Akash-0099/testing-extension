import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import { getRunDetailForUser } from '@/lib/data'

// GET /api/runs/[runId] — full run with checkpoints
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { runId } = await params
  const run = await getRunDetailForUser(runId, session.userId)
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(run)
}
