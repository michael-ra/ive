import { useLayoutEffect, useRef } from 'react'

// Pointer capture keeps dragging reliable even outside the header. Individual
// translate leaves the panel's entrance animation intact.
export default function useDialogDrag(panelRef, open = true) {
  const current = useRef({ x: 0, y: 0 })
  const drag = useRef(null)
  const move = (x, y) => {
    const panel = panelRef.current
    if (!panel) return
    const r = panel.getBoundingClientRect()
    const baseX = r.left - current.current.x, baseY = r.top - current.current.y
    const view = window.visualViewport
    const left = (view?.offsetLeft || 0) + 8, top = (view?.offsetTop || 0) + 8
    const right = left + (view?.width || innerWidth) - 16
    const bottom = top + (view?.height || innerHeight) - 16
    const next = {
      x: Math.max(left - baseX, Math.min(x, right - r.width - baseX)),
      y: Math.max(top - baseY, Math.min(y, bottom - r.height - baseY)),
    }
    if (next.x !== current.current.x || next.y !== current.current.y) {
      current.current = next
      panel.style.translate = `${next.x}px ${next.y}px`
    }
  }
  useLayoutEffect(() => {
    current.current = { x: 0, y: 0 }; drag.current = null
    if (panelRef.current) {
      panelRef.current.style.translate = '0px 0px'
      panelRef.current.style.transitionProperty = 'opacity, border-color, box-shadow'
    }
    if (!open || !panelRef.current) return
    const fit = () => move(current.current.x, current.current.y)
    const observer = new ResizeObserver(fit)
    observer.observe(panelRef.current)
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); window.visualViewport?.removeEventListener('resize', fit) }
  }, [open])
  const interactive = target => target.closest('button, input, textarea, select, a, [role="button"]')
  const end = event => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    event.currentTarget.style.cursor = 'grab'
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {

    headerProps: {
      'data-dialog-drag-handle': '', tabIndex: 0,
      'aria-label': 'Move dialog with arrow keys. Home resets its position.',
      title: 'Drag to move · arrow keys to move · Home to center',
      style: { cursor: 'grab', touchAction: 'none', userSelect: 'none' },
      onPointerDown: event => {
        if (event.button !== 0 || interactive(event.target) || innerWidth < 640) return
        event.preventDefault()
        event.currentTarget.style.cursor = 'grabbing'
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ...{ start: current.current } }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: event => {
        const d = drag.current
        if (d?.id === event.pointerId) move(d.start.x + event.clientX - d.x, d.start.y + event.clientY - d.y)
      },
      onPointerUp: end, onPointerCancel: end,
      onLostPointerCapture: event => { drag.current = null; event.currentTarget.style.cursor = 'grab' },
      onKeyDown: event => {
        if (event.target !== event.currentTarget || innerWidth < 640) return
        const steps = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }
        if (event.key === 'Home') { event.preventDefault(); move(0, 0) }
        else if (steps[event.key]) { event.preventDefault(); const [x,y] = steps[event.key]; move(current.current.x+x, current.current.y+y) }
      },
    },
  }
}
