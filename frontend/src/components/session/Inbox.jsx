import { useState, useEffect, useRef } from 'react'
import { visibleSessions } from '../../lib/visibleSessions'
import { Inbox as InboxIcon, Check, Eye, X, Bell, Archive, RotateCcw, Sparkles, Server } from 'lucide-react'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import { Button } from '../ui'

function compactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

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
  const activeItems = visibleSessions(sessions)
    .filter((s) => s.status === 'exited' && !dismissedInbox[s.id] && s.cli_type !== 'shell')
    .sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''))

  // Dismissed archive: sessions that were dismissed AND are still exited
  // (sessions that started running again are auto-removed from dismissedInbox by the store)
  const dismissedItems = visibleSessions(sessions)
    .filter((s) => dismissedInbox[s.id] && s.status === 'exited' && s.cli_type !== 'shell')
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[480px] x-panel shadow-x-3 overflow-hidden scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          {showDismissed ? (
            <Archive size={14} className="text-x-faint" />
          ) : (
            <InboxIcon size={14} className="text-x-accent-ink" />
          )}
          <span className="text-xs text-x-ink font-medium">
            {showDismissed ? 'Dismissed' : 'Inbox'}
          </span>
          <span className="text-[11px] text-x-muted">
            {showDismissed
              ? `${dismissedItems.length} dismissed`
              : `${activeItems.length + backgroundResults.length} item${(activeItems.length + backgroundResults.length) !== 1 ? 's' : ''}`}
          </span>
          <div className="flex-1" />
          {!showDismissed && activeItems.length > 0 && (
            <button
              onClick={handleDismissAll}
              className="flex items-center gap-1 text-[11px] text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
            >
              <Check size={10} />
              dismiss all
            </button>
          )}
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className={`flex items-center gap-1 text-[11px] transition-colors duration-[80ms] ${
              showDismissed
                ? 'text-x-ink-secondary'
                : 'text-x-muted hover:text-x-ink-secondary'
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
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]">
            <X size={15} />
          </Button>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {items.map((session, idx) => (
            <div
              key={session.id}
              data-idx={idx}
              onClick={() => setSelectedIdx(idx)}
              className={`flex items-center gap-2.5 px-4 py-3 border-b border-x-line-subtle transition-colors cursor-pointer ${
                selectedIdx === idx
                  ? 'bg-x-accent-subtle ring-1 ring-inset ring-x-accent/40'
                  : 'hover:bg-x-hover/50'
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                showDismissed ? 'bg-x-hover' : 'bg-x-accent-ink/10'
              }`}>
                {showDismissed ? (
                  <Archive size={14} className="text-x-faint" />
                ) : (
                  <Bell size={14} className="text-x-accent-ink" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-xs text-x-ink truncate">{session.name}</div>
                <div className="text-[11px] text-x-muted mt-0.5">
                  {session.model} · {session.turn_count || 0} turns
                  {Number(session.token_count) > 0 && ` · ${session.token_count_estimated ? '~' : ''}${compactNumber(session.token_count)} tok`}
                </div>
              </div>

              <Button type="submit"
                onClick={() => handleOpen(session)}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms]"
              >
                <Eye size={10} />
                review
              </Button>

              {showDismissed ? (
                <Button type="submit"
                  onClick={() => handleUndismiss(session.id)}
                  className="flex items-center gap-1 px-1.5 py-1 text-x-faint hover:text-x-accent-ink hover:bg-x-hover transition-colors duration-[80ms]"
                  title="Move back to inbox"
                >
                  <RotateCcw size={10} />
                </Button>
              ) : (
                <Button type="submit"
                  onClick={() => handleDismiss(session.id)}
                  className="flex items-center gap-1 px-1.5 py-1 text-x-faint hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms]"
                >
                  <Check size={10} />
                </Button>
              )}
            </div>
          ))}

          {/* Background job results (distill, mcp parse) */}
          {!showDismissed && backgroundResults.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1.5">
                <span className="text-[11px] text-x-muted uppercase tracking-wider font-medium">Background Jobs</span>
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
                    className="flex items-center gap-2.5 px-4 py-3 border-b border-x-line-subtle hover:bg-x-hover transition-colors duration-[80ms] cursor-pointer"
                    onClick={handleOpen}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isDistill ? 'bg-x-accent/10' : 'bg-x-good/10'
                    }`}>
                      {isDistill ? (
                        <Sparkles size={14} className="text-x-accent" />
                      ) : (
                        <Server size={14} className="text-x-good" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-x-ink truncate">{label}</div>
                      <div className="text-[11px] text-x-muted mt-0.5">{subtitle}</div>
                    </div>

                    <Button type="submit"
                      onClick={(e) => { e.stopPropagation(); handleOpen() }}
                      className={`flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors duration-[80ms] ${
                        isDistill
                          ? 'bg-x-accent/10 hover:bg-x-accent/20 text-x-accent'
                          : 'bg-x-good/10 hover:bg-x-good/20 text-x-good'
                      }`}
                    >
                      <Eye size={10} />
                      open
                    </Button>

                    <Button type="submit"
                      onClick={(e) => { e.stopPropagation(); removeBackgroundResult(job.id) }}
                      className="flex items-center gap-1 px-1.5 py-1 text-x-faint hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms]"
                    >
                      <X size={10} />
                    </Button>
                  </div>
                )
              })}
            </>
          )}

          {items.length === 0 && (!backgroundResults.length || showDismissed) && (
            <div className="px-4 py-12 text-center">
              {showDismissed ? (
                <>
                  <Archive size={24} className="text-x-line mx-auto mb-2" />
                  <p className="text-xs text-x-ink-secondary">No dismissed sessions</p>
                  <p className="text-[11px] text-x-faint mt-1">
                    dismissed inbox items appear here
                  </p>
                </>
              ) : (
                <>
                  <InboxIcon size={24} className="text-x-line mx-auto mb-2" />
                  <p className="text-xs text-x-ink-secondary">All clear</p>
                  <p className="text-[11px] text-x-faint mt-1">
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
