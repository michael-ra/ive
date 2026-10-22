import { useState, useEffect } from 'react'
import { Inbox } from 'lucide-react'
import useStore from '../../state/store'

/**
 * Yellow "mailbox" badge showing how many sessions need attention.
 * Left click  → jump to most recent attention-needing session
 * Right click → drop a popover listing all of them
 *
 * Used in both the Sidebar header and the StatusBar.
 *
 * Props:
 *   position: 'below' (default) | 'above'  — popover anchor direction
 *   workspaceId: optional — filter to sessions in this workspace only
 *   compact: optional — smaller badge for inline workspace use
 */
export default function MailboxPill({
  position = 'below',
  align = 'right',
  workspaceId = null,
  compact = false,
  className = 'relative',
  menuClass = null,
}) {
  const sessions = useStore((s) => s.sessions)
  const planWaiting = useStore((s) => s.planWaiting)
  const dismissedInbox = useStore((s) => s.dismissedInbox)
  const openTabs = useStore((s) => s.openTabs)
  const [showMenu, setShowMenu] = useState(false)

  const items = Object.values(sessions)
    .filter((s) => {
      if (workspaceId && s.workspace_id !== workspaceId) return false
      // A closed plain terminal is not an agent waiting for review.
      if (s.cli_type === 'shell') return false
      return (s.status === 'exited' && !dismissedInbox[s.id]) || planWaiting[s.id]
    })
    .sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''))

  useEffect(() => {
    if (!showMenu) return
    const handler = (e) => {
      if (
        !e.target.closest('[data-mailbox-pill-menu]') &&
        !e.target.closest('[data-mailbox-pill-trigger]')
      ) {
        setShowMenu(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [showMenu])

  if (items.length === 0) return null

  const openSession = (s) => {
    if (!s) return
    useStore.getState().setActiveWorkspace(s.workspace_id)
    if (!openTabs.includes(s.id)) {
      useStore.getState().openSession(s.id)
    } else {
      useStore.getState().setActiveSession(s.id)
    }
    setShowMenu(false)
  }

  const resolvedMenuClass = menuClass || `absolute ${align === 'right' ? 'right-0' : 'left-0'} ${position === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'}`

  return (
    <div className={className}>
      <span
        role="button"
        tabIndex={0}
        data-mailbox-pill-trigger
        onClick={() => openSession(items[0])}
        onContextMenu={(e) => {
          e.preventDefault()
          setShowMenu((v) => !v)
        }}
        className={`inline-flex items-center gap-1 font-medium tabular-nums bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink rounded-full transition-colors duration-[80ms] cursor-pointer text-[11px] ${
          compact ? 'px-1 py-0' : 'px-1.5 py-0.5'
        }`}
        title={`${items.length} session${items.length === 1 ? '' : 's'} need attention — click: jump to most recent · right-click: list all`}
      >
        <Inbox size={compact ? 8 : 9} />
        {items.length}
      </span>
      {showMenu && (
        <div
          data-mailbox-pill-menu
          className={`${resolvedMenuClass} x-panel py-1 min-w-[220px] max-w-[280px] max-h-[60vh] overflow-y-auto z-50 scale-in`}
        >
          <div className="px-2.5 py-1 text-[11px] text-x-muted font-medium uppercase tracking-[0.06em] border-b border-x-line-subtle">
            Mailbox · {items.length}
          </div>
          {items.map((s) => {
            const waiting = planWaiting[s.id]
            return (
              <button
                key={s.id}
                onClick={() => openSession(s)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-x-hover transition-colors duration-[80ms]"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    waiting ? 'bg-x-accent-ink animate-subtle-pulse' : 'bg-x-accent-ink'
                  }`}
                />
                <span className="truncate flex-1 text-x-ink-secondary">{s.name}</span>
                <span className="text-[11px] text-x-muted shrink-0">
                  {waiting ? 'input' : 'done'}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
