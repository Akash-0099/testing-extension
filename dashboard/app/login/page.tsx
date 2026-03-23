'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (tab === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (tab === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    try {
      const endpoint = tab === 'signin' ? '/api/auth/login' : '/api/auth/signup'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        router.push('/')
        router.refresh()
      } else {
        const d = await res.json()
        setError(d.error || (tab === 'signin' ? 'Login failed' : 'Signup failed'))
      }
    } catch {
      setError('Network error — is the server running?')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/icon.png" alt="Logo" className="login-logo-img" />
        <div className="login-title">Workflow Recorder</div>
        <div className="login-sub">
          {tab === 'signin' ? 'Sign in to view and compare your recorded workflows' : 'Create your account to get started'}
        </div>

        {/* Tabs */}
        <div className="auth-tabs">
          <button
            id="tab-signin"
            className={`auth-tab${tab === 'signin' ? ' active' : ''}`}
            onClick={() => { setTab('signin'); setError('') }}
            type="button"
          >
            Sign In
          </button>
          <button
            id="tab-signup"
            className={`auth-tab${tab === 'signup' ? ' active' : ''}`}
            onClick={() => { setTab('signup'); setError('') }}
            type="button"
          >
            Sign Up
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              id="auth-email"
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              id="auth-password"
              type="password"
              className="form-input"
              placeholder={tab === 'signup' ? 'Min 8 characters' : '••••••••'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>
          {tab === 'signup' && (
            <div className="form-group">
              <label className="form-label">Confirm Password</label>
              <input
                id="auth-confirm-password"
                type="password"
                className="form-input"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          <button id="auth-submit" type="submit" className="form-submit" disabled={loading}>
            {loading ? (tab === 'signin' ? 'Signing in…' : 'Creating account…') : (tab === 'signin' ? 'Sign In →' : 'Create Account →')}
          </button>
        </form>

        <div className="form-hint">
          {tab === 'signin'
            ? <>No account? <button className="link-btn" onClick={() => { setTab('signup'); setError('') }}>Sign up</button></>
            : <>Already have an account? <button className="link-btn" onClick={() => { setTab('signin'); setError('') }}>Sign in</button></>
          }
        </div>
      </div>
    </div>
  )
}
