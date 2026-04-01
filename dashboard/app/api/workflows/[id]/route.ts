import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import { getWorkflowDetailForUser } from '@/lib/data'

// GET /api/workflows/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const workflow = await getWorkflowDetailForUser(id, session.userId)
  if (!workflow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(workflow)
}
