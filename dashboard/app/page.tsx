import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import HomeClient from './HomeClient'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const workflows = await prisma.workflow.findMany({
    orderBy: { recordedAt: 'desc' },
    include: {
      _count: { select: { screenshots: true, runs: true } },
    },
  })

  const totalRuns = await prisma.playbackRun.count()
  const totalCheckpoints = await prisma.playbackCheckpoint.count()

  return (
    <HomeClient
      workflows={workflows as any}
      stats={{ workflows: workflows.length, runs: totalRuns, checkpoints: totalCheckpoints }}
      userEmail={session.email}
    />
  )
}
