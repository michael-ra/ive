import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { continueSession } from '../../lib/sessionActions'

export function TerminalContextNotice({ sessionId }) {
  const session = useStore((s) => s.sessions[sessionId])
  const [runtime, setRuntime] = useState(null)
  useEffect(() => {
    if (!['claude', 'codex'].includes(session?.cli_type || 'claude')) return undefined
    let cancelled = false
    setRuntime(null)
    const refresh = () => api.getSessionRuntimeModel(sessionId).then((data) => {
      if (!cancelled) setRuntime(data)
    }).catch(() => {})
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId, session?.cli_type, session?.status, session?.native_session_id])
  return <SessionContextNotice session={session} runtime={runtime} />
}

export default function SessionContextNotice({ session, runtime }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const context = runtime?.context
  const observed = runtime?.observed?.model || runtime?.launched
  const configured = session?.model
  const mismatch = observed && configured && observed !== configured && !observed.includes(configured)
  if (!context?.warning && !mismatch) return null
  const idle = session?.pty_alive && !session?.read_only && ['idle', 'stopped', 'done'].includes(session?.status || 'idle')
  const compact = async () => {
    setPending(true); setError('')
    try { await api.sendSessionInput(session.id, '/compact', { ready_timeout: 3 }) }
    catch (e) { setError(e.message || 'Could not compact context.') }
    finally { setPending(false) }
  }
  const fresh = async (mode) => {
    setPending(true); setError('')
    try { await continueSession(session.id, mode) }
    catch (e) { setError(e.message || 'Could not prepare a new session.') }
    finally { setPending(false) }
  }
  return (
    <aside aria-label="Session context" className="shrink-0 border-b border-x-line bg-amber-500/10 px-4 py-2 text-xs text-x-ink">
      {mismatch && <p>Selected: <strong>{configured}</strong>. Last observed: <strong>{observed}</strong>. Choose your model in the session controls to apply it.</p>}
      {context?.warning && <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 min-w-[180px]">Large context: <strong>{Math.round(context.input_tokens / 1000)}k tokens</strong> in the last request, including cache. This is separate from total usage.
          {' '}Continue with a short handoff and exact history saved locally, or start a new topic with empty context.
        </p>
        <button type="button" onClick={() => fresh('handoff')} disabled={session?.read_only || pending || (session?.pty_alive && !idle)} className="rounded border border-x-line bg-x-surface px-2 py-1 disabled:opacity-50">Continue in fresh session</button>
        <button type="button" onClick={() => fresh('empty')} disabled={session?.read_only || pending} className="rounded border border-x-line bg-x-surface px-2 py-1 disabled:opacity-50">New topic</button>
        {['claude', 'codex'].includes(session?.cli_type || 'claude') && <button type="button" onClick={compact} disabled={!idle || pending} title={!idle ? 'Start the session and wait until it is idle.' : 'Summarize the active context; saved chat history remains available.'} className="rounded border border-x-line bg-x-surface px-2 py-1 disabled:opacity-50">{pending ? 'Requesting…' : 'Compact context'}</button>}
      </div>}
      {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
    </aside>
  )
}
