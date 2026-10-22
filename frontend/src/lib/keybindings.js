// ─── Configurable keybinding system ─────────────────────────────────────────
// Combo shape: { key: string, meta?: boolean, ctrl?: boolean, shift?: boolean, alt?: boolean }
// Stored in localStorage as cc-keybindings (overrides only — defaults live here).

const KEY_LABELS = {
  ArrowLeft: '\u2190', ArrowRight: '\u2192', ArrowUp: '\u2191', ArrowDown: '\u2193',
  Enter: '\u21B5', Backspace: '\u232B', Delete: '\u2326', Escape: 'Esc',
  ' ': 'Space', Tab: '\u21E5',
}

export const KEYBINDING_DEFS = [
  // ── Navigation ──
  { id: 'commandPalette', label: 'Command Palette', section: 'Navigation', defaultKey: { key: 'k', meta: true } },
  { id: 'promptPalette', label: 'Prompt Library', section: 'Navigation', defaultKey: { key: '/', meta: true } },
  { id: 'quickActionPalette', label: 'Quick Action Palette', section: 'Navigation', defaultKey: { key: 'y', meta: true } },
  // The launcher tiles are gone; ⌘K is the one place to search. The id stays
  // so saved overrides keep working.
  { id: 'navigationLauncher', label: 'Navigation Launcher', section: 'Navigation', defaultKey: null },
  // ⌘F finds in the open chat or terminal (Home: all sessions); ⌘⇧F always
  // searches every session, as in VS Code / Cursor.
  { id: 'search', label: 'Find in Session', section: 'Navigation', defaultKey: { key: 'f', meta: true } },
  { id: 'globalSearch', label: 'Search All Sessions', section: 'Navigation', defaultKey: { key: 'F', meta: true, shift: true } },
  { id: 'previewUrl', label: 'Preview (screenshot / open)', section: 'Navigation', defaultKey: { key: 'p', meta: true } },
  { id: 'sidebar', label: 'Toggle Sidebar', section: 'Navigation', defaultKey: { key: '\\', meta: true } },
  // ⌘J shows or hides the terminal drawer of the open session (Scratchpad
  // moved to the ⋯ menu and ⌘K); ⌘⇧E switches Board ⇄ Session, ⌘⇧H goes Home.
  { id: 'toggleTerminal', label: 'Toggle Terminal', section: 'Navigation', defaultKey: { key: 'j', meta: true } },
  { id: 'toggleSessionLevel', label: 'Switch Board ⇄ Session', section: 'Navigation', defaultKey: { key: 'E', meta: true, shift: true } },
  { id: 'goHome', label: 'Go to Home', section: 'Navigation', defaultKey: { key: 'H', meta: true, shift: true } },

  // ── Panels ──
  { id: 'featureBoard', label: 'Feature Board', section: 'Panels', defaultKey: { key: 'b', meta: true } },
  { id: 'pipelineEditor', label: 'Pipeline Editor', section: 'Panels', defaultKey: { key: 'L', meta: true, shift: true } },
  { id: 'missionControl', label: 'Mission Control', section: 'Panels', defaultKey: { key: 'm', meta: true } },
  { id: 'guidelines', label: 'Guidelines', section: 'Panels', defaultKey: { key: 'g', meta: true } },
  { id: 'mcpServers', label: 'MCP Servers', section: 'Panels', defaultKey: { key: 'S', meta: true, shift: true } },
  { id: 'agentTree', label: 'Agent Tree', section: 'Panels', defaultKey: { key: 't', meta: true } },
  { id: 'composer', label: 'Composer', section: 'Panels', defaultKey: { key: 'e', meta: true } },
  { id: 'sideChat', label: 'Chat with Claude', section: 'Panels', defaultKey: { key: 'J', meta: true, shift: true } },
  { id: 'scratchpad', label: 'Scratchpad', section: 'Panels', defaultKey: null },
  { id: 'inbox', label: 'Inbox', section: 'Panels', defaultKey: { key: 'i', meta: true } },
  { id: 'research', label: 'New Research', section: 'Panels', defaultKey: { key: 'r', meta: true } },
  { id: 'marketplace', label: 'Plugins & Skills', section: 'Panels', defaultKey: { key: 'M', meta: true, shift: true } },
  { id: 'skillsLibrary', label: 'Agent Skills Library', section: 'Panels', defaultKey: null },
  { id: 'codeReview', label: 'Code Review', section: 'Panels', defaultKey: { key: 'G', meta: true, shift: true } },
  { id: 'annotate', label: 'Annotate Output', section: 'Panels', defaultKey: { key: 'A', meta: true, shift: true } },
  // ⌘⇧N belongs to "Set up session…" (full dialog) since quick start took ⌘N.
  // ⌘⇧F went to "Search All Sessions" (editor convention); capture an Idea is ⌘⇧I.
  { id: 'quickFeature', label: 'Quick Feature', section: 'Panels', defaultKey: { key: 'I', meta: true, shift: true } },
  { id: 'observatory', label: 'Discovery Inbox', section: 'Panels', defaultKey: { key: 'O', meta: true, shift: true } },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', section: 'Panels', defaultKey: { key: '?', meta: true, shift: true } },

  // ── Sessions ──
  { id: 'newSession', label: 'New Session (quick start)', section: 'Sessions', defaultKey: { key: 'n', meta: true } },
  { id: 'newSessionSetup', label: 'Set Up Session (full dialog)', section: 'Sessions', defaultKey: { key: 'N', meta: true, shift: true } },
  { id: 'closeTab', label: 'Close Session', section: 'Sessions', defaultKey: { key: 'w', meta: true } },
  { id: 'stopSession', label: 'Stop Session', section: 'Sessions', defaultKey: { key: '.', meta: true } },
  { id: 'splitView', label: 'Split View', section: 'Sessions', defaultKey: { key: 'd', meta: true } },
  { id: 'broadcast', label: 'Broadcast', section: 'Sessions', defaultKey: { key: 'Enter', meta: true, shift: true } },
  { id: 'usage', label: 'Usage', section: 'Sessions', defaultKey: { key: 'u', meta: true } },
  { id: 'msgPrev', label: 'Jump to previous message start', section: 'Sessions', defaultKey: { key: 'ArrowUp', meta: true, shift: true } },
  { id: 'msgNext', label: 'Jump to next message start', section: 'Sessions', defaultKey: { key: 'ArrowDown', meta: true, shift: true } },

  // ── Feature Board ──
  { id: 'boardTabPrev', label: 'Previous workspace tab', section: 'Feature Board', defaultKey: { key: '[' } },
  { id: 'boardTabNext', label: 'Next workspace tab', section: 'Feature Board', defaultKey: { key: ']' } },

  // ── Task Modal ──
  { id: 'taskTabPrev', label: 'Previous tab', section: 'Task Modal', defaultKey: { key: 'ArrowLeft', alt: true } },
  { id: 'taskTabNext', label: 'Next tab', section: 'Task Modal', defaultKey: { key: 'ArrowRight', alt: true } },
  { id: 'taskFieldPrev', label: 'Previous field', section: 'Task Modal', defaultKey: { key: 'ArrowUp', alt: true } },
  { id: 'taskFieldNext', label: 'Next field', section: 'Task Modal', defaultKey: { key: 'ArrowDown', alt: true } },
]

