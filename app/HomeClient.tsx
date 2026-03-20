'use client'

import { useRouter } from 'next/navigation'

interface Workflow {
  id: string
  name: string
  recordedAt: string
  _count: { screenshots: number; runs: number }
}

interface Props {
  workflows: Workflow[]
  stats: { workflows: number; runs: number; checkpoints: number }
  userEmail: string
}

export default function HomeClient({ workflows, stats, userEmail }: Props) {
  const router = useRouter()

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

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

        <a href="/" className="nav-item active">
          <span className="nav-icon">📋</span>Workflows
        </a>

        <div style={{ flex: 1 }} />

        <div style={{ padding: '12px 8px', borderTop: '1px solid var(--border)', marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Signed in as<br />
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{userEmail}</span>
          </div>
          <button id="logout-btn" className="btn btn-danger" style={{ width: '100%', justifyContent: 'center' }} onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </nav>

      {/* Main */}
      <main className="main">
        <div className="page-header">
          <div className="page-title">Workflows</div>
          <div className="page-subtitle">All recorded workflows — click to view screenshots and playback comparisons</div>
        </div>

        <div className="content">
          {/* Stats */}
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--accent-light)' }}>{stats.workflows}</div>
              <div className="stat-label">Recorded Workflows</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--green)' }}>{stats.runs}</div>
              <div className="stat-label">Playback Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--blue)' }}>{stats.checkpoints}</div>
              <div className="stat-label">Checkpoint Images</div>
            </div>
          </div>

          {/* Workflow list */}
          {workflows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <div className="empty-title">No workflows yet</div>
              <div className="empty-desc">
                Record a workflow in the Chrome extension and it will appear here automatically.
              </div>
            </div>
          ) : (
            <div className="card-grid">
              {workflows.map(w => (
                <div
                  key={w.id}
                  id={`workflow-card-${w.id}`}
                  className="workflow-card"
                  onClick={() => router.push(`/workflows/${w.id}`)}
                >
                  <div className="workflow-card-title">{w.name}</div>
                  <div className="workflow-card-meta">
                    <span className="badge badge-purple">📸 {w._count.screenshots} checkpoints</span>
                    <span className="badge badge-green">▶ {w._count.runs} runs</span>
                  </div>
                  <div className="workflow-card-date">Recorded {fmtDate(w.recordedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
