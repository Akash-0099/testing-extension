'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Checkpoint {
  id: string
  index: number
  label: string | null
  dataUrl: string
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
  checkpoints: Checkpoint[]
  workflow: {
    id: string
    name: string
    recordedAt: string
    screenshots: RecordingScreenshot[]
  }
}

export default function ComparisonClient({ run, workflowId }: { run: Run; workflowId: string }) {
  const router = useRouter()
  const [activeIndex, setActiveIndex] = useState(0)

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const pairs = run.checkpoints.map((cp, i) => ({
    checkpoint: cp,
    recording: run.workflow.screenshots.find(s => s.index === cp.index) ?? run.workflow.screenshots[i] ?? null,
  }))

  const active = pairs[activeIndex]
  const matchCount = pairs.filter(p => p.recording).length

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
        <div className="nav-item" onClick={() => router.push(`/workflows/${workflowId}`)} style={{ cursor: 'pointer' }}>
          <span className="nav-icon">🔍</span>Workflow Detail
        </div>
        <div className="nav-item active">
          <span className="nav-icon">⚖️</span>Comparison
        </div>

        {/* Checkpoint selector */}
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
            <span className="nav-icon">{pair.recording ? '✅' : '⚠️'}</span>
            {pair.checkpoint.label || `CP ${i + 1}`}
          </button>
        ))}
      </nav>

      <main className="main">
        <div className="page-header">
          <div className="breadcrumb" onClick={() => router.push(`/workflows/${workflowId}`)}>
            ← Back to {run.workflow.name}
          </div>
          <div className="page-title">Checkpoint Comparison</div>
          <div className="page-subtitle">
            Playback on {fmtDate(run.playedAt)} · {run.checkpoints.length} checkpoints · {matchCount} matched
          </div>
        </div>

        <div className="content">
          {pairs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🖼️</div>
              <div className="empty-title">No checkpoints in this run</div>
              <div className="empty-desc">This playback run did not capture any checkpoint screenshots.</div>
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
                    {pair.recording ? '✅' : '⚠️'} {pair.checkpoint.label || `CP ${i + 1}`}
                  </button>
                ))}
              </div>

              {/* Main comparison grid */}
              <div className="compare-grid">
                {/* Left: Recording (baseline) */}
                <div className="compare-panel">
                  <div className="compare-panel-header">
                    <span>📸 Recording Baseline</span>
                    <span className="badge badge-purple">{active.recording?.label || `CP ${activeIndex + 1}`}</span>
                  </div>
                  {active.recording ? (
                    <img
                      id={`baseline-img-${activeIndex}`}
                      src={active.recording.dataUrl}
                      alt="Recording baseline"
                    />
                  ) : (
                    <div className="empty-state" style={{ padding: 40, background: 'var(--bg3)' }}>
                      <div className="empty-icon">🚫</div>
                      <div className="empty-title">No baseline screenshot</div>
                      <div className="empty-desc">No recording screenshot found for this checkpoint index.</div>
                    </div>
                  )}
                  <div className="compare-label">
                    Recorded: {fmtDate(run.workflow.recordedAt)}
                  </div>
                </div>

                {/* Right: Playback (current) */}
                <div className="compare-panel">
                  <div className="compare-panel-header">
                    <span>▶ Playback Result</span>
                    <span className="badge badge-green">{active.checkpoint.label || `CP ${activeIndex + 1}`}</span>
                  </div>
                  <img
                    id={`playback-img-${activeIndex}`}
                    src={active.checkpoint.dataUrl}
                    alt="Playback result"
                  />
                  <div className="compare-label">
                    Played: {fmtDate(run.playedAt)}
                  </div>
                </div>
              </div>

              {/* Summary bar */}
              <div className="card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {active.checkpoint.label || `Checkpoint ${activeIndex + 1}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {active.recording ? 'Baseline screenshot is available for comparison.' : 'No baseline — no recording screenshot was found for this index.'}
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
