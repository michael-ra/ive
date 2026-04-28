import { useState, useEffect, useRef, useMemo } from 'react'
import { Monitor, Clock, DollarSign, Zap, Square } from 'lucide-react'
import useStore from '../../state/store'

function SessionCard({ session, isActive, isFocused, onClick }) {
  const isRunning = session.status === 'running'
  const isExited = session.status === 'exited'

  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col p-3.5 rounded-lg border transition-all text-left min-w-0 overflow-hidden ${
        isActive
          ? 'border-accent-primary/40 bg-accent-subtle'
          : 'border-border-primary bg-bg-secondary hover:border-border-accent hover:bg-bg-elevated'
      } ${isFocused ? 'ring-1 ring-indigo-400/60' : ''}`}
    >
      {/* Status dot */}
      <span className={`absolute top-3.5 right-3.5 w-2 h-2 rounded-full ${
        isRunning ? 'bg-green-400 animate-subtle-pulse' :
        isExited ? 'bg-yellow-400' : 'bg-zinc-700'
      }`} />

      {/* Name */}
      <span className="text-xs text-text-primary font-medium pr-5 break-words">
        {session.name}
      </span>

      {/* Config badges */}
      <div className="flex items-center gap-2 mt-2.5">
        <span className="flex items-center gap-1 text-[10px] font-mono text-indigo-400">
          <Monitor size={9} />
          {session.model || 'sonnet'}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-mono text-text-faint">
          <Zap size={9} />
          {session.effort || 'high'}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-2 mt-2 text-[10px] font-mono text-text-faint">
        {session.turn_count > 0 && (
          <span className="flex items-center gap-1">
            <Clock size={9} />
            {session.turn_count} turns
          </span>
        )}
        {Number(session.total_cost_usd) > 0 && (
          <span className="flex items-center gap-1">
            <DollarSign size={9} />
            ${Number(session.total_cost_usd).toFixed(4)}
          </span>
        )}
      </div>

      {/* Status label */}
      <span className={`mt-2.5 text-[10px] font-medium ${
        isRunning ? 'text-green-400' : isExited ? 'text-yellow-500' : 'text-text-faint'
      }`}>
        {isRunning ? 'running' : isExited ? 'exited' : 'idle'}
      </span>
    </button>
  )
}

export default function MissionControl({ onClose }) {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const viewMode = useStore((s) => s.viewMode)
  const tabScope = useStore((s) => s.tabScope)

  const handleSelect = (id) => {
    const store = useStore.getState()
    const session = sessions[id]

    if (viewMode === 'tabs' && activeSessionId && activeSessionId !== id) {
      // Tab mode: replace the currently active tab with the selected session
      const tabs = [...store.openTabs]
      const activeIdx = tabs.indexOf(activeSessionId)
      if (activeIdx >= 0) {
        // Remove old active, insert new one at its position (if not already open)
        if (tabs.includes(id)) {
          // Already open — just swap positions: remove from old spot, put at activeIdx
          const fromIdx = tabs.indexOf(id)
          tabs.splice(fromIdx, 1)
          // Adjust activeIdx if the removed item was before it
          const insertAt = fromIdx < activeIdx ? activeIdx - 1 : activeIdx
          tabs.splice(insertAt, 1) // remove old active
          tabs.splice(insertAt, 0, id) // insert selected at that position
        } else {
          tabs.splice(activeIdx, 1, id) // replace active with selected
        }
        useStore.setState({ openTabs: tabs, activeSessionId: id, showHome: false })
      } else {
        store.openSession(id)
        useStore.setState({ showHome: false })
      }
    } else {
      // Grid mode (or no active tab to replace)
      if (tabScope === 'workspace' && session) {
        // Switch to the session's workspace so it's visible
        store.setActiveWorkspace(session.workspace_id)
      }
      store.openSession(id)
      useStore.setState({ showHome: false })
    }

    onClose()
  }

  const stopAll = () => {
    const ws = useStore.getState().ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    Object.values(sessions).forEach((s) => {
      if (s.status === 'running') {
        ws.send(JSON.stringify({ action: 'stop', session_id: s.id }))
      }
    })
  }

  const allSessions = Object.values(sessions)
  const running = allSessions.filter((s) => s.status === 'running')
  const totalCost = allSessions.reduce((sum, s) => sum + (Number(s.total_cost_usd) || 0), 0)

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
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[8vh] overflow-y-auto outline-none"
      onClick={onClose}
    >
      <div
        className="w-[720px] ide-panel overflow-hidden mb-8 scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-primary">
          <span className="text-sm text-text-primary font-semibold">Mission Control</span>
          <div className="flex-1" />
          <span className="text-[10px] font-mono text-text-faint/50 mr-2">
            <kbd className="text-text-faint/40">↑↓←→</kbd> navigate · <kbd className="text-text-faint/40">↵</kbd> open
          </span>
          <span className="text-[11px] font-mono text-text-faint">
            {allSessions.length} sessions · {running.length} running
            {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ''}
          </span>
          {running.length > 0 && (
            <button
              onClick={stopAll}
              className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
            >
              <Square size={10} />
              stop all
            </button>
          )}
        </div>

        {/* Grid by workspace */}
        <div ref={gridRef} className="p-5 space-y-5">
          {workspaces.map((ws) => {
            const wsSessions = allSessions.filter((s) => s.workspace_id === ws.id)
            if (wsSessions.length === 0) return null
            return (
              <div key={ws.id}>
                <div className="flex items-baseline gap-2 mb-2.5">
                  <span className="text-[10px] font-semibold text-text-faint uppercase tracking-widest">
                    {ws.name}
                  </span>
                  <span className="text-[10px] text-text-faint/50 font-mono truncate">{ws.path}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {wsSessions.map((session) => (
                    <div key={session.id} data-session-idx={sessionIdxMap[session.id]} className="min-w-0">
                      <SessionCard
                        session={session}
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
            <div className="text-center py-10 text-text-faint text-xs">
              No sessions yet
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
