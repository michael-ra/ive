import { useState, useEffect, useRef, useMemo } from 'react'
import { visibleSessions } from '../../lib/visibleSessions'
import {
  Clock,
  Hash,
  Monitor,
  Square,
  Zap,
} from 'lucide-react'
import useStore from '../../state/store'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus } from '../../lib/sessionStatus'
import { Button } from '../ui'
import { getEffortDisplay } from '../../lib/constants'

function compactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function SessionCard({ session, sessionStarted, isActive, isFocused, onClick }) {
  const statusMeta = getSessionDisplayStatus(session, sessionStarted)
  const isRunning = session.status === 'running'

  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col p-4 rounded-lg border transition-colors duration-[80ms] text-left min-w-0 overflow-hidden ${
        isActive
          ? 'border-x-accent/45 bg-x-tint'
          : 'border-x-line bg-x-surface hover:border-x-line-strong hover:bg-x-hover'
      } ${isFocused ? 'ring-2 ring-x-focus border-x-accent/50' : ''}`}
    >
      {/* Status dot */}
      <span className={`absolute top-4 right-4 w-2 h-2 rounded-full ${statusMeta.dotClass} ${isRunning ? 'animate-pulse' : ''}`} title={statusMeta.label} />

      {/* Name */}
      <span className="text-[13px] text-x-ink font-medium pr-6 break-words">
        {session.name}
      </span>

      {/* Config badges */}
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        <span className="flex items-center gap-1 text-[11px] font-medium text-x-accent bg-x-tint border border-x-accent/30 px-1.5 py-0.5 rounded-md">
          <Monitor size={9} />
          {session.model || 'sonnet'}
        </span>
        <span className="flex items-center gap-1 text-[11px] font-medium text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 px-1.5 py-0.5 rounded-md">
          <Zap size={9} />
          {getEffortDisplay(session.cli_type, session.effort, session.model)}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {session.turn_count > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-x-good bg-x-good/10 border border-x-good/30 px-1.5 py-0.5 rounded-md">
            <Clock size={9} />
            {session.turn_count} turns
          </span>
        )}
        {Number(session.token_count) > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-x-ink-secondary bg-x-hover border border-x-line px-1.5 py-0.5 rounded-md tabular-nums">
            <Hash size={9} />
            {session.token_count_estimated ? '~' : ''}{compactNumber(session.token_count)} tok
          </span>
        )}
      </div>

      {/* Status label */}
      <span className={`mt-3 text-[11px] font-medium uppercase tracking-wider ${statusMeta.textClass}`}>
        {statusMeta.label.toLowerCase()}
      </span>
    </button>
  )
}

export const SystemsCockpit = resolveExtensionPanel('company', 'SystemsCockpit')

export default function MissionControl({ onClose }) {
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const workspaces = useStore((s) => s.workspaces)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const tabScope = useStore((s) => s.tabScope)

  const handleSelect = (id) => {
    const store = useStore.getState()
    const session = sessions[id]

    if (tabScope === 'workspace' && session) {
      // Switch to the session's workspace so it's visible
      store.setActiveWorkspace(session.workspace_id)
    }
    // Picking a card opens that session full size (the Session level).
    store.goSession(id)
    onClose()
  }

  const stopAll = () => {
    const ws = useStore.getState().ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    visibleSessions(sessions).forEach((s) => {
      if (s.status === 'running') {
        ws.send(JSON.stringify({ action: 'stop', session_id: s.id }))
      }
    })
  }

  // Helper sessions (Commander, Brainstormer) are never counted or listed.
  const allSessions = visibleSessions(sessions)
  const running = allSessions.filter((s) => s.status === 'running')
  const totalTokens = allSessions.reduce((sum, s) => sum + (Number(s.token_count) || 0), 0)
  const estimatedTokens = allSessions.some((s) => s.token_count_estimated)

  // ── Keyboard navigation ────────────────────────────────────────────────
  const gridRef = useRef(null)
  const containerRef = useRef(null)

  // Flat list of sessions in display order (grouped by workspace).
  const flatSessions = workspaces.flatMap((ws) =>
    allSessions.filter((s) => s.workspace_id === ws.id)
  )
  const sessionIdxMap = Object.fromEntries(flatSessions.map((s, i) => [s.id, i]))

  // Build a 2D grid of flat indices that mirrors the actual visual layout:
  // each workspace starts a new set of rows, each row has up to 3 items.
  const cols = 3
  const { gridRows, idxToPos } = useMemo(() => {
    const rows = []
    const posMap = {}
    workspaces.forEach((ws) => {
      const wsSessions = allSessions.filter((s) => s.workspace_id === ws.id)
      for (let i = 0; i < wsSessions.length; i += cols) {
        const row = wsSessions.slice(i, i + cols).map((s) => sessionIdxMap[s.id])
        const rowIdx = rows.length
        row.forEach((flatIdx, colIdx) => { posMap[flatIdx] = { row: rowIdx, col: colIdx } })
        rows.push(row)
      }
    })
    return { gridRows: rows, idxToPos: posMap }
  }, [workspaces, allSessions.length, flatSessions.length])

  // Initialize focus to the active session, or 0
  const initIdx = activeSessionId && sessionIdxMap[activeSessionId] != null
    ? sessionIdxMap[activeSessionId]
    : flatSessions.length > 0 ? 0 : -1
  const [focusIdx, setFocusIdx] = useState(initIdx)

  // Steal focus from the terminal when Mission Control opens
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleKeyDown = (e) => {
    const total = flatSessions.length
    if (total === 0) return
    const tag = e.target?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea') return

    if (e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      setFocusIdx((i) => Math.min(total - 1, i < 0 ? 0 : i + 1))
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      setFocusIdx((i) => Math.max(0, i < 0 ? 0 : i - 1))
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setFocusIdx((cur) => {
        const i = cur < 0 ? 0 : cur
        const pos = idxToPos[i]
        if (!pos) return i
        const nextRow = gridRows[pos.row + 1]
        if (!nextRow) return i // already on last row
        return nextRow[Math.min(pos.col, nextRow.length - 1)]
      })
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setFocusIdx((cur) => {
        const i = cur < 0 ? 0 : cur
        const pos = idxToPos[i]
        if (!pos) return i
        const prevRow = gridRows[pos.row - 1]
        if (!prevRow) return i // already on first row
        return prevRow[Math.min(pos.col, prevRow.length - 1)]
      })
      return
    }
    if (e.key === 'Enter' && focusIdx >= 0) {
      e.preventDefault()
      e.stopPropagation()
      const session = flatSessions[focusIdx]
      if (session) handleSelect(session.id)
      return
    }
  }

  // Scroll focused card into view.
  useEffect(() => {
    if (focusIdx < 0) return
    const el = gridRef.current?.querySelector(`[data-session-idx="${focusIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex items-start justify-center pt-[10vh] overflow-y-auto outline-none"
      onClick={onClose}
    >
      <div
        className="w-[min(1040px,94vw)] x-panel overflow-hidden mb-8 scale-in border border-x-line shadow-x-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-x-line bg-x-surface">
          <span className="text-sm text-x-ink font-semibold">Mission Control</span>
          <span className="hidden md:inline text-[12px] text-x-muted">Jump to any session, in every project</span>
          <div className="flex-1" />
          <span className="hidden sm:inline-flex text-[11px] font-mono text-x-muted mr-3 bg-x-surface-2 border border-x-line-subtle px-2 py-0.5 rounded-md">
            <kbd className="text-x-ink-secondary">↑↓←→</kbd> navigate · <kbd className="text-x-ink-secondary">↵</kbd> open
          </span>
          <span className="text-[11px] text-x-ink-secondary bg-x-surface-2 border border-x-line-subtle px-2.5 py-0.5 rounded-md mr-1 tabular-nums">
            {allSessions.length} sessions · {running.length} running
            {totalTokens > 0 ? ` · ${estimatedTokens ? '~' : ''}${compactNumber(totalTokens)} tok` : ''}
          </span>
          {running.length > 0 && (
            <Button type="submit"
              onClick={stopAll}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 hover:bg-x-accent-ink/20 transition-colors duration-[80ms]"
            >
              <Square size={10} />
              stop all
            </Button>
          )}
        </div>

        {/* Grid by workspace */}
        <div ref={gridRef} className="p-5 space-y-6">
          <SystemsCockpit />

          {workspaces.map((ws) => {
            const wsSessions = allSessions.filter((s) => s.workspace_id === ws.id)
            if (wsSessions.length === 0) return null
            return (
              <div key={ws.id} className="space-y-3">
                <div className="flex items-baseline gap-2 pb-1 border-b border-x-line-subtle">
                  <span className="text-[11px] font-medium text-x-accent uppercase tracking-wider">
                    {ws.name}
                  </span>
                  <span className="text-[11px] text-x-muted font-mono truncate max-w-[280px]" title={ws.path}>{ws.path}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {wsSessions.map((session) => (
                    <div key={session.id} data-session-idx={sessionIdxMap[session.id]} className="min-w-0">
                      <SessionCard
                        session={session}
                        sessionStarted={sessionStarted}
                        isActive={session.id === activeSessionId}
                        isFocused={focusIdx === sessionIdxMap[session.id]}
                        onClick={() => handleSelect(session.id)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {allSessions.length === 0 && (
            <div className="text-center py-14 text-x-ink-secondary text-[13px]">
              No active agent sessions found
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
