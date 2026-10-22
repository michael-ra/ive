import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Plus, Minus, Sliders, Terminal, MessageSquare, Maximize2 } from 'lucide-react'
import useStore from '../../state/store'
import ChatPanel from '../chat/ChatPanel'
import TerminalSlot from '../shell/TerminalSlot'
import SessionCloseButton from '../session/SessionCloseButton'
import useSessionChipMenu from '../session/SessionChipMenu'
import StatusDot from '../ui/StatusDot'
import { isShellSession } from '../../lib/sessionStatus'
import { sessionStateOf } from '../../lib/sessionVocabulary'
import { isHelperSession } from '../../lib/visibleSessions'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { shouldFocusGridTerminal } from '../../lib/gridFocus'

// The tile wall (Grid mode of the Board): every open session as a tile with
// its chat or terminal, in a built-in layout or a custom template. Opening a
// tile ("Open", double-click) goes to the Session level; there is no
// in-grid focus mode any more. Terminals render through <TerminalSlot
// mode="tile">, so switching levels never remounts them.

const GRID_SESSION_VIEWS_KEY = 'ive.grid-session-views'

// Same status dot + word as the sidebar and the session header.
export function CellStatus({ session, sessionStarted }) {
  if (!session) return null
  const meta = sessionStateOf(session, sessionStarted)
  return (
    <span className={`ive-cell-status ${meta.textClass}`} data-session-state={meta.state}>
      <StatusDot state={meta.state} />
      {meta.label}
    </span>
  )
}

function readGridSessionViews() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRID_SESSION_VIEWS_KEY) || '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch { return {} }
}

