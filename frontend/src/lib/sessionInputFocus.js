// Where the keyboard goes when a session is started or opened.
//
// App.jsx asks for it with the `cc-focus-terminal` window event (Home-Enter,
// quick start, sidebar card, tab shortcut, a modal closing). Like Claude Code,
// Codex and Cursor, the cursor then sits in the input the user sees:
//
//   terminal view (or the open terminal drawer)  -> the xterm
//   chat view                                    -> the chat composer
//
// A terminal that is mounted but not on screen (closed drawer, hidden grid
// cell, phone chat view) never takes the focus: typing would go into an
// invisible PTY. On touch-only devices a programmatic focus can pop the soft
// keyboard, so the composer only takes it when the user was just typing
// (Home-Enter, quick start: the keyboard is up anyway); opening a session
// from the list leaves the keyboard closed until the user taps the field.

export const MIN_SHOWN_PX = 20
export const TYPING_GRACE_MS = 3000

/** Laid out with a usable size (not display:none, not a 0px drawer or a 1px hidden cell). */
export function isShown(el) {
  if (!el || el.isConnected === false) return false
  return el.clientWidth >= MIN_SHOWN_PX && el.clientHeight >= MIN_SHOWN_PX
}

const escapeAttr = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'))

/** Is a terminal of this session on screen? Terminal.jsx marks its scroll wrapper. */
export function terminalShownFor(sessionId, root = globalThis.document) {
  if (!sessionId || !root?.querySelectorAll) return false
  return [...root.querySelectorAll(`[data-terminal-session="${escapeAttr(sessionId)}"]`)].some(isShown)
}

/** Touch-only device: no hover and a coarse pointer (phones, tablets without a trackpad). */
export function isTouchOnly(win = globalThis.window) {
  try { return !!win?.matchMedia?.('(hover: none) and (pointer: coarse)').matches } catch { return false }
}

let lastTypedAt = 0
let tracking = false
/** Remember the last keystroke; on touch devices it means the soft keyboard is up. */
export function trackTyping(doc = globalThis.document) {
  if (tracking || !doc?.addEventListener) return
  tracking = true
  doc.addEventListener('keydown', () => { lastTypedAt = Date.now() }, true)
}
export function noteTyping(at = Date.now()) { lastTypedAt = at }
export function msSinceTyping(now = Date.now()) { return lastTypedAt ? now - lastTypedAt : Infinity }

/** Pure rule: may the chat composer take the focus on its own? */
export function mayAutoFocusComposer({ touchOnly = false, sinceTypingMs = Infinity } = {}) {
  return !touchOnly || sinceTypingMs < TYPING_GRACE_MS
}

/**
 * Put the cursor into a session's chat composer if that is where it belongs:
 * the session is the active one, its composer is on screen and usable, no
 * terminal of it is on screen, and (touch) the user was just typing.
 * Returns true when it focused.
 */
export function focusChatComposerFor({ sessionId, activeSessionId, textarea, doc = globalThis.document, win = globalThis.window }) {
  if (!sessionId || sessionId !== activeSessionId) return false
  if (!textarea || textarea.disabled || !isShown(textarea)) return false
  if (terminalShownFor(sessionId, doc)) return false
  if (!mayAutoFocusComposer({ touchOnly: isTouchOnly(win), sinceTypingMs: msSinceTyping() })) return false
  if (doc?.activeElement === textarea) return true
  textarea.focus({ preventScroll: true })
  return doc?.activeElement === textarea
}

// Track from app start: the keystrokes that matter happen on Home, before any
// chat panel exists.
if (typeof document !== 'undefined') trackTyping()
