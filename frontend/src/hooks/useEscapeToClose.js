import { useEffect, useRef } from 'react'

// Escape closes an open menu or popover, and only that. Capture phase on
// window so it runs before xterm.js (which would send Escape to the agent)
// and the app-level Escape stack (which would close a panel or leave the
// Session level). Mark the menu element with data-ive-popover as well: the
// app-level handler stands back while one is in the DOM.
export default function useEscapeToClose(open, onClose) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close.current?.()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open])
}
