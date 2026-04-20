import { useRef, useState, useEffect } from 'react'
import { Pen, Square, Circle, MousePointer, Undo2, Trash2 } from 'lucide-react'

const TOOLS = [
  { id: 'select', icon: MousePointer, label: 'Select/Move' },
  { id: 'pen', icon: Pen, label: 'Draw' },
  { id: 'rect', icon: Square, label: 'Rectangle' },
  { id: 'circle', icon: Circle, label: 'Circle' },
]

const COLORS = ['#e4e4e7', '#6366f1', '#22c55e', '#ef4444', '#eab308', '#06b6d4', '#a855f7', '#f97316']

/** Extract all text notes from diagram elements */
export function extractDiagramNotes(diagramData) {
  if (!diagramData?.elements) return []
  return diagramData.elements
    .filter((el) => el.type === 'text')
    .map((el, i) => ({ id: i + 1, text: el.text }))
}

export default function ExcalidrawWrapper({ initialData, onChange, taskId }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const sizeRef = useRef({ w: 800, h: 600 })
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState('#e4e4e7')
  const [strokeWidth, setStrokeWidth] = useState(2)
  const elementsRef = useRef(initialData?.elements || [])
  const [elementCount, setElementCount] = useState(elementsRef.current.length)
  const undoRef = useRef([])
  const drawingRef = useRef(false)
  const pathRef = useRef([])
  const startRef = useRef(null)
  const [textInput, setTextInput] = useState(null)
  const [voicePos, setVoicePos] = useState(null) // position where voice note is recording
  const [isRecording, setIsRecording] = useState(false)
  const saveTimer = useRef(null)
  const rafRef = useRef(null)
  const lastRightClick = useRef(0)
  const voiceRecRef = useRef(null)

  // Zoom & pan
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const panningRef = useRef(false)
  const panStartRef = useRef(null)

  // Dragging elements
  const dragRef = useRef(null) // { index, offsetX, offsetY }

  const resize = () => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    sizeRef.current = { w: rect.width, h: rect.height }
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    canvas.style.width = rect.width + 'px'
    canvas.style.height = rect.height + 'px'
    redraw()
  }

  useEffect(() => {
    resize()
    const obs = new ResizeObserver(resize)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // Load saved images
  useEffect(() => {
    elementsRef.current.forEach((el, i) => {
      if (el.type === 'image' && el.src && !el._img) {
        const img = new window.Image()
        img.onload = () => { elementsRef.current[i]._img = img; redraw() }
        img.src = el.src
      }
    })
  }, [])

  const toCanvas = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    }
  }

  const redraw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const { w, h } = sizeRef.current

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0a0a0f'
    ctx.fillRect(0, 0, w, h)

    ctx.save()
    ctx.translate(panRef.current.x, panRef.current.y)
    ctx.scale(zoomRef.current, zoomRef.current)

    // Grid
    const gs = 40
    const startX = Math.floor(-panRef.current.x / zoomRef.current / gs) * gs
    const startY = Math.floor(-panRef.current.y / zoomRef.current / gs) * gs
    const endX = startX + w / zoomRef.current + gs
    const endY = startY + h / zoomRef.current + gs
    ctx.strokeStyle = '#1a1a25'
    ctx.lineWidth = 0.5 / zoomRef.current
    for (let x = startX; x < endX; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, endY); ctx.stroke() }
    for (let y = startY; y < endY; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(endX, y); ctx.stroke() }

    // Elements
    for (const el of elementsRef.current) renderElement(ctx, el)

    // Current stroke
    const path = pathRef.current
    if (drawingRef.current && path.length > 1 && tool === 'pen') {
      ctx.strokeStyle = color; ctx.lineWidth = strokeWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y)
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
      ctx.stroke()
    }
    if (drawingRef.current && startRef.current && path.length > 0 && (tool === 'rect' || tool === 'circle')) {
      const s = startRef.current, e = path[path.length - 1]
      ctx.strokeStyle = color; ctx.lineWidth = strokeWidth
      if (tool === 'rect') ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y)
      if (tool === 'circle') {
        ctx.beginPath()
        ctx.ellipse(s.x + (e.x - s.x) / 2, s.y + (e.y - s.y) / 2, Math.abs(e.x - s.x) / 2, Math.abs(e.y - s.y) / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    ctx.restore()

    // Zoom indicator
    ctx.fillStyle = '#71717a'
    ctx.font = '10px monospace'
    ctx.fillText(`${Math.round(zoomRef.current * 100)}%`, 8, h - 8)
  }

  const renderElement = (ctx, el) => {
    ctx.strokeStyle = el.color || '#e4e4e7'; ctx.fillStyle = el.color || '#e4e4e7'
    ctx.lineWidth = el.strokeWidth || 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (el.type === 'path' && el.points?.length > 1) {
      ctx.beginPath(); ctx.moveTo(el.points[0].x, el.points[0].y)
      for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y)
      ctx.stroke()
    } else if (el.type === 'rect') {
      ctx.strokeRect(el.x, el.y, el.w, el.h)
    } else if (el.type === 'circle') {
      ctx.beginPath()
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w) / 2, Math.abs(el.h) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (el.type === 'text') {
      ctx.font = `${el.fontSize || 14}px "SF Mono", monospace`
      ctx.fillText(el.text, el.x, el.y)
    } else if (el.type === 'image' && el._img) {
      ctx.drawImage(el._img, el.x, el.y, el.w, el.h)
    }
  }

  const hitTest = (pos) => {
    for (let i = elementsRef.current.length - 1; i >= 0; i--) {
      const el = elementsRef.current[i]
      if (el.type === 'image' || el.type === 'rect' || el.type === 'circle') {
        if (pos.x >= el.x && pos.x <= el.x + el.w && pos.y >= el.y && pos.y <= el.y + el.h) return i
      } else if (el.type === 'text') {
        if (pos.x >= el.x && pos.x <= el.x + 200 && pos.y >= el.y - 16 && pos.y <= el.y + 4) return i
      }
    }
    return -1
  }

  const pushElement = (el) => {
    undoRef.current = [...undoRef.current, elementsRef.current.map(e => ({...e}))]
    elementsRef.current = [...elementsRef.current, el]
    setElementCount(elementsRef.current.length)
    scheduleSave(); redraw()
  }

  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const clean = elementsRef.current.map(({_img, ...rest}) => rest)
      onChange?.({ elements: clean })
    }, 500)
  }

  const handleMouseDown = (e) => {
    if (e.button === 2) return // right-click handled by contextmenu
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Middle click or Alt+click: pan
      panningRef.current = true
      panStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y }
      return
    }
    if (textInput) return
    const pos = toCanvas(e.clientX, e.clientY)

    if (tool === 'select') {
      const idx = hitTest(pos)
      if (idx >= 0) {
        const el = elementsRef.current[idx]
        dragRef.current = { index: idx, offsetX: pos.x - el.x, offsetY: pos.y - el.y }
      }
      return
    }

    drawingRef.current = true
    startRef.current = pos
    pathRef.current = [pos]
  }

  const handleMouseMove = (e) => {
    if (panningRef.current) {
      panRef.current = { x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y }
      redraw(); return
    }
    if (dragRef.current) {
      const pos = toCanvas(e.clientX, e.clientY)
      const d = dragRef.current
      elementsRef.current[d.index] = { ...elementsRef.current[d.index], x: pos.x - d.offsetX, y: pos.y - d.offsetY }
      redraw(); return
    }
    if (!drawingRef.current) return
    pathRef.current = [...pathRef.current, toCanvas(e.clientX, e.clientY)]
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(redraw)
  }

  const handleMouseUp = () => {
    if (panningRef.current) { panningRef.current = false; return }
    if (dragRef.current) { dragRef.current = null; scheduleSave(); return }
    if (!drawingRef.current) return
    drawingRef.current = false
    const path = pathRef.current, start = startRef.current

    if (tool === 'pen' && path.length > 1) pushElement({ type: 'path', points: path, color, strokeWidth })
    else if (tool === 'rect' && start && path.length > 0) {
      const e = path[path.length - 1]; pushElement({ type: 'rect', x: start.x, y: start.y, w: e.x - start.x, h: e.y - start.y, color, strokeWidth })
    } else if (tool === 'circle' && start && path.length > 0) {
      const e = path[path.length - 1]; pushElement({ type: 'circle', x: start.x, y: start.y, w: e.x - start.x, h: e.y - start.y, color, strokeWidth })
    }
    pathRef.current = []; startRef.current = null; redraw()
  }

  // Right-click → place text, double-right-click → voice note
  const handleContextMenu = (e) => {
    e.preventDefault()
    const pos = toCanvas(e.clientX, e.clientY)
    const now = Date.now()

    if (now - lastRightClick.current < 400) {
      // Double right-click → voice note
      lastRightClick.current = 0
      startVoiceNote(pos)
    } else {
      // Single right-click → text input
      lastRightClick.current = now
      setTextInput(pos)
    }
  }

  const startVoiceNote = (pos) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('Speech recognition not supported'); return }

    setVoicePos(pos)
    setIsRecording(true)

    const rec = new SR()
    rec.continuous = false
    rec.interimResults = false
    rec.lang = navigator.language || 'en-US'

    rec.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript
      }
      if (text.trim()) {
        pushElement({ type: 'text', x: pos.x, y: pos.y + 14, text: text.trim(), color: '#eab308', fontSize: 14 })
      }
      setIsRecording(false)
      setVoicePos(null)
    }

    rec.onerror = () => { setIsRecording(false); setVoicePos(null) }
    rec.onend = () => { setIsRecording(false); setVoicePos(null) }

    try { rec.start(); voiceRecRef.current = rec } catch { setIsRecording(false); setVoicePos(null) }
  }

  const stopVoiceNote = () => {
    if (voiceRecRef.current) { voiceRecRef.current.abort(); voiceRecRef.current = null }
  }

  const handleTextSubmit = (text) => {
    if (text.trim() && textInput) pushElement({ type: 'text', x: textInput.x, y: textInput.y + 14, text: text.trim(), color, fontSize: 14 })
    setTextInput(null)
  }

  // Scroll → zoom
  const handleWheel = (e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(0.1, Math.min(5, zoomRef.current * delta))
    // Zoom toward cursor
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    panRef.current.x = mx - (mx - panRef.current.x) * (newZoom / zoomRef.current)
    panRef.current.y = my - (my - panRef.current.y) * (newZoom / zoomRef.current)
    zoomRef.current = newZoom
    redraw()
  }

  const handleUndo = () => {
    if (undoRef.current.length === 0) return
    elementsRef.current = undoRef.current.pop()
    setElementCount(elementsRef.current.length); scheduleSave(); redraw()
  }

  const handleClear = () => {
    undoRef.current.push(elementsRef.current.map(e => ({...e})))
    elementsRef.current = []; setElementCount(0); scheduleSave(); redraw()
  }

  // Paste images
  useEffect(() => {
    const handler = (e) => {
      for (const item of e.clipboardData?.items || []) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          const url = URL.createObjectURL(blob)
          const img = new window.Image()
          img.onload = () => {
            const scale = Math.min(500 / img.width, 400 / img.height, 1)
            pushElement({ type: 'image', x: 50, y: 50, w: img.width * scale, h: img.height * scale, src: url, _img: img })
          }
          img.src = url
          return
        }
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [color, strokeWidth])

  // Export + attach PNG
  useEffect(() => {
    const handler = async () => {
      const canvas = canvasRef.current
      if (!canvas || canvas.width === 0) return

      // Force a redraw to ensure canvas has content
      redraw()

      // Export canvas to PNG blob
      try {
        const dataUrl = canvas.toDataURL('image/png')
        const filename = `diagram-${Date.now()}.png`

        // Download
        const a = document.createElement('a')
        a.href = dataUrl
        a.download = filename
        a.click()

        // Attach to task — convert data URL to blob directly
        if (taskId) {
          const binaryString = atob(dataUrl.split(',')[1])
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          const blob = new Blob([bytes], { type: 'image/png' })
          const formData = new FormData()
          formData.append('file', blob, filename)
          const uploadRes = await fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: formData })
          if (uploadRes.ok) {
            // Notify the detail modal to refresh attachments
            window.dispatchEvent(new CustomEvent('attachments-updated', { detail: { taskId } }))
          } else {
            console.error('Failed to attach:', await uploadRes.text())
          }
        }
      } catch (e) {
        console.error('Export failed:', e)
      }
    }
    window.addEventListener('excalidraw-export-png', handler)
    return () => window.removeEventListener('excalidraw-export-png', handler)
  }, [taskId])

  useEffect(() => {
    const handler = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); handleUndo() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const tb = (t) => `p-1.5 rounded transition-colors ${tool === t ? 'bg-indigo-600/30 text-indigo-300' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-1 px-1.5 py-1.5 bg-[#0e0e16] border-b border-zinc-800 shrink-0">
        {TOOLS.map((t) => <button key={t.id} onClick={() => setTool(t.id)} className={tb(t.id)} title={t.label}><t.icon size={14} /></button>)}
        <div className="w-px h-4 bg-zinc-800 mx-1" />
        {COLORS.map((c) => <button key={c} onClick={() => setColor(c)} className={`w-3.5 h-3.5 rounded-full border-2 ${color === c ? 'border-white' : 'border-transparent hover:border-zinc-600'}`} style={{ backgroundColor: c }} />)}
        <div className="w-px h-4 bg-zinc-800 mx-1" />
        <select value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} className="bg-[#111118] border border-zinc-700 rounded px-1 py-1.5 text-[11px] text-zinc-400 font-mono">
          <option value={1}>1</option><option value={2}>2</option><option value={4}>4</option><option value={8}>8</option>
        </select>
        <div className="flex-1" />
        <button onClick={handleUndo} className="p-1 text-zinc-500 hover:text-zinc-300" title="Undo ⌘Z"><Undo2 size={13} /></button>
        <button onClick={handleClear} className="p-1 text-zinc-500 hover:text-red-400" title="Clear"><Trash2 size={13} /></button>
        <span className="text-[11px] text-zinc-700 font-mono ml-1">{elementCount}</span>
      </div>

      <div ref={containerRef} className="flex-1 relative" style={{ cursor: tool === 'select' ? 'default' : 'crosshair', minHeight: '200px' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { if (drawingRef.current) handleMouseUp() }}
          onContextMenu={handleContextMenu}
          onWheel={handleWheel}
          style={{ position: 'absolute', top: 0, left: 0 }}
        />
        {textInput && (
          <input
            autoFocus
            className="absolute bg-[#111118]/90 border border-indigo-500 text-zinc-200 font-mono text-[11px] px-1.5 py-1.5 rounded focus:outline-none z-10"
            style={{ left: textInput.x * zoomRef.current + panRef.current.x, top: textInput.y * zoomRef.current + panRef.current.y, minWidth: '150px' }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTextSubmit(e.target.value); if (e.key === 'Escape') setTextInput(null) }}
            onBlur={(e) => handleTextSubmit(e.target.value)}
            placeholder="type note..."
          />
        )}

        {/* Voice recording indicator */}
        {isRecording && voicePos && (
          <div
            className="absolute z-10 flex items-center gap-1 px-2.5 py-1.5 bg-red-500/20 border border-red-500/40 rounded-lg animate-pulse"
            style={{ left: voicePos.x * zoomRef.current + panRef.current.x, top: voicePos.y * zoomRef.current + panRef.current.y - 30 }}
          >
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            <span className="text-[11px] text-red-300 font-mono">listening...</span>
            <button onClick={stopVoiceNote} className="text-[11px] text-red-400 hover:text-red-300 font-mono ml-1">stop</button>
          </div>
        )}
      </div>
    </div>
  )
}
