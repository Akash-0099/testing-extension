import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { countPlaybackCheckpoints, countPlaybackRuns, listWorkflowSummaries } from '@/lib/data'
import HomeClient from './HomeClient'

/** Server page: requires session, loads workflows and aggregate stats for `HomeClient`. */
export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const [workflows, totalRuns, totalCheckpoints] = await Promise.all([
    listWorkflowSummaries(),
    countPlaybackRuns(),
    countPlaybackCheckpoints(),
  ])

  return (
    <HomeClient
      workflows={workflows}
      stats={{ workflows: workflows.length, runs: totalRuns, checkpoints: totalCheckpoints }}
      userEmail={session.email}
    />
  )
}
