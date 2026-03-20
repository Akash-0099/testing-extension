import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

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
  const { name, recordedAt, events, screenshots } = body

  if (!name || !events) {
    return NextResponse.json({ error: 'name and events required' }, { status: 400 })
  }

  const workflow = await prisma.workflow.create({
    data: {
      name,
      recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
      events,
    },
  })

  // Bulk-insert recording screenshots if provided
  if (screenshots && typeof screenshots === 'object') {
    const screenshotData = Object.entries(screenshots).map(([idx, dataUrl]) => {
      // Find matching checkpoint event
      const checkpointEvents = (events as any[]).filter((e: any) => e.type === 'checkpoint')
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

  return NextResponse.json({ id: workflow.id }, { status: 201 })
}
