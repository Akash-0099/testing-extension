import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getUserSettings } from '@/lib/data'
import SettingsClient from './SettingsClient'

/** Server page: loads the signed-in user's extension settings. */
export default async function SettingsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const settings = await getUserSettings(session.userId)

  return (
    <SettingsClient
      initialSettings={settings}
      userEmail={session.email}
    />
  )
}
