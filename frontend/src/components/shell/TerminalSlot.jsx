import { useLayoutEffect, useRef } from 'react'
import { getTerminalPortalNode, getTerminalSlot, registerTerminalSlot } from '../../lib/terminalSlots'
import useStore from '../../state/store'
import { TerminalContextNotice } from '../session/SessionContextNotice'

// Where a session's terminal shows: a board tile, the session drawer or the
// full view. The slot adopts the session's stable portal node (rendered by
// TerminalKeepAlive) and gives it back to the parking container on unmount,
// so the TerminalView itself never remounts. Exactly one slot per session.
//   mode: 'tile' | 'drawer' | 'full'
export default function TerminalSlot({ sessionId, mode = 'full', focusOnMount = false, className = '', style }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    const node = getTerminalPortalNode(sessionId)
    if (!el || !node) return undefined
    if (node.parentElement !== el) el.appendChild(node)
    const unregister = registerTerminalSlot(sessionId, { el, mode })
    // Focus in the layout commit, before a fast follow-up Enter can arrive.
    // Background tiles must never take the keyboard from the selected session.
    if (focusOnMount && useStore.getState().activeSessionId === sessionId) {
      window.dispatchEvent(new Event('cc-focus-terminal'))
    }
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('cc-terminal-refit')))
    return () => {
      cancelAnimationFrame(frame)
      unregister()
      // Detach the node for the rest of this commit. React restores the focus
      // it saw before the mutation phase to any element still in the document;
      // a parked terminal that gets its focus back would re-activate its
      // session (Terminal.jsx focus handler) and undo the switch. The parking
      // container (TerminalKeepAlive, layout phase) adopts the node right
      // after, so the terminal keeps its scrollback and sends no resize.
      node.remove()
      queueMicrotask(() => {
        if (node.parentElement || getTerminalSlot(sessionId)) return
        document.querySelector('[data-terminal-parked]')?.appendChild(node)
      })
    }
  }, [sessionId, mode, focusOnMount])

  return (
    <>
    {mode !== 'drawer' && <TerminalContextNotice key={sessionId} sessionId={sessionId} />}
    <div
      ref={ref}
      data-terminal-slot={sessionId}
      data-terminal-mode={mode}
      className={`ive-terminal-slot${className ? ` ${className}` : ''}`}
      style={style}
    />
    </>
  )
}
