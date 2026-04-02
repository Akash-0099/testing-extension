'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

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
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    if (!isMounted) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'ArrowLeft') {
        setActiveIndex(prev => Math.max(0, prev - 1))
      } else if (e.key === 'ArrowRight') {
        setActiveIndex(prev => Math.min(run.checkpoints.length - 1, prev + 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isMounted, run.checkpoints.length])

  function fmtDate(iso: string) {
    if (!isMounted) {
      return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
    }
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  // Derive recording-time checkpoint events in order (to match by position)
  const recordingCheckpointEvents: any[] = (run.workflow.events || []).filter(
    (e: any) => e.type === 'checkpoint' || e.type === 'console_checkpoint' || e.type === 'network_checkpoint'
  )

  let screenshotCpIdx = 0
  const pairs = run.checkpoints.map((cp, i) => {
    let recording: RecordingScreenshot | null = null
    const isScreenshot = cp.checkpointType !== 'console' && cp.checkpointType !== 'network'
    
    if (isScreenshot) {
      recording = run.workflow.screenshots.find(s => s.index === screenshotCpIdx) ?? null
      screenshotCpIdx++
    }

    return {
      checkpoint: cp,
      recording,
      // Matches the i-th checkpoint of playback run to the i-th parsed checkpoint event from recording run
      recordingEvent: recordingCheckpointEvents[i] ?? null,
    }
  })

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

  function methodBadgeStyle(method: string | null): React.CSSProperties {
    const m = (method || '').toUpperCase()
    let bg = 'var(--bg3)', color = 'var(--text)', borderColor = 'var(--border)'

    if (m === 'GET') { bg = 'rgba(59,130,246,0.15)'; color = '#93c5fd'; borderColor = 'rgba(59,130,246,0.4)'; }
    else if (m === 'POST') { bg = 'rgba(20,184,166,0.15)'; color = '#5eead4'; borderColor = 'rgba(20,184,166,0.4)'; }
    else if (m === 'PUT' || m === 'PATCH') { bg = 'rgba(245,158,11,0.15)'; color = '#fcd34d'; borderColor = 'rgba(245,158,11,0.4)'; }
    else if (m === 'DELETE') { bg = 'rgba(239,68,68,0.15)'; color = '#fca5a5'; borderColor = 'rgba(239,68,68,0.4)'; }

    return {
      background: bg, color, border: `1px solid ${borderColor}`,
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace',
      fontSize: 11, padding: '4px 10px', textTransform: 'uppercase', letterSpacing: '0.05em',
      fontWeight: 700, borderRadius: '6px'
    }
  }

  function statusBadgeStyle(status: number | null | undefined): React.CSSProperties {
    const base: React.CSSProperties = { 
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace', 
      fontSize: 11, padding: '4px 10px', fontWeight: 600, borderRadius: '6px', letterSpacing: '0.05em' 
    }
    if (!status) return { ...base, background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }
    if (status >= 200 && status < 300) return { ...base, background: 'rgba(34,197,94,0.15)', color: '#86efac', border: '1px solid rgba(34,197,94,0.4)' }
    if (status >= 300 && status < 400) return { ...base, background: 'rgba(168,85,247,0.15)', color: '#d8b4fe', border: '1px solid rgba(168,85,247,0.4)' }
    if (status >= 400 && status < 500) return { ...base, background: 'rgba(234,179,8,0.15)', color: '#fde047', border: '1px solid rgba(234,179,8,0.4)' }
    return { ...base, background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)' }
  }

  function monoBlock(content: string | null | undefined, placeholder = '—') {
    return (
      <div className="mono-block" style={{
        fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace', 
        fontSize: 12, background: '#13131a',
        border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0',
        minHeight: 48, maxHeight: 300, overflowY: 'auto', lineHeight: 1.6,
      }}>
        {content ?? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{placeholder}</span>}
      </div>
    )
  }

  function prettyValue(value: unknown): string | null {
    if (value == null) return null
    if (typeof value === 'string') {
      try {
        return JSON.stringify(JSON.parse(value), null, 2)
      } catch {
        return value
      }
    }
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  function renderLogContext(title: string, logs: any[] | null | undefined) {
    const lines = Array.isArray(logs) ? logs.filter(Boolean) : []
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
        {lines.length === 0
          ? monoBlock(null, 'No surrounding log')
          : monoBlock(lines.map((line) => {
              const level = (line?.level || 'log').toUpperCase()
              const message = line?.message || '—'
              return `[${level}] ${message}`
            }).join('\n'))}
      </div>
    )
  }

  function renderDetailBlock(title: string, value: unknown, placeholder: string) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
        {monoBlock(prettyValue(value), placeholder)}
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
            <div style={{ padding: '16px' }}>
              {monoBlock(expectedMsg, 'No log message recorded')}
              <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                {renderLogContext('One Log Before', captured?.expectedContextBefore)}
                {renderLogContext('One Log After', captured?.expectedContextAfter)}
              </div>
            </div>
            <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
          </div>
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Captured Log (Playback)</span>
              <span className="badge" style={matched ? { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                {matched ? 'Matched' : 'Not Matched'}
              </span>
            </div>
            <div style={{ padding: '16px' }}>
              {monoBlock(capturedMsg, 'No matching log captured')}
              <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                {renderLogContext('One Log Before', captured?.capturedContextBefore)}
                {renderLogContext('One Log After', captured?.capturedContextAfter)}
              </div>
            </div>
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
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={methodBadgeStyle(expMethod)}>{expMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(expStatus)}>{expStatus ?? '—'}</span>
              </div>
              {monoBlock(expUrl || null, 'No URL recorded')}
              {renderDetailBlock('Request Headers', captured?.expectedRequestHeaders, 'No request headers recorded')}
              {renderDetailBlock('Request Payload', captured?.expectedRequestBody, 'No request payload recorded')}
              {renderDetailBlock('Response Headers', captured?.expectedResponseHeaders, 'No response headers recorded')}
              {renderDetailBlock('Response Payload', captured?.expectedResponseBody, 'No response payload recorded')}
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
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={methodBadgeStyle(capMethod)}>{capMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(capStatus ?? undefined)}>{capStatus ?? '—'}</span>
              </div>
              {monoBlock(capUrl, 'No matching request captured')}
              {renderDetailBlock('Request Headers', captured?.requestHeaders, 'No request headers captured')}
              {renderDetailBlock('Request Payload', captured?.requestBody, 'No request payload captured')}
              {renderDetailBlock('Response Headers', captured?.responseHeaders, 'No response headers captured')}
              {renderDetailBlock('Response Payload', captured?.responseBody, 'No response payload captured')}
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
          <span className="nav-text">All Workflows</span>
        </Link>
        <Link href="/settings" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="nav-text">Settings</span>
        </Link>
        <div className="nav-item" onClick={() => router.push(`/workflows/${workflowId}`)} style={{ cursor: 'pointer' }}>
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          <span className="nav-text">Workflow Detail</span>
        </div>
        <div className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
          </svg>
          <span className="nav-text">Comparison</span>
        </div>

        <hr className="divider" />
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', padding: '0 8px', marginBottom: 8 }}>
          CHECKPOINTS
        </div>
        {pairs.map((pair, i) => {
          const cpColor = pair.checkpoint.checkpointType === 'console' ? 'var(--yellow)' :
                          pair.checkpoint.checkpointType === 'network' ? 'var(--blue)' : 'var(--accent-light)';
          
          return (
          <button
            key={i}
            id={`checkpoint-selector-${i}`}
            className={`nav-item ${i === activeIndex ? 'active' : ''}`}
            onClick={() => setActiveIndex(i)}
            title={pair.checkpoint.label || `CP ${i + 1}`}
            style={i === activeIndex ? { borderLeft: `3px solid ${cpColor}` } : { borderLeft: '3px solid transparent' }}
          >
            <span className="nav-icon" aria-hidden="true" style={{ color: cpColor, fontWeight: 'bold', fontSize: 11 }}>
              {pair.recording || pair.checkpoint.capturedData ? 'OK' : '!'}
            </span>
            <span className="nav-text">{pair.checkpoint.label || `CP ${i + 1}`}</span>
          </button>
        )})}
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
