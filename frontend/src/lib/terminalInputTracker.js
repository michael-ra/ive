import useStore from '../state/store'

/**
 * Best-effort tracker for what the user has typed into the live xterm
 * input. We can't see Claude's Ink input field directly (it lives in
 * the PTY) so we sniff `term.onData` keystrokes and apply simple rules
 * to maintain a parallel buffer client-side. The buffer powers the
 * floating "@token detected" badge over each terminal.
 *
 * Tracking is intentionally conservative: anything we can't model
 * confidently (cursor moves, function keys, OS-specific escape
 * sequences) resets the buffer to empty rather than letting it drift.
 * Worst case the badge disappears for a moment until the user types
 * the next char — much better than confidently showing stale info.
 */

const MAX_BUFFER = 10000 // hard cap so a giant paste can't bloat memory

/**
 * Apply a single chunk of input data to the current buffer and return
 * the new buffer text. Pure function — easy to unit test.
 */
export function applyInput(prev, data) {
  if (!data) return prev

  // ── Multi-char chunks (paste, IME, function keys) ──────────────
  if (data.length > 1) {
    // CSI / DCS / OSC sequences (\x1b[, \x1b], etc.) — likely arrow
    // keys, function keys, mouse reports. We can't reason about
    // cursor moves so play it safe and reset.
    if (data.charCodeAt(0) === 0x1b) return ''
    // Otherwise treat as a paste — strip control bytes and append.
    let cleaned = ''
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      const code = ch.charCodeAt(0)
      if (code === 0x0d || code === 0x0a) {
        // Mid-paste newline = effectively a submit; clear the buffer.
        cleaned = ''
      } else if (code >= 0x20 && code !== 0x7f) {
        cleaned += ch
      }
    }
    const next = (prev + cleaned)
    return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next
  }

  // ── Single-byte input ──────────────────────────────────────────
  const code = data.charCodeAt(0)

  // Enter / line submission → buffer is gone
  if (code === 0x0d || code === 0x0a) return ''

  // Escape (alone) — Claude's Ink input clears on Escape
  if (code === 0x1b) return ''

  // Ctrl+C / Ctrl+U / Ctrl+W / Ctrl+G — clear input
  if (code === 0x03 || code === 0x15 || code === 0x17 || code === 0x07) return ''

  // Backspace (DEL or BS)
  if (code === 0x7f || code === 0x08) return prev.slice(0, -1)

  // Other control bytes we don't recognize → reset (better than drift)
  if (code < 0x20) return ''

  // Printable → append
  const next = prev + data
  return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next
}

/**
 * Push one input chunk for `sessionId` through the tracker and update
 * the store if the buffer changed.
 */
export function trackTerminalInput(sessionId, data) {
  if (!sessionId) return
  const store = useStore.getState()
  const prev = store.inputBuffers[sessionId] || ''
  const next = applyInput(prev, data)
  if (next !== prev) store.setInputBuffer(sessionId, next)
}
