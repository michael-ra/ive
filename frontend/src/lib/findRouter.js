// Routes ⌘F / Ctrl+F to the right search.
//
// Every mounted chat transcript and terminal registers a find target. On ⌘F:
//   1. the target that holds keyboard focus wins (typing in the terminal →
//      terminal search, in the chat composer or transcript → chat search);
//   2. otherwise the visible chat of the active session, then its terminal;
//   3. no session on screen (Home, nothing open), or the focus sits in a text
//      field or dialog outside the sessions → false, and the caller opens the
//      search across all sessions instead.
// Only one find bar is open at a time: opening one closes the others.

const targets = new Set()
const OUTSIDE_FIELD = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [aria-modal="true"]'

/**
 * target: { sessionId, kind: 'chat' | 'terminal', getRoot: () => Element,
 *           open: () => void, close: () => void, isOpen: () => boolean }
 * Returns an unregister function.
 */
export function registerFindTarget(target) {
  targets.add(target)
  return () => targets.delete(target)
}

export function isElementShown(el) {
  if (!el || el.isConnected === false) return false
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
  const rect = el.getBoundingClientRect?.()
  return !rect || (rect.width > 8 && rect.height > 8)
}

/** Pick the target ⌘F should open, or null. Exported for tests. */
export function pickFindTarget({ active = globalThis.document?.activeElement, activeSessionId = null, showHome = false, list = [...targets] } = {}) {
  const shown = list.filter((t) => isElementShown(t.getRoot?.()))
  const focused = active && active !== active.ownerDocument?.body
    ? shown.find((t) => t.getRoot()?.contains(active))
    : null
  if (focused) return focused
  if (showHome || !activeSessionId) return null
  // Typing in a field outside the sessions (a dialog, the sidebar filter,
  // the global search itself): ⌘F means the search across all sessions.
  if (active?.closest?.(OUTSIDE_FIELD)) return null
  return shown.find((t) => t.sessionId === activeSessionId && t.kind === 'chat')
    || shown.find((t) => t.sessionId === activeSessionId && t.kind === 'terminal')
    || null
}

/**
 * Open the in-session search for what is on screen. Returns true when a
 * session search opened, false when the caller should fall back to the
 * search across all sessions.
 */
export function openFindInSession(state = {}) {
  const target = pickFindTarget(state)
  if (!target) return false
  for (const t of targets) if (t !== target && t.isOpen?.()) t.close?.()
  target.open()
  return true
}

/** Close every open find bar (session switch, level change). */
export function closeAllFindBars(exceptSessionId = null) {
  for (const t of targets) if (t.sessionId !== exceptSessionId && t.isOpen?.()) t.close?.()
}
