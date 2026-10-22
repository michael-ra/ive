// One TerminalView per session, placed anywhere (board tile, session drawer,
// full view) without remounting: TerminalKeepAlive renders each terminal
// into a stable detached portal node, and a <TerminalSlot> adopts that node
// into its own DOM. This module owns the nodes and the slot registry; it has
// no React dependency so screens and tests can use it directly.

const portalNodes = new Map()
const slots = new Map()
const listeners = new Set()

function notify() {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* one listener must not stop the others */ }
  }
}

// Stable node per session, detached until a slot adopts it. The parked
// container (TerminalKeepAlive) keeps unadopted nodes in the document, 1×1 px
// and invisible, so xterm sends no resize while nothing shows the terminal.
export function getTerminalPortalNode(sessionId) {
  if (!sessionId) return null
  let node = portalNodes.get(sessionId)
  if (!node) {
    if (typeof document === 'undefined') return null
    node = document.createElement('div')
    node.className = 'ive-terminal-portal'
    node.setAttribute('data-terminal-session', sessionId)
    portalNodes.set(sessionId, node)
  }
  return node
}

export function hasTerminalPortalNode(sessionId) {
  return portalNodes.has(sessionId)
}

export function releaseTerminalPortalNode(sessionId) {
  const node = portalNodes.get(sessionId)
  if (!node) return
  portalNodes.delete(sessionId)
  slots.delete(sessionId)
  try { node.remove() } catch { /* already detached */ }
  notify()
}

// Exactly one slot per session: a second registration replaces the first and
// logs a warning, because two visible slots would mean two geometries.
export function registerTerminalSlot(sessionId, { el, mode } = {}) {
  if (!sessionId) return () => {}
  const entry = { el: el || null, mode: mode || 'full' }
  const previous = slots.get(sessionId)
  if (previous && previous.el !== entry.el) {
    console.warn(`[terminalSlots] session ${sessionId} already has a ${previous.mode} slot; replacing it with ${entry.mode}`)
  }
  slots.set(sessionId, entry)
  notify()
  return function unregister() {
    if (slots.get(sessionId) === entry) {
      slots.delete(sessionId)
      notify()
    }
  }
}

export function getTerminalSlot(sessionId) {
  return slots.get(sessionId) || null
}

export function subscribeTerminalSlots(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Test helper: forget every node and slot.
export function resetTerminalSlots() {
  for (const node of portalNodes.values()) {
    try { node.remove() } catch { /* detached */ }
  }
  portalNodes.clear()
  slots.clear()
  notify()
}
