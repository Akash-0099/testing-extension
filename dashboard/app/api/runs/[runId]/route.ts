import { NextRequest, NextResponse } from 'next/server'
import { getRunDetail } from '@/lib/data'

// GET /api/runs/[runId] — full run with checkpoints
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params
  const run = await getRunDetail(runId)
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(run)
}
