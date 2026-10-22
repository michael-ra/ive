import { useRef, useState, useEffect, useCallback } from 'react'
import { X, Pen, Square, Circle, ArrowUpRight, Type, Eraser, Undo2, Download, Save } from 'lucide-react'

/**
 * Full-screen image annotation modal.
 *
 * Opens when a pasted image thumbnail is clicked. Renders the source image
 * on a canvas and lets the user draw annotations (pen, rect, circle, arrow,
 * text). Save exports the annotated result as a PNG and calls `onSave(blob)`.
 */

const TOOLS = [
  { id: 'pen',    icon: Pen,           label: 'Pen' },
  { id: 'rect',   icon: Square,        label: 'Rectangle' },
  { id: 'circle', icon: Circle,        label: 'Circle' },
  { id: 'arrow',  icon: ArrowUpRight,  label: 'Arrow' },
  { id: 'text',   icon: Type,          label: 'Text (click to place)' },
  { id: 'eraser', icon: Eraser,        label: 'Eraser (click element)' },
]

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#e4e4e7', '#000000']
const WIDTHS = [2, 4, 8]

export default function ImageAnnotator({ imageSrc, onSave, onClose }) {
  const canvasRef = useRef(null)
  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState('#ef4444')
  const [strokeWidth, setStrokeWidth] = useState(4)
  const [elements, setElements] = useState([]) // drawn annotations
  const [drawing, setDrawing] = useState(null) // in-progress element
  const [img, setImg] = useState(null)         // loaded Image object
  const [textInput, setTextInput] = useState(null) // { x, y } for placing text

  // Load the source image
  useEffect(() => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => setImg(image)
    image.src = imageSrc
  }, [imageSrc])

  // Render canvas whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')

    // Size canvas to image (capped to viewport)
    const maxW = window.innerWidth - 80
    const maxH = window.innerHeight - 160
    const scale = Math.min(1, maxW / img.width, maxH / img.height)
    canvas.width = img.width * scale
    canvas.height = img.height * scale

    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    // Draw committed elements + in-progress element
    const allElements = drawing ? [...elements, drawing] : elements
    for (const el of allElements) {
      ctx.strokeStyle = el.color
      ctx.fillStyle = el.color
      ctx.lineWidth = el.strokeWidth
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      if (el.type === 'pen' && el.points?.length > 1) {
        ctx.beginPath()
        ctx.moveTo(el.points[0][0], el.points[0][1])
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i][0], el.points[i][1])
        }
        ctx.stroke()
      } else if (el.type === 'rect') {
        ctx.strokeRect(el.x, el.y, el.w, el.h)
      } else if (el.type === 'circle') {
        ctx.beginPath()
        const cx = el.x + el.w / 2
        const cy = el.y + el.h / 2
        const rx = Math.abs(el.w / 2)
        const ry = Math.abs(el.h / 2)
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
        ctx.stroke()
      } else if (el.type === 'arrow') {
        ctx.beginPath()
        ctx.moveTo(el.x, el.y)
        ctx.lineTo(el.x + el.w, el.y + el.h)
        ctx.stroke()
        // Arrowhead
        const angle = Math.atan2(el.h, el.w)
        const headLen = Math.max(12, el.strokeWidth * 3)
        ctx.beginPath()
        ctx.moveTo(el.x + el.w, el.y + el.h)
        ctx.lineTo(
          el.x + el.w - headLen * Math.cos(angle - Math.PI / 6),
          el.y + el.h - headLen * Math.sin(angle - Math.PI / 6)
        )
        ctx.moveTo(el.x + el.w, el.y + el.h)
        ctx.lineTo(
          el.x + el.w - headLen * Math.cos(angle + Math.PI / 6),
          el.y + el.h - headLen * Math.sin(angle + Math.PI / 6)
        )
        ctx.stroke()
      } else if (el.type === 'text') {
        ctx.font = `bold ${Math.max(16, el.strokeWidth * 4)}px sans-serif`
        ctx.fillText(el.text, el.x, el.y)
      }
    }
  }, [img, elements, drawing])

  const getPos = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  const handleMouseDown = useCallback((e) => {
    if (!canvasRef.current) return
    const [x, y] = getPos(e)

    if (tool === 'text') {
      setTextInput({ x, y })
      return
    }

    if (tool === 'eraser') {
      // Remove the last element whose bounding area contains the click
      setElements((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const el = prev[i]
          if (hitTest(el, x, y)) {
            return [...prev.slice(0, i), ...prev.slice(i + 1)]
          }
        }
        return prev
      })
      return
    }

    if (tool === 'pen') {
      setDrawing({ type: 'pen', points: [[x, y]], color, strokeWidth })
    } else {
      setDrawing({ type: tool, x, y, w: 0, h: 0, color, strokeWidth })
    }
  }, [tool, color, strokeWidth, getPos])

  const handleMouseMove = useCallback((e) => {
    if (!drawing) return
    const [x, y] = getPos(e)
    if (drawing.type === 'pen') {
      setDrawing((d) => ({ ...d, points: [...d.points, [x, y]] }))
    } else {
      setDrawing((d) => ({ ...d, w: x - d.x, h: y - d.y }))
    }
  }, [drawing, getPos])

  const handleMouseUp = useCallback(() => {
    if (!drawing) return
    // Only commit if the element has meaningful size
    const isTiny = drawing.type === 'pen'
      ? drawing.points.length < 3
      : Math.abs(drawing.w || 0) < 3 && Math.abs(drawing.h || 0) < 3
    if (!isTiny) {
      setElements((prev) => [...prev, drawing])
    }
    setDrawing(null)
  }, [drawing])

  const handleTextSubmit = (text) => {
    if (text?.trim() && textInput) {
      setElements((prev) => [...prev, {
        type: 'text', x: textInput.x, y: textInput.y, text: text.trim(), color, strokeWidth,
      }])
      setTextInput(null) // only clear after committing — avoids blur race with new placements
    }
  }

  const cancelText = () => setTextInput(null)

  const undo = () => setElements((prev) => prev.slice(0, -1))

  const handleSave = async () => {
    if (!canvasRef.current) return
    canvasRef.current.toBlob((blob) => {
      if (blob) onSave(blob)
    }, 'image/png')
  }

  const handleDownload = () => {
    if (!canvasRef.current) return
    const url = canvasRef.current.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = 'annotated.png'
    a.click()
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (textInput) cancelText()
        else onClose()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [textInput, onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-x-scrim backdrop-blur-[4px]"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-x-surface border-b border-x-line shrink-0">
        {/* Tools */}
        <div className="flex items-center gap-0.5">
          {TOOLS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                className={`p-1.5 rounded-md transition-colors duration-[80ms] ${
                  tool === t.id
                    ? 'bg-x-tint text-x-accent'
                    : 'text-x-muted hover:text-x-ink hover:bg-x-hover'
                }`}
                title={t.label}
              >
                <Icon size={16} />
              </button>
            )
          })}
        </div>

        <div className="w-px h-5 bg-x-line mx-1" />

        {/* Colors */}
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full border border-x-line-strong transition-shadow duration-[80ms] ${
                color === c ? 'ring-2 ring-x-accent ring-offset-2 ring-offset-bg-secondary' : ''
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div className="w-px h-5 bg-x-line mx-1" />

        {/* Stroke width */}
        <div className="flex items-center gap-1">
          {WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => setStrokeWidth(w)}
              className={`px-2 py-1 text-[11px] font-medium tabular-nums rounded-md transition-colors duration-[80ms] ${
                strokeWidth === w
                  ? 'bg-x-tint text-x-accent'
                  : 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
              }`}
            >
              {w}px
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-x-line mx-1" />

        {/* Actions */}
        <button
          onClick={undo}
          disabled={elements.length === 0}
          className="p-1.5 text-x-muted hover:text-x-ink hover:bg-x-hover rounded-md disabled:opacity-40 transition-colors duration-[80ms]"
          title="Undo (⌘Z)"
        >
          <Undo2 size={16} />
        </button>

        <div className="flex-1" />

        <span className="text-[11px] text-x-muted tabular-nums mr-2">
          {elements.length} annotation{elements.length !== 1 ? 's' : ''}
        </span>

        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 h-[30px] px-2.5 text-xs font-medium text-x-ink-secondary hover:text-x-ink border border-x-line hover:border-x-line-strong hover:bg-x-hover rounded-md transition-colors duration-[80ms]"
          title="Download PNG"
        >
          <Download size={13} />
          Download
        </button>

        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 h-[30px] px-2.5 text-xs font-medium text-x-on-accent bg-x-accent hover:bg-x-accent-ink active:scale-[.98] rounded-md transition-colors duration-[80ms]"
          title="Save annotated image and insert path into terminal"
        >
          <Save size={13} />
          Save & insert
        </button>

        <button
          onClick={onClose}
          className="p-1.5 text-x-muted hover:text-x-ink hover:bg-x-hover rounded-md ml-1 transition-colors duration-[80ms]"
        >
          <X size={18} />
        </button>
      </div>

      {/* Canvas area */}
      <div className="flex-1 flex items-center justify-center overflow-auto p-4">
        {img ? (
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            className="rounded-lg shadow-x-3"
            style={{ cursor: tool === 'text' ? 'text' : tool === 'eraser' ? 'crosshair' : 'crosshair' }}
          />
        ) : (
          <div className="text-x-muted text-[13px]">Loading image...</div>
        )}
      </div>

      {/* Inline text input (positioned at click point) */}
      {textInput && canvasRef.current && (() => {
        const rect = canvasRef.current.getBoundingClientRect()
        return (
          <input
            ref={(r) => r && setTimeout(() => r.focus(), 0)}
            type="text"
            placeholder="type annotation..."
            className="fixed z-[70] px-2 py-1 text-[13px] bg-x-surface border border-x-accent rounded-md text-x-ink placeholder:text-x-muted shadow-x-1 focus:outline-none focus:ring-[3px] focus:ring-x-focus min-w-[120px]"
            style={{ left: rect.left + textInput.x, top: rect.top + textInput.y - 30 }}
            onKeyDown={(e) => {
              e.stopPropagation() // don't let Escape/Cmd+Z reach the global handler
              if (e.key === 'Enter') handleTextSubmit(e.target.value)
              if (e.key === 'Escape') cancelText()
            }}
            onBlur={(e) => handleTextSubmit(e.target.value)}
          />
        )
      })()}
    </div>
  )
}

// Hit test: check if (x,y) is near an element (for eraser)
function hitTest(el, x, y) {
  const margin = 12
  if (el.type === 'pen' && el.points) {
    return el.points.some(([px, py]) => Math.abs(px - x) < margin && Math.abs(py - y) < margin)
  }
  if (el.type === 'rect' || el.type === 'circle' || el.type === 'arrow') {
    const minX = Math.min(el.x, el.x + (el.w || 0)) - margin
    const maxX = Math.max(el.x, el.x + (el.w || 0)) + margin
    const minY = Math.min(el.y, el.y + (el.h || 0)) - margin
    const maxY = Math.max(el.y, el.y + (el.h || 0)) + margin
    return x >= minX && x <= maxX && y >= minY && y <= maxY
  }
  if (el.type === 'text') {
    return x >= el.x - margin && x <= el.x + 200 && y >= el.y - 30 && y <= el.y + margin
  }
  return false
}
