import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/runs — create a playback run with its checkpoints
export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    workflowId,
    playedAt,
    checkpoints,
    status,
    failedEventIndex,
    failedEventType,
    failedEventSelector,
  } = body
  // #region agent log
  fetch('http://127.0.0.1:7561/ingest/b3d33611-6fc1-4e05-be90-0b2bee1a6f88',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'883328'},body:JSON.stringify({sessionId:'883328',runId:'playback-pre-fix',hypothesisId:'H4',location:'dashboard/app/api/runs/route.ts:POST:body',message:'Runs API received payload',data:{workflowId:workflowId??null,status:status??null,failedEventIndex:failedEventIndex??null,failedEventType:failedEventType??null,hasFailedEventSelector:!!failedEventSelector},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId required' }, { status: 400 })
  }

  const run = await prisma.playbackRun.create({
    data: {
      workflowId,
      playedAt: playedAt ? new Date(playedAt) : new Date(),
      status: status ?? 'passed',
      failedEventIndex: failedEventIndex ?? null,
      failedEventType: failedEventType ?? null,
      failedEventSelector: failedEventSelector ?? null,
    },
  })
  // #region agent log
  fetch('http://127.0.0.1:7561/ingest/b3d33611-6fc1-4e05-be90-0b2bee1a6f88',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'883328'},body:JSON.stringify({sessionId:'883328',runId:'playback-pre-fix',hypothesisId:'H4',location:'dashboard/app/api/runs/route.ts:POST:created',message:'Playback run inserted',data:{runId:run.id,status:run.status,failedEventIndex:run.failedEventIndex??null,failedEventType:run.failedEventType??null,hasFailedEventSelector:!!run.failedEventSelector},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (checkpoints && typeof checkpoints === 'object') {
    const checkpointData = Object.entries(checkpoints).map(([idx, entry]: [string, any]) => ({
      runId: run.id,
      index: parseInt(idx),
      label: entry.label ?? `Checkpoint ${parseInt(idx) + 1}`,
      checkpointType: entry.checkpointType ?? 'screenshot',
      dataUrl: entry.dataUrl ?? null,
      capturedData: entry.capturedData ?? null,
    }))
    if (checkpointData.length > 0) {
      await prisma.playbackCheckpoint.createMany({ data: checkpointData })
    }
  }

  return NextResponse.json({ id: run.id }, { status: 201 })
}
