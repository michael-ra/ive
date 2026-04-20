// ─── Configurable keybinding system ─────────────────────────────────────────
// Combo shape: { key: string, meta?: boolean, shift?: boolean, alt?: boolean }
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
  { id: 'search', label: 'Search Sessions', section: 'Navigation', defaultKey: { key: 'f', meta: true } },
  { id: 'previewUrl', label: 'Preview (screenshot / open)', section: 'Navigation', defaultKey: { key: 'p', meta: true } },
  { id: 'sidebar', label: 'Toggle Sidebar', section: 'Navigation', defaultKey: { key: '\\', meta: true } },

  // ── Panels ──
  { id: 'featureBoard', label: 'Feature Board', section: 'Panels', defaultKey: { key: 'b', meta: true } },
  { id: 'pipelineEditor', label: 'Pipeline Editor', section: 'Panels', defaultKey: { key: 'l', meta: true, shift: true } },
  { id: 'missionControl', label: 'Mission Control', section: 'Panels', defaultKey: { key: 'm', meta: true } },
  { id: 'guidelines', label: 'Guidelines', section: 'Panels', defaultKey: { key: 'g', meta: true } },
  { id: 'mcpServers', label: 'MCP Servers', section: 'Panels', defaultKey: { key: 'S', meta: true, shift: true } },
  { id: 'agentTree', label: 'Agent Tree', section: 'Panels', defaultKey: { key: 't', meta: true } },
  { id: 'composer', label: 'Composer', section: 'Panels', defaultKey: { key: 'e', meta: true } },
  { id: 'scratchpad', label: 'Scratchpad', section: 'Panels', defaultKey: { key: 'j', meta: true } },
  { id: 'inbox', label: 'Inbox', section: 'Panels', defaultKey: { key: 'i', meta: true } },
  { id: 'research', label: 'Research Panel', section: 'Panels', defaultKey: { key: 'r', meta: true } },
  { id: 'marketplace', label: 'Plugins & Skills', section: 'Panels', defaultKey: { key: 'M', meta: true, shift: true } },
  { id: 'skillsLibrary', label: 'Agent Skills Library', section: 'Panels', defaultKey: null },
  { id: 'codeReview', label: 'Code Review', section: 'Panels', defaultKey: { key: 'G', meta: true, shift: true } },
  { id: 'annotate', label: 'Annotate Output', section: 'Panels', defaultKey: { key: 'A', meta: true, shift: true } },
  { id: 'quickFeature', label: 'Quick Feature', section: 'Panels', defaultKey: { key: 'N', meta: true, shift: true } },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', section: 'Panels', defaultKey: { key: '?', meta: true, shift: true } },

  // ── Sessions ──
  { id: 'newSession', label: 'New Session', section: 'Sessions', defaultKey: { key: 'n', meta: true } },
  { id: 'closeTab', label: 'Close Tab', section: 'Sessions', defaultKey: { key: 'w', meta: true } },
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

// ── Storage ──────────────────────────────────────────────────────────────────

export function getKeybindings() {
  const overrides = getOverrides()
  const map = {}
  for (const def of KEYBINDING_DEFS) {
    map[def.id] = overrides[def.id] || def.defaultKey
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

export function matchesKey(event, combo) {
  if (!combo) return false
  const meta = event.metaKey || event.ctrlKey
  return event.key === combo.key
    && meta === !!combo.meta
    && event.shiftKey === !!combo.shift
    && event.altKey === !!combo.alt
}

export function combosEqual(a, b) {
  if (!a || !b) return false
  return a.key === b.key
    && !!a.meta === !!b.meta
    && !!a.shift === !!b.shift
    && !!a.alt === !!b.alt
}

// ── Display ──────────────────────────────────────────────────────────────────

export function formatKeyCombo(combo) {
  if (!combo) return '\u2014'
  const parts = []
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
