import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getWorkflowDetailForUser } from '@/lib/data'
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
  const workflow = await getWorkflowDetailForUser(id, session.userId)

  if (!workflow) redirect('/')

  return <WorkflowDetailClient workflow={workflow} />
}
