import { useState, useEffect, useRef } from 'react'
import { Inbox as InboxIcon, MessageSquare, Check, Eye, X, Bell, Archive, RotateCcw, Sparkles, Server } from 'lucide-react'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function InboxPanel({ onClose }) {
  const sessions = useStore((s) => s.sessions)
  const openTabs = useStore((s) => s.openTabs)
  const backgroundResults = useStore((s) => s.backgroundResults)
  const removeBackgroundResult = useStore((s) => s.removeBackgroundResult)
  const dismissedInbox = useStore((s) => s.dismissedInbox)
  const dismissInboxItem = useStore((s) => s.dismissInboxItem)
  const dismissAllInboxItems = useStore((s) => s.dismissAllInboxItems)
  const undismissInboxItem = useStore((s) => s.undismissInboxItem)
  const [showDismissed, setShowDismissed] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const listRef = useRef(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  // Active inbox: exited sessions that haven't been dismissed
  const activeItems = Object.values(sessions)
    .filter((s) => s.status === 'exited' && !dismissedInbox[s.id])
    .sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''))

  // Dismissed archive: sessions that were dismissed AND are still exited
  // (sessions that started running again are auto-removed from dismissedInbox by the store)
  const dismissedItems = Object.values(sessions)
    .filter((s) => dismissedInbox[s.id] && s.status === 'exited')
    .sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''))

  const items = showDismissed ? dismissedItems : activeItems

  // Reset selection when switching between active/dismissed
  useEffect(() => { setSelectedIdx(-1) }, [showDismissed])

  useListKeyboardNav({
    itemCount: items.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const session = items[idx]
      if (session) handleOpen(session)
    },
    onDelete: (idx) => {
      const session = items[idx]
      if (!session) return
      if (showDismissed) handleUndismiss(session.id)
      else handleDismiss(session.id)
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const handleOpen = (session) => {
    const store = useStore.getState()
    if (session.workspace_id && session.workspace_id !== store.activeWorkspaceId) {
      store.setActiveWorkspace(session.workspace_id)
    }
    if (!openTabs.includes(session.id)) {
      store.openSession(session.id)
    } else {
      store.setActiveSession(session.id)
    }
    onClose()
  }

  const handleDismiss = (id) => {
    dismissInboxItem(id)
  }

  const handleDismissAll = () => {
    dismissAllInboxItems(activeItems.map((i) => i.id))
  }

  const handleUndismiss = (id) => {
    undismissInboxItem(id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[480px] ide-panel overflow-hidden scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          {showDismissed ? (
            <Archive size={14} className="text-text-faint" />
          ) : (
            <InboxIcon size={14} className="text-amber-400" />
          )}
          <span className="text-xs text-text-primary font-medium">
            {showDismissed ? 'Dismissed' : 'Inbox'}
          </span>
          <span className="text-[10px] text-text-faint">
            {showDismissed
              ? `${dismissedItems.length} dismissed`
              : `${activeItems.length + backgroundResults.length} item${(activeItems.length + backgroundResults.length) !== 1 ? 's' : ''}`}
          </span>
          <div className="flex-1" />
          {!showDismissed && activeItems.length > 0 && (
            <button
              onClick={handleDismissAll}
              className="flex items-center gap-1 text-[10px] text-text-faint hover:text-text-secondary transition-colors"
            >
              <Check size={10} />
              dismiss all
            </button>
          )}
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className={`flex items-center gap-1 text-[10px] transition-colors ${
              showDismissed
                ? 'text-text-secondary'
                : 'text-text-faint hover:text-text-secondary'
            }`}
            title={showDismissed ? 'Back to inbox' : 'Show dismissed'}
          >
            {showDismissed ? (
              <>
                <InboxIcon size={10} />
                inbox{activeItems.length > 0 ? ` (${activeItems.length})` : ''}
              </>
            ) : (
              <>
                <Archive size={10} />
                dismissed{dismissedItems.length > 0 ? ` (${dismissedItems.length})` : ''}
              </>
            )}
          </button>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {items.map((session, idx) => (
            <div
              key={session.id}
              data-idx={idx}
              onClick={() => setSelectedIdx(idx)}
              className={`flex items-center gap-2.5 px-4 py-3 border-b border-border-secondary transition-colors cursor-pointer ${
                selectedIdx === idx
                  ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
                  : 'hover:bg-bg-hover/50'
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                showDismissed ? 'bg-white/5' : 'bg-amber-500/10'
              }`}>
                {showDismissed ? (
                  <Archive size={14} className="text-text-faint" />
                ) : (
                  <Bell size={14} className="text-amber-400" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-primary font-mono truncate">{session.name}</div>
                <div className="text-[10px] text-text-faint font-mono mt-0.5">
                  {session.model} · {session.turn_count || 0} turns
                  {Number(session.total_cost_usd) > 0 && ` · $${Number(session.total_cost_usd).toFixed(4)}`}
                </div>
              </div>

              <button
                onClick={() => handleOpen(session)}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded-md transition-colors"
              >
                <Eye size={10} />
                review
              </button>

              {showDismissed ? (
                <button
                  onClick={() => handleUndismiss(session.id)}
                  className="flex items-center gap-1 px-1.5 py-1 text-text-faint hover:text-amber-400 hover:bg-bg-hover rounded-md transition-colors"
                  title="Move back to inbox"
                >
                  <RotateCcw size={10} />
                </button>
              ) : (
                <button
                  onClick={() => handleDismiss(session.id)}
                  className="flex items-center gap-1 px-1.5 py-1 text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                >
                  <Check size={10} />
                </button>
              )}
            </div>
          ))}

          {/* Background job results (distill, mcp parse) */}
          {!showDismissed && backgroundResults.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1.5">
                <span className="text-[10px] text-text-faint uppercase tracking-widest font-semibold">Background Jobs</span>
              </div>
              {backgroundResults.map((job) => {
                const isDistill = job.jobType === 'distill'
                const isMcp = job.jobType === 'mcp_parse'
                const label = isDistill
                  ? `${job.result?.name || job.artifactType || 'Artifact'}`
                  : isMcp
                    ? `${job.result?.name || 'MCP Server'}`
                    : 'Background job'
                const subtitle = isDistill
                  ? `Distilled ${job.artifactType} from ${job.sessionName || 'session'}`
                  : isMcp
                    ? `Parsed MCP server config`
                    : ''

                const handleOpen = () => {
                  if (isDistill) {
                    window.dispatchEvent(new CustomEvent('open-distill-result', {
                      detail: { result: job.result, artifactType: job.artifactType },
                    }))
                  } else if (isMcp) {
                    window.dispatchEvent(new CustomEvent('open-mcp-parse-result', {
                      detail: { result: job.result },
                    }))
                  }
                  onClose()
                }

                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-2.5 px-4 py-3 border-b border-border-secondary hover:bg-bg-hover/50 transition-colors cursor-pointer"
                    onClick={handleOpen}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isDistill ? 'bg-indigo-500/10' : 'bg-emerald-500/10'
                    }`}>
                      {isDistill ? (
                        <Sparkles size={14} className="text-indigo-400" />
                      ) : (
                        <Server size={14} className="text-emerald-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-text-primary font-mono truncate">{label}</div>
                      <div className="text-[10px] text-text-faint font-mono mt-0.5">{subtitle}</div>
                    </div>

                    <button
                      onClick={(e) => { e.stopPropagation(); handleOpen() }}
                      className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                        isDistill
                          ? 'bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400'
                          : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400'
                      }`}
                    >
                      <Eye size={10} />
                      open
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); removeBackgroundResult(job.id) }}
                      className="flex items-center gap-1 px-1.5 py-1 text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </div>
                )
              })}
            </>
          )}

          {items.length === 0 && (!backgroundResults.length || showDismissed) && (
            <div className="px-4 py-12 text-center">
              {showDismissed ? (
                <>
                  <Archive size={24} className="text-border-primary mx-auto mb-2" />
                  <p className="text-xs text-text-faint">No dismissed sessions</p>
                  <p className="text-[10px] text-text-faint/60 mt-1">
                    dismissed inbox items appear here
                  </p>
                </>
              ) : (
                <>
                  <InboxIcon size={24} className="text-border-primary mx-auto mb-2" />
                  <p className="text-xs text-text-faint">All clear</p>
                  <p className="text-[10px] text-text-faint/60 mt-1">
                    sessions that finish or need attention appear here
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
