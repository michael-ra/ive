import { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck,
  X,
  Loader2,
  AlertCircle,
  ScrollText,
  Ban,
  RefreshCw,
} from 'lucide-react'
import { api, ApiError } from '../../lib/api'

const MODE_TONE = {
  brief: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  code: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  full: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
}

function fmtTs(iso) {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  if (isNaN(d.getTime())) return iso
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function fmtUA(ua) {
  if (!ua) return 'unknown'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/Macintosh/i.test(ua)) return 'macOS'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return ua.slice(0, 24)
}

function ModePill({ mode }) {
  const tone = MODE_TONE[mode] || 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30'
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-mono uppercase border rounded ${tone}`}>
      {mode || '—'}
    </span>
  )
}

function AuditDrawer({ session, onClose }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listAuditLog({ actor_id: session.id, limit: 200 })
      setEntries(data?.entries || [])
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [session.id])

  useEffect(() => { reload() }, [reload])

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-stretch justify-end" onClick={onClose}>
      <div
        className="bg-zinc-950 border-l border-zinc-800 w-full max-w-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={14} className="text-indigo-400" />
            <div className="min-w-0">
              <div className="text-[12px] text-zinc-100 truncate">
                Audit log — {session.label || session.id.slice(0, 8)}
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">
                {session.last_ip || '—'} · {fmtUA(session.last_user_agent)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={reload}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-200">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px]">
          {error && (
            <div className="flex items-center gap-2 text-rose-400 mb-2">
              <AlertCircle size={12} /> {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="text-zinc-500 italic">No audited actions yet.</div>
          )}
          <table className="w-full">
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-zinc-900/60 align-top">
                  <td className="py-1 pr-2 text-zinc-500 whitespace-nowrap">
                    {fmtTs(e.ts)}
                  </td>
                  <td className="py-1 pr-2 text-zinc-300 whitespace-nowrap">
                    {e.method}
                  </td>
                  <td className="py-1 pr-2 text-zinc-100 break-all">
                    {e.path}
                  </td>
                  <td className="py-1 text-right whitespace-nowrap">
                    <span className={
                      e.status >= 500 ? 'text-rose-400'
                      : e.status >= 400 ? 'text-amber-400'
                      : e.status >= 300 ? 'text-zinc-400'
                      : 'text-emerald-400'
                    }>
                      {e.status || '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function AuthSessionsPanel({ onClose }) {
  const [sessions, setSessions] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [revoking, setRevoking] = useState(null)
  const [drillDown, setDrillDown] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listAuthSessions()
      setSessions(data?.sessions || [])
      setCurrentId(data?.current_id || null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const handleRevoke = async (s) => {
    if (!confirm(`Revoke "${s.label || s.id.slice(0, 8)}"? They'll be logged out immediately.`)) return
    setRevoking(s.id)
    try {
      await api.revokeAuthSession(s.id)
      await reload()
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-indigo-400" />
            <div>
              <h2 className="text-zinc-100 text-sm font-semibold">Authenticated Sessions</h2>
              <p className="text-zinc-500 text-[11px] mt-0.5">
                Active joiners with mode, IP, and last activity. Click an entry to see what they did.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={reload}
              disabled={loading}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1.5 text-zinc-500 hover:text-zinc-200">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="flex items-center gap-2 text-rose-400 text-[12px] mb-3">
              <AlertCircle size={14} /> {error}
            </div>
          )}
          {loading && sessions.length === 0 && (
            <div className="flex items-center gap-2 text-zinc-500 text-[12px]">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}
          {!loading && sessions.length === 0 && !error && (
            <div className="text-zinc-500 text-[12px] italic">
              No active joiner sessions. Mint an invite to share access.
            </div>
          )}

          {sessions.length > 0 && (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-zinc-500 text-[10px] uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2 px-2 font-medium">Label</th>
                  <th className="text-left py-2 px-2 font-medium">Mode</th>
                  <th className="text-left py-2 px-2 font-medium">IP</th>
                  <th className="text-left py-2 px-2 font-medium">Device</th>
                  <th className="text-left py-2 px-2 font-medium">Last seen</th>
                  <th className="text-left py-2 px-2 font-medium">Expires</th>
                  <th className="text-right py-2 px-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const isMe = s.id === currentId
                  return (
                    <tr
                      key={s.id}
                      className="border-b border-zinc-900/60 hover:bg-zinc-900/40 cursor-pointer"
                      onClick={() => setDrillDown(s)}
                    >
                      <td className="py-2 px-2 text-zinc-100">
                        <div className="flex items-center gap-1.5">
                          <span>{s.label || <span className="text-zinc-500 italic">unnamed</span>}</span>
                          {isMe && (
                            <span className="text-[9px] px-1 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded uppercase">
                              you
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-zinc-600 font-mono">
                          {s.id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="py-2 px-2"><ModePill mode={s.mode} /></td>
                      <td className="py-2 px-2 text-zinc-300 font-mono text-[11px]">
                        {s.last_ip || '—'}
                      </td>
                      <td className="py-2 px-2 text-zinc-400 text-[11px]">
                        {fmtUA(s.last_user_agent)}
                      </td>
                      <td className="py-2 px-2 text-zinc-400 text-[11px]">
                        {fmtTs(s.last_used_at || s.created_at)}
                      </td>
                      <td className="py-2 px-2 text-zinc-400 text-[11px]">
                        {fmtTs(s.expires_at)}
                      </td>
                      <td className="py-2 px-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleRevoke(s)}
                          disabled={revoking === s.id || isMe}
                          title={isMe ? "Use Logout to revoke yourself" : "Revoke session"}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {revoking === s.id
                            ? <Loader2 size={11} className="animate-spin" />
                            : <Ban size={11} />}
                          Revoke
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drillDown && (
        <AuditDrawer session={drillDown} onClose={() => setDrillDown(null)} />
      )}
    </div>
  )
}
