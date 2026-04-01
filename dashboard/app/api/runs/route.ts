import { NextRequest, NextResponse } from 'next/server'
import { createRunRecord } from '@/lib/data'

interface RunCheckpointInput {
  label?: string | null
  checkpointType?: string | null
  dataUrl?: string | null
  capturedData?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asRunCheckpointInput(value: unknown): RunCheckpointInput {
  return isRecord(value) ? (value as RunCheckpointInput) : {}
}

// POST /api/runs — create a playback run with its checkpoints
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    workflowId?: string
    playedAt?: string
    checkpoints?: Record<string, unknown> | null
    status?: string
    failedEventIndex?: number | null
    failedEventType?: string | null
    failedEventSelector?: string | null
  }
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

  let run
  try {
    run = await createRunRecord({
      workflowId,
      playedAt: playedAt ? new Date(playedAt) : new Date(),
      status: status ?? 'passed',
      failedEventIndex: failedEventIndex ?? null,
      failedEventType: failedEventType ?? null,
      failedEventSelector: failedEventSelector ?? null,
      checkpoints: checkpoints && typeof checkpoints === 'object'
        ? Object.entries(checkpoints).map(([idx, entry]) => {
            const checkpoint = asRunCheckpointInput(entry)
            const checkpointIndex = Number.parseInt(idx, 10)

            return {
              index: checkpointIndex,
              label: checkpoint.label ?? `Checkpoint ${checkpointIndex + 1}`,
              checkpointType: checkpoint.checkpointType ?? 'screenshot',
              dataUrl: checkpoint.dataUrl ?? null,
              capturedData: checkpoint.capturedData ?? null,
            }
          })
        : [],
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 })
  }
  // #region agent log
  fetch('http://127.0.0.1:7561/ingest/b3d33611-6fc1-4e05-be90-0b2bee1a6f88',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'883328'},body:JSON.stringify({sessionId:'883328',runId:'playback-pre-fix',hypothesisId:'H4',location:'dashboard/app/api/runs/route.ts:POST:created',message:'Playback run inserted',data:{runId:run.id,status:run.status,failedEventIndex:run.failedEventIndex??null,failedEventType:run.failedEventType??null,hasFailedEventSelector:!!run.failedEventSelector},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  return NextResponse.json({ id: run.id }, { status: 201 })
}
