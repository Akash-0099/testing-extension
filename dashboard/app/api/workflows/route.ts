import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

function isCheckpointType(type: unknown) {
  return type === 'checkpoint' || type === 'console_checkpoint' || type === 'network_checkpoint'
}

function checkpointToEvent(checkpoint: any) {
  if (!checkpoint || !isCheckpointType(checkpoint.type)) return null
  return {
    checkpointId: checkpoint.checkpointId ?? null,
    type: checkpoint.type,
    label: checkpoint.label ?? null,
    url: checkpoint.url ?? null,
    timestamp: checkpoint.timestamp ?? Date.now(),
    screenshotIndex: checkpoint.screenshotIndex ?? null,
    logMessage: checkpoint.logMessage ?? null,
    logLevel: checkpoint.logLevel ?? null,
    logTimestamp: checkpoint.logTimestamp ?? null,
    logUrl: checkpoint.logUrl ?? null,
    logContextBefore: checkpoint.logContextBefore ?? [],
    logContextAfter: checkpoint.logContextAfter ?? [],
    networkUrl: checkpoint.networkUrl ?? null,
    networkMethod: checkpoint.networkMethod ?? null,
    networkStatus: checkpoint.networkStatus ?? null,
    networkStatusText: checkpoint.networkStatusText ?? null,
    networkRequestHeaders: checkpoint.networkRequestHeaders ?? null,
    networkResponseHeaders: checkpoint.networkResponseHeaders ?? null,
    networkRequestBody: checkpoint.networkRequestBody ?? null,
    networkResponseBody: checkpoint.networkResponseBody ?? null,
  }
}

function normalizeEvents(events: any[], checkpoints: any[]) {
  const eventList = Array.isArray(events) ? [...events] : []
  const explicitCheckpoints: any[] = []
  if (Array.isArray(checkpoints)) {
    checkpoints.forEach((checkpoint) => {
      const mapped = checkpointToEvent(checkpoint)
      if (mapped) explicitCheckpoints.push(mapped)
    })
  }

  if (explicitCheckpoints.length === 0) return eventList

  const existingCheckpointKeys = new Set(
    eventList
      .filter((event) => isCheckpointType(event?.type))
      .map((event) => event?.checkpointId
        ? `checkpoint:${event.checkpointId}`
        : JSON.stringify([
            event.type ?? null,
            event.label ?? null,
            event.timestamp ?? null,
            event.url ?? null,
          ]))
  )

  explicitCheckpoints.forEach((checkpoint) => {
    const key = checkpoint?.checkpointId
      ? `checkpoint:${checkpoint.checkpointId}`
      : JSON.stringify([
          checkpoint.type ?? null,
          checkpoint.label ?? null,
          checkpoint.timestamp ?? null,
          checkpoint.url ?? null,
        ])
    if (!existingCheckpointKeys.has(key)) {
      eventList.push(checkpoint)
    }
  })

  eventList.sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0))
  return eventList
}

// GET /api/workflows — list all workflows
export async function GET(req: NextRequest) {
  // Allow the extension to list workflows without a browser session.
  const isExtension = req.headers.get('X-Extension') === 'true'
  if (!isExtension) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workflows = await prisma.workflow.findMany({
    orderBy: { recordedAt: 'desc' },
    include: {
      _count: { select: { screenshots: true, runs: true } },
    },
  })
  return NextResponse.json(workflows)
}

// POST /api/workflows — create workflow + recording screenshots
export async function POST(req: NextRequest) {
  // Allow extension without session (API key check via Origin could be added later)
  const body = await req.json()
  const { name, recordedAt, events, screenshots, checkpoints } = body
  const normalizedEvents = normalizeEvents(
    Array.isArray(events) ? events : [],
    Array.isArray(checkpoints) ? checkpoints : []
  )
  const checkpointEvents = normalizedEvents.filter((e: any) => e?.type === 'checkpoint')

  if (!name || !Array.isArray(events)) {
    return NextResponse.json({ error: 'name and events required' }, { status: 400 })
  }

  const workflow = await prisma.workflow.create({
    data: {
      name,
      recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
      events: normalizedEvents,
    },
  })

  // Bulk-insert recording screenshots if provided
  if (screenshots && typeof screenshots === 'object') {
    const screenshotData = Object.entries(screenshots).map(([idx, dataUrl]) => {
      const checkpoint = checkpointEvents[parseInt(idx)]
      return {
        workflowId: workflow.id,
        index: parseInt(idx),
        label: checkpoint?.label ?? `Checkpoint ${parseInt(idx) + 1}`,
        url: checkpoint?.url ?? null,
        dataUrl: dataUrl as string,
      }
    })
    if (screenshotData.length > 0) {
      await prisma.recordingScreenshot.createMany({ data: screenshotData })
    }
  }

  return NextResponse.json({
    id: workflow.id,
    checkpointCount: normalizedEvents.filter((event: any) => isCheckpointType(event?.type)).length,
  }, { status: 201 })
}
