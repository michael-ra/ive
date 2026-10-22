// Phone terminal keys: the bytes the key bar above the iOS keyboard sends,
// the sticky ⌃ modifier (the next typed key goes out as a control byte) and
// the remembered phone font size. Pure helpers, unit-tested in
// tests/phone-keys-unit.mjs.

// Named keys of the key bar. Arrows depend on the terminal's cursor key mode
// (DECCKM): normal mode sends CSI, application mode (vim, less) sends SS3.
export function keyBytes(name, { appCursor = false } = {}) {
  const arrow = { up: 'A', down: 'B', right: 'C', left: 'D' }[name]
  if (arrow) return `${appCursor ? '\x1bO' : '\x1b['}${arrow}`
  switch (name) {
    case 'esc': return '\x1b'
    case 'tab': return '\t'
    case 'shift-tab': return '\x1b[Z'
    case 'ctrl-c': return '\x03'
    case 'ctrl-d': return '\x04'
    case 'ctrl-r': return '\x12'
    case 'slash': return '/'
    case 'pipe': return '|'
    case 'tilde': return '~'
    default: return ''
  }
}

// One typed character with Ctrl held, as a terminal sends it.
// Returns null when the key has no control form (it is then sent unchanged).
export function ctrlByte(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null
  const code = ch.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64) // @ A-Z [ \ ] ^ _
  if (ch === ' ' || ch === '2') return '\x00'
  if (ch === '/' || ch === '-' || ch === '7') return '\x1f'
  if (ch === '?' || ch === '8') return '\x7f'
  if (ch === '3') return '\x1b'
  if (ch === '4') return '\x1c'
  if (ch === '5') return '\x1d'
  if (ch === '6') return '\x1e'
  return null
}

// ── Sticky ⌃ per session ────────────────────────────────────────────────
const armed = new Set()
const listeners = new Set()
const notify = () => { for (const fn of listeners) { try { fn() } catch { /* listener gone */ } } }

export function isCtrlArmed(sessionId) { return armed.has(sessionId) }
export function setCtrlArmed(sessionId, on) {
  if (!sessionId || armed.has(sessionId) === !!on) return
  if (on) armed.add(sessionId)
  else armed.delete(sessionId)
  notify()
}
export function subscribeCtrl(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Applied to everything the terminal is about to send (xterm onData). With
// ⌃ armed, a single typed character becomes its control byte and the
// modifier releases. Escape sequences and pastes pass through unchanged and
// also release it, like a real modifier that was let go.
export function applyStickyCtrl(sessionId, data) {
  if (!armed.has(sessionId) || typeof data !== 'string' || !data) return data
  setCtrlArmed(sessionId, false)
  if (data.length !== 1) return data
  return ctrlByte(data) ?? data
}

// ── Phone terminal font size (pinch / A− A+), remembered per device ──────
export const PHONE_FONT_KEY = 'ive-phone-terminal-font'
export const PHONE_FONT_MIN = 8
export const PHONE_FONT_MAX = 22
export const PHONE_FONT_DEFAULT = 12

export function clampPhoneFont(size) {
  const n = Number(size)
  if (!Number.isFinite(n)) return PHONE_FONT_DEFAULT
  return Math.min(PHONE_FONT_MAX, Math.max(PHONE_FONT_MIN, Math.round(n * 2) / 2))
}
export function readPhoneFont(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PHONE_FONT_KEY)
    return raw == null ? PHONE_FONT_DEFAULT : clampPhoneFont(raw)
  } catch { return PHONE_FONT_DEFAULT }
}
export function writePhoneFont(size, storage = globalThis.localStorage) {
  const value = clampPhoneFont(size)
  try { storage?.setItem(PHONE_FONT_KEY, String(value)) } catch { /* private mode */ }
  return value
}

// ── Last line of activity from a rendered terminal screen ───────────────
// The newest meaningful line, skipping the CLI's own chrome: blank rows,
// box-drawing rules, the empty input prompt and shortcut hints.
const BOX = /[│┃╭╮╰╯─━═┌┐└┘├┤┬┴┼╔╗╚╝║▐▌▛▜▝▘▗▖]/g
const CHROME = [
  /^>\s*$/, /^[›❯>]\s*$/, /^\?\s+for shortcuts/i, /shift\+tab to cycle/i, /^esc to (interrupt|cancel)$/i,
  /^(auto-accept|bypass permissions|plan mode) (edits )?on/i, /^\d+%?\s+context left/i, /^type a message/i,
]
export function lastActivityLine(screen = '') {
  const lines = String(screen).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(BOX, ' ').replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2) continue
    if (CHROME.some((re) => re.test(text))) continue
    return text.length > 160 ? `${text.slice(0, 157)}…` : text
  }
  return ''
}
