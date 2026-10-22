import { Home, LayoutGrid, SquareTerminal } from 'lucide-react'
import useStore from '../../state/store'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus } from '../../lib/sessionStatus'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { formatKeyCombo } from '../../lib/keybindings'
import { getSessionLevelTarget, MOBILE_QUERY } from '../../lib/focusableSessions'
import useMediaQuery from '../../hooks/useMediaQuery'

// The one place that answers "where am I?". IVE has three levels and this
// switch is always visible in the app bar, in the same order:
//   Home      start tasks, see projects and your tasks
//   Overview  every open session side by side, what needs you
//   Session   one session full size: its terminal and its context
export function useViewLevel() {
  const showHome = useStore((s) => s.showHome)
  const openCount = useStore((s) => s.openTabs.length)
  const sessionFocus = useStore((s) => s.sessionFocus)
  if (showHome || openCount === 0) return 'home'
  return sessionFocus ? 'session' : 'overview'
}

export default function ViewSwitch() {
  const level = useViewLevel()
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const tabScope = useStore((s) => s.tabScope)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const keybindings = useStore((s) => s.keybindings)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const visible = tabScope === 'workspace' && activeWorkspaceId
    ? openTabs.filter((id) => sessions[id]?.workspace_id === activeWorkspaceId)
    : openTabs
  const needsYou = visible.filter((id) => sessions[id] && sessionNeedsAttention(sessions[id])).length
  const hasSessions = visible.length > 0
  // Same list App uses to decide what may be shown full size, so the
  // Session button never targets a session App immediately un-focuses.
  const sessionTarget = getSessionLevelTarget({ openTabs, sessions, tabScope, activeWorkspaceId, activeGridTemplateId, gridTemplates, activeSessionId }, { isMobile })
  const current = sessions[sessionTarget]
  const currentStatus = current ? getSessionDisplayStatus(current, sessionStarted) : null
  const sessionName = current?.name || 'Session'
  const key = (id) => (keybindings?.[id] ? ` (${formatKeyCombo(keybindings[id])})` : '')
  const store = useStore.getState

  return (
    <nav className="ive-view-switch" aria-label="Where you are">
      <button
        type="button"
        data-chrome-button
        aria-current={level === 'home' ? 'page' : undefined}
        onClick={() => store().goHome()}
        title={`Home: start tasks, projects and your tasks${key('goHome')}`}
      >
        <Home size={15} aria-hidden="true" />
        <span className="ive-view-switch-label">Home</span>
      </button>
      <span className="ive-view-switch-sep" aria-hidden="true">›</span>
      <button
        type="button"
        data-chrome-button
        aria-current={level === 'overview' ? 'page' : undefined}
        disabled={!hasSessions}
        onClick={() => store().goOverview()}
        title={hasSessions ? `Overview: all open sessions side by side${key('toggleSessionLevel')}` : 'Overview: open or start a session first'}
      >
        <LayoutGrid size={15} aria-hidden="true" />
        <span className="ive-view-switch-label">Overview</span>
        {hasSessions && <span className="ive-view-switch-count" aria-label={`${visible.length} open sessions`}>{visible.length}</span>}
        {needsYou > 0 && <span className="ive-view-switch-alert" aria-label={`${needsYou} need you`}>{needsYou}</span>}
      </button>
      <span className="ive-view-switch-sep" aria-hidden="true">›</span>
      <button
        type="button"
        data-chrome-button
        aria-current={level === 'session' ? 'page' : undefined}
        disabled={!sessionTarget}
        onClick={() => store().goSession(sessionTarget)}
        title={sessionTarget ? `Session: ${sessionName} full size${key('toggleSessionLevel')}` : 'Session: open or start a session first'}
      >
        <SquareTerminal size={15} aria-hidden="true" />
        <span className="ive-view-switch-session">{sessionName}</span>
        {currentStatus && <span className={`h-2 w-2 rounded-full shrink-0 ${currentStatus.dotClass}`} title={currentStatus.label} aria-label={currentStatus.label} />}
      </button>
    </nav>
  )
}
