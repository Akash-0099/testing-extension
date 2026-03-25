'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Checkpoint {
  id: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
}

interface RecordingScreenshot {
  id: string
  index: number
  label: string | null
  dataUrl: string
}

interface Run {
  id: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: Checkpoint[]
  workflow: {
    id: string
    name: string
    recordedAt: string
    events: any[]
    screenshots: RecordingScreenshot[]
  }
}

/** Side-by-side recording vs playback comparison for one run, with checkpoint navigation. */
export default function ComparisonClient({ run, workflowId }: { run: Run; workflowId: string }) {
  const router = useRouter()
  const [activeIndex, setActiveIndex] = useState(0)

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  // Derive recording-time checkpoint events in order (to match by position)
  const recordingCheckpointEvents: any[] = (run.workflow.events || []).filter(
    (e: any) => e.type === 'checkpoint' || e.type === 'console_checkpoint' || e.type === 'network_checkpoint'
  )

  const pairs = run.checkpoints.map((cp, i) => ({
    checkpoint: cp,
    recording: run.workflow.screenshots.find(s => s.index === cp.index) ?? run.workflow.screenshots[i] ?? null,
    recordingEvent: recordingCheckpointEvents[cp.index] ?? recordingCheckpointEvents[i] ?? null,
  }))

  const active = pairs[activeIndex]
  const isFailed = run.status === 'failed'
  const isPassed = run.status === 'passed'

  // Parse capturedData JSON safely
  function parseCapturedData(cp: Checkpoint): any {
    if (!cp.capturedData) return null
    try { return JSON.parse(cp.capturedData) } catch { return null }
  }

  function cpTypeLabel(type: string | null) {
    if (type === 'console') return 'Console Log'
    if (type === 'network') return 'Network Request'
    return 'Screenshot'
  }

  function cpTypeBadgeStyle(type: string | null): React.CSSProperties {
    if (type === 'console') return { background: 'rgba(234,179,8,0.15)', color: '#ca8a04', border: '1px solid rgba(234,179,8,0.3)' }
    if (type === 'network') return { background: 'rgba(59,130,246,0.15)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)' }
    return { background: 'rgba(168,85,247,0.15)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)' }
  }

  function statusBadgeStyle(status: number | null | undefined): React.CSSProperties {
    if (!status) return { background: 'var(--bg3)', color: 'var(--text-muted)' }
    if (status >= 200 && status < 300) return { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' }
    return { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }
  }

  function monoBlock(content: string | null | undefined, placeholder = '—') {
    return (
      <div style={{
        fontFamily: 'monospace', fontSize: 13, background: 'var(--bg3)',
        border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text)',
        minHeight: 56, lineHeight: 1.6,
      }}>
        {content ?? <span style={{ color: 'var(--text-muted)' }}>{placeholder}</span>}
      </div>
    )
  }

  function renderComparePane() {
    if (!active) return null
    const { checkpoint: cp, recording, recordingEvent } = active
    const type = cp.checkpointType
    const captured = parseCapturedData(cp)

    if (type === 'console') {
      const expectedMsg: string = recordingEvent?.logMessage ?? null
      const capturedMsg: string | null = captured?.capturedMessage ?? null
      const matched: boolean = captured?.matched ?? false
      return (
        <div className="compare-grid">
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Expected Log (Recording)</span>
              <span className="badge" style={cpTypeBadgeStyle('console')}>Console</span>
            </div>
            {monoBlock(expectedMsg, 'No log message recorded')}
            <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
          </div>
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Captured Log (Playback)</span>
              <span className="badge" style={matched ? { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                {matched ? 'Matched' : 'Not Matched'}
              </span>
            </div>
            {monoBlock(capturedMsg, 'No matching log captured')}
            <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
          </div>
        </div>
      )
    }

    if (type === 'network') {
      const expMethod: string = recordingEvent?.networkMethod ?? ''
      const expUrl: string = recordingEvent?.networkUrl ?? ''
      const expStatus: number = recordingEvent?.networkStatus ?? null
      const capMethod: string | null = captured?.capturedMethod ?? null
      const capUrl: string | null = captured?.capturedUrl ?? null
      const capStatus: number | null = captured?.capturedStatus ?? null
      const matched: boolean = captured?.matched ?? false
      return (
        <div className="compare-grid">
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Expected Request (Recording)</span>
              <span className="badge" style={cpTypeBadgeStyle('network')}>Network</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ fontFamily: 'monospace', fontSize: 12 }}>{expMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(expStatus)}>{expStatus ?? '—'}</span>
              </div>
              {monoBlock(expUrl || null, 'No URL recorded')}
            </div>
            <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
          </div>
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Captured Request (Playback)</span>
              <span className="badge" style={matched ? { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                {matched ? 'Matched' : 'Not Matched'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ fontFamily: 'monospace', fontSize: 12 }}>{capMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(capStatus ?? undefined)}>{capStatus ?? '—'}</span>
              </div>
              {monoBlock(capUrl, 'No matching request captured')}
            </div>
            <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
          </div>
        </div>
      )
    }

    // Default: screenshot comparison
    return (
      <div className="compare-grid">
        <div className="compare-panel">
          <div className="compare-panel-header">
            <span>Recording Baseline</span>
            <span className="badge badge-purple">{recording?.label || `CP ${activeIndex + 1}`}</span>
          </div>
          {recording ? (
            <img
              id={`baseline-img-${activeIndex}`}
              src={recording.dataUrl}
              alt="Recording baseline"
            />
          ) : (
            <div className="empty-state" style={{ padding: 40, background: 'var(--bg3)' }}>
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No baseline screenshot</div>
              <div className="empty-desc">No recording screenshot found for this checkpoint index.</div>
            </div>
          )}
          <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
        </div>
        <div className="compare-panel">
          <div className="compare-panel-header">
            <span>Playback Result</span>
            <span className="badge badge-green">{cp.label || `CP ${activeIndex + 1}`}</span>
          </div>
          {cp.dataUrl ? (
            <img
              id={`playback-img-${activeIndex}`}
              src={cp.dataUrl}
              alt="Playback result"
            />
          ) : (
            <div className="empty-state" style={{ padding: 40, background: 'var(--bg3)' }}>
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No playback screenshot</div>
              <div className="empty-desc">No screenshot was captured for this checkpoint.</div>
            </div>
          )}
          <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" aria-hidden="true" />
          <div>
            <div className="sidebar-logo-text">QA Dashboard</div>
            <div className="sidebar-logo-sub">Workflow Studio</div>
          </div>
        </div>
        <a href="/" className="nav-item">
          <span className="nav-icon" aria-hidden="true" />
          All Workflows
        </a>
        <div className="nav-item" onClick={() => router.push(`/workflows/${workflowId}`)} style={{ cursor: 'pointer' }}>
          <span className="nav-icon" aria-hidden="true" />
          Workflow Detail
        </div>
        <div className="nav-item active">
          <span className="nav-icon" aria-hidden="true" />
          Comparison
        </div>

        <hr className="divider" />
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', padding: '0 8px', marginBottom: 8 }}>
          CHECKPOINTS
        </div>
        {pairs.map((pair, i) => (
          <button
            key={i}
            id={`checkpoint-selector-${i}`}
            className={`nav-item ${i === activeIndex ? 'active' : ''}`}
            onClick={() => setActiveIndex(i)}
          >
            <span className="nav-icon" aria-hidden="true">{pair.recording || pair.checkpoint.capturedData ? 'OK' : '!'}</span>
            {pair.checkpoint.label || `CP ${i + 1}`}
          </button>
        ))}
      </nav>

      <main className="main">
        <div className="page-header">
          <div className="breadcrumb" onClick={() => router.push(`/workflows/${workflowId}`)}>
            ← Back to {run.workflow.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="page-title">Checkpoint Comparison</div>
            {isPassed && <span className="badge badge-green">Passed</span>}
            {isFailed && <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Failed</span>}
            {run.status === 'aborted' && <span className="badge" style={{ background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Aborted</span>}
          </div>
          <div className="page-subtitle">
            Playback on {fmtDate(run.playedAt)} · {run.checkpoints.length} checkpoints
          </div>
        </div>

        <div className="content">
          {isFailed && (
            <div style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}>
              <span style={{ fontSize: 18 }} aria-hidden="true">!</span>
              <div>
                <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>
                  Test Failed — Step {(run.failedEventIndex ?? 0) + 1}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Event type: <strong style={{ color: 'var(--text)' }}>{run.failedEventType ?? 'unknown'}</strong>
                  {run.failedEventSelector && (
                    <> · Selector: <code style={{ fontSize: 12, background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4 }}>{run.failedEventSelector.slice(0, 80)}</code></>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  The target element could not be found in the page. The workflow stopped at this step.
                </div>
              </div>
            </div>
          )}

          {pairs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No checkpoints in this run</div>
              <div className="empty-desc">This playback run did not capture any checkpoints.</div>
            </div>
          ) : active ? (
            <>
              {/* Checkpoint nav pills */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
                {pairs.map((pair, i) => (
                  <button
                    key={i}
                    id={`cp-pill-${i}`}
                    onClick={() => setActiveIndex(i)}
                    className="btn"
                    style={{
                      padding: '6px 14px', fontSize: 12,
                      background: i === activeIndex ? 'var(--accent)' : 'var(--bg3)',
                      color: i === activeIndex ? 'white' : 'var(--text-muted)',
                      border: `1px solid ${i === activeIndex ? 'var(--accent)' : 'var(--border)'}`,
                    }}
                  >
                    <span style={{ marginRight: 4 }}>{cpTypeLabel(pair.checkpoint.checkpointType)}</span>
                    {pair.checkpoint.label || `CP ${i + 1}`}
                  </button>
                ))}
              </div>

              {/* Checkpoint type badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span className="badge" style={cpTypeBadgeStyle(active.checkpoint.checkpointType)}>
                  {cpTypeLabel(active.checkpoint.checkpointType)}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {active.checkpoint.label || `Checkpoint ${activeIndex + 1}`}
                </span>
              </div>

              {/* Type-aware comparison pane */}
              {renderComparePane()}

              {/* Summary / nav bar */}
              <div className="card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {active.checkpoint.label || `Checkpoint ${activeIndex + 1}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {cpTypeLabel(active.checkpoint.checkpointType)} checkpoint
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    id="prev-cp-btn"
                    className="btn btn-ghost"
                    disabled={activeIndex === 0}
                    onClick={() => setActiveIndex(i => Math.max(0, i - 1))}
                  >
                    ← Prev
                  </button>
                  <button
                    id="next-cp-btn"
                    className="btn btn-ghost"
                    disabled={activeIndex === pairs.length - 1}
                    onClick={() => setActiveIndex(i => Math.min(pairs.length - 1, i + 1))}
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  )
}
