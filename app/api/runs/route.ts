import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/runs — create a playback run with its checkpoints
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { workflowId, playedAt, checkpoints } = body

  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId required' }, { status: 400 })
  }

  const run = await prisma.playbackRun.create({
    data: {
      workflowId,
      playedAt: playedAt ? new Date(playedAt) : new Date(),
    },
  })

  if (checkpoints && typeof checkpoints === 'object') {
    const checkpointData = Object.entries(checkpoints).map(([idx, entry]: [string, any]) => ({
      runId: run.id,
      index: parseInt(idx),
      label: entry.label ?? `Checkpoint ${parseInt(idx) + 1}`,
      dataUrl: entry.dataUrl ?? entry,
    }))
    if (checkpointData.length > 0) {
      await prisma.playbackCheckpoint.createMany({ data: checkpointData })
    }
  }

  return NextResponse.json({ id: run.id }, { status: 201 })
}
