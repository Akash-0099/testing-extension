import { NextRequest, NextResponse } from 'next/server'
import { getWorkflowDetail } from '@/lib/data'

// GET /api/workflows/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workflow = await getWorkflowDetail(id)
  if (!workflow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(workflow)
}
