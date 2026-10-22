// Grid-terminal focus helpers (extracted from App.jsx). A bare click inside a grid cell focuses
// its terminal, but not when the click lands on an interactive control.
export const GRID_FOCUS_IGNORE_SELECTOR =
  'input, textarea, select, button, a, [contenteditable="true"], [data-grid-focus-ignore="true"]'

export function shouldFocusGridTerminal(e) {
  return !e.target?.closest?.(GRID_FOCUS_IGNORE_SELECTOR)
}

// Where keyboard focus may sit when IVE hands it back to the selected
// session's terminal (after a modal closed, another session was selected or
// the level changed). Text fields, open dialogs and menus keep it; a stray
// button, a sidebar card or <body> do not, typing there reaches no session.
export const TERMINAL_FOCUS_KEEP_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-ive-popover]'

export function canRestoreTerminalFocus(active) {
  if (!active || active.isConnected === false || active === active.ownerDocument?.body) return true
  if (active.classList?.contains('xterm-helper-textarea')) return true
  // A field that is no longer rendered (the composer of the session just left,
  // now display:none) has lost the keyboard already.
  if (typeof active.getClientRects === 'function' && active.getClientRects().length === 0) return true
  return !active.closest?.(TERMINAL_FOCUS_KEEP_SELECTOR)
}
