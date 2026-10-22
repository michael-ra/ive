import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import useStore from '../../state/store'
import TerminalView from '../chat/Terminal'
import { getTerminalPortalNode, getTerminalSlot, releaseTerminalPortalNode, subscribeTerminalSlots } from '../../lib/terminalSlots'

// One TerminalView per open session, mounted once and rendered into a stable
// portal node. A <TerminalSlot> (tile, drawer, full view) adopts the node;
// nodes nobody shows wait in the parking container below, 1×1 px and
// invisible, where Terminal.jsx sends no resize (fitLayout stops < 20 px).
// Desktop only; the phone keeps rendering TerminalView directly (App.jsx).
let slotVersion = 0
const subscribe = (fn) => subscribeTerminalSlots(() => { slotVersion += 1; fn() })
const getSlotVersion = () => slotVersion

export default function TerminalKeepAlive() {
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  useSyncExternalStore(subscribe, getSlotVersion, getSlotVersion)
  const parkedRef = useRef(null)
  const previousIds = useRef([])

  const ids = openTabs.filter((id) => !!sessions[id])

  // Park every node without a slot before the terminals' own effects open
  // xterm in it (layout effects of this parent run after the children's
  // layout effects, but before any passive effect).
  useLayoutEffect(() => {
    const parked = parkedRef.current
    for (const id of ids) {
      const node = getTerminalPortalNode(id)
      if (!node || getTerminalSlot(id)) continue
      if (parked && node.parentElement !== parked) parked.appendChild(node)
    }
    // Closed tabs: React has unmounted the portal children already; drop the node.
    for (const id of previousIds.current) {
      if (!ids.includes(id)) releaseTerminalPortalNode(id)
    }
    previousIds.current = ids
  })

  return (
    <>
      <div
        data-terminal-parked=""
        ref={parkedRef}
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
      />
      {ids.map((id) => {
        const node = getTerminalPortalNode(id)
        if (!node) return null
        const mode = getTerminalSlot(id)?.mode || null
        return createPortal(
          <TerminalView key={id} sessionId={id} slotMode={mode} overviewPreview={mode === 'tile'} inDrawer={mode === 'drawer'} />,
          node,
          id,
        )
      })}
    </>
  )
}
