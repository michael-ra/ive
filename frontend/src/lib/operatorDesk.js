import { isHelperSession } from './visibleSessions.js'

export const OPERATOR_DESK_STORAGE_KEY = 'ive.operator-desk'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

// Toasts auto-dismiss after 30 s, but the timer restarts on every mount, so a
// persisted "… finished working" came back after each reload. On restore keep
// only toasts that stay until handled (auth_failed) and recent ones that still
// matter; "finished" news from a previous page is over.
const TOAST_TTL_MS = 30000
const STAY_UNTIL_HANDLED = new Set(['auth_failed'])
const NEWS_ONLY = new Set(['session_done', 'success', 'info'])

export function restorableNotifications(list, now = Date.now()) {
  if (!Array.isArray(list)) return []
  return list.filter((n) => {
    if (!n || typeof n !== 'object') return false
    if (STAY_UNTIL_HANDLED.has(n.type)) return true
    if (NEWS_ONLY.has(n.type)) return false
    const at = Number(n.timestamp)
    return Number.isFinite(at) && now - at < TOAST_TTL_MS
  })
}

export function readOperatorDesk(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(OPERATOR_DESK_STORAGE_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const desk = {}
    for (const key of ['activeWorkspaceId', 'activeSessionId']) {
      if (parsed[key] === null || typeof parsed[key] === 'string') desk[key] = parsed[key]
    }
    if (Array.isArray(parsed.openTabs)) {
      desk.openTabs = [...new Set(parsed.openTabs.filter((id) => typeof id === 'string'))]
    }
    if (Array.isArray(parsed.notifications)) desk.notifications = restorableNotifications(parsed.notifications)
    if (hasOwn(parsed, 'planWaiting')) desk.planWaiting = parsed.planWaiting
    if (typeof parsed.showHome === 'boolean') desk.showHome = parsed.showHome
    // A reload lands on the same level (session, board or home); resync
    // drops the focus again if the active session is gone.
    if (typeof parsed.sessionFocus === 'boolean') desk.sessionFocus = parsed.sessionFocus
    if (typeof parsed.activeNavGroup === 'string') desk.activeNavGroup = parsed.activeNavGroup
    return desk
  } catch {
    return null
  }
}

export function restoreOperatorDesk(store, storage) {
  const desk = readOperatorDesk(storage)
  if (desk) store.setState(desk)
  return desk
}

export function persistOperatorDesk(state, storage) {
  const desk = {
    activeWorkspaceId: state.activeWorkspaceId,
    activeSessionId: state.activeSessionId,
    openTabs: state.openTabs,
    notifications: state.notifications,
    planWaiting: state.planWaiting,
    showHome: state.showHome,
    sessionFocus: !!state.sessionFocus,
    activeNavGroup: state.activeNavGroup,
  }
  try {
    storage.setItem(OPERATOR_DESK_STORAGE_KEY, JSON.stringify(desk))
  } catch {
    // Storage can be unavailable in privacy mode; the live store remains authoritative.
  }
  return desk
}

export function operatorDeskChanged(state, previous) {
  return state.activeWorkspaceId !== previous.activeWorkspaceId
    || state.activeSessionId !== previous.activeSessionId
    || state.openTabs !== previous.openTabs
    || state.notifications !== previous.notifications
    || state.planWaiting !== previous.planWaiting
    || state.showHome !== previous.showHome
    || state.sessionFocus !== previous.sessionFocus
    || state.activeNavGroup !== previous.activeNavGroup
}

export function notificationSessionId(notification) {
  return notification?.sessionId || notification?.session_id || null
}

export function notificationSessionReady(notification, sessions) {
  // Keep the persisted notice while data loads, but do not fetch recovery for
  // an unknown session. Full-snapshot reconciliation decides if it is stale.
  return notification?.type !== 'auth_failed' || !!sessions?.[notificationSessionId(notification)]
}

// Only call this with an authoritative full-session snapshot (or an explicit
// deletion). A workspace list is partial and cannot prove a saved tab is gone.
export function reconcileSessionReferences(state, isAvailable) {
  const openTabs = [...new Set(state.openTabs || [])].filter(isAvailable)
  const activeSessionId = isAvailable(state.activeSessionId)
    ? state.activeSessionId : openTabs[0] || null
  return {
    openTabs,
    activeSessionId,
    sessionFocus: !!state.sessionFocus && isAvailable(state.activeSessionId),
    terminalFocusRequest: state.terminalFocusRequest && isAvailable(state.terminalFocusRequest.id)
      ? state.terminalFocusRequest : null,
    planWaiting: Object.fromEntries(Object.entries(state.planWaiting || {}).filter(([id]) => isAvailable(id))),
    notifications: (state.notifications || []).filter((notice) => {
      const id = notificationSessionId(notice)
      return !id || isAvailable(id)
    }),
    gridTemplates: reconcileGridAssignments(state.gridTemplates, isAvailable),
  }
}

export function reconcileGridAssignments(templates, isAvailable) {
  return (templates || []).map((template) => {
    const assignments = template.cell_assignments || {}
    const entries = Object.entries(assignments).filter(([, id]) => !id || isAvailable(id))
    return entries.length === Object.keys(assignments).length ? template
      : { ...template, cell_assignments: Object.fromEntries(entries) }
  })
}

// A fresh browser (new profile, cleared site data) has no stored tabs, so
// the Board stayed empty while sessions were running. Open those instead:
// sessions with a live PTY, without IVE's own helper sessions.
export function runningSessionTabs(sessions) {
  return Object.values(sessions || {})
    .filter((s) => s?.id && s.pty_alive && !s.archived && !s.read_only && !isHelperSession(s))
    .sort((a, b) => String(b.last_active_at || '').localeCompare(String(a.last_active_at || '')))
    .map((s) => s.id)
}
