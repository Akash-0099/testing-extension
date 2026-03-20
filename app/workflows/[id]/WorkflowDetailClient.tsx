'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Screenshot {
  id: string
  index: number
  label: string | null
  dataUrl: string
  url: string | null
}

interface Run {
  id: string
  playedAt: string
  _count: { checkpoints: number }
}

interface Workflow {
  id: string
  name: string
  recordedAt: string
  events: any[]
  screenshots: Screenshot[]
  runs: Run[]
}

export default function WorkflowDetailClient({ workflow }: { workflow: Workflow }) {
  const router = useRouter()
  const [selectedImg, setSelectedImg] = useState<Screenshot | null>(null)

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const eventCount = Array.isArray(workflow.events) ? workflow.events.length : 0

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🎬</div>
          <div>
            <div className="sidebar-logo-text">QA Dashboard</div>
            <div className="sidebar-logo-sub">Workflow Studio</div>
          </div>
        </div>
        <a href="/" className="nav-item">
          <span className="nav-icon">📋</span>All Workflows
        </a>
        <div className="nav-item active">
          <span className="nav-icon">🔍</span>Detail View
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          {/* Breadcrumb */}
          <div className="breadcrumb" onClick={() => router.push('/')}>
            ← Back to all workflows
          </div>
          <div className="page-title">{workflow.name}</div>
          <div className="page-subtitle">Recorded {fmtDate(workflow.recordedAt)} · {eventCount} events</div>
        </div>

        <div className="content">
          {/* Stats */}
          <div className="stats-row" style={{ marginBottom: 28 }}>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--accent-light)' }}>{workflow.screenshots.length}</div>
              <div className="stat-label">Recording Checkpoints</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--green)' }}>{workflow.runs.length}</div>
              <div className="stat-label">Playback Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--blue)' }}>{eventCount}</div>
              <div className="stat-label">Recorded Events</div>
            </div>
          </div>

          {/* Recording screenshots */}
          <div className="section-title">📸 Recording Checkpoints</div>
          {workflow.screenshots.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <div className="empty-icon">📷</div>
              <div className="empty-title">No checkpoints yet</div>
              <div className="empty-desc">Take screenshot checkpoints while recording to see them here.</div>
            </div>
          ) : (
            <div className="screenshot-strip">
              {workflow.screenshots.map(s => (
                <div
                  key={s.id}
                  id={`recording-screenshot-${s.index}`}
                  className="screenshot-thumb"
                  onClick={() => setSelectedImg(s)}
                >
                  <img src={s.dataUrl} alt={s.label || `Checkpoint ${s.index + 1}`} />
                  <div className="screenshot-thumb-label">{s.label || `Checkpoint ${s.index + 1}`}</div>
                </div>
              ))}
            </div>
          )}

          <hr className="divider" />

          {/* Playback runs */}
          <div className="section-title" style={{ marginBottom: 14 }}>▶ Playback Runs</div>
          {workflow.runs.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <div className="empty-icon">🎥</div>
              <div className="empty-title">No playback runs yet</div>
              <div className="empty-desc">Play back this workflow in the extension to capture checkpoint screenshots for comparison.</div>
            </div>
          ) : (
            <div className="run-list">
              {workflow.runs.map(run => (
                <div
                  key={run.id}
                  id={`run-item-${run.id}`}
                  className="run-item"
                  onClick={() => router.push(`/workflows/${workflow.id}/runs/${run.id}`)}
                >
                  <div className="run-item-left">
                    <div className="run-item-date">Played {fmtDate(run.playedAt)}</div>
                    <div className="run-item-count">{run._count.checkpoints} checkpoints captured</div>
                  </div>
                  <span className="badge badge-green">View Comparison →</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Lightbox */}
      {selectedImg && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 999, cursor: 'pointer',
          }}
          onClick={() => setSelectedImg(null)}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <img src={selectedImg.dataUrl} alt={selectedImg.label || ''} style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12 }} />
            <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'rgba(0,0,0,0.7)', padding: '6px 12px', borderRadius: 8, fontSize: 13, color: '#fff' }}>
              {selectedImg.label || `Checkpoint ${selectedImg.index + 1}`} {selectedImg.url ? `· ${new URL(selectedImg.url).pathname}` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
