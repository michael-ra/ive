import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, House, Plus } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getCliLabel } from '../../lib/constants'
import { getSessionDisplayStatus, isShellSession } from '../../lib/sessionStatus'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { visibleSessions } from '../../lib/visibleSessions'
import { lastActivityLine } from '../../lib/phoneKeys'
import { openQuickStart } from '../../lib/quickStart'

// Phone home: every session as one card, Waiting first, then the ones
// that are Running, then the rest. A tap opens the session full screen.
// Status updates arrive live over the WebSocket (store); the last activity
// line is read from each live session's rendered screen every few seconds
// while this list is on screen.

const ACTIVITY_POLL_MS = 6000

function rankOf(session, meta) {
  if (meta.tone === 'waiting' || sessionNeedsAttention(session)) return 0
  if (meta.isWorking) return 1
  if (meta.tone === 'error' || meta.tone === 'auth') return 0
  return 2
}

function stamp(session) {
  return String(session.last_active_at || session.updated_at || session.created_at || '')
}

export default function PhoneOverview({ onOpenHome }) {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const messages = useStore((s) => s.messages)
  const connected = useStore((s) => s.connected)
  const auth = useStore((s) => s.currentAuth)
  const [screenLines, setScreenLines] = useState({})
  const [workspaceId, setWorkspaceId] = useState('')
  const canCreate = connected && ['full', 'code'].includes(auth?.mode)
  useEffect(() => { if (workspaceId && !workspaces.some((item) => item.id === workspaceId)) setWorkspaceId('') }, [workspaceId, workspaces])

  const items = useMemo(() => {
    const wsName = Object.fromEntries((workspaces || []).map((w) => [w.id, w.name]))
    return visibleSessions(sessions)
      .filter((s) => !workspaceId || s.workspace_id === workspaceId)
      .map((s) => {
        const meta = getSessionDisplayStatus(s, sessionStarted)
        return { session: s, meta, rank: rankOf(s, meta), workspace: wsName[s.workspace_id] || '' }
      })
      .sort((a, b) => a.rank - b.rank || stamp(b.session).localeCompare(stamp(a.session)) || String(a.session.name).localeCompare(String(b.session.name)))
  }, [sessions, workspaces, sessionStarted, workspaceId])

  // Last activity line: poll the rendered screen of live sessions while the
  // list is visible. One request at a time keeps the phone and the Mac quiet.
  const liveIds = items.filter((i) => i.session.pty_alive && !i.session.is_external).map((i) => i.session.id).join(',')
  const busyRef = useRef(false)
  useEffect(() => {
    const ids = liveIds ? liveIds.split(',') : []
    if (!ids.length) return
    let cancelled = false
    const poll = async () => {
      if (busyRef.current || document.visibilityState !== 'visible') return
      busyRef.current = true
      try {
        for (const id of ids) {
          if (cancelled) break
          try {
            const out = await api.getSessionOutput(id, 40)
            const line = lastActivityLine(out?.screen || out?.text || '')
            if (!cancelled && line) setScreenLines((prev) => (prev[id] === line ? prev : { ...prev, [id]: line }))
          } catch { /* session gone or not readable */ }
        }
      } finally { busyRef.current = false }
    }
    poll()
    const timer = setInterval(poll, ACTIVITY_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [liveIds])

  const activityFor = (session) => {
    if (session.attention) return [session.attention.title, session.attention.message].filter(Boolean).join(' · ')
    if (screenLines[session.id]) return screenLines[session.id]
    const list = messages?.[session.id]
    if (Array.isArray(list) && list.length) {
      for (let i = list.length - 1; i >= 0 && i >= list.length - 6; i--) {
        const m = list[i]
        const text = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((b) => b?.text || '').join(' ') : ''
        const line = text.replace(/\s+/g, ' ').trim()
        if (line) return line.length > 160 ? `${line.slice(0, 157)}…` : line
      }
    }
    return ''
  }

  const open = (session) => {
    const store = useStore.getState()
    if (session.workspace_id && store.activeWorkspaceId !== session.workspace_id) store.setActiveWorkspace(session.workspace_id)
    store.openSession(session.id)
  }

  const needs = items.filter((i) => i.rank === 0).length
  const working = items.filter((i) => i.rank === 1).length
  const create = () => {
    if (!canCreate) return
    if (!workspaceId) { openQuickStart(); return }
    useStore.getState().setActiveWorkspace(workspaceId)
    // Same short prompt as every "New session", with this project preselected.
    openQuickStart({ workspaceId })
  }
  let lastRank = null

  return (
    <div className="ive-phone-overview" data-phone-overview="">
      <div className="ive-phone-overview-head">
        <div>
          <h1>Sessions</h1>
          <p>
            {items.length === 0 ? 'Nothing running yet' : `${items.length} ${items.length === 1 ? 'session' : 'sessions'}`}
            {needs > 0 && <span className="is-alert"> · {needs} {needs === 1 ? 'needs' : 'need'} you</span>}
            {working > 0 && <span> · {working} working</span>}
          </p>
        </div>
        <button type="button" className="ive-phone-chip" onClick={onOpenHome} aria-label="Open Home">
          <House size={16} aria-hidden="true" /> Home
        </button>
      </div>
      <label className="mb-3 block text-sm text-x-muted">Projekt
        <select aria-label="Sessions nach Projekt filtern" className="mt-1 min-h-11 w-full rounded-lg border border-x-line bg-x-surface px-3 text-base text-x-ink" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">Alle Projekte</option>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
      </label>
      {!connected && <p role="status" className="mb-3 text-sm text-x-warning">Keine Verbindung zum Mac. Du siehst den zuletzt geladenen Stand.</p>}

      {items.length === 0 ? (
        <div className="ive-phone-empty">
          <p>Starte eine Session direkt vom iPhone. Sie läuft auf deinem Mac, solange er wach und erreichbar ist.</p>
          <button type="button" disabled={!canCreate} className="ive-phone-primary disabled:opacity-50" onClick={create}>
            <Plus size={18} aria-hidden="true" /> {workspaceId ? 'Neue Session in diesem Projekt' : 'New session'}
          </button>
        </div>
      ) : (
        <ul className="ive-phone-list" aria-label="Sessions">
          {items.map(({ session, meta, rank, workspace }) => {
            const header = rank !== lastRank ? (rank === 0 ? 'Waiting' : rank === 1 ? 'Running' : 'Done') : null
            lastRank = rank
            const activity = activityFor(session)
            return (
              <li key={session.id}>
                {header && <h2 className="ive-phone-group" data-group={rank}>{header}</h2>}
                <button
                  type="button"
                  className="ive-phone-card"
                  data-phone-session={session.id}
                  data-tone={rank === 0 ? 'waiting' : meta.isWorking ? 'working' : meta.tone}
                  onClick={() => open(session)}
                  aria-label={`Open ${session.name}, ${meta.label}`}
                >
                  <span className="ive-phone-card-top">
                    <span className="ive-phone-card-name">{session.name || 'Session'}</span>
                    <span className={`ive-phone-status ${meta.textClass}`} data-status={meta.label}>
                      <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dotClass}`} aria-hidden="true" />
                      {meta.label}
                    </span>
                  </span>
                  <span className="ive-phone-card-meta">
                    {isShellSession(session) ? 'Mac-Shell · direkte Befehle' : getCliLabel(session.cli_type || 'claude')}
                    {session.model ? ` · ${session.model}` : ''}
                    {workspace ? ` · ${workspace}` : ''}
                  </span>
                  <span className="ive-phone-card-activity" data-phone-activity="">{activity || (session.pty_alive ? 'No output yet' : 'Not running. Tap to start.')}</span>
                  <ChevronRight size={18} className="ive-phone-card-chevron" aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="ive-phone-overview-foot">
        <button type="button" disabled={!canCreate} className="ive-phone-primary disabled:opacity-50" onClick={create}>
          <Plus size={18} aria-hidden="true" /> {workspaceId ? 'Neue Session in diesem Projekt' : 'New session'}
        </button>
      </div>
    </div>
  )
}
