import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/runs/[runId] — full run with checkpoints
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params
  const run = await prisma.playbackRun.findUnique({
    where: { id: runId },
    include: {
      checkpoints: { orderBy: { index: 'asc' } },
      workflow: {
        include: { screenshots: { orderBy: { index: 'asc' } } },
      },
    },
  })
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(run)
}