const STORAGE_KEY = 'cc-keybindings'

// Mac browsers reserve these Command combinations before page handlers run,
// so in a Mac browser their defaults use Control instead (⌃N quick start,
// ⌃⇧N setup, ⌃W close tab, ⌃T agent tree, ⌃M mission control, ⌃R research,
// ⌃D board). The desktop app and other platforms keep ⌘ (contract: ⌘N).
const BROWSER_CONTROL_BINDINGS = new Set([
  'newSession', 'newSessionSetup', 'closeTab', 'agentTree',
  'missionControl', 'research', 'splitView',
])

// Control+letter combos that agent CLIs (Claude Code, Codex) and readline
// rely on. In the terminal these go to the PTY, except TERMINAL_IVE_CONTROL_KEYS
// in a Mac browser while an IVE action is bound to them.
const PTY_CONTROL_KEYS = new Set('cdzlraekuwypnbftgj'.split(''))

export function isMacPlatform() {
  return /Mac/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '')
}

export function isMacBrowser() {
  return typeof window !== 'undefined'
    && !window.__TAURI__ && !window.__TAURI_INTERNALS__
    && isMacPlatform()
}

export function getDefaultKeybinding(def, macBrowser = isMacBrowser()) {
  if (macBrowser && BROWSER_CONTROL_BINDINGS.has(def.id) && def.defaultKey?.meta) {
    const { meta, ...combo } = def.defaultKey
    return { ...combo, ctrl: true }
  }
  return def.defaultKey
}

// Matches the binding for `id`, but never a Control key the terminal already
// handed to the PTY.
export function matchesAction(event, bindings, id) {
  if (event._ivePtyKey) return false
  return matchesKey(event, bindings?.[id])
}

export function getTabSwitchCombo(key = '1') {
  return { key, ...(isMacBrowser() ? { ctrl: true } : { meta: true }) }
}

// True for Control+letter keys that normally belong to the PTY.
export function isPtyControlKey(event) {
  return !!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && typeof event.key === 'string' && PTY_CONTROL_KEYS.has(event.key.toLowerCase())
}

