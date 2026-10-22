// Which open sessions can be shown full size ("Session" level) right now.
// The overview grid shows the open tabs of the current scope, or, with a
// custom grid template active (desktop only), just the sessions assigned to
// its cells. App, the view switch and ⌘⇧E must agree on this list, otherwise
// a target outside it is focused and immediately dropped again.
export const MOBILE_QUERY = '(max-width: 767px)'

export function isMobileViewport() {
  try { return !!globalThis.matchMedia?.(MOBILE_QUERY).matches } catch { return false }
}

export function getFocusableSessionIds(state, { isMobile = false } = {}) {
  const { openTabs = [], sessions = {}, tabScope, activeWorkspaceId, activeGridTemplateId, gridTemplates = [] } = state
  const inScope = (id) => sessions[id] && (tabScope !== 'workspace' || !activeWorkspaceId || sessions[id].workspace_id === activeWorkspaceId)
  const templateId = isMobile ? null : activeGridTemplateId
  if (!templateId) return openTabs.filter(inScope)
  const template = gridTemplates.find((t) => t.id === templateId)
  const open = new Set(openTabs)
  return [...new Set(Object.values(template?.cell_assignments || {}))].filter((id) => open.has(id) && sessions[id] && inScope(id))
}

// The session the "Session" level opens: the active one if it can be shown,
// else the first one that can.
export function getSessionLevelTarget(state, opts) {
  const ids = getFocusableSessionIds(state, opts)
  return ids.includes(state.activeSessionId) ? state.activeSessionId : (ids[0] || null)
}
