/** Map of session_id → xterm.write function. Used to route PTY output to the right terminal. */
export const terminalWriters = new Map()

/**
 * Map of session_id → control handle for the mounted terminal.
 * Each handle exposes imperative methods (e.g. `jumpToMessage`) so global
 * keyboard handlers in `useKeyboard.js` can drive the active terminal without
 * importing React or reaching into refs.
 */
export const terminalControls = new Map()

/** Track which sessions have started PTYs — persists across React remounts */
export const startedSessions = new Set()
