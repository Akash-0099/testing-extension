import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/workflows/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: {
      screenshots: { orderBy: { index: 'asc' } },
      runs: {
        orderBy: { playedAt: 'desc' },
        include: { _count: { select: { checkpoints: true } } },
      },
    },
  })
  if (!workflow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(workflow)
}
