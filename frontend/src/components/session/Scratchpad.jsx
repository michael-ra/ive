import { useState, useEffect, useRef, useCallback } from 'react'
import { X, StickyNote, Mic, MicOff, Copy, Zap } from 'lucide-react'
import { api } from '../../lib/api'
import { uuid } from '../../lib/uuid'

export default function Scratchpad({ sessionId, onClose, hideHeader = false }) {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, text }
  const saveTimer = useRef(null)
  const textareaRef = useRef(null)
  const lastRightClick = useRef(0)
  const voiceRecRef = useRef(null)
  // Stable per-mount client id so we can ignore our own broadcast echo.
  const clientId = useRef(uuid())
  // Tracks the last time the user typed locally — used to defer remote
  // updates while they're actively editing (avoids cursor jumps).
  const lastTypedAt = useRef(0)
  const isFocused = useRef(false)
  // Holds a pending remote update to apply after focus/idle.
  const pendingRemote = useRef(null)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

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
        await api.updateSessionScratchpad(sessionId, text, clientId.current)
        setSaving(false)
      }, 600)
    },
    [sessionId],
  )

  // Live-sync: receive scratchpad updates from other clients via WS.
  useEffect(() => {
    const onRemote = (e) => {
      const { sessionId: sid, content: incoming, origin } = e.detail || {}
      if (sid !== sessionIdRef.current) return
      if (origin && origin === clientId.current) return // own echo

      const apply = (text) => {
        // Cancel any pending self-save so we don't clobber the incoming value.
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
        setContent(text)
      }

      const recentlyTyped = Date.now() - lastTypedAt.current < 1500
      if (isFocused.current && recentlyTyped) {
        // Defer — apply after the user stops typing or blurs.
        pendingRemote.current = incoming
      } else {
        pendingRemote.current = null
        apply(incoming)
      }
    }
    window.addEventListener('scratchpad-remote-update', onRemote)
    return () => window.removeEventListener('scratchpad-remote-update', onRemote)
  }, [])

  // Cleanup timers + recording on unmount
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (voiceRecRef.current) { voiceRecRef.current.abort(); voiceRecRef.current = null }
  }, [])

  const handleChange = (e) => {
    const text = e.target.value
    lastTypedAt.current = Date.now()
    setContent(text)
    save(text)
  }

  const handleFocus = () => { isFocused.current = true }
  const handleBlur = () => {
    isFocused.current = false
    // Apply any deferred remote update once the user is no longer editing.
    if (pendingRemote.current !== null) {
      const text = pendingRemote.current
      pendingRemote.current = null
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      setContent(text)
    }
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
      className={`flex flex-col h-full bg-x-bg ${hideHeader ? '' : 'border-l border-x-line'}`}
      style={hideHeader ? { width: '100%' } : { width: 340 }}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-x-line">
          <StickyNote size={12} className="text-x-accent-ink/70" />
          <span className="text-[11px] font-mono text-x-ink-secondary flex-1">Scratchpad</span>
          {recording && (
            <button
              onClick={stopRecording}
              className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-x-accent-ink/20 border border-x-accent-ink/30 text-x-accent-ink rounded animate-subtle-pulse"
            >
              <MicOff size={9} /> stop
            </button>
          )}
          {saving && <span className="text-[11px] font-mono text-x-faint">saving...</span>}
          {!saving && !recording && loaded && content && <span className="text-[11px] font-mono text-x-faint">saved</span>}
          <button
            onClick={onClose}
            className="text-x-faint hover:text-x-ink-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Recording indicator */}
      {recording && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-accent-ink/10 border-b border-x-accent-ink/20">
          <Mic size={11} className="text-x-accent-ink animate-subtle-pulse" />
          <span className="text-[11px] font-mono text-x-accent-ink">listening... right-click or esc to stop</span>
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="Notes, links, context...&#10;&#10;Double right-click for voice input&#10;Select text → right-click for options"
        spellCheck={false}
        className="flex-1 w-full resize-none bg-transparent text-x-ink-secondary text-[12px] font-mono leading-relaxed p-3 placeholder-x-muted focus:outline-none selection:bg-x-accent/30"
      />

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[60] min-w-[180px] bg-x-surface border border-x-line rounded-md shadow-x-1 py-1 animate-in"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleCopy}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-mono text-x-ink-secondary hover:bg-x-hover transition-colors text-left"
          >
            <Copy size={11} className="text-x-muted" />
            Copy
          </button>
          <div className="border-t border-x-line my-0.5" />
          <button
            onClick={handleCreateFeature}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-mono text-x-accent-ink hover:bg-x-hover transition-colors text-left"
          >
            <Zap size={11} className="text-x-accent-ink" />
            Create Feature
          </button>
        </div>
      )}
    </div>
  )
}
