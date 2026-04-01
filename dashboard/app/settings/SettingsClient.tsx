'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { UserSettingsRecord } from '@/lib/data'

interface Props {
  initialSettings: UserSettingsRecord
  userEmail: string
}

/** Logged-in settings page for extension preferences synced from MongoDB. */
export default function SettingsClient({ initialSettings, userEmail }: Props) {
  const router = useRouter()
  const [playBufferSeconds, setPlayBufferSeconds] = useState(
    String(initialSettings.playBufferSeconds)
  )
  const [promptScreenshotLabel, setPromptScreenshotLabel] = useState(
    initialSettings.promptScreenshotLabel
  )
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | ''
    message: string
  }>({ type: '', message: '' })

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback({ type: '', message: '' })

    const parsedBuffer = Number.parseInt(playBufferSeconds, 10)
    if (!Number.isFinite(parsedBuffer) || parsedBuffer < 0 || parsedBuffer > 60) {
      setFeedback({
        type: 'error',
        message: 'DOM load buffer must be a whole number between 0 and 60.',
      })
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playBufferSeconds: parsedBuffer,
          promptScreenshotLabel,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.error || `Server returned ${res.status}`)
      }

      setPlayBufferSeconds(String(data.settings.playBufferSeconds))
      setPromptScreenshotLabel(Boolean(data.settings.promptScreenshotLabel))
      setFeedback({
        type: 'success',
        message: 'Settings saved. The extension will use them the next time the popup opens.',
      })
    } catch (error) {
      setFeedback({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Could not save settings.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <img src="/icon.svg" alt="Logo" className="sidebar-logo-icon-img" />
          <div>
            <div className="sidebar-logo-text">QA Dashboard</div>
            <div className="sidebar-logo-sub">Workflow Recorder</div>
          </div>
        </div>

        <Link href="/" className="nav-item">
          <span className="nav-icon" aria-hidden="true" />
          Workflows
        </Link>
        <Link href="/settings" className="nav-item active">
          <span className="nav-icon" aria-hidden="true" />
          Settings
        </Link>

        <div style={{ flex: 1 }} />

        <div style={{ padding: '12px 8px', borderTop: '1px solid var(--border)', marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Signed in as<br />
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{userEmail}</span>
          </div>
          <button
            className="btn btn-danger"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleLogout}
          >
            Sign Out
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          <div className="page-title">Settings</div>
          <div className="page-subtitle">
            These extension preferences are stored per account in MongoDB.
          </div>
        </div>

        <div className="content">
          <form onSubmit={handleSubmit} className="card" style={{ maxWidth: 720 }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              Extension Playback
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>
              Update the defaults used by the Chrome extension when this account is signed in.
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="settings-play-buffer">
                DOM Load Buffer (seconds)
              </label>
              <input
                id="settings-play-buffer"
                type="number"
                min={0}
                max={60}
                className="form-input"
                value={playBufferSeconds}
                onChange={(event) => setPlayBufferSeconds(event.target.value)}
              />
              <div className="form-hint" style={{ textAlign: 'left', marginTop: 4 }}>
                Extra wait time before playback continues after page loads.
              </div>
            </div>

            <label
              htmlFor="settings-prompt-label"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '14px 16px',
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                marginBottom: 18,
                cursor: 'pointer',
              }}
            >
              <input
                id="settings-prompt-label"
                type="checkbox"
                checked={promptScreenshotLabel}
                onChange={(event) => setPromptScreenshotLabel(event.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: 'block', fontWeight: 600 }}>
                  Prompt for screenshot labels
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  When enabled, screenshot checkpoints ask for an optional label. When disabled, screenshot checkpoints are saved without labels.
                </span>
              </span>
            </label>

            {feedback.message && (
              <div
                style={{
                  marginBottom: 18,
                  color:
                    feedback.type === 'error'
                      ? 'var(--red)'
                      : 'var(--green)',
                  fontSize: 14,
                }}
              >
                {feedback.message}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => router.push('/')}
              >
                Back to Workflows
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  )
}
