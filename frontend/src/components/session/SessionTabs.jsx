import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Pencil, Copy, Download, Trash2, Globe, FolderOpen, LayoutGrid, Columns2, Rows2, Grid2x2, Home, ChevronLeft, ChevronRight, Sparkles, Brain } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getWorkspaceColor } from '../../lib/constants'
import useMediaQuery from '../../hooks/useMediaQuery'

function ContextMenu({ x, y, session, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onClose])

  const handleRename = async () => {
    const name = prompt('Rename session:', session.name)
    if (name?.trim()) {
      const updated = await api.renameSession(session.id, name.trim())
      useStore.getState().loadSessions([updated])
    }
    onClose()
  }

  const handleClone = async () => {
    const cloned = await api.cloneSession(session.id)
    useStore.getState().addSession(cloned)
    onClose()
  }

  const handleExport = () => {
    window.open(`/api/sessions/${session.id}/export`, '_blank')
    onClose()
  }

  const handleDelete = async () => {
    await api.deleteSession(session.id)
    useStore.getState().removeSession(session.id)
    onClose()
  }

  const handleLearn = async () => {
    onClose()
    try {
      const cli = session.cli_type || 'claude'
      const res = await api.distillSession(session.id, { type: 'guideline', cli })
      if (res.error) {
        useStore.getState().addNotification({
          type: 'warning',
          message: `Could not learn from "${session.name}": ${res.error}`,
        })
      } else {
        useStore.getState().addNotification({
          type: 'info',
          message: `Learning from "${session.name}" in background...`,
        })
      }
    } catch (e) {
      useStore.getState().addNotification({
        type: 'warning',
        message: `Could not learn from "${session.name}": ${e.message || 'unknown error'}`,
      })
    }
  }

  const items = [
    { icon: Pencil, label: 'Rename', action: handleRename },
    { icon: Copy, label: 'Clone', action: handleClone },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn },
    { icon: Download, label: 'Export', action: handleExport },
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-50 ide-panel py-1 min-w-[150px] scale-in"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.action}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
            item.danger ? 'text-red-400 hover:bg-red-400/10' : 'text-text-secondary hover:bg-bg-hover'
          }`}
        >
          <item.icon size={12} />
          {item.label}
        </button>
      ))}
    </div>
  )
}

function InlineRenameInput({ session, onDone }) {
  const [value, setValue] = useState(session.name)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const save = async () => {
    const name = value.trim()
    if (name && name !== session.name) {
      const updated = await api.renameSession(session.id, name)
      useStore.getState().loadSessions([updated])
    }
    onDone()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') onDone()
      }}
      className="bg-transparent border border-accent-primary/60 rounded px-1.5 py-0.5 text-xs font-mono text-text-primary focus:outline-none ide-focus-ring w-24"
      onClick={(e) => e.stopPropagation()}
    />
  )
}

export default function SessionTabs() {
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const splitMode = useStore((s) => s.splitMode)
  const splitSessionId = useStore((s) => s.splitSessionId)
  const viewMode = useStore((s) => s.viewMode)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const showHome = useStore((s) => s.showHome)
  const tabScope = useStore((s) => s.tabScope)
  const setTabScope = useStore((s) => s.setTabScope)
  const peers = useStore((s) => s.peers)
  const myClientId = useStore((s) => s.myClientId)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const closeTab = useStore((s) => s.closeTab)
  const planWaiting = useStore((s) => s.planWaiting)
  const sessionActivity = useStore((s) => s.sessionActivity)
  const compactionState = useStore((s) => s.compactionState)
  const [ctx, setCtx] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [showLayoutMenu, setShowLayoutMenu] = useState(false)
  // Mobile clamps to single-terminal view — hide the grid/tabs toggle and the
  // layout dropdown so users can't activate a multi-terminal layout that the
  // App.jsx render path will refuse to honor anyway.
  const isMobile = useMediaQuery('(max-width: 767px)')
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    if (!showLayoutMenu) return
    const h = (e) => {
      if (!e.target.closest('[data-layout-menu]') && !e.target.closest('[data-layout-trigger]')) {
        setShowLayoutMenu(false)
      }
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [showLayoutMenu])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])

  // When the active session changes (e.g. via ⌘← / ⌘→), make sure that tab is
  // visible in the horizontally scrolling strip. Without this, ⌘-arrowing past
  // the right/left edge would silently activate offscreen tabs.
  useEffect(() => {
    if (!activeSessionId) return
    const el = document.querySelector(`[data-tab-id="${activeSessionId}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
    }
  }, [activeSessionId])

  const isSessionActive = (id) => sessionActivity[id] && (now - sessionActivity[id]) < 5000

  // Filter tabs based on scope
  const visibleTabs = tabScope === 'workspace' && activeWorkspaceId
    ? openTabs.filter((id) => sessions[id]?.workspace_id === activeWorkspaceId)
    : openTabs

  useEffect(() => {
    updateScrollState()
  }, [visibleTabs.length, updateScrollState])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateScrollState])

  const scrollBy = (dir) => {
    scrollRef.current?.scrollBy({ left: dir * 200, behavior: 'smooth' })
  }

  return (
    <>
      <div className="flex items-stretch bg-bg-inset border-b border-border-primary text-xs select-none min-h-[44px] md:min-h-0 touch-manipulation">
        {/* Home icon */}
        <button
          data-chrome-button
          onClick={() => useStore.setState({ showHome: !showHome })}
          className={`flex items-center px-2.5 shrink-0 border-r border-border-secondary transition-colors ${
            showHome || openTabs.length === 0
              ? 'text-accent-primary bg-bg-primary'
              : 'text-text-faint hover:text-text-secondary hover:bg-bg-secondary/50'
          }`}
          title="Home"
        >
          <Home size={13} />
        </button>

        {openTabs.length > 0 && <>
        {/* Tab scope toggle */}
        <button
          data-chrome-button
          onClick={() => setTabScope(tabScope === 'project' ? 'workspace' : 'project')}
          className="flex items-center gap-1 px-2.5 shrink-0 text-text-faint hover:text-text-secondary border-r border-border-secondary transition-colors"
          title={tabScope === 'project' ? 'Showing all tabs — click for workspace only' : 'Showing workspace tabs — click for all'}
        >
          {tabScope === 'project' ? <Globe size={14} /> : <FolderOpen size={14} />}
        </button>

        {/* Grid/tabs view toggle — hidden on mobile (single-terminal only) */}
        {!isMobile && (
        <button
          data-chrome-button
          onClick={() => {
            useStore.getState().setViewMode(viewMode === 'tabs' ? 'grid' : 'tabs')
          }}
          className={`flex items-center gap-1 px-2.5 shrink-0 border-r border-border-secondary transition-colors ${
            viewMode === 'grid' ? 'text-accent-primary' : 'text-text-faint hover:text-text-secondary'
          }`}
          title={viewMode === 'grid' ? 'Grid view — click for tabs' : 'Tabs view — click for grid'}
        >
          <LayoutGrid size={14} />
        </button>
        )}

        {/* Grid layout dropdown (only visible in grid mode + non-mobile) */}
        {!isMobile && viewMode === 'grid' && (() => {
          const builtins = [
            { id: 'equal',       icon: Grid2x2,  label: 'Equal grid' },
            { id: 'focusRight',  icon: Columns2, label: 'Focus left · stack right' },
            { id: 'focusBottom', icon: Rows2,    label: 'Focus top · stack bottom' },
          ]
          const activeTpl = activeGridTemplateId
            ? gridTemplates.find((t) => t.id === activeGridTemplateId)
            : null
          const builtin = builtins.find((b) => b.id === gridLayout) || builtins[0]
          const Icon = activeTpl ? LayoutGrid : builtin.icon
          const currentLabel = activeTpl ? activeTpl.name : builtin.label

          return (
            <div className="relative shrink-0 border-r border-border-secondary">
              <button
                data-chrome-button
                data-layout-trigger
                onClick={() => setShowLayoutMenu((v) => !v)}
                className="flex items-center gap-1 px-2 h-full text-accent-primary transition-colors hover:bg-bg-hover"
                title={`Layout: ${currentLabel} — click to choose`}
              >
                <Icon size={11} />
                <span className="text-[10px] font-mono max-w-[100px] truncate">{currentLabel}</span>
              </button>
              {showLayoutMenu && (
                <div
                  data-layout-menu
                  className="absolute left-0 top-full mt-1 ide-panel py-1 min-w-[220px] z-50 scale-in"
                >
                  <div className="px-2.5 py-1 text-[9px] text-text-faint font-medium uppercase tracking-wider border-b border-border-secondary">
                    Built-in
                  </div>
                  {builtins.map((b) => {
                    const BIcon = b.icon
                    const isActive = !activeGridTemplateId && gridLayout === b.id
                    return (
                      <button
                        key={b.id}
                        onClick={() => {
                          useStore.getState().setGridLayout(b.id)
                          setShowLayoutMenu(false)
                        }}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-bg-hover transition-colors ${
                          isActive ? 'text-accent-primary' : 'text-text-secondary'
                        }`}
                      >
                        <BIcon size={11} className="shrink-0" />
                        <span className="flex-1 truncate">{b.label}</span>
                        {isActive && <span className="text-[9px] text-accent-primary">●</span>}
                      </button>
                    )
                  })}

                  {gridTemplates.length > 0 && (
                    <>
                      <div className="px-2.5 py-1 text-[9px] text-text-faint font-medium uppercase tracking-wider border-b border-t border-border-secondary mt-1">
                        Custom templates
                      </div>
                      {gridTemplates.map((tpl) => {
                        const isActive = activeGridTemplateId === tpl.id
                        return (
                          <button
                            key={tpl.id}
                            onClick={() => {
                              useStore.getState().setActiveGridTemplateId(tpl.id)
                              setShowLayoutMenu(false)
                            }}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-bg-hover transition-colors ${
                              isActive ? 'text-accent-primary' : 'text-text-secondary'
                            }`}
                          >
                            <LayoutGrid size={11} className="shrink-0" />
                            <span className="flex-1 truncate">{tpl.name}</span>
                            {isActive && <span className="text-[9px] text-accent-primary">●</span>}
                          </button>
                        )
                      })}
                    </>
                  )}

                  <div className="border-t border-border-secondary mt-1">
                    <button
                      onClick={() => {
                        setShowLayoutMenu(false)
                        window.dispatchEvent(new CustomEvent('open-panel', { detail: 'grid-templates' }))
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-indigo-400 hover:bg-bg-hover transition-colors"
                    >
                      <span className="shrink-0">+</span>
                      <span>Manage templates...</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {/* Scroll left arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scrollBy(-1)}
            className="hidden md:flex items-center px-1 shrink-0 text-text-secondary hover:text-text-primary bg-bg-inset hover:bg-bg-secondary/50 border-r border-border-secondary transition-colors z-10"
            title="Scroll tabs left"
          >
            <ChevronLeft size={14} />
          </button>
        )}

        {/* Scrollable tab area */}
        <div
          ref={scrollRef}
          className="flex-1 flex items-stretch overflow-x-auto min-w-0 tab-scroll-hide touch-manipulation"
          onScroll={updateScrollState}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
        >
        {visibleTabs.map((id, idx) => {
          const session = sessions[id]
          if (!session) return null
          const isActive = activeSessionId === id
          const isSplit = splitMode && splitSessionId === id
          const wsColor = getWorkspaceColor(workspaces.find((w) => w.id === session.workspace_id))
          const isDragOver = dropIdx === idx && dragIdx !== idx
          return (
            <div
              key={id}
              data-chrome-button
              data-tab-id={id}
              tabIndex={-1}
              draggable
              onDragStart={(e) => {
                setDragIdx(idx)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('tab-idx', String(idx))
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropIdx(idx)
              }}
              onDragLeave={() => setDropIdx(null)}
              onDrop={(e) => {
                e.preventDefault()
                const from = parseInt(e.dataTransfer.getData('tab-idx'))
                if (!isNaN(from) && from !== idx) {
                  useStore.getState().reorderTabs(from, idx)
                }
                setDragIdx(null)
                setDropIdx(null)
              }}
              onDragEnd={() => { setDragIdx(null); setDropIdx(null) }}
              onClick={() => { setActiveSession(id); useStore.setState({ showHome: false }) }}
              onDoubleClick={() => setRenamingId(id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtx({ x: e.clientX, y: e.clientY, session })
              }}
              className={`group relative flex items-center gap-1.5 px-3 py-2 shrink-0 cursor-grab active:cursor-grabbing whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-bg-primary text-text-primary'
                  : isSplit
                    ? 'bg-bg-primary/40 text-text-secondary hover:bg-bg-primary/60'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-secondary/50'
              } ${isDragOver ? 'bg-accent-subtle' : ''}`}
            >
              {/* Top accent bar — primary active gets full bar; split secondary gets a dimmer one */}
              {(isActive || isSplit) && (
                <div
                  className="absolute top-0 left-0 right-0"
                  style={{
                    height: '2px',
                    background: wsColor,
                    opacity: isActive ? 1 : 0.55,
                  }}
                />
              )}

              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  planWaiting[id] || isSessionActive(id)
                    ? 'bg-amber-400 animate-subtle-pulse'
                    : compactionState[id]?.status === 'compacting' || compactionState[id]?.status === 'warning'
                      ? 'bg-orange-400 animate-pulse'
                      : session.status === 'running'
                        ? 'bg-green-400'
                        : session.status === 'exited'
                          ? 'bg-zinc-500'
                          : 'bg-zinc-600'
                }`}
                title={
                  planWaiting[id] ? 'Waiting for input'
                  : isSessionActive(id) ? 'Needs attention'
                  : compactionState[id]?.status === 'compacting' ? 'Compacting context'
                  : compactionState[id]?.status === 'warning' ? `${compactionState[id].percent_left}% context left`
                  : session.status === 'running' ? 'Running'
                  : session.status === 'exited' ? 'Exited'
                  : 'Idle'
                }
              />
              {session.session_type === 'commander' && (
                <span className="text-[9px] text-amber-400 font-semibold">CMD</span>
              )}
              {(() => {
                try {
                  const mi = typeof session.memory_injected_info === 'string'
                    ? JSON.parse(session.memory_injected_info) : session.memory_injected_info
                  if (mi?.count > 0) return (
                    <span
                      className="text-violet-400/70"
                      title={`${mi.count} memory ${mi.count === 1 ? 'entry' : 'entries'} injected (${mi.chars} chars)`}
                    >
                      <Brain size={10} />
                    </span>
                  )
                } catch { /* ignore */ }
                return null
              })()}
              {(() => {
                const tags = Array.isArray(session.tags) ? session.tags
                  : typeof session.tags === 'string' ? (() => { try { return JSON.parse(session.tags) } catch { return [] } })()
                  : []
                return tags.length > 0 ? (
                  <div className="flex gap-0.5">
                    {tags.slice(0, 2).map(tag => (
                      <span key={tag} className="text-[8px] px-1 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/20">
                        {tag}
                      </span>
                    ))}
                    {tags.length > 2 && <span className="text-[8px] text-zinc-500">+{tags.length - 2}</span>}
                  </div>
                ) : null
              })()}
              {compactionState[id] && (() => {
                const cs = compactionState[id]
                const isWarn = cs.status === 'warning'
                const label =
                  cs.status === 'compacting' ? '↯ compacting'
                  : cs.status === 'compacted' ? '↯ compacted'
                  : `↯ ${cs.percent_left}% left`
                const tip =
                  cs.status === 'compacting' ? 'Auto-compacting context — earlier messages will be summarized'
                  : cs.status === 'compacted' ? 'Context was just auto-compacted'
                  : `Only ${cs.percent_left}% context remaining until auto-compact`
                return (
                  <span
                    className={`text-[9px] font-semibold uppercase tracking-wider ${isWarn ? 'text-orange-400' : 'text-yellow-400'}`}
                    title={tip}
                  >
                    {label}
                  </span>
                )
              })()}
              {renamingId === id ? (
                <InlineRenameInput session={session} onDone={() => setRenamingId(null)} />
              ) : (
                <span className={`text-xs ${isActive ? 'font-medium' : ''}`}>{session.name}</span>
              )}
              <span className="text-text-faint font-mono text-[10px]">{session.model}</span>
              {session.is_external ? <span className="text-teal-400/70 font-mono text-[9px]">ext</span> : null}
              {/* Multiplayer: peer presence dots */}
              {(() => {
                const viewing = Object.entries(peers).filter(([cid, p]) => p.viewing_session === id && cid !== myClientId)
                return viewing.length > 0 ? (
                  <div className="flex items-center -space-x-1">
                    {viewing.slice(0, 3).map(([cid, p]) => (
                      <span
                        key={cid}
                        className="w-3.5 h-3.5 rounded-full text-[7px] font-bold text-white flex items-center justify-center ring-1 ring-bg-primary"
                        style={{ background: p.color }}
                        title={p.name}
                      >
                        {p.name?.[0]?.toUpperCase() || '?'}
                      </span>
                    ))}
                    {viewing.length > 3 && (
                      <span className="text-[8px] text-text-faint ml-0.5">+{viewing.length - 3}</span>
                    )}
                  </div>
                ) : null
              })()}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(id)
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all p-0.5 -mr-1 hover:bg-bg-hover rounded"
              >
                <X size={12} />
              </button>

              {/* Right border separator for inactive tabs */}
              {!isActive && (
                <div className="absolute right-0 top-1/4 bottom-1/4 w-px bg-border-secondary" />
              )}
            </div>
          )
        })}
        </div>

        {/* Scroll right arrow */}
        {canScrollRight && (
          <button
            onClick={() => scrollBy(1)}
            className="hidden md:flex items-center px-1 shrink-0 text-text-secondary hover:text-text-primary bg-bg-inset hover:bg-bg-secondary/50 border-l border-border-secondary transition-colors z-10"
            title="Scroll tabs right"
          >
            <ChevronRight size={14} />
          </button>
        )}
        </>}
      </div>

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} session={ctx.session} onClose={() => setCtx(null)} />
      )}
    </>
  )
}