// Mac browser only: the Control letters IVE keeps even when the terminal has
// focus (⌃N / ⌃⇧N quick start + setup, ⌃T agent tree, ⌃W close tab). An
// explicit allowlist: ⌃R, ⌃D, ⌃M stay with the agent inside the terminal even
// though research / board / mission control use them elsewhere. ⌃1-9 are
// not PTY keys and are intercepted anyway.
const TERMINAL_IVE_CONTROL_KEYS = new Set(['n', 't', 'w'])

export function isBrowserReservedControlKey(event, _bindings, macBrowser = isMacBrowser()) {
  return macBrowser && !!event.ctrlKey && !event.metaKey && !event.altKey
    && typeof event.key === 'string' && TERMINAL_IVE_CONTROL_KEYS.has(event.key.toLowerCase())
}

export function isGlobalShortcut(event, bindings) {
  return KEYBINDING_DEFS.some((def) => isGlobalSection(def.section) && matchesKey(event, bindings[def.id]))
    || (/^[1-9]$/.test(event.key) && matchesKey(event, getTabSwitchCombo(event.key)))
}

// Whether the terminal should hand this key to IVE instead of xterm.
// Readline / agent Control keys only qualify for ⌃N/⌃T/⌃W in a Mac browser,
// and only while an IVE action is bound to them.
export function shouldTerminalIntercept(event, bindings) {
  if (isPtyControlKey(event) && !isBrowserReservedControlKey(event, bindings)) return false
  return isGlobalShortcut(event, bindings)
}

// ── Storage ──────────────────────────────────────────────────────────────────

export function getKeybindings() {
  const overrides = getOverrides()
  const map = {}
  for (const def of KEYBINDING_DEFS) {
    map[def.id] = Object.hasOwn(overrides, def.id) ? overrides[def.id] : getDefaultKeybinding(def)
  }
  return map
}

export function getOverrides() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
  catch { return {} }
}

export function setKeybinding(id, combo) {
  const overrides = getOverrides()
  overrides[id] = combo
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export function resetKeybinding(id) {
  const overrides = getOverrides()
  delete overrides[id]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export function resetAllKeybindings() {
  localStorage.removeItem(STORAGE_KEY)
}

// ── Matching ─────────────────────────────────────────────────────────────────

// On macOS ⌘ and ⌃ are distinct: a `meta` combo needs metaKey, a `ctrl`
// combo needs ctrlKey. Elsewhere there is no ⌘ key, so Ctrl stands in for
// `meta` (Ctrl+K opens the palette on Linux/Windows).
export function matchesKey(event, combo, mac = isMacPlatform()) {
  if (!combo || !event || typeof event.key !== 'string') return false
  let modifiersMatch
  if (mac) {
    modifiersMatch = !!event.metaKey === !!combo.meta && !!event.ctrlKey === !!combo.ctrl
  } else {
    const wantsCtrl = !!(combo.meta || combo.ctrl)
    modifiersMatch = !!(event.metaKey || event.ctrlKey) === wantsCtrl
  }
  const keyMatches = event.key.toLowerCase() === combo.key.toLowerCase()
  return keyMatches
    && modifiersMatch
    && !!event.shiftKey === !!combo.shift
    && !!event.altKey === !!combo.alt
}

// Equal when they would fire on the same physical key press.
export function combosEqual(a, b, mac = isMacPlatform()) {
  if (!a || !b) return false
  const sameMods = mac
    ? !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl
    : !!(a.meta || a.ctrl) === !!(b.meta || b.ctrl)
  return a.key.toLowerCase() === b.key.toLowerCase()
    && sameMods
    && !!a.shift === !!b.shift
    && !!a.alt === !!b.alt
}

// ── Display ──────────────────────────────────────────────────────────────────

export function formatKeyCombo(combo) {
  if (!combo) return '\u2014'
  const parts = []
  if (combo.ctrl) parts.push('\u2303')
  if (combo.meta) parts.push('\u2318')
  if (combo.shift) parts.push('\u21E7')
  if (combo.alt) parts.push('\u2325')
  const label = KEY_LABELS[combo.key] || (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key)
  parts.push(label)
  return parts.join('')
}

// ── Conflicts ────────────────────────────────────────────────────────────────

export function findConflict(currentId, combo, bindings) {
  for (const [id, bc] of Object.entries(bindings)) {
    if (id === currentId) continue
    if (combosEqual(bc, combo)) {
      const def = KEYBINDING_DEFS.find((d) => d.id === id)
      return { id, label: def?.label || id }
    }
  }
  return null
}

// Sections that require at least Cmd/Ctrl or Alt (prevents raw keypresses from
// shadowing normal typing).
const GLOBAL_SECTIONS = new Set(['Navigation', 'Panels', 'Sessions'])

export function isGlobalSection(section) {
  return GLOBAL_SECTIONS.has(section)
}
