import { useState, useEffect, useRef } from 'react'
import { X, MessageSquare, Trash2, Send, Check } from 'lucide-react'
import { uuid } from '../../lib/uuid'
import { sendTerminalCommand } from '../../lib/terminal'
import useStore from '../../state/store'
import { Button } from '../ui'

export default function ImageAnnotatorModal({ imageUrl, filename, sessionId, onClose }) {
  const [annotations, setAnnotations] = useState([])
  const [newPin, setNewPin] = useState(null) // { x, y }
  const [commentInput, setCommentInput] = useState('')
  const [activePinId, setActivePinId] = useState(null)
  const [copied, setCopied] = useState(false)
  const imageRef = useRef(null)

  const storageKey = `ive-annotations-${sessionId || 'global'}-${filename || encodeURIComponent(imageUrl)}`

  // Load annotations from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        setAnnotations(JSON.parse(saved))
      }
    } catch (e) {
      console.error('Failed to load annotations:', e)
    }
  }, [storageKey])

  // Save annotations to localStorage
  const saveAnnotations = (list) => {
    setAnnotations(list)
    try {
      localStorage.setItem(storageKey, JSON.stringify(list))
    } catch (e) {
      console.error('Failed to save annotations:', e)
    }
  }

  const handleImageClick = (e) => {
    if (!imageRef.current) return
    const rect = imageRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100

    setNewPin({ x, y })
    setCommentInput('')
    setActivePinId(null)
  }

  const handleAddAnnotation = (e) => {
    e.preventDefault()
    if (!commentInput.trim() || !newPin) return

    const updated = [
      ...annotations,
      {
        id: uuid(),
        x: newPin.x,
        y: newPin.y,
        text: commentInput.trim(),
        timestamp: new Date().toISOString(),
      },
    ]
    saveAnnotations(updated)
    setNewPin(null)
    setCommentInput('')
  }

  const handleDeleteAnnotation = (id, e) => {
    e?.stopPropagation()
    const updated = annotations.filter((ann) => ann.id !== id)
    saveAnnotations(updated)
    if (activePinId === id) setActivePinId(null)
  }

  const handleSendToAgent = () => {
    if (annotations.length === 0 || !sessionId) return
    const commentList = annotations
      .map((ann, idx) => `Pin #${idx + 1} at [x: ${Math.round(ann.x)}%, y: ${Math.round(ann.y)}%] : "${ann.text}"`)
      .join('\n')

    const message = `Here are my annotations on the uploaded file (${filename || 'image'}):\n\n${commentList}`
    sendTerminalCommand(sessionId, message)
    
    // Add visual feedback
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-4 md:p-10 select-none animate-in">
      <div className="relative w-full max-w-5xl h-[85vh] x-panel flex flex-col md:flex-row overflow-hidden">
        {/* Header Close button (Mobile) */}
        <Button type="submit"
          onClick={onClose}
          className="absolute top-4 right-4 z-40 p-2 bg-x-surface border border-x-line text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms] md:hidden"
        >
          <X size={18} />
        </Button>

        {/* Left pane: Interactive Image Canvas */}
        <div className="flex-1 min-h-0 bg-x-surface-2 flex items-center justify-center p-6 relative group overflow-hidden">
          <div className="relative max-w-full max-h-full">
            {/* The Image */}
            <img
              ref={imageRef}
              src={imageUrl}
              alt={filename || "Annotatable image"}
              onClick={handleImageClick}
              className="max-w-full max-h-[70vh] rounded-lg border border-x-line object-contain cursor-crosshair select-none"
              draggable={false}
            />

            {/* Render Saved Pins */}
            {annotations.map((ann, idx) => (
              <div
                key={ann.id}
                style={{ left: `${ann.x}%`, top: `${ann.y}%` }}
                className="annotation-pin"
                onClick={(e) => {
                  e.stopPropagation()
                  setActivePinId(activePinId === ann.id ? null : ann.id)
                  setNewPin(null)
                }}
              >
                <span>{idx + 1}</span>
                <span className="annotation-pin-pulse" />

                {/* Popover overlay tooltip */}
                {activePinId === ann.id && (
                  <div
                    className="absolute bottom-7 left-1/2 -translate-x-1/2 w-48 p-2.5 x-panel text-left z-40 animate-in pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-[11px] leading-relaxed text-x-ink break-words font-sans">
                      {ann.text}
                    </p>
                    <div className="flex justify-between items-center mt-2 pt-1.5 border-t border-x-line">
                      <span className="text-[11px] text-x-muted tabular-nums">Pin #{idx + 1}</span>
                      <button
                        onClick={(e) => handleDeleteAnnotation(ann.id, e)}
                        className="text-x-accent-ink p-0.5 rounded hover:bg-x-accent-ink/10 transition-colors duration-[80ms]"
                        title="Delete pin"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Render Temporary Click Placement Pin */}
            {newPin && (
              <div
                style={{ left: `${newPin.x}%`, top: `${newPin.y}%` }}
                className="absolute w-5 h-5 rounded-full bg-x-accent border border-white flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2 shadow-x-1 animate-pulse z-30"
              >
                <div className="absolute inset-7 w-56 p-3 x-panel text-left pointer-events-auto z-40 transform -translate-x-[calc(50%-10px)] bottom-7 flex flex-col gap-2">
                  <span className="text-[11px] font-medium text-x-accent">Create pin</span>
                  <form onSubmit={handleAddAnnotation} className="flex flex-col gap-2">
                    <textarea
                      autoFocus
                      value={commentInput}
                      onChange={(e) => setCommentInput(e.target.value)}
                      placeholder="Type your comment/instruction..."
                      rows={2}
                      className="w-full bg-x-surface-2 border border-x-line rounded-md p-1.5 text-xs text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none font-sans"
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button
                        type="button"
                        onClick={() => setNewPin(null)}
                        className="px-2 py-1 text-[11px] font-medium text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={!commentInput.trim()}
                        className="px-2.5 py-1 text-[11px] bg-x-accent hover:bg-x-accent-ink active:scale-[.98] disabled:opacity-40 text-x-on-accent font-medium transition-colors duration-[80ms]"
                      >
                        Pin it
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right pane: Side Annotations list & actions */}
        <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-x-line bg-x-surface flex flex-col min-h-0">
          <div className="p-4 border-b border-x-line flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-x-ink truncate max-w-[160px]">{filename || 'Markup image'}</h3>
              <p className="text-[11px] text-x-muted mt-0.5">Click image to annotate</p>
            </div>
            <Button type="submit"
              onClick={onClose}
              className="hidden md:flex p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]"
            >
              <X size={16} />
            </Button>
          </div>

          {/* Annotations List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
            {annotations.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-20 text-x-muted">
                <MessageSquare size={24} className="opacity-40 mb-2" />
                <p className="text-xs">No comments yet</p>
                <p className="text-[11px] opacity-70 mt-1">Pins placed will show up here</p>
              </div>
            ) : (
              annotations.map((ann, idx) => (
                <div
                  key={ann.id}
                  onClick={() => {
                    setActivePinId(ann.id)
                    setNewPin(null)
                  }}
                  className={`p-3 rounded-lg border transition-colors duration-[80ms] cursor-pointer ${
                    activePinId === ann.id
                      ? 'bg-x-tint border-x-accent/45'
                      : 'bg-x-surface border-x-line hover:bg-x-hover hover:border-x-line-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-x-tint text-x-accent text-[11px] font-medium tabular-nums border border-x-accent/30">
                      {idx + 1}
                    </span>
                    <p className="flex-1 text-[11px] leading-relaxed text-x-ink-secondary font-sans break-words pt-0.5">
                      {ann.text}
                    </p>
                    <button
                      onClick={(e) => handleDeleteAnnotation(ann.id, e)}
                      className="p-1 rounded text-x-muted hover:text-x-accent-ink hover:bg-x-accent-ink/10 opacity-0 group-hover:opacity-100 md:opacity-100 transition-opacity duration-[80ms]"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div className="flex justify-between items-center mt-2 text-[11px] text-x-muted tabular-nums">
                    <span>Pos: {Math.round(ann.x)}%, {Math.round(ann.y)}%</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Action buttons */}
          {annotations.length > 0 && sessionId && (
            <div className="p-4 border-t border-x-line flex flex-col gap-2">
              <Button type="submit"
                onClick={handleSendToAgent}
                disabled={copied}
                className={`w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors duration-[80ms] ${
                  copied
                    ? 'bg-x-good/15 border border-x-good/30 text-x-good'
                    : 'bg-x-accent hover:bg-x-accent-ink active:scale-[.98] text-x-on-accent'
                }`}
              >
                {copied ? (
                  <>
                    <Check size={14} />
                    <span>Sent as Agent Prompt!</span>
                  </>
                ) : (
                  <>
                    <Send size={12} />
                    <span>Send Feedbacks to Agent</span>
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
