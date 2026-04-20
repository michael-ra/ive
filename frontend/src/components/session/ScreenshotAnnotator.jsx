import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Square, ArrowUpRight, Pencil, Type, Undo2, Redo2, Download, Send } from 'lucide-react'

const COLORS = [
  { id: 'red', value: '#ef4444' },
  { id: 'yellow', value: '#eab308' },
  { id: 'blue', value: '#3b82f6' },
  { id: 'green', value: '#22c55e' },
  { id: 'white', value: '#ffffff' },
  { id: 'black', value: '#000000' },
]

const TOOL_DEFS = [
  { id: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { id: 'arrow', icon: ArrowUpRight, label: 'Arrow', key: 'A' },
  { id: 'freehand', icon: Pencil, label: 'Draw', key: 'D' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
]

// ── Drawing helpers ──────────────────────────────────────────────────────

function drawAnnotation(ctx, ann) {
  ctx.strokeStyle = ann.color
  ctx.fillStyle = ann.color
  ctx.lineWidth = ann.lineWidth || 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  switch (ann.type) {
    case 'rect': {
      ctx.beginPath()
      ctx.rect(ann.x, ann.y, ann.w, ann.h)
      ctx.stroke()
      break
    }
    case 'arrow': {
      ctx.beginPath()
      ctx.moveTo(ann.x1, ann.y1)
      ctx.lineTo(ann.x2, ann.y2)
      ctx.stroke()
      // arrowhead
      const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1)
      const head = 16
      ctx.beginPath()
      ctx.moveTo(ann.x2, ann.y2)
      ctx.lineTo(ann.x2 - head * Math.cos(angle - Math.PI / 6), ann.y2 - head * Math.sin(angle - Math.PI / 6))
      ctx.moveTo(ann.x2, ann.y2)
      ctx.lineTo(ann.x2 - head * Math.cos(angle + Math.PI / 6), ann.y2 - head * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
      break
    }
    case 'freehand': {
      if (ann.points.length < 2) break
      ctx.beginPath()
      ctx.moveTo(ann.points[0].x, ann.points[0].y)
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y)
      ctx.stroke()
      break
    }
    case 'text': {
      ctx.font = `bold ${ann.fontSize || 28}px sans-serif`
      ctx.fillText(ann.text, ann.x, ann.y)
      break
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────

export default function ScreenshotAnnotator({ imageUrl, sourceUrl, onClose, onSendToSession }) {
  const canvasRef = useRef(null)
  const imageRef = useRef(null)
  const [tool, setTool] = useState('rect')
  const [color, setColor] = useState('#ef4444')
  const [annotations, setAnnotations] = useState([])
  const [undone, setUndone] = useState([])
  const [drawing, setDrawing] = useState(null)
  const [textInput, setTextInput] = useState(null)
  const [textValue, setTextValue] = useState('')
  const [ready, setReady] = useState(false)

  // Load image — canvas sizing happens in the redraw effect once canvas mounts.
  // NOTE: Do NOT revoke the blob URL here — React StrictMode double-mounts
  // in dev, and revoking on first unmount kills the URL before the second mount.
  // The URL is revoked when the annotator is closed (onClose).
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setReady(true)
    }
    img.onerror = () => {
      console.error('Failed to load screenshot image:', imageUrl)
      onClose?.()
    }
    img.src = imageUrl
  }, [imageUrl])

  // Redraw (also sizes the canvas on first call)
  const redraw = useCallback(() => {
    const c = canvasRef.current
    const img = imageRef.current
    if (!c || !img) return
    if (c.width !== img.naturalWidth) c.width = img.naturalWidth
    if (c.height !== img.naturalHeight) c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0)
    const all = drawing ? [...annotations, drawing] : annotations
    for (const ann of all) drawAnnotation(ctx, ann)
  }, [annotations, drawing])

  useEffect(() => { if (ready) redraw() }, [ready, redraw])

  // Canvas coords (CSS-scaled → image-space)
  const coords = (e) => {
    const c = canvasRef.current
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }
  }

  const handleMouseDown = (e) => {
    if (tool === 'text') {
      setTextInput(coords(e))
      setTextValue('')
      return
    }
    const p = coords(e)
    const base = { color, lineWidth: 3 }
    if (tool === 'rect') setDrawing({ ...base, type: 'rect', x: p.x, y: p.y, w: 0, h: 0 })
    if (tool === 'arrow') setDrawing({ ...base, type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y })
    if (tool === 'freehand') setDrawing({ ...base, type: 'freehand', points: [p] })
  }

  const handleMouseMove = (e) => {
    if (!drawing) return
    const p = coords(e)
    setDrawing((d) => {
      if (!d) return d
      if (d.type === 'rect') return { ...d, w: p.x - d.x, h: p.y - d.y }
      if (d.type === 'arrow') return { ...d, x2: p.x, y2: p.y }
      if (d.type === 'freehand') return { ...d, points: [...d.points, p] }
      return d
    })
  }

  const handleMouseUp = () => {
    if (!drawing) return
    const ok =
      (drawing.type === 'rect' && (Math.abs(drawing.w) > 4 || Math.abs(drawing.h) > 4)) ||
      (drawing.type === 'arrow' && (Math.abs(drawing.x2 - drawing.x1) > 4 || Math.abs(drawing.y2 - drawing.y1) > 4)) ||
      (drawing.type === 'freehand' && drawing.points.length > 2)
    if (ok) { setAnnotations((a) => [...a, drawing]); setUndone([]) }
    setDrawing(null)
  }

  const commitText = () => {
    if (textValue.trim() && textInput) {
      setAnnotations((a) => [...a, { type: 'text', x: textInput.x, y: textInput.y, text: textValue.trim(), color, fontSize: 28 }])
      setUndone([])
    }
    setTextInput(null)
    setTextValue('')
  }

  const undo = useCallback(() => {
    setAnnotations((prev) => {
      if (!prev.length) return prev
      setUndone((u) => [...u, prev[prev.length - 1]])
      return prev.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setUndone((prev) => {
      if (!prev.length) return prev
      setAnnotations((a) => [...a, prev[prev.length - 1]])
      return prev.slice(0, -1)
    })
  }, [])

  const save = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    c.toBlob((blob) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `screenshot_${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/png')
  }, [])

  const sendToSession = useCallback(async () => {
    const c = canvasRef.current
    if (!c || !onSendToSession) return
    c.toBlob(async (blob) => {
      const form = new FormData()
      form.append('file', blob, `screenshot_${Date.now()}.png`)
      try {
        const resp = await fetch('/api/paste-image', { method: 'POST', body: form })
        const data = await resp.json()
        if (data.path) { onSendToSession(data.path); onClose() }
      } catch (e) {
        console.error('Failed to send screenshot:', e)
      }
    }, 'image/png')
  }, [onSendToSession, onClose])

  // Keyboard shortcuts (tool-level, not global)
  useEffect(() => {
    const handler = (e) => {
      if (textInput) return // don't intercept while typing
      const meta = e.metaKey || e.ctrlKey
      if (e.key === 'r' && !meta) { setTool('rect'); return }
      if (e.key === 'a' && !meta) { setTool('arrow'); return }
      if (e.key === 'd' && !meta) { setTool('freehand'); return }
      if (e.key === 't' && !meta) { setTool('text'); return }
      if (e.key === 'z' && meta && e.shiftKey) { e.preventDefault(); redo(); return }
      if (e.key === 'z' && meta) { e.preventDefault(); undo(); return }
      if (e.key === 's' && meta) { e.preventDefault(); save(); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [textInput, undo, redo, save])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#111118] border-b border-zinc-800 shrink-0">
        <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[220px]">{sourceUrl}</span>
        <div className="w-px h-4 bg-zinc-700" />

        {/* Tools */}
        {TOOL_DEFS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.key})`}
              className={`p-1.5 rounded transition-colors ${
                tool === t.id
                  ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/30'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent'
              }`}
            >
              <Icon size={14} />
            </button>
          )
        })}

        <div className="w-px h-4 bg-zinc-700" />

        {/* Colors */}
        {COLORS.map((c) => (
          <button
            key={c.id}
            onClick={() => setColor(c.value)}
            className={`w-4.5 h-4.5 rounded-full transition-transform hover:scale-110 ${color === c.value ? 'ring-2 ring-white/60 scale-110' : ''}`}
            style={{ backgroundColor: c.value, border: '1px solid rgba(255,255,255,0.2)', width: 18, height: 18 }}
            title={c.id}
          />
        ))}

        <div className="w-px h-4 bg-zinc-700" />

        {/* Undo / Redo */}
        <button onClick={undo} disabled={!annotations.length} title="Undo (⌘Z)"
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
          <Undo2 size={14} />
        </button>
        <button onClick={redo} disabled={!undone.length} title="Redo (⌘⇧Z)"
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
          <Redo2 size={14} />
        </button>

        <div className="flex-1" />

        {/* Actions */}
        <button onClick={save} title="Save (⌘S)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md transition-colors">
          <Download size={12} /> Save
        </button>
        {onSendToSession && (
          <button onClick={sendToSession} title="Send to active session"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-indigo-300 hover:text-indigo-200 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/25 rounded-md transition-colors">
            <Send size={12} /> Send
          </button>
        )}
        <button onClick={onClose} title="Close (Esc)"
          className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors ml-1">
          <X size={16} />
        </button>
      </div>

      {/* ── Canvas ── */}
      <div className="flex-1 flex items-center justify-center p-6 min-h-0 overflow-auto">
        {ready ? (
          <div className="relative inline-block">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-[calc(100vh-120px)] shadow-2xl rounded-md"
              style={{ cursor: tool === 'text' ? 'text' : 'crosshair' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            />

            {/* Floating text input when placing text */}
            {textInput && canvasRef.current && (() => {
              const c = canvasRef.current
              const r = c.getBoundingClientRect()
              const sx = r.width / c.width
              const sy = r.height / c.height
              return (
                <input
                  type="text"
                  autoFocus
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') { setTextInput(null); setTextValue('') } }}
                  onBlur={commitText}
                  className="absolute bg-transparent outline-none font-sans font-bold"
                  style={{
                    left: textInput.x * sx,
                    top: textInput.y * sy - 16,
                    color,
                    fontSize: 18,
                    minWidth: 80,
                    borderBottom: '1px solid rgba(255,255,255,0.3)',
                  }}
                />
              )
            })()}
          </div>
        ) : (
          <div className="text-zinc-500 text-sm font-mono animate-pulse">Loading screenshot…</div>
        )}
      </div>

      {/* ── Hint bar ── */}
      <div className="px-4 py-1.5 bg-[#111118] border-t border-zinc-800 shrink-0">
        <span className="text-[9px] text-zinc-600 font-mono">
          R rect · A arrow · D draw · T text · ⌘Z undo · ⌘⇧Z redo · ⌘S save · esc close
        </span>
      </div>
    </div>
  )
}
