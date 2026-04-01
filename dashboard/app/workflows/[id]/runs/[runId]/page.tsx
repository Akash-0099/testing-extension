import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getRunDetail } from '@/lib/data'
import ComparisonClient from './ComparisonClient'

/** Server page: loads a playback run with checkpoints and baseline screenshots. */
export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

  const { id, runId } = await params

  const run = await getRunDetail(runId)

  if (!run || run.workflowId !== id) redirect(`/workflows/${id}`)

  return <ComparisonClient run={run} workflowId={id} />
}
