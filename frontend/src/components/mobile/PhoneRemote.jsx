// Paired-phone helpers: the PIN lock overlay (shown when the backend answers
// 423 or the socket reports `phone_locked`) and a one-time prompt to turn on
// push notifications from the Home Screen app.
import { useEffect, useRef, useState } from 'react'
import { Bell, Lock, X } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { isPushSupported, getPushSubscription, subscribeForPush } from '../../lib/pushClient'
import useMediaQuery from '../../hooks/useMediaQuery'
import { Button } from '../ui'

const PUSH_DISMISSED_KEY = 'ive-phone-push-dismissed-v1'

export function PhoneLockOverlay() {
  const [state, setState] = useState(null) // null | { reason }
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const onLocked = (e) => {
      const reason = e.detail?.error === 'reauth_required' ? 'reauth' : 'locked'
      setState((prev) => prev || { reason })
    }
    window.addEventListener('ive:phone-locked', onLocked)
    return () => window.removeEventListener('ive:phone-locked', onLocked)
  }, [])

  useEffect(() => {
    if (state) setTimeout(() => inputRef.current?.focus(), 50)
  }, [state])

  if (!state) return null

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.phoneUnlock(pin)
      setPin('')
      setState(null)
      window.dispatchEvent(new CustomEvent('ive:phone-unlocked'))
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null
      if (body?.error === 'revoked') { window.location.reload(); return }
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a minute.')
      else setError(`Wrong PIN${body?.attempts_left ? ` (${body.attempts_left} tries left)` : ''}`)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-x-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="phone-lock-title" data-phone-lock>
      <form onSubmit={submit} className="x-panel w-full max-w-xs space-y-3 p-5">
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-x-accent" />
          <h2 id="phone-lock-title" className="text-sm font-semibold text-x-ink">
            {state.reason === 'reauth' ? 'Confirm with your PIN' : 'IVE is locked'}
          </h2>
        </div>
        <p className="text-xs text-x-ink-secondary">
          {state.reason === 'reauth'
            ? 'This changes who can access your Mac. Enter the PIN, then try again.'
            : 'This phone was idle. Enter the PIN you set on the Mac.'}
        </p>
        <input
          ref={inputRef}
          type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="current-password"
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label="PIN"
          className="h-11 w-full rounded-md border border-x-line bg-x-surface px-3 text-center font-mono text-lg tracking-[0.3em] text-x-ink focus:border-x-accent focus:outline-none"
          data-phone-lock-input
        />
        {error && <div className="text-[12px] text-x-danger" role="alert">{error}</div>}
        <Button type="submit" variant="primary" loading={busy} disabled={busy || pin.length < 4} className="w-full">Unlock</Button>
      </form>
    </div>
  )
}

function isStandalone() {
  return typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone === true)
}

export function PhonePushPrompt() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [show, setShow] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (!isMobile || !isStandalone() || !isPushSupported()) return undefined
    try { if (localStorage.getItem(PUSH_DISMISSED_KEY)) return undefined } catch { /* private mode */ }
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return undefined
    let alive = true
    ;(async () => {
      try {
        const st = await api.phoneStatus()
        if (!st?.is_device) return
        const sub = await getPushSubscription().catch(() => null)
        if (alive && !sub) setShow(true)
      } catch { /* not paired / offline */ }
    })()
    return () => { alive = false }
  }, [isMobile])

  if (!show) return null
  const dismiss = () => {
    try { localStorage.setItem(PUSH_DISMISSED_KEY, '1') } catch { /* ignore */ }
    setShow(false)
  }
  const enable = async () => {
    // iOS only shows the permission sheet from a tap, so this runs on click.
    const res = await subscribeForPush().catch(() => ({ ok: false, reason: 'error' }))
    if (res.ok) { setShow(false); return }
    setMsg(res.reason === 'permission_denied' ? 'Blocked. Allow it in iOS Settings → Notifications → IVE.' : 'Could not turn on notifications.')
  }
  return (
    <div className="fixed bottom-3 left-3 right-3 z-40 rounded-lg border border-x-line bg-x-surface p-3 text-xs shadow-x-1" data-phone-push-prompt>
      <div className="flex items-start gap-2">
        <Bell size={14} className="mt-0.5 shrink-0 text-x-accent" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-medium text-x-ink">Get notified on this phone</div>
          <div className="text-[11px] leading-relaxed text-x-ink-secondary">When a session needs you or is finished.</div>
          {msg && <div className="mt-1 text-[11px] text-x-danger">{msg}</div>}
        </div>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="p-0.5 text-x-faint hover:text-x-ink-secondary"><X size={13} /></button>
      </div>
      <Button variant="primary" size="sm" onClick={enable} className="mt-2 w-full">Turn on notifications</Button>
    </div>
  )
}
