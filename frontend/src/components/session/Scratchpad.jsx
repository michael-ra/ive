import { useState, useEffect, useRef, useCallback } from 'react'
import { X, StickyNote, Mic, MicOff, Copy, Zap } from 'lucide-react'
import { api } from '../../lib/api'

export default function Scratchpad({ sessionId, onClose }) {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, text }
  const saveTimer = useRef(null)
  const textareaRef = useRef(null)
  const lastRightClick = useRef(0)
  const voiceRecRef = useRef(null)

  // Load scratchpad on mount / session change
  useEffect(() => {
    if (!sessionId) return
    setLoaded(false)
    api.getSessionScratchpad(sessionId).then((res) => {
      setContent(res.scratchpad || '')
      setLoaded(true)
    })
  }, [sessionId])

  // Auto-save with debounce
  const save = useCallback(
    (text) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        setSaving(true)
        await api.updateSessionScratchpad(sessionId, text)
        setSaving(false)
      }, 600)
    },
    [sessionId],
  )

  // Cleanup timers + recording on unmount
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (voiceRecRef.current) { voiceRecRef.current.abort(); voiceRecRef.current = null }
  }, [])

  const handleChange = (e) => {
    const text = e.target.value
    setContent(text)
    save(text)
  }

  // Append text and save
  const appendText = useCallback((text) => {
    setContent((prev) => {
      const next = prev + (prev && !prev.endsWith('\n') ? '\n' : '') + text
      save(next)
      return next
    })
  }, [save])

  // Voice recording — use abort() not stop() for instant mic release
  const stopRecording = useCallback(() => {
    if (voiceRecRef.current) {
      voiceRecRef.current.abort()
      // Don't null the ref here — onend does it to avoid race
    }
    setRecording(false)
  }, [])

  const startRecording = useCallback(() => {
    // Kill any lingering recognition first
    if (voiceRecRef.current) {
      voiceRecRef.current.abort()
      voiceRecRef.current = null
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { alert('Speech recognition not supported — use Chrome or Edge.'); return }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = navigator.language || 'en-US'

    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript
      }
      if (text.trim()) appendText(text.trim())
    }

    rec.onerror = () => { voiceRecRef.current = null; setRecording(false) }
    rec.onend = () => { voiceRecRef.current = null; setRecording(false) }

    try {
      rec.start()
      voiceRecRef.current = rec
      setRecording(true)
    } catch {
      voiceRecRef.current = null
      setRecording(false)
    }
  }, [appendText])

  // Close context menu on any click or scroll
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true) }
  }, [ctxMenu])

  const handleCopy = useCallback(() => {
    if (ctxMenu?.text) navigator.clipboard.writeText(ctxMenu.text)
    setCtxMenu(null)
  }, [ctxMenu])

  const handleCreateFeature = useCallback(() => {
    const text = ctxMenu?.text || ''
    setCtxMenu(null)
    window.dispatchEvent(new CustomEvent('open-quick-feature', { detail: { text } }))
  }, [ctxMenu])

  // Right-click: show context menu with Copy + Create Feature.
  // If recording, stop recording instead. Double-right-click (no selection) starts voice.
  const handleContextMenu = useCallback((e) => {
    e.preventDefault()

    if (voiceRecRef.current) {
      stopRecording()
      return
    }

    // Get selected text from the textarea
    const ta = textareaRef.current
    const selectedText = ta ? ta.value.substring(ta.selectionStart, ta.selectionEnd) : ''

    if (selectedText) {
      // Show custom context menu at cursor position
      setCtxMenu({ x: e.clientX, y: e.clientY, text: selectedText })
    } else {
      // No selection — use double-right-click for voice (legacy behavior)
      const now = Date.now()
      if (now - lastRightClick.current < 400) {
        lastRightClick.current = 0
        startRecording()
      } else {
        lastRightClick.current = now
      }
    }
  }, [startRecording, stopRecording])

  // Escape while recording → stop recording (don't close panel)
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape' && recording) {
      e.preventDefault()
      e.stopPropagation()
      stopRecording()
    }
  }, [recording, stopRecording])

  // Focus textarea when panel opens
  useEffect(() => {
    if (loaded && textareaRef.current) textareaRef.current.focus()
  }, [loaded])

  return (
    <div
      className="flex flex-col h-full bg-[#0e0e16] border-l border-zinc-800"
      style={{ width: 340 }}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-zinc-800">
        <StickyNote size={12} className="text-amber-400/70" />
        <span className="text-[11px] font-mono text-zinc-300 flex-1">Scratchpad</span>
        {recording && (
          <button
            onClick={stopRecording}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-red-500/20 border border-red-500/30 text-red-300 rounded animate-pulse"
          >
            <MicOff size={9} /> stop
          </button>
        )}
        {saving && <span className="text-[11px] font-mono text-zinc-600">saving...</span>}
        {!saving && !recording && loaded && content && <span className="text-[11px] font-mono text-zinc-700">saved</span>}
        <button
          onClick={onClose}
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Recording indicator */}
      {recording && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <Mic size={11} className="text-red-400 animate-pulse" />
          <span className="text-[11px] font-mono text-red-300">listening... right-click or esc to stop</span>
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        placeholder="Notes, links, context...&#10;&#10;Double right-click for voice input&#10;Select text → right-click for options"
        spellCheck={false}
        className="flex-1 w-full resize-none bg-transparent text-zinc-300 text-[12px] font-mono leading-relaxed p-3 placeholder-zinc-700 focus:outline-none selection:bg-indigo-500/30"
      />

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[60] min-w-[180px] bg-[#1a1a24] border border-zinc-700 rounded-md shadow-xl py-1 animate-in"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleCopy}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-mono text-zinc-300 hover:bg-zinc-700/50 transition-colors text-left"
          >
            <Copy size={11} className="text-zinc-500" />
            Copy
          </button>
          <div className="border-t border-zinc-800 my-0.5" />
          <button
            onClick={handleCreateFeature}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-mono text-amber-300 hover:bg-zinc-700/50 transition-colors text-left"
          >
            <Zap size={11} className="text-amber-400" />
            Create Feature
          </button>
        </div>
      )}
    </div>
  )
}