export default function SessionGrid() {
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const tabScope = useStore((s) => s.tabScope)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridColumns = useStore((s) => s.gridColumns)
  const gridMinRowHeight = useStore((s) => s.gridMinRowHeight)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const terminalBoardMode = useStore((s) => s.terminalBoardMode)
  const gridAdjustMode = useStore((s) => s.gridAdjustMode)

  // Reorder + context menu on cell headers.
  const sessionChipMenu = useSessionChipMenu()
  const SessionMenuButton = sessionChipMenu.MenuButton

  // Per-tile chat/terminal choice (sessionId -> 'chat' | 'terminal'), kept
  // per browser so a reload shows each tile the way the user left it.
  const [gridSessionViews, setGridSessionViews] = useState(readGridSessionViews)
  useEffect(() => {
    try { localStorage.setItem(GRID_SESSION_VIEWS_KEY, JSON.stringify(gridSessionViews)) } catch { /* private mode */ }
  }, [gridSessionViews])
  // A plain terminal ("shell") has no chat view: always the terminal.
  const isSessionTerminalView = useCallback((sid) => (
    isShellSession(sessions[sid]) ||
    (terminalBoardMode ? gridSessionViews[sid] !== 'chat' : gridSessionViews[sid] === 'terminal')
  ), [gridSessionViews, terminalBoardMode, sessions])
  const toggleSessionGridView = (sid) => {
    useStore.getState().setActiveSession(sid)
    setGridSessionViews((prev) => {
      const isTerminal = terminalBoardMode ? prev[sid] !== 'chat' : prev[sid] === 'terminal'
      const next = { ...prev }
      if (terminalBoardMode) {
        if (isTerminal) next[sid] = 'chat'
        else delete next[sid]
      } else if (isTerminal) {
        delete next[sid]
      } else {
        next[sid] = 'terminal'
      }
      return next
    })
    useStore.getState().focusSessionTerminal(sid)
  }

  // The grid's box drives the auto column count (tiles scale the session
  // size down, so the most legible layout wins).
  const areaRef = useRef(null)
  const [areaWidth, setAreaWidth] = useState(0)
  const [areaHeight, setAreaHeight] = useState(0)
  useEffect(() => {
    const area = areaRef.current
    if (!area) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setAreaWidth(entry.contentRect.width)
      setAreaHeight(entry.contentRect.height)
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  const handleHeightDragStart = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = useStore.getState().gridMinRowHeight
    const handleMouseMove = (moveEvent) => {
      const deltaY = moveEvent.clientY - startY
      useStore.getState().setGridMinRowHeight(Math.max(100, Math.min(800, startHeight + deltaY)))
    }
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [])

  const openSession = (id) => {
    useStore.getState().goSession(id)
    setTimeout(() => window.dispatchEvent(new Event('cc-focus-terminal')), 120)
  }

  // Tabs filtered by the project/workspace scope; helper sessions stay out.
  const visibleTabs = openTabs.filter((id) => sessions[id] && !isHelperSession(sessions[id])
    && (tabScope !== 'workspace' || !activeWorkspaceId || sessions[id].workspace_id === activeWorkspaceId))

  const activeTpl = activeGridTemplateId ? gridTemplates.find((t) => t.id === activeGridTemplateId) : null

  const renderHeader = (id, s) => (
    <div {...sessionChipMenu.chipProps(id)} className="ive-session-heading">
      <span onDoubleClick={() => openSession(id)} className="ive-session-title truncate flex-1" title="Double-click to open">{s?.name}</span>
      <CellStatus session={s} sessionStarted={sessionStarted} />
      <SessionMenuButton id={id} name={s?.name} />
      <button type="button" className="ive-terminal-expand" aria-label={`Open ${s?.name || 'session'}`} title="Open" onClick={() => openSession(id)}>
        <Maximize2 size={14} aria-hidden="true" />
      </button>
      {isShellSession(s) ? (
        <Terminal size={11} className="text-x-faint shrink-0 mr-1" aria-label="Terminal" />
      ) : (
        <>
          <span className="t-meta mono mr-1 truncate max-w-[120px]">{s?.model}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleSessionGridView(id) }}
            className="ive-terminal-expand"
            title={isSessionTerminalView(id) ? 'Switch to Chat View' : 'Switch to Terminal View'}
          >
            {isSessionTerminalView(id) ? <MessageSquare size={11} aria-hidden="true" /> : <Terminal size={11} aria-hidden="true" />}
          </button>
        </>
      )}
      <SessionCloseButton sessionId={id} name={s?.name} />
    </div>
  )

  const renderBody = (id) => (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {isSessionTerminalView(id)
        ? <TerminalSlot sessionId={id} mode="tile" focusOnMount />
        : <ChatPanel sessionId={id} inGrid={true} onToggleTerminal={() => toggleSessionGridView(id)} />}
    </div>
  )

  const tileEvents = (id) => ({
    onMouseDownCapture: (e) => {
      if (!shouldFocusGridTerminal(e)) return
      useStore.getState().setActiveSession(id)
      requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
    },
    // Typing into a tile's composer (click or Tab) selects that session.
    onFocusCapture: (e) => {
      if (!e.target?.matches?.('textarea, input, [contenteditable="true"]')) return
      if (useStore.getState().activeSessionId !== id) useStore.getState().setActiveSession(id)
    },
  })

  let content
  if (activeTpl) {
    /* ─── Custom Grid Template ─── */
    const totalRows = Math.max(1, ...activeTpl.cells.map((c) => (c.row || 1) + (c.rowSpan || 1) - 1))
    const tplAssignments = activeTpl.cell_assignments || {}
    content = (
      <div
        data-terminal-grid=""
        className="flex-1 min-w-0 grid min-h-0 gap-1 p-1 overflow-auto"
        style={{
          gridTemplateColumns: `repeat(${activeTpl.cols}, minmax(320px, 1fr))`,
          gridTemplateRows: `repeat(${totalRows}, minmax(${gridMinRowHeight}px, 1fr))`,
        }}
      >
        {activeTpl.cells.map((cell, i) => {
          let sessionId = tplAssignments[cell.id]
          if (sessionId && (!sessions[sessionId] || !openTabs.includes(sessionId))) sessionId = null
          if (sessionId && tabScope === 'workspace' && activeWorkspaceId && sessions[sessionId]?.workspace_id !== activeWorkspaceId) sessionId = null
          const s = sessionId ? sessions[sessionId] : null
          const isFocused = sessionId && activeSessionId === sessionId
          return (
            <div
              key={cell.id}
              data-grid-cell-session={sessionId || undefined}
              className={`ive-grid-tile relative flex flex-col min-h-0 overflow-hidden${isFocused ? ' is-active' : ''}${!s ? ' is-empty' : ''}`}
              style={{ gridColumn: `${cell.col} / span ${cell.colSpan}`, gridRow: `${cell.row} / span ${cell.rowSpan}` }}
              {...(sessionId ? tileEvents(sessionId) : {})}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('session-id')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
              }}
              onDrop={(e) => {
                const sid = e.dataTransfer.getData('session-id')
                if (!sid) return
                e.preventDefault()
                e.stopPropagation()
                const store = useStore.getState()
                if (!store.openTabs.includes(sid)) store.openSession(sid)
                store.assignSessionToCell(activeTpl.id, cell.id, sid)
              }}
            >
              {s ? (
                <>
                  {renderHeader(sessionId, s)}
                  {renderBody(sessionId)}
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-center px-3">
                  <div>
                    <div className="t-meta mono">cell {i + 1}</div>
                    <div className="t-meta mt-1">drag a session here</div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  } else {
    /* ─── Built-in grid ─── */
    const readableColumns = Math.max(1, Math.min(3, Math.floor((areaWidth || 520) / 520)))
    const layout = readableColumns < 2 ? 'equal' : gridLayout
    const n = visibleTabs.length
    const others = Math.max(1, n - 1)
    const rowMinmax = `minmax(${Math.max(380, gridMinRowHeight)}px, 1fr)`
    const autoRowMin = Math.max(240, gridMinRowHeight)
    const autoColumns = (() => {
      const gridW = areaWidth - 8 // grid padding (p-1)
      const gridH = areaHeight - 8
      if (!(gridW > 0 && gridH > 0)) return readableColumns
      const sessionW = gridW - 8, sessionH = gridH - 8
      let best = 1, bestScore = 0
      for (let c = 1; c <= Math.min(n, 4); c++) {
        const r = Math.ceil(n / c)
        const fitH = (gridH - 4 * (r - 1)) / r
        const tileW = (gridW - 4 * (c - 1)) / c
        const tileH = Math.max(autoRowMin, fitH)
        const score = Math.min(tileW / sessionW, tileH / sessionH) * (fitH < autoRowMin ? 0.9 : 1)
        if (score >= bestScore - 0.005) { best = c; bestScore = Math.max(score, bestScore) }
      }
      return best
    })()
    let gridStyle
    if (n > 1 && layout === 'focusRight') {
      gridStyle = { gridTemplateColumns: 'minmax(520px, 2fr) minmax(360px, 1fr)', gridTemplateRows: `repeat(${others}, ${rowMinmax})` }
    } else if (n > 1 && layout === 'focusBottom') {
      gridStyle = {
        gridTemplateColumns: `repeat(${Math.min(others, readableColumns)}, minmax(0, 1fr))`,
        gridTemplateRows: `minmax(${Math.max(500, gridMinRowHeight * 2)}px, 2fr)`,
        gridAutoRows: rowMinmax,
      }
    } else {
      gridStyle = {
        gridTemplateColumns: `repeat(${Math.max(1, Math.min(n, gridColumns > 0 ? gridColumns : autoColumns))}, minmax(${gridColumns > 0 ? 320 : 0}px, 1fr))`,
        gridAutoRows: gridColumns > 0 ? rowMinmax : `minmax(${autoRowMin}px, 1fr)`,
      }
    }
    let nonFocusCounter = 0
    const placement = (isFocused) => {
      if (n <= 1 || layout === 'equal') return undefined
      if (layout === 'focusRight') {
        if (isFocused) return { gridColumn: 1, gridRow: `1 / span ${others}` }
        return { gridColumn: 2, gridRow: ++nonFocusCounter }
      }
      if (layout === 'focusBottom') {
        if (isFocused) return { gridColumn: `1 / span ${Math.min(others, readableColumns)}`, gridRow: 1 }
        const col = ++nonFocusCounter
        return { gridColumn: ((col - 1) % readableColumns) + 1, gridRow: Math.floor((col - 1) / readableColumns) + 2 }
      }
      return undefined
    }
    content = (
      <div data-terminal-grid="" className="flex-1 min-w-0 min-h-0 relative grid gap-1 p-1 overflow-auto" style={gridStyle}>
        {visibleTabs.map((id) => {
          const s = sessions[id]
          const isActiveTab = activeSessionId === id
          return (
            <div
              key={id}
              data-session-view={id}
              data-grid-cell-session={id}
              className={`ive-grid-tile relative flex flex-col min-h-0 overflow-hidden${isActiveTab ? ' is-active' : ''}${sessionNeedsAttention(s) ? ' ive-cell-needs-you' : ''}`}
              style={placement(isActiveTab)}
              {...tileEvents(id)}
            >
              {renderHeader(id, s)}
              {renderBody(id)}
            </div>
          )
        })}
        {visibleTabs.length === 0 && (
          <div className="ive-grid-empty t-meta">No open sessions in this scope.</div>
        )}
      </div>
    )
  }

  return (
    <div ref={areaRef} className="ive-session-grid flex-1 flex min-h-0 min-w-0 relative" data-session-grid="">
      {content}
      {gridAdjustMode && (
        <div className="absolute left-6 top-1/2 -translate-y-1/2 z-[45] flex items-center gap-6 pointer-events-none">
          <div className="flex flex-col items-center pointer-events-auto select-none" style={{ height: `${gridMinRowHeight}px` }}>
            <div className="w-4 h-[2px] bg-x-accent/60 rounded-full" />
            <div className="flex-1 w-[2px] bg-gradient-to-b from-x-accent/60 to-x-accent-ink/80 relative">
              <div className="absolute right-4 top-1/2 -translate-y-1/2 px-2 py-1 rounded-md bg-x-tooltip-bg text-x-tooltip-ink t-meta mono whitespace-nowrap">
                {gridMinRowHeight}px
              </div>
            </div>
            <svg onMouseDown={handleHeightDragStart} className="w-4 h-4 text-x-accent cursor-ns-resize active:scale-110 transition-transform duration-[80ms] fill-current mt-[-2px] relative" viewBox="0 0 24 24">
              <title>Drag to adjust row height</title>
              <path d="M12 3l10 16H2L12 3z" />
            </svg>
          </div>
          <div className="p-4 rounded-[10px] border border-x-line bg-x-surface shadow-x-1 pointer-events-auto w-64 flex flex-col gap-4 select-none animate-in">
            <div className="flex items-center justify-between border-b border-x-line pb-2">
              <div className="flex items-center gap-2">
                <Sliders size={14} className="text-x-accent" />
                <span className="text-x-ink font-semibold">Adjust Grid Layout</span>
              </div>
              <button type="button" onClick={() => useStore.getState().setGridAdjustMode(false)} className="p-1 rounded-md hover:bg-x-hover text-x-faint hover:text-x-ink-secondary" title="Close">
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="t-meta">Grid Columns</span>
              <div className="flex items-center gap-2.5">
                <button type="button" onClick={() => useStore.getState().setGridColumns(Math.max(0, gridColumns - 1))}
                  className="w-7 h-7 rounded-md border border-x-line bg-x-surface-2 hover:bg-x-hover text-x-ink-secondary flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={gridColumns === 0} title="Decrease columns (minimum: Auto)">
                  <Minus size={12} />
                </button>
                <div className="flex-1 text-center py-1 rounded-md bg-x-surface-2 border border-x-line mono text-x-ink">
                  {gridColumns === 0 ? 'Auto' : `${gridColumns} Column${gridColumns > 1 ? 's' : ''}`}
                </div>
                <button type="button" onClick={() => { const next = Math.min(6, gridColumns + 1); useStore.getState().setGridColumns(next === 0 ? 1 : next) }}
                  className="w-7 h-7 rounded-md border border-x-line bg-x-surface-2 hover:bg-x-hover text-x-ink-secondary flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={gridColumns === 6} title="Increase columns (maximum: 6)">
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="t-meta">Min Row Height</span>
              <span className="t-meta mono">{gridMinRowHeight}px (drag gauge to adjust)</span>
            </div>
            <div className="t-meta border-t border-x-line pt-2">Use the vertical gauge to drag-resize height. Adjust column count using the buttons above.</div>
          </div>
        </div>
      )}
      {sessionChipMenu.element}
    </div>
  )
}
