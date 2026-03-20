import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import ComparisonClient from './ComparisonClient'

export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

  const { id, runId } = await params

  const run = await prisma.playbackRun.findUnique({
    where: { id: runId },
    include: {
      checkpoints: { orderBy: { index: 'asc' } },
      workflow: {
        include: { screenshots: { orderBy: { index: 'asc' } } },
      },
    },
  })

  if (!run || run.workflowId !== id) redirect(`/workflows/${id}`)

  return <ComparisonClient run={run as any} workflowId={id} />
}
