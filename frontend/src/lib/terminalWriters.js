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

/**
 * Sessions whose start_pty is scheduled but not sent yet (the store waits for
 * layout so the PTY starts at the visible size). Resizes are held back until
 * then, otherwise the backend answers "Session not running".
 */
export const pendingPtyStarts = new Set()

/**
 * session_id → Date.now() of the last PTY output frame. Lets a first message
 * wait until a freshly started TUI has drawn its prompt and gone quiet.
 */
export const lastOutputAt = new Map()
