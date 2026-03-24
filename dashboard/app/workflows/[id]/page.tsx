import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import WorkflowDetailClient from './WorkflowDetailClient'

/** Server page: loads one workflow with screenshots and runs, or redirects. */
export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

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

  if (!workflow) redirect('/')

  return <WorkflowDetailClient workflow={workflow as any} />
}
