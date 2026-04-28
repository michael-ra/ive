import { useEffect, useRef, useState, useCallback } from 'react'

const STORAGE_KEY = 'ive.cmdk_button_pos'
const SIZE = 48
const DRAG_THRESHOLD = 5
const MARGIN = 8

function loadPos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (typeof v?.left === 'number' && typeof v?.top === 'number') return v
  } catch {}
  return null
}

function savePos(pos) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)) } catch {}
}

function clampToViewport(pos) {
  if (typeof window === 'undefined') return pos
  const w = window.innerWidth
  const h = window.innerHeight
  const left = Math.max(MARGIN, Math.min(pos.left, w - SIZE - MARGIN))
  const top = Math.max(MARGIN, Math.min(pos.top, h - SIZE - MARGIN))
  return { left, top }
}

function defaultPos() {
  if (typeof window === 'undefined') return { left: 24, top: 24 }
  return clampToViewport({
    left: window.innerWidth - SIZE - 20,
    top: window.innerHeight - SIZE - 96,
  })
}

export default function FloatingCommandButton({ onActivate }) {
  const [pos, setPos] = useState(() => clampToViewport(loadPos() || defaultPos()))
  const drag = useRef({ active: false, startX: 0, startY: 0, offX: 0, offY: 0, moved: false })

  useEffect(() => { savePos(pos) }, [pos])

  useEffect(() => {
    const onResize = () => setPos((p) => clampToViewport(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    const rect = e.currentTarget.getBoundingClientRect()
    drag.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      moved: false,
    }
  }, [])

  const onPointerMove = useCallback((e) => {
    const d = drag.current
    if (!d.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    d.moved = true
    setPos(clampToViewport({ left: e.clientX - d.offX, top: e.clientY - d.offY }))
  }, [])

  const onPointerUp = useCallback((e) => {
    const d = drag.current
    if (!d.active) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    const wasDrag = d.moved
    drag.current.active = false
    if (!wasDrag) onActivate?.()
  }, [onActivate])

  return (
    <button
      type="button"
      aria-label="Open command palette"
      title="Command palette (drag to move)"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        left: pos.left,
        top: pos.top,
        width: SIZE,
        height: SIZE,
        touchAction: 'none',
      }}
      className="fixed z-40 rounded-full bg-accent-primary text-white shadow-lg shadow-black/40 flex items-center justify-center font-mono text-[12px] font-bold tracking-wider hover:brightness-110 active:brightness-95 select-none cursor-grab active:cursor-grabbing border border-white/15 backdrop-blur-sm"
    >
      ⌘K
    </button>
  )
}
