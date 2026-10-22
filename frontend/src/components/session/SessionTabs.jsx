import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Pencil, Copy, Download, Trash2, Globe, FolderOpen, LayoutGrid, Columns2, Rows2, Grid2x2, Home, ChevronLeft, ChevronRight, Sparkles, Brain, MessageCircle, CircleHelp, Plus, Search, Keyboard } from 'lucide-react'
import { openQuickStart } from '../../lib/quickStart'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { closeSession, deleteSessionWithConfirm, continueSession } from '../../lib/sessionActions'
import { requestSessionRename } from '../../lib/sessionRename'
import { sessionIdentityStyle } from '../../lib/sessionIdentity'
import './sessionIdentity.css'
import SessionCloseButton from './SessionCloseButton'
import PrimaryNavigation from '../navigation/PrimaryNavigation'
import ViewSwitch from '../navigation/ViewSwitch'
import SidebarToggle from '../layout/SidebarToggle'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus } from '../../lib/sessionStatus'
import useMediaQuery from '../../hooks/useMediaQuery'
import { Button, IconButton } from '../ui'
import { getKeybindings, formatKeyCombo } from '../../lib/keybindings'

// Also used by the Session-view chips and overview cell headers (App.jsx),
// where the tab strip is hidden on mid-size desktops.
export function ContextMenu({ x, y, session, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onClose])

  const handleRename = () => {
    onClose()
    requestSessionRename(session.id)
  }

  const handleClone = async () => {
    const cloned = await api.cloneSession(session.id)
    useStore.getState().addSession(cloned)
    onClose()
  }
  const handleFresh = async (mode) => {
    onClose()
    try { await continueSession(session.id, mode) }
    catch (e) { useStore.getState().addNotification({ type: 'warning', message: e.message || 'Could not prepare a new session.' }) }
  }

  const handleExport = () => {
    window.open(`/api/sessions/${session.id}/export`, '_blank')
    onClose()
  }

  const handleDelete = async () => {
    onClose()
    await deleteSessionWithConfirm(session.id)
  }

  const handleLearn = async () => {
    onClose()
    try {
      const model = session.model
        ? `${session.cli_type || 'claude'}:${session.model}`
        : undefined
      const res = await api.distillSession(session.id, { type: 'guideline', model })
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
    { icon: MessageCircle, label: 'Continue in fresh session', action: () => handleFresh('handoff') },
    { icon: Plus, label: 'New topic', action: () => handleFresh('empty') },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn },
    { icon: Download, label: 'Export', action: handleExport },
    { icon: X, label: 'Close session', action: () => { onClose(); closeSession(session.id) } },
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return (
    <div
      ref={menuRef}
      role="menu"
      data-session-menu
      className="fixed z-50 bg-x-surface border border-x-line rounded-xl shadow-x-1 py-1 min-w-[150px] scale-in"
      style={{ left: Math.max(4, Math.min(x, window.innerWidth - 225)), top: Math.max(4, Math.min(y, window.innerHeight - 290)) }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={item.action}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors duration-[80ms] ${
            item.danger ? 'text-x-accent-ink hover:bg-x-accent-ink/10' : 'text-x-ink-secondary hover:bg-x-hover'
          }`}
        >
          <item.icon size={12} />
          {item.label}
        </button>
      ))}
    </div>
  )
}

export default function SessionTabs({ onOpenLauncher, launcherOpen = false, onToggleSideChat, sideChatOpen = false }) {
  const keybindings = useStore((s) => s.keybindings)
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const showHome = useStore((s) => s.showHome)
  const activeNavGroup = useStore((s) => s.activeNavGroup)
  const setActiveNavGroup = useStore((s) => s.setActiveNavGroup)
  const tabScope = useStore((s) => s.tabScope)
  const setTabScope = useStore((s) => s.setTabScope)
  const peers = useStore((s) => s.peers)
  const myClientId = useStore((s) => s.myClientId)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const planWaiting = useStore((s) => s.planWaiting)
  const sessionActivity = useStore((s) => s.sessionActivity)
  const compactionState = useStore((s) => s.compactionState)
  const [ctx, setCtx] = useState(null)
  const [dragIdx, setDragIdx] = useState(null)
  const [dropIdx, setDropIdx] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [showLayoutMenu, setShowLayoutMenu] = useState(false)
  // Mobile clamps to single-terminal view — hide the grid/tabs toggle and the
  // layout dropdown so users can't activate a multi-terminal layout that the
  // App.jsx render path will refuse to honor anyway.
  const isMobile = useMediaQuery('(max-width: 767px)')
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const homeShowing = showHome || openTabs.length === 0
  const chatBinding = getKeybindings().sideChat
  const chatKey = chatBinding ? formatKeyCombo(chatBinding) : ''
  const currentGroup = homeShowing || launcherOpen ? activeNavGroup : null
  const selectGroup = (groupId) => {
    setActiveNavGroup(groupId)
    if (activeSessionId && !showHome && openTabs.length > 0) {
      onOpenLauncher?.()
    } else {
      window.dispatchEvent(new Event('open-home-tools'))
      requestAnimationFrame(() => {
        document.querySelector(`[data-ia-main-group="${groupId}"]`)?.scrollIntoView({ block: 'start' })
      })
    }
  }

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
      <div className={`x-app-bar ${openTabs.length === 0 ? 'is-home ' : ''}${sidebarVisible && !isMobile ? 'has-sidebar ' : ''}flex items-stretch bg-x-bg border-b border-x-line text-xs select-none min-h-[46px] touch-manipulation`}>
        {!isMobile && <SidebarToggle />}
        <div className="x-brand-lockup hidden sm:flex items-center shrink-0">
          <ViewSwitch />
        </div>
        <PrimaryNavigation activeGroup={currentGroup} onSelect={selectGroup} />
        <IconButton
          icon={CircleHelp}
          label="IVE kennenlernen"
          iconSize={17}
          onClick={() => window.dispatchEvent(new Event('open-onboarding'))}
          className="ive-tour-button self-center h-9 w-9 shrink-0"
        />
        <button
          type="button"
          className="x-create-action is-labelled"
          data-new-session-button
          onClick={() => openQuickStart()}
          title={`Create a new session (${formatKeyCombo(keybindings.newSession)})`}
          aria-label="Create a new session"
        >
          <Plus size={16} aria-hidden="true" />
          <span className="x-create-label" aria-hidden="true">New session</span>
        </button>
        {/* Home: on wider screens the Home › Overview › Session switch replaces this */}
        <IconButton
          icon={Home}
          label="Home"
          iconSize={17}
          data-chrome-button
          onClick={() => showHome ? useStore.getState().goOverview() : useStore.getState().goHome()}
          selected={showHome || openTabs.length === 0}
          className="self-center h-8 w-8 sm:hidden"
        />

        {openTabs.length > 0 && <>
        {/* Scope selector: Global vs Workspace Dashboard */}
        <div
          className="ive-scope-toggle flex items-center gap-0.5 bg-x-surface-2 border border-x-line rounded-md p-0.5 m-1.5 shrink-0 select-none"
          role="group"
          aria-label="Session tab scope"
        >
          <IconButton
            icon={Globe}
            label="Global Dashboard (All workspaces)"
            iconSize={16}
            data-chrome-button
            onClick={() => setTabScope('project')}
            selected={tabScope === 'project'}
            aria-pressed={tabScope === 'project'}
            className="h-7 w-7"
          />
          <IconButton
            icon={FolderOpen}
            label="Workspace Dashboard (Active workspace only)"
            iconSize={16}
            data-chrome-button
            onClick={() => setTabScope('workspace')}
            selected={tabScope === 'workspace'}
            aria-pressed={tabScope === 'workspace'}
            className="h-7 w-7"
          />
        </div>
        <div className="w-px bg-x-line self-stretch my-2 shrink-0 mr-2" />

        {/* Grid layout dropdown (only visible on desktop) */}
        {!isMobile && (() => {
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
            <div className={`relative shrink-0 border-r border-x-line-subtle ${showLayoutMenu ? 'z-50' : 'z-10'}`}>
              <button
                data-chrome-button
                data-layout-trigger
                onClick={() => setShowLayoutMenu((v) => !v)}
                className="flex items-center justify-center px-3.5 h-full text-x-accent transition-colors duration-[80ms] hover:bg-x-hover"
                title={`Layout: ${currentLabel} — click to choose`}
              >
                <Icon size={15} />
              </button>
              {showLayoutMenu && (
                <div
                  data-layout-menu
                  className="absolute left-0 top-full mt-1 bg-x-surface border border-x-line rounded-[10px] shadow-x-1 py-1 min-w-[220px] z-50 scale-in"
                >
                  <div className="px-2.5 py-1 text-[11px] text-x-faint font-medium uppercase tracking-[0.06em] border-b border-x-line-subtle">
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
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-x-hover transition-colors duration-[80ms] ${
                          isActive ? 'text-x-accent' : 'text-x-ink-secondary'
                        }`}
                      >
                        <BIcon size={11} className="shrink-0" />
                        <span className="flex-1 truncate">{b.label}</span>
                        {isActive && <span className="text-[11px] text-x-accent">●</span>}
                      </button>
                    )
                  })}

                  {gridTemplates.length > 0 && (
                    <>
                      <div className="px-2.5 py-1 text-[11px] text-x-faint font-medium uppercase tracking-[0.06em] border-b border-t border-x-line-subtle mt-1">
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
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-x-hover transition-colors duration-[80ms] ${
                              isActive ? 'text-x-accent' : 'text-x-ink-secondary'
                            }`}
                          >
                            <LayoutGrid size={11} className="shrink-0" />
                            <span className="flex-1 truncate">{tpl.name}</span>
                            {isActive && <span className="text-[11px] text-x-accent">●</span>}
                          </button>
                        )
                      })}
                    </>
                  )}

                  <div className="border-t border-x-line-subtle mt-1">
                    <button
                      onClick={() => {
                        setShowLayoutMenu(false)
                        window.dispatchEvent(new CustomEvent('open-panel', { detail: 'grid-templates' }))
                      }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-x-accent hover:bg-x-hover transition-colors duration-[80ms]"
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
            className="ive-tabstrip hidden md:flex items-center px-1 shrink-0 text-x-ink-secondary hover:text-x-ink bg-x-surface-2 hover:bg-x-hover border-r border-x-line-subtle transition-colors duration-[80ms] z-10"
            title="Scroll tabs left"
          >
            <ChevronLeft size={14} />
          </button>
        )}

        {/* Scrollable tab area */}
        <div
          ref={scrollRef}
          className="ive-tabstrip flex-1 flex items-stretch overflow-x-auto min-w-0 tab-scroll-hide touch-manipulation"
          onScroll={updateScrollState}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
        >
        {visibleTabs.map((id, idx) => {
          const session = sessions[id]
          if (!session) return null
          const isActive = activeSessionId === id
          const isDragOver = dropIdx === idx && dragIdx !== idx
          const statusMeta = getSessionDisplayStatus(session, sessionStarted)
          return (
            <div
              key={id}
              data-chrome-button
              data-tab-id={id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActiveSession(id)
                  useStore.setState({ showHome: false })
                }
              }}
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
              onDoubleClick={() => requestSessionRename(id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtx({ x: e.clientX, y: e.clientY, session })
              }}
              style={sessionIdentityStyle(id)}
              className={`ive-session-identity ive-session-tab group relative flex items-center gap-2 px-4 py-3 shrink-0 cursor-grab active:cursor-grabbing whitespace-nowrap transition-colors duration-[80ms] ${
                isActive
                  ? 'bg-x-surface text-x-ink font-medium border-r border-x-line'
                  : 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
              } ${isDragOver ? 'bg-x-tint' : ''}`}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  planWaiting[id] || isSessionActive(id)
                    ? 'bg-x-accent-ink animate-subtle-pulse'
                      : compactionState[id]?.status === 'compacting' || compactionState[id]?.status === 'warning'
                        ? 'bg-x-accent-ink animate-pulse'
                        : statusMeta.dotClass
                }`}
                title={
                  planWaiting[id] ? 'Waiting for input'
                  : isSessionActive(id) ? 'Needs attention'
                  : compactionState[id]?.status === 'compacting' ? 'Compacting context'
                  : compactionState[id]?.status === 'warning' ? `${compactionState[id].percent_left}% context left`
                  : statusMeta.label
                }
              />
              {session.session_type === 'commander' && (
                <span className="text-[11px] text-x-accent-ink font-semibold">CMD</span>
              )}
              {(() => {
                try {
                  const mi = typeof session.memory_injected_info === 'string'
                    ? JSON.parse(session.memory_injected_info) : session.memory_injected_info
                  if (mi?.count > 0) return (
                    <span
                      className="text-x-accent/70"
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
                      <span key={tag} className="text-[11px] px-1 rounded bg-x-accent/15 text-x-accent border border-x-accent/20">
                        {tag}
                      </span>
                    ))}
                    {tags.length > 2 && <span className="text-[11px] text-x-muted">+{tags.length - 2}</span>}
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
                    className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${isWarn ? 'text-x-accent-ink' : 'text-x-ink-secondary'}`}
                    title={tip}
                  >
                    {label}
                  </span>
                )
              })()}
              <span className={`ive-session-title text-[13px] ${isActive ? 'font-medium' : ''}`}>{session.name}</span>
              <span className="text-x-faint font-mono text-[11px] max-w-[180px] truncate">{session.model}</span>
              {session.is_external ? <span className="text-x-accent/70 font-mono text-[11px]">ext</span> : null}
              {/* Multiplayer: peer presence dots */}
              {(() => {
                const viewing = Object.entries(peers).filter(([cid, p]) => p.viewing_session === id && cid !== myClientId)
                return viewing.length > 0 ? (
                  <div className="flex items-center -space-x-1">
                    {viewing.slice(0, 3).map(([cid, p]) => (
                      <span
                        key={cid}
                        className="w-3.5 h-3.5 rounded-full text-[7px] font-bold text-x-on-accent flex items-center justify-center ring-1 ring-x-bg"
                        style={{ background: p.color }}
                        title={p.name}
                      >
                        {p.name?.[0]?.toUpperCase() || '?'}
                      </span>
                    ))}
                    {viewing.length > 3 && (
                      <span className="text-[11px] text-x-faint ml-0.5">+{viewing.length - 3}</span>
                    )}
                  </div>
                ) : null
              })()}
              <SessionCloseButton sessionId={id} name={session.name} />

              {/* Right border separator for inactive tabs */}
              {!isActive && (
                <div className="absolute right-0 top-1/4 bottom-1/4 w-px bg-x-line-subtle" />
              )}
            </div>
          )
        })}
        </div>

        {/* Scroll right arrow */}
        {canScrollRight && (
          <button
            onClick={() => scrollBy(1)}
            className="ive-tabstrip hidden md:flex items-center px-1 shrink-0 text-x-ink-secondary hover:text-x-ink bg-x-surface-2 hover:bg-x-hover border-l border-x-line-subtle transition-colors duration-[80ms] z-10"
            title="Scroll tabs right"
          >
            <ChevronRight size={14} />
          </button>
        )}
        </>}
        {/* Always-visible ways in: search everything (⌘K) and quick help (?). */}
        <div className="ive-findbar" data-findbar>
          <button
            type="button"
            className="ive-findbar-search"
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
            title="Search tools, sessions and projects (⌘K)"
            aria-label="Search tools, sessions and projects"
            aria-keyshortcuts="Meta+K"
          >
            <Search size={14} aria-hidden="true" />
            <span className="ive-findbar-label">Search</span>
            <kbd aria-hidden="true">⌘K</kbd>
          </button>
          <button
            type="button"
            className="ive-findbar-help"
            onClick={() => window.dispatchEvent(new Event('open-cheat-sheet'))}
            title="Quick help and all keyboard shortcuts (?)"
            aria-label="Quick help and keyboard shortcuts"
            aria-keyshortcuts="?"
          >
            <Keyboard size={15} aria-hidden="true" />
          </button>
        </div>
        {onToggleSideChat && <button type="button" className="ive-sidechat-toggle" aria-label="Chat with Claude" title={`Chat with Claude: ask anything, no session needed${chatKey ? ` (${chatKey})` : ''}`} aria-expanded={sideChatOpen} aria-controls="ive-sidechat" onClick={onToggleSideChat}>
          <MessageCircle size={16} /><span className="ive-chat-long">Chat with Claude</span><span className="ive-chat-short">Chat</span>
        </button>}
      </div>

      <div className="ive-primary-nav-row lg:hidden shrink-0 border-b border-x-line bg-x-bg">
        <PrimaryNavigation activeGroup={currentGroup} onSelect={selectGroup} compact />
      </div>

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} session={ctx.session} onClose={() => setCtx(null)} />
      )}
    </>
  )
}
