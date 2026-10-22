import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

// Header slots: HeaderBar registers one DOM node per slot ("crumb", "actions"),
// screens render into them with <HeaderPortal slot="…">. Several portals may
// target the same slot; they appear in mount order. Without a header (phone)
// a portal renders nothing.
const nodes = new Map()
const listeners = new Set()
let version = 0

function notify() {
  version += 1
  for (const fn of [...listeners]) {
    try { fn() } catch { /* one listener must not stop the others */ }
  }
}

export function registerHeaderSlot(slot, el) {
  if (!slot) return
  if (el) nodes.set(slot, el)
  else nodes.delete(slot)
  notify()
}

export function getHeaderSlotNode(slot) {
  return nodes.get(slot) || null
}

export function subscribeHeaderSlots(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const getVersion = () => version

export default function HeaderPortal({ slot = 'actions', children }) {
  useSyncExternalStore(subscribeHeaderSlots, getVersion, getVersion)
  const node = getHeaderSlotNode(slot)
  if (!node) return null
  return createPortal(children, node)
}
