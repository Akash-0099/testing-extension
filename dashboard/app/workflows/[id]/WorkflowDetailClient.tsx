'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

// ─── Event type helpers ───────────────────────────────────────────────────────

type CheckpointEvent =
  | { type: 'checkpoint';         label: string; screenshotIndex: number; url: string; timestamp: number }
  | { type: 'console_checkpoint'; label: string; logMessage: string;      url: string; timestamp: number }
  | { type: 'network_checkpoint'; label: string; networkUrl: string; networkMethod: string; networkStatus: number; url: string; timestamp: number }

function isCheckpointEvent(e: any): e is CheckpointEvent {
  return e?.type === 'checkpoint' || e?.type === 'console_checkpoint' || e?.type === 'network_checkpoint'
}

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
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
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

/** Single-workflow studio view: checkpoints, runs, and screenshot lightbox. */
export default function WorkflowDetailClient({ workflow }: { workflow: Workflow }) {
  const router = useRouter()
  const [selectedImg, setSelectedImg] = useState<Screenshot | null>(null)

  /** Formats timestamps for headers and run rows (en-US). */
  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const eventCount = Array.isArray(workflow.events) ? workflow.events.length : 0
  const passedRuns = workflow.runs.filter(r => r.status === 'passed').length
  const failedRuns = workflow.runs.filter(r => r.status === 'failed').length

  // All three checkpoint types extracted from the events JSON
  const checkpointEvents = Array.isArray(workflow.events)
    ? (workflow.events as any[]).filter(isCheckpointEvent)
    : []

  /** Downloads the workflow data as a prettified JSON file. */
  function handleExportJson() {
    const data = JSON.stringify(workflow, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.name.replace(/\s+/g, '-').toLowerCase() || 'workflow'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Map screenshot-checkpoint events to their captured thumbnail (screenshots are keyed by
  // sequential index among screenshot-only checkpoints, not the overall event index).
  let ssIdx = 0
  const screenshotByEventIndex = new Map<number, Screenshot>()
  if (Array.isArray(workflow.events)) {
    (workflow.events as any[]).forEach((ev, evIdx) => {
      if (ev?.type === 'checkpoint') {
        const ss = workflow.screenshots.find(s => s.index === ssIdx)
        if (ss) screenshotByEventIndex.set(evIdx, ss)
        ssIdx++
      }
    })
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <img src="/icon.svg" alt="Logo" className="sidebar-logo-icon-img" />
          <div>
            <div className="sidebar-logo-text">QA Dashboard</div>
            <div className="sidebar-logo-sub">Workflow Studio</div>
          </div>
        </div>
        <Link href="/" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          All Workflows
        </Link>
        <Link href="/settings" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </Link>
        <div className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          Detail View
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          {/* Breadcrumb */}
          <div className="breadcrumb" onClick={() => router.push('/')}>
            ← Back to all workflows
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div className="page-title">{workflow.name}</div>
            <button
              onClick={handleExportJson}
              className="btn btn-primary"
              style={{ padding: '8px 16px', fontSize: 13, gap: 8 }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export JSON
            </button>
          </div>
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
              <div className="stat-val" style={{ color: 'var(--green)' }}>{passedRuns}</div>
              <div className="stat-label">Passed Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: failedRuns > 0 ? 'var(--red, #ef4444)' : 'var(--text-muted)' }}>{failedRuns}</div>
              <div className="stat-label">Failed Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--blue)' }}>{eventCount}</div>
              <div className="stat-label">Recorded Events</div>
            </div>
          </div>

          {/* Recording screenshots */}
          <div className="section-title">Recording Checkpoints</div>
          {workflow.screenshots.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
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

          {/* Checkpoint timeline */}
          <div className="section-title" style={{ marginBottom: 14 }}>Checkpoint Timeline</div>
          {checkpointEvents.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 20px', marginBottom: 24 }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <div className="empty-title">No checkpoints recorded</div>
              <div className="empty-desc">Add screenshot, console, or network checkpoints while recording to see them here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {checkpointEvents.map((cp, i) => {
                const isScreenshot = cp.type === 'checkpoint'
                const isConsole    = cp.type === 'console_checkpoint'
                const isNetwork    = cp.type === 'network_checkpoint'

                const accentColor = isScreenshot ? 'var(--blue, #3b82f6)'
                  : isConsole    ? '#7c3aed'
                  : '#0891b2'

                const typeLabel = isScreenshot ? 'Screenshot' : isConsole ? 'Console' : 'Network'

                // Find the thumbnail for screenshot checkpoints
                let thumb: Screenshot | undefined
                if (isScreenshot) {
                  // Re-derive per rendered list order
                  let screenshotCpIdx = 0
                  for (let j = 0; j <= i; j++) {
                    if (checkpointEvents[j].type === 'checkpoint') {
                      if (j === i) {
                        thumb = workflow.screenshots.find(s => s.index === screenshotCpIdx)
                      }
                      screenshotCpIdx++
                    }
                  }
                }

                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 14,
                      background: 'var(--bg2, #111)', border: '1px solid var(--border)',
                      borderLeft: `3px solid ${accentColor}`,
                      borderRadius: 8, padding: '12px 16px',
                    }}
                  >
                    {/* Index badge */}
                    <div style={{
                      minWidth: 28, height: 28, borderRadius: '50%',
                      background: accentColor, color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, flexShrink: 0,
                    }}>
                      {i + 1}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.6px', color: accentColor,
                        }}>{typeLabel}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cp.label}
                        </span>
                      </div>

                      {isConsole && (
                        <div style={{
                          fontFamily: 'monospace', fontSize: 11,
                          background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)',
                          borderRadius: 4, padding: '4px 8px', color: '#a78bfa',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {(cp as any).logMessage?.slice(0, 120) ?? ''}
                        </div>
                      )}

                      {isNetwork && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{
                            fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                            background: 'rgba(8,145,178,0.15)', color: '#22d3ee',
                            border: '1px solid rgba(8,145,178,0.3)',
                            borderRadius: 3, padding: '2px 6px',
                          }}>
                            {(cp as any).networkMethod}
                          </span>
                          <span style={{
                            fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320,
                          }}>
                            {(cp as any).networkUrl?.replace(/^https?:\/\/[^/]+/, '') ?? (cp as any).networkUrl}
                          </span>
                          {(cp as any).networkStatus != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, borderRadius: 3, padding: '2px 6px',
                              background: (cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
                              color: (cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? '#4ade80' : '#f87171',
                              border: `1px solid ${(cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
                            }}>
                              {(cp as any).networkStatus}
                            </span>
                          )}
                        </div>
                      )}

                      {isScreenshot && thumb && (
                        <img
                          src={thumb.dataUrl}
                          alt={cp.label}
                          onClick={() => setSelectedImg(thumb!)}
                          style={{
                            marginTop: 8, height: 72, borderRadius: 6,
                            border: '1px solid var(--border)', cursor: 'pointer',
                            objectFit: 'cover', display: 'block',
                          }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <hr className="divider" />

          {/* Playback runs */}
          <div className="section-title" style={{ marginBottom: 14 }}>Playback Runs</div>
          {workflow.runs.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <div className="empty-title">No playback runs yet</div>
              <div className="empty-desc">Play back this workflow in the extension to capture checkpoint screenshots for comparison.</div>
            </div>
          ) : (
            <div className="run-list">
              {workflow.runs.map(run => {
                const isPassed = run.status === 'passed'
                const isFailed = run.status === 'failed'
                const isAborted = run.status === 'aborted'
                return (
                  <div
                    key={run.id}
                    id={`run-item-${run.id}`}
                    className="run-item"
                    onClick={() => router.push(`/workflows/${workflow.id}/runs/${run.id}`)}
                    style={{ borderLeft: `3px solid ${isFailed ? 'var(--red, #ef4444)' : isPassed ? 'var(--green)' : 'var(--border)'}` }}
                  >
                    <div className="run-item-left">
                      <div className="run-item-date">Played {fmtDate(run.playedAt)}</div>
                      <div className="run-item-count">{run._count.checkpoints} checkpoints captured</div>
                      {isFailed && run.failedEventType && (
                        <div style={{ fontSize: 11, color: 'var(--red, #ef4444)', marginTop: 4 }}>
                          Failed at step {(run.failedEventIndex ?? 0) + 1}: {run.failedEventType}
                          {run.failedEventSelector ? ` — ${run.failedEventSelector.slice(0, 50)}` : ''}
                        </div>
                      )}
                      {isAborted && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          Stopped manually
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      {isPassed && <span className="badge badge-green">Passed</span>}
                      {isFailed && <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Failed</span>}
                      {isAborted && <span className="badge" style={{ background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Aborted</span>}
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>View →</span>
                    </div>
                  </div>
                )
              })}
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
