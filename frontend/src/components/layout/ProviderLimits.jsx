import ProviderLogo from '../ui/ProviderLogo'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import './provider-limits.css'

function resetLabel(seconds, now) {
  if (!seconds) return 'Reset not reported'
  const left = seconds * 1000 - now
  if (left <= 0) return 'Awaiting reset update'
  const minutes = Math.ceil(left / 60000)
  if (minutes < 60) return `Reset in ${minutes}m`
  if (minutes < 1440) return `Reset in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `Reset ${new Date(seconds * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

export default function ProviderLimits() {
  const sessionId = useStore((s) => s.activeSessionId)
  const session = useStore((s) => s.sessions[s.activeSessionId])
  const auth = useStore((s) => s.currentAuth)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())
  const canRead = ['localhost', 'owner_legacy', 'owner_device'].includes(auth?.actor_kind)
  const scope = `${sessionId || ''}:${session?.account_id || ''}:${session?.cli_type || ''}`

  useEffect(() => {
    if (!canRead) return
    let cancelled = false, pending = false
    const update = async () => {
      if (document.hidden || pending) return
      pending = true
      setLoading(true)
      try {
        const result = await api.getProviderLimits(sessionId)
        if (!cancelled) setData({ ...result, scope })
      } catch {
        if (!cancelled) setData((previous) => ({ ...(previous?.scope === scope ? previous : {}), scope,
          stale: true, message: 'Account limits are unavailable. Try refreshing shortly.' }))
      } finally {
        pending = false
        if (!cancelled) setLoading(false)
      }
    }
    update()
    const interval = setInterval(update, 60000)
    document.addEventListener('visibilitychange', update)
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener('visibilitychange', update) }
  }, [canRead, scope, refresh, sessionId])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [])

  if (!canRead || session?.cli_type === 'shell') return null
  const current = data?.scope === scope ? data : null
  const provider = current?.provider || session?.cli_type || 'codex'
  const name = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : provider
  const stale = current?.stale || (current?.updated_at && now / 1000 - current.updated_at > 300)
  const allWindows = Array.isArray(current?.windows) ? current.windows : []
  const main = allWindows.filter((item) => item.bucket === provider)
  const windows = (main.length ? main : allWindows).slice(0, 2)
  const standard = ['5h', 'Week'].map((label) => windows.find((item) => item.label === label) || { label })
  const shown = windows.some((item) => !['5h', 'Week'].includes(item.label)) ? windows : standard

  return (
    <div className="ive-provider-limits" data-provider-limits aria-label="Provider account limits">
      <details className="ive-provider-limits-details">
        <summary>
          <span className="ive-provider-limits-account" title={current?.account_label || 'Local CLI account'}><strong className="inline-flex items-center gap-1.5"><ProviderLogo provider={provider} className="w-3.5 h-3.5 shrink-0" />{name}</strong><span>Account limits</span></span>
          {shown.map((item, index) => {
            const expired = item.resets_at && item.resets_at * 1000 <= now
            const remaining = expired ? null : item.remaining_percent
            return <span className={`ive-provider-limit ${stale ? 'is-stale' : ''}`} key={`${item.bucket}:${item.label}:${index}`}>
              <span>{item.label}</span>
              <strong>{Number.isFinite(remaining) ? `${remaining}% left` : '—'}</strong>
              {Number.isFinite(remaining) && <meter min="0" max="100" value={remaining} aria-label={`${item.label} quota remaining`} />}
              <span className="ive-provider-reset">{resetLabel(item.resets_at, now)}</span>
            </span>
          })}
          <span className="ive-provider-freshness">{loading ? 'Updating…' : stale ? 'Last reported · stale' : !windows.length ? 'Not reported' : 'Details'}</span>
        </summary>
        <div className="ive-provider-limits-popover">
          <strong>{name} · {current?.account_label || 'Local CLI account'}</strong>
          <p>Shared by sessions using this account. Token totals do not determine the remaining quota.</p>
          {current?.message && <p role="status">{current.message}</p>}
          {allWindows.map((item, index) => <p key={index}><strong>{item.bucket_label} · {item.label}:</strong> {item.resets_at && item.resets_at * 1000 <= now ? 'Awaiting reset update' : `${item.remaining_percent}% left`}. {item.resets_at ? new Date(item.resets_at * 1000).toLocaleString() : 'Reset not reported'}</p>)}
          {current?.updated_at && <p>Last reported: {new Date(current.updated_at * 1000).toLocaleString()}{stale ? ' · Refresh needed' : ''}</p>}
        </div>
      </details>
      <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}
        aria-label="Refresh account limits" title="Refresh account limits" className="ive-provider-refresh"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
    </div>
  )
}
