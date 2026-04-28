import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Camera, ExternalLink, X, Loader2, RefreshCw, Maximize2, Minimize2, Mic, StickyNote, Trash2, Zap, ChevronRight, Download, Paperclip, Search, Server } from 'lucide-react'
import useStore from '../../state/store'
import { api, rewriteLocalPreviewUrl, demoApi, localPreviewUrl } from '../../lib/api'
import useMediaQuery from '../../hooks/useMediaQuery'
import DemoPanel from './DemoPanel'

export default function LivePreview({ url: initialUrl, taskId: initialTaskId, onScreenshot, onClose }) {
  // When IVE is served via Cloudflare tunnel / multiplayer mode, localhost
  // URLs from worker dev servers must be routed through `/preview/<port>/`
  // — the visitor's browser can't resolve `localhost` on the host machine.
  const [currentUrl, setCurrentUrl] = useState(rewriteLocalPreviewUrl(initialUrl))
  const [loading, setLoading] = useState(true)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState(null)
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false)
  const [previewId, setPreviewId] = useState(null)
  const [needsInstall, setNeedsInstall] = useState(false)
  const [installing, setInstalling] = useState(false)
  // ── Multiplayer-shared preview state ────────────────────
  // When this preview is keyed (workspace + port) the backend may attach
  // us to an existing browser page rather than spawn a new one. Only the
  // current driver can dispatch input/navigate/resize.
  const [shared, setShared] = useState(false)
  const [driverId, setDriverId] = useState(null)
  const [subscriberId, setSubscriberId] = useState(null)
  const [driverDeniedAt, setDriverDeniedAt] = useState(0)
  const isDriver = !shared || (driverId !== null && driverId === subscriberId)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const urlInputRef = useRef(null)
  const wsRef = useRef(null)
  const imgCache = useRef(new Image())
  const lastMouseMove = useRef(0)
  // Touch-pointer tracking: tap → click, drag → wheel scroll. Without this,
  // tapping the canvas on a phone does nothing (canvas only handled mouse
  // events) and scrolling wasn't possible at all over a tunnel.
  const touchPointer = useRef(null) // { startX, startY, lastX, lastY, moved }

  // ── Voice annotation state ──────────────────────────────
  const [notes, setNotes] = useState([])
  const [recording, setRecording] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [savingTask, setSavingTask] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId || null)
  const [taskSearch, setTaskSearch] = useState('')
  const [showTaskPicker, setShowTaskPicker] = useState(false)
  const recRef = useRef(null)
  const recordingRef = useRef(false)
  const pendingTranscript = useRef('')
  const pendingNoteId = useRef(null)
  const taskSearchRef = useRef(null)

  const globalWs = useStore((s) => s.ws)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)

  const wsId = activeWorkspaceId || workspaces[0]?.id

  // ── Demo runner integration ─────────────────────────────
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoStatus, setDemoStatus] = useState(null)
  const [pullingDemo, setPullingDemo] = useState(false)

  // Light poll for demo status while panel is open. Live ws updates also
  // come through DemoPanel — this just keeps the toolbar badge fresh.
  useEffect(() => {
    if (!wsId) return
    let cancelled = false
    async function fetchOnce() {
      try {
        const d = await demoApi.status(wsId)
        if (!cancelled) setDemoStatus(d)
      } catch { /* ignore */ }
    }
    fetchOnce()
    const t = setInterval(fetchOnce, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [wsId])

  // Subscribe to ws demo_state messages so the badge updates instantly
  // even when DemoPanel isn't mounted.
  useEffect(() => {
    if (!globalWs) return
    function onMsg(e) {
      let data
      try { data = JSON.parse(e.data) } catch { return }
      if (data.type === 'demo_state' && data.demo?.workspace_id === wsId) {
        setDemoStatus(data.demo)
      }
    }
    globalWs.addEventListener('message', onMsg)
    return () => globalWs.removeEventListener('message', onMsg)
  }, [globalWs, wsId])

  const handlePullLatest = useCallback(async () => {
    if (!wsId) return
    setPullingDemo(true)
    try {
      const d = await demoApi.pullLatest(wsId)
      setDemoStatus(d)
    } catch (e) {
      setError(`Pull failed: ${e.message}`)
      setTimeout(() => setError(null), 4000)
    } finally {
      setPullingDemo(false)
    }
  }, [wsId])

  // If user hasn't typed a URL and a demo is running, autofill from the
  // demo's port (routed through the preview proxy on tunnel origins).
  useEffect(() => {
    if (!demoStatus || demoStatus.status !== 'running' || !demoStatus.port) return
    if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== '') return
    setCurrentUrl(localPreviewUrl(demoStatus.port, '/'))
  }, [demoStatus, currentUrl])

  // Tasks for current workspace, sorted by most recent
  const workspaceTasks = useMemo(() => {
    return Object.values(tasks)
      .filter(t => t.workspace_id === wsId)
      .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''))
  }, [tasks, wsId])

  const filteredTasks = useMemo(() => {
    if (!taskSearch.trim()) return workspaceTasks.slice(0, 8)
    const q = taskSearch.toLowerCase()
    return workspaceTasks.filter(t => t.title?.toLowerCase().includes(q)).slice(0, 8)
  }, [workspaceTasks, taskSearch])

  const selectedTask = selectedTaskId ? tasks[selectedTaskId] : null

  // ── Playwright preview session ──────────────────────────
  useEffect(() => {
    if (!globalWs || globalWs.readyState !== 1) return

    const container = containerRef.current
    const width = container ? container.clientWidth : 1280
    const height = container ? container.clientHeight : 720

    globalWs.send(JSON.stringify({
      action: 'preview_start',
      url: rewriteLocalPreviewUrl(initialUrl),
      width: Math.round(width),
      height: Math.round(height),
      workspace_id: wsId,
    }))
    wsRef.current = globalWs

    function onMessage(e) {
      let data
      try { data = JSON.parse(e.data) } catch { return }

      if (data.type === 'preview_started') {
        setPreviewId(data.preview_id)
        setShared(Boolean(data.shared))
        setSubscriberId(data.subscriber_id || null)
        setDriverId(data.driver_id || null)
        setLoading(false)
        setNeedsInstall(false)
        setError(null)
      } else if (data.type === 'preview_driver_changed') {
        setDriverId(data.driver_id || null)
      } else if (data.type === 'preview_driver_denied') {
        // Another peer is driving — flash a subtle hint instead of
        // silently dropping the user's clicks.
        setDriverDeniedAt(Date.now())
      } else if (data.type === 'preview_error') {
        setNeedsInstall(true)
        setLoading(false)
      } else if (data.type === 'preview_frame' && canvasRef.current) {
        const img = imgCache.current
        img.onload = () => {
          const canvas = canvasRef.current
          if (!canvas) return
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width
            canvas.height = img.height
          }
          canvas.getContext('2d').drawImage(img, 0, 0)
        }
        img.src = 'data:image/jpeg;base64,' + data.data
      } else if (data.type === 'preview_navigated') {
        setCurrentUrl(data.url)
      } else if (data.type === 'preview_screenshot') {
        const bytes = Uint8Array.from(atob(data.data), c => c.charCodeAt(0))
        const blob = new Blob([bytes], { type: 'image/png' })
        onScreenshot(URL.createObjectURL(blob), currentUrl)
        setCapturing(false)
      }
    }

    globalWs.addEventListener('message', onMessage)
    return () => globalWs.removeEventListener('message', onMessage)
  }, [globalWs])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (previewId && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ action: 'preview_stop', preview_id: previewId }))
      }
      if (recRef.current) { try { recRef.current.abort() } catch {} }
    }
  }, [previewId])

  // ── Install Playwright ──────────────────────────────────
  const installPlaywright = useCallback(async () => {
    setInstalling(true)
    try {
      const resp = await fetch('/api/install-screenshot-tools', { method: 'POST' })
      const data = await resp.json()
      if (data.ok) {
        setNeedsInstall(false)
        setError(null)
        // Retry preview start
        if (globalWs?.readyState === 1) {
          const container = containerRef.current
          globalWs.send(JSON.stringify({
            action: 'preview_start',
            url: currentUrl,
            width: Math.round(container?.clientWidth || 1280),
            height: Math.round(container?.clientHeight || 720),
          }))
          setLoading(true)
        }
      } else {
        const lastStep = data.steps?.[data.steps.length - 1]
        setError(lastStep?.output || 'Installation failed')
      }
    } catch (e) {
      setError(`Install error: ${e.message}`)
    } finally {
      setInstalling(false)
    }
  }, [globalWs, currentUrl])

  // ── Driver claim helper ─────────────────────────────────
  // First interaction from a non-driver subscriber auto-claims control.
  // Server processes WS frames serially, so the claim lands before the
  // input that immediately follows it.
  const ensureDriver = useCallback(() => {
    if (!shared || isDriver || !previewId || wsRef.current?.readyState !== 1) return
    wsRef.current.send(JSON.stringify({ action: 'preview_claim_driver', preview_id: previewId }))
  }, [shared, isDriver, previewId])

  // ── Mouse / keyboard forwarding to Playwright ───────────
  const sendMouseEvent = useCallback((type, e) => {
    if (!previewId || !wsRef.current || !canvasRef.current) return
    // Suppress mousemove storms while watching — they'd flood claim-driver
    // requests. Real interaction (mousedown/up/click) still claims.
    if (type === 'mousemove' && shared && !isDriver) return
    if (type === 'mousemove') {
      const now = Date.now()
      if (now - lastMouseMove.current < 33) return
      lastMouseMove.current = now
    }
    if (type === 'mousedown') ensureDriver()
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const scaleY = canvasRef.current.height / rect.height
    wsRef.current.send(JSON.stringify({
      action: 'preview_input',
      preview_id: previewId,
      event: {
        type,
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
        button: ['left', 'middle', 'right'][e.button] || 'left',
        clickCount: e.detail || 1,
        altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
      },
    }))
  }, [previewId, shared, isDriver, ensureDriver])

  const sendWheelEvent = useCallback((e) => {
    if (!previewId || !wsRef.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const scaleY = canvasRef.current.height / rect.height
    wsRef.current.send(JSON.stringify({
      action: 'preview_input',
      preview_id: previewId,
      event: {
        type: 'wheel',
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
        deltaX: e.deltaX, deltaY: e.deltaY,
        altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
      },
    }))
  }, [previewId])

  // ── Touch handling ──────────────────────────────────────
  // Touch events run alongside the existing mouse-event path; calling
  // preventDefault on touchstart suppresses the synthetic mousedown/up
  // that iOS/Android otherwise fire after a tap, so we don't double-send.
  // Tap → synthesize click; single-finger drag → wheel scroll (Playwright's
  // mouse driver has no native touch path).
  const TAP_SLOP = 8
  const sendWheelDelta = useCallback((clientX, clientY, dx, dy) => {
    if (!previewId || !wsRef.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const scaleY = canvasRef.current.height / rect.height
    wsRef.current.send(JSON.stringify({
      action: 'preview_input',
      preview_id: previewId,
      event: {
        type: 'wheel',
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
        deltaX: dx, deltaY: dy,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      },
    }))
  }, [previewId])

  const sendSyntheticMouse = useCallback((type, clientX, clientY) => {
    if (!previewId || !wsRef.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const scaleY = canvasRef.current.height / rect.height
    wsRef.current.send(JSON.stringify({
      action: 'preview_input',
      preview_id: previewId,
      event: {
        type,
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
        button: 'left', clickCount: 1,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      },
    }))
  }, [previewId])

  const onTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    const t = e.touches[0]
    touchPointer.current = {
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX, lastY: t.clientY,
      moved: false,
    }
    ensureDriver()
  }, [ensureDriver])

  const onTouchMove = useCallback((e) => {
    if (e.touches.length !== 1) return
    const t = touchPointer.current
    if (!t) return
    e.preventDefault()
    const touch = e.touches[0]
    const dxFromStart = touch.clientX - t.startX
    const dyFromStart = touch.clientY - t.startY
    if (!t.moved && Math.hypot(dxFromStart, dyFromStart) < TAP_SLOP) return
    t.moved = true
    // Finger up = page scrolls down → invert deltas.
    const dx = t.lastX - touch.clientX
    const dy = t.lastY - touch.clientY
    t.lastX = touch.clientX
    t.lastY = touch.clientY
    if (dx || dy) sendWheelDelta(touch.clientX, touch.clientY, dx, dy)
  }, [sendWheelDelta])

  const onTouchEnd = useCallback((e) => {
    const t = touchPointer.current
    touchPointer.current = null
    if (!t) return
    e.preventDefault()
    if (!t.moved) {
      sendSyntheticMouse('mousedown', t.lastX, t.lastY)
      sendSyntheticMouse('mouseup', t.lastX, t.lastY)
    }
  }, [sendSyntheticMouse])

  const sendKeyEvent = useCallback((type, e) => {
    if (!previewId || !wsRef.current) return
    if (document.activeElement === urlInputRef.current) return
    if (e.key === 'Escape') return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return
    if (e.key === 'r' && (e.metaKey || e.ctrlKey)) return

    if (type === 'keydown') ensureDriver()
    e.preventDefault()
    wsRef.current.send(JSON.stringify({
      action: 'preview_input',
      preview_id: previewId,
      event: {
        type,
        key: e.key, code: e.code, keyCode: e.keyCode,
        text: e.key.length === 1 ? e.key : '',
        altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
      },
    }))
  }, [previewId, ensureDriver])

  // ── Screenshot ──────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    setCapturing(true)
    setError(null)
    if (previewId && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ action: 'preview_screenshot', preview_id: previewId }))
      setTimeout(() => setCapturing(false), 10000)
    } else {
      try {
        const resp = await fetch(`/api/screenshot?url=${encodeURIComponent(currentUrl)}`)
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Failed (${resp.status})`)
        onScreenshot(URL.createObjectURL(await resp.blob()), currentUrl)
      } catch (e) {
        setError(e.message)
        setTimeout(() => setError(null), 4000)
      } finally {
        setCapturing(false)
      }
    }
  }, [currentUrl, onScreenshot, previewId])

  // ── Navigation ──────────────────────────────────────────
  const doNavigate = useCallback((url) => {
    if (previewId && wsRef.current?.readyState === 1) {
      setLoading(true)
      const u = rewriteLocalPreviewUrl(url)
      wsRef.current.send(JSON.stringify({ action: 'preview_navigate', preview_id: previewId, url: u }))
      setTimeout(() => setLoading(false), 2000)
    }
  }, [previewId])

  const handleReload = () => doNavigate(currentUrl)

  const handleUrlKeyDown = (e) => {
    if (e.key === 'Enter') {
      let u = currentUrl.trim()
      if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
      // Rewrite localhost → /preview/<port>/... when on a tunnel origin
      u = rewriteLocalPreviewUrl(u)
      setCurrentUrl(u)
      doNavigate(u)
    }
  }

  // ── Viewport resize ─────────────────────────────────────
  useEffect(() => {
    if (!previewId || !containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          action: 'preview_resize', preview_id: previewId,
          width: Math.round(width), height: Math.round(height),
        }))
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [previewId])

  // ── Voice annotation: push-to-talk ──────────────────────
  const grabCanvasShot = useCallback(() => {
    if (canvasRef.current) return canvasRef.current.toDataURL('image/png')
    return null
  }, [])

  const startRecording = useCallback(() => {
    if (recordingRef.current) return
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setError('Speech recognition not supported — use Chrome or Edge')
      setTimeout(() => setError(null), 3000)
      return
    }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = navigator.language || 'en-US'
    pendingTranscript.current = ''
    pendingNoteId.current = null

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const t = e.results[i][0].transcript
          pendingTranscript.current += (pendingTranscript.current ? ' ' : '') + t
        }
      }
    }

    rec.onend = () => {
      recRef.current = null
      recordingRef.current = false
      setRecording(false)
      const nid = pendingNoteId.current
      const transcript = pendingTranscript.current.trim() || '(no speech detected)'
      if (nid) {
        setNotes(prev => prev.map(n => n.id === nid ? { ...n, transcript, pending: false } : n))
        pendingNoteId.current = null
      }
    }

    rec.onerror = (e) => {
      if (e.error === 'aborted') return
      console.error('Speech error:', e.error)
      recRef.current = null
      recordingRef.current = false
      setRecording(false)
      const nid = pendingNoteId.current
      if (nid) {
        setNotes(prev => prev.map(n => n.id === nid ? { ...n, transcript: '(recognition failed)', pending: false } : n))
        pendingNoteId.current = null
      }
    }

    try {
      rec.start()
      recRef.current = rec
      recordingRef.current = true
      setRecording(true)
    } catch (e) {
      console.error('Failed to start recording:', e)
    }
  }, [])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current || !recRef.current) return
    const screenshot = grabCanvasShot()
    const noteId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    pendingNoteId.current = noteId

    setNotes(prev => [...prev, {
      id: noteId, screenshot, transcript: null,
      url: currentUrl, timestamp: Date.now(), pending: true,
    }])
    setNotesOpen(true)
    recRef.current.stop()
  }, [grabCanvasShot, currentUrl])

  // ── Global key handlers ─────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'r' && !e.repeat) {
        e.preventDefault()
        e.stopImmediatePropagation()
        startRecording()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); e.stopImmediatePropagation(); return }
      // Don't handle other shortcuts when typing in inputs inside notes panel
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' && document.activeElement !== urlInputRef.current) {
        if (e.key === 'Escape') { setShowTaskPicker(false); return }
        return
      }
      if (document.activeElement === urlInputRef.current) {
        if (e.key === 'Escape') onClose()
        return
      }
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleCapture() }
    }

    const onKeyUp = (e) => {
      if (e.key === 'r' && recordingRef.current) stopRecording()
      else if ((e.key === 'Meta' || e.key === 'Control') && recordingRef.current) stopRecording()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [onClose, handleCapture, startRecording, stopRecording])

  // ── Upload screenshots + build description ──────────────
  // Returns { filenames: string[], markdown: string }
  // Each screenshot gets a unique timestamped filename so multiple
  // batches attached to the same task never overwrite each other.
  const uploadNotesWithScreenshots = useCallback(async (targetTaskId, headerLine) => {
    const batchTs = Date.now().toString(36)
    const filenames = []
    const lines = [headerLine || '']

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      const time = new Date(n.timestamp).toLocaleTimeString()
      const filename = `note_${batchTs}_${i + 1}.png`
      filenames.push(filename)

      lines.push(`Note ${i + 1} — ${time}`)
      lines.push(`Page: ${n.url}`)
      lines.push(`"${n.transcript || '(no transcript)'}"`)

      // Upload screenshot + reference it by attachment URL
      if (n.screenshot) {
        try {
          const resp = await fetch(n.screenshot)
          const blob = await resp.blob()
          const form = new FormData()
          form.append('file', blob, filename)
          await fetch(`/api/tasks/${targetTaskId}/attachments`, { method: 'POST', body: form })
          lines.push(`Screenshot: ${filename} (/api/attachments/${targetTaskId}/${filename})`)
        } catch (e) {
          console.warn('Failed to upload screenshot:', e)
          lines.push('Screenshot: (upload failed)')
        }
      }
      lines.push('')
    }

    return { filenames, markdown: lines.join('\n') }
  }, [notes])

  // ── Create new task from notes ──────────────────────────
  const createTaskFromNotes = useCallback(async () => {
    if (!wsId || notes.length === 0) return
    setSavingTask(true)
    try {
      const hostname = (() => { try { return new URL(notes[0].url).hostname } catch { return 'site' } })()
      const title = taskTitle.trim() || `Preview notes: ${hostname}`

      // Create task first (placeholder description)
      const task = await api.createTask({
        workspace_id: wsId, title,
        description: '(uploading preview notes...)',
        priority: 'normal',
        labels: JSON.stringify(['preview-notes']),
      })

      // Upload screenshots + build description with correct attachment URLs
      const { markdown } = await uploadNotesWithScreenshots(task.id, `Preview Notes\n${'—'.repeat(30)}\n`)

      // Update description with the real content
      await api.updateTask2(task.id, { description: markdown })
      const updated = await api.getTask(task.id)
      useStore.getState().updateTaskInStore(updated)

      setNotes([]); setTaskTitle(''); setNotesOpen(false)
    } catch (e) {
      setError(`Task creation failed: ${e.message}`)
      setTimeout(() => setError(null), 4000)
    } finally {
      setSavingTask(false)
    }
  }, [notes, taskTitle, wsId, uploadNotesWithScreenshots])

  // ── Attach notes to existing task ───────────────────────
  const attachNotesToTask = useCallback(async () => {
    if (!selectedTaskId || notes.length === 0) return
    setSavingTask(true)
    try {
      const task = tasks[selectedTaskId]
      const now = new Date().toLocaleString()

      // Upload screenshots + build description section
      const { markdown } = await uploadNotesWithScreenshots(
        selectedTaskId,
        `Preview Notes (added ${now})\n${'—'.repeat(30)}\n`,
      )

      // Append to existing description
      const existingDesc = task?.description || ''
      const separator = existingDesc ? '\n\n---\n\n' : ''
      await api.updateTask2(selectedTaskId, { description: existingDesc + separator + markdown })

      const updated = await api.getTask(selectedTaskId)
      useStore.getState().updateTaskInStore(updated)

      setNotes([]); setNotesOpen(false)
    } catch (e) {
      setError(`Attach failed: ${e.message}`)
      setTimeout(() => setError(null), 4000)
    } finally {
      setSavingTask(false)
    }
  }, [selectedTaskId, notes, tasks, uploadNotesWithScreenshots])

  const deleteNote = useCallback((id) => {
    setNotes(prev => prev.filter(n => n.id !== id))
  }, [])

  const hasPending = notes.some(n => n.pending)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80">
      {/* ── Toolbar ──────────────────────────────────────── */}
      <div
        className={`flex items-center gap-2 px-3 py-2 bg-[#111118]/95 border-b border-zinc-800 backdrop-blur-sm transition-all overflow-x-auto ${
          toolbarCollapsed ? 'opacity-30 hover:opacity-100 h-8' : ''
        }`}
        onMouseEnter={() => toolbarCollapsed && setToolbarCollapsed(false)}
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <Camera size={14} className="text-indigo-400 shrink-0" />
        <span className="text-[11px] text-zinc-400 font-mono shrink-0">Preview</span>
        {previewId && <span className="text-[9px] text-emerald-500/60 font-mono shrink-0">LIVE</span>}
        {previewId && shared && (
          isDriver ? (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-indigo-500/10 text-indigo-300 border-indigo-500/30 shrink-0"
              title="You are driving this shared preview"
            >
              DRIVING
            </span>
          ) : (
            <button
              onClick={ensureDriver}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 transition-colors ${
                Date.now() - driverDeniedAt < 800
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : 'bg-zinc-700/30 text-zinc-400 border-zinc-600/40 hover:bg-zinc-700/60 hover:text-zinc-200'
              }`}
              title="Another peer is driving — click to take control"
            >
              WATCHING · take control
            </button>
          )
        )}

        <input
          ref={urlInputRef} type="text" value={currentUrl}
          onChange={(e) => setCurrentUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          className="flex-1 min-w-[140px] px-2.5 py-1 text-[11px] font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
          placeholder="URL"
        />

        <button onClick={handleReload} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors" title="Reload">
          <RefreshCw size={13} />
        </button>

        <button onClick={handleCapture} disabled={capturing || needsInstall}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded transition-colors disabled:opacity-50 shrink-0">
          {capturing ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
          <span className="hidden sm:inline">{capturing ? 'Capturing...' : 'Screenshot'}</span>
          <kbd className="text-[9px] text-indigo-400/50 bg-indigo-900/30 px-1 py-0.5 rounded hidden sm:inline">⌘↵</kbd>
        </button>

        {/* Tap-to-record mic toggle — replaces hold-⌘R for touch devices.
            Click once to start recording, click again to stop and save the
            note. Works on desktop too as a click-friendly alternative. */}
        <button
          onClick={() => (recording ? stopRecording() : startRecording())}
          className={`flex items-center justify-center p-1.5 rounded border transition-colors shrink-0 ${
            recording
              ? 'bg-red-500/25 border-red-500/40 text-red-300 animate-pulse'
              : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:text-zinc-200'
          }`}
          title={recording ? 'Stop recording' : 'Record voice note'}
        >
          <Mic size={13} />
        </button>

        {/* Demo badge + Pull Latest */}
        {demoStatus && demoStatus.status !== 'stopped' && (
          <>
            <span
              className={`text-[9px] font-mono px-1.5 py-1 rounded border shrink-0 ${
                demoStatus.status === 'running' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                : demoStatus.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/25'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/25'
              }`}
              title={`Demo: ${demoStatus.status}${demoStatus.port ? ` on :${demoStatus.port}` : ''}`}
            >
              demo{demoStatus.last_commit ? ` @ ${demoStatus.last_commit.slice(0, 7)}` : ''}
            </span>
            <button
              onClick={handlePullLatest}
              disabled={pullingDemo || demoStatus.status === 'building'}
              className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-mono bg-indigo-600/15 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/25 rounded transition-colors disabled:opacity-40 shrink-0"
              title="git pull + reinstall (if needed) + restart on same port"
            >
              {pullingDemo || demoStatus.status === 'building'
                ? <Loader2 size={10} className="animate-spin" />
                : <RefreshCw size={10} />}
              Pull Latest
            </button>
          </>
        )}

        {/* Demo panel toggle */}
        <button
          onClick={() => setDemoOpen(!demoOpen)}
          className={`relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-mono rounded border transition-colors ${
            demoOpen
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
              : 'bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:text-zinc-300'
          }`}
          title="Demo runner panel"
        >
          <Server size={12} />
        </button>

        {/* Notes toggle */}
        <button onClick={() => setNotesOpen(!notesOpen)}
          className={`relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-mono rounded border transition-colors ${
            notesOpen
              ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
              : 'bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:text-zinc-300'
          }`} title="Voice notes panel">
          <StickyNote size={12} />
          {notes.length > 0 && (
            <span className="text-[9px] bg-amber-500/30 text-amber-300 px-1 rounded-full">{notes.length}</span>
          )}
        </button>

        <button onClick={() => window.open(currentUrl, '_blank', 'noopener,noreferrer')}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors" title="Open in new tab">
          <ExternalLink size={13} />
        </button>

        <button onClick={() => setToolbarCollapsed(!toolbarCollapsed)}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          title={toolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'}>
          {toolbarCollapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
        </button>

        <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors" title="Close (Esc)">
          <X size={14} />
        </button>
      </div>

      {/* ── Error toast ──────────────────────────────────── */}
      {error && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 px-4 py-2 text-[11px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 rounded-md backdrop-blur-sm max-w-[500px] break-all">
          {error}
        </div>
      )}

      {/* ── Loading bar ──────────────────────────────────── */}
      {loading && !needsInstall && (
        <div className="absolute top-12 left-0 right-0 h-0.5 bg-zinc-800 z-10">
          <div className="h-full bg-indigo-500/60 animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      {/* ── Main area ────────────────────────────────────── */}
      <div className="flex-1 flex relative overflow-hidden">
        {/* Browser viewport */}
        <div ref={containerRef} className="flex-1 relative">
          {needsInstall ? (
            /* ── Install prompt (no fallback) ──────────── */
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a10]">
              <div className="w-[400px] bg-[#111118] border border-zinc-700 rounded-lg p-6 text-center space-y-4">
                <div className="text-3xl">🎭</div>
                <h3 className="text-[13px] font-mono text-zinc-200 font-medium">Playwright Required</h3>
                <p className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                  Live preview renders websites in a real Chromium browser via Playwright.
                  <br />Install it to use this feature.
                </p>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    onClick={installPlaywright}
                    disabled={installing}
                    className="flex items-center gap-2 px-4 py-2 text-[11px] font-mono font-medium bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-md transition-colors disabled:opacity-50"
                  >
                    {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {installing ? 'Installing...' : 'Install Playwright'}
                  </button>
                  <button onClick={onClose}
                    className="px-4 py-2 text-[11px] font-mono text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded-md transition-colors">
                    Close
                  </button>
                </div>
                {installing && (
                  <p className="text-[9px] font-mono text-zinc-600">
                    This may take a minute — downloading Chromium...
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* ── Playwright canvas ─────────────────────── */
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full bg-white cursor-default"
              tabIndex={0}
              style={{ touchAction: 'none' }}
              onMouseDown={(e) => { e.preventDefault(); sendMouseEvent('mousedown', e) }}
              onMouseUp={(e) => sendMouseEvent('mouseup', e)}
              onMouseMove={(e) => sendMouseEvent('mousemove', e)}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
              onWheel={(e) => { e.preventDefault(); sendWheelEvent(e) }}
              onKeyDown={(e) => sendKeyEvent('keydown', e)}
              onKeyUp={(e) => sendKeyEvent('keyup', e)}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}

          {/* ── Recording overlay ───────────────────────── */}
          {recording && (
            <div className="absolute inset-0 pointer-events-none z-20">
              <div className="absolute inset-0 border-4 border-red-500/60 animate-pulse rounded-sm" />
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-red-600/90 rounded-full shadow-lg backdrop-blur-sm">
                <Mic size={14} className="text-white animate-pulse" />
                <span className="text-[12px] font-mono text-white font-medium">Recording... release ⌘R to capture</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Demo panel (right sidebar; full-width drawer on mobile) ── */}
        {demoOpen && wsId && (
          <div
            className={
              isMobile
                ? 'absolute inset-0 z-30 flex [&>*]:w-full [&>*]:!w-full'
                : 'contents'
            }
          >
            <DemoPanel
              workspaceId={wsId}
              onClose={() => setDemoOpen(false)}
              onPreviewUrl={(u) => { setCurrentUrl(u); doNavigate(u) }}
            />
          </div>
        )}

        {/* ── Notes panel (right sidebar; full-width drawer on mobile) ── */}
        {notesOpen && (
          <div className={`bg-[#0c0c12] border-l border-zinc-800 flex flex-col shrink-0 ${
            isMobile
              ? 'absolute inset-y-0 right-0 left-0 z-30 border-l-0'
              : 'w-[280px]'
          }`}>
            {/* Panel header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <StickyNote size={12} className="text-amber-400" />
              <span className="text-[11px] text-zinc-300 font-mono font-medium">Notes</span>
              <span className="text-[9px] text-zinc-600 font-mono">{notes.length}</span>
              <div className="flex-1" />
              {notes.length > 0 && (
                <button onClick={() => { setNotes([]); setTaskTitle('') }}
                  className="text-[9px] text-zinc-600 hover:text-red-400 font-mono transition-colors">
                  clear all
                </button>
              )}
              <button onClick={() => setNotesOpen(false)} className="p-0.5 rounded hover:bg-zinc-800 text-zinc-600 hover:text-zinc-400">
                <ChevronRight size={12} />
              </button>
            </div>

            {/* Notes list */}
            <div className="flex-1 overflow-y-auto">
              {notes.length === 0 ? (
                <div className="p-4 text-center">
                  <Mic size={20} className="text-zinc-700 mx-auto mb-2" />
                  <p className="text-[10px] text-zinc-600 font-mono leading-relaxed">
                    Hold <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">⌘R</kbd> to record a voice note.
                    <br />Screenshot is captured on release.
                  </p>
                </div>
              ) : (
                notes.map((note, i) => (
                  <div key={note.id} className="border-b border-zinc-800/50 group">
                    {note.screenshot && (
                      <div className="relative">
                        <img src={note.screenshot} alt={`Note ${i + 1}`}
                          className="w-full h-auto object-cover max-h-[140px]" />
                        <div className="absolute top-1 left-1.5 flex items-center gap-1 px-1.5 py-0.5 bg-black/70 rounded text-[8px] font-mono text-zinc-400">
                          #{i + 1}
                          <span className="text-zinc-600">{new Date(note.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <button onClick={() => deleteNote(note.id)}
                          className="absolute top-1 right-1.5 p-1 bg-black/60 rounded text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 size={10} />
                        </button>
                      </div>
                    )}
                    <div className="px-2.5 py-2">
                      {note.pending ? (
                        <div className="flex items-center gap-1.5 text-[10px] text-amber-400/70 font-mono">
                          <Loader2 size={10} className="animate-spin" /> transcribing...
                        </div>
                      ) : (
                        <p className="text-[10px] text-zinc-300 font-mono leading-relaxed">{note.transcript}</p>
                      )}
                      <p className="text-[8px] text-zinc-600 font-mono mt-1 truncate" title={note.url}>{note.url}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ── Save to task section ──────────────────── */}
            {notes.length > 0 && (
              <div className="border-t border-zinc-800 p-2.5 space-y-2">
                {/* Task picker */}
                <div className="relative">
                  {selectedTask ? (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded text-[10px] font-mono text-indigo-300">
                      <Paperclip size={9} className="shrink-0" />
                      <span className="truncate flex-1">{selectedTask.title}</span>
                      <button onClick={() => setSelectedTaskId(null)} className="text-indigo-400/50 hover:text-indigo-300 shrink-0">
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
                      <input
                        ref={taskSearchRef}
                        type="text"
                        value={taskSearch}
                        onChange={(e) => { setTaskSearch(e.target.value); setShowTaskPicker(true) }}
                        onFocus={() => setShowTaskPicker(true)}
                        onBlur={() => setTimeout(() => setShowTaskPicker(false), 150)}
                        placeholder="Attach to existing task..."
                        className="w-full pl-6 pr-2 py-1.5 text-[10px] font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                      />
                    </div>
                  )}

                  {/* Task dropdown */}
                  {showTaskPicker && !selectedTask && filteredTasks.length > 0 && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-[#111118] border border-zinc-700 rounded shadow-xl max-h-[200px] overflow-y-auto z-10">
                      {filteredTasks.map(t => (
                        <button key={t.id}
                          onMouseDown={(e) => { e.preventDefault(); setSelectedTaskId(t.id); setShowTaskPicker(false); setTaskSearch('') }}
                          className="w-full text-left px-2.5 py-1.5 text-[10px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            t.status === 'in_progress' ? 'bg-blue-400' :
                            t.status === 'todo' ? 'bg-amber-400' :
                            t.status === 'done' ? 'bg-emerald-400' : 'bg-zinc-600'
                          }`} />
                          <span className="truncate">{t.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                {selectedTask ? (
                  <button onClick={attachNotesToTask} disabled={savingTask || hasPending}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] font-mono font-medium bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/25 rounded transition-colors disabled:opacity-40">
                    {savingTask ? <Loader2 size={10} className="animate-spin" /> : <Paperclip size={10} />}
                    {savingTask ? 'Attaching...' : `Attach ${notes.length} note${notes.length > 1 ? 's' : ''}`}
                  </button>
                ) : (
                  <>
                    <input type="text" value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder={`Preview notes: ${(() => { try { return new URL(notes[0]?.url).hostname } catch { return 'site' } })()}`}
                      className="w-full px-2 py-1.5 text-[10px] font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                    />
                    <button onClick={createTaskFromNotes} disabled={savingTask || hasPending}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] font-mono font-medium bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/25 rounded transition-colors disabled:opacity-40">
                      {savingTask ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                      {savingTask ? 'Creating...' : `Create Task (${notes.length} note${notes.length > 1 ? 's' : ''})`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom hint bar ──────────────────────────────── */}
      <div className="px-3 py-1.5 bg-[#111118]/95 border-t border-zinc-800 text-center">
        <span className="text-[9px] text-zinc-600 font-mono">
          {recording
            ? 'speaking... release ⌘R to capture screenshot + save note'
            : needsInstall
              ? 'install Playwright to enable live browser preview'
              : 'hold ⌘R voice note · ⌘↵ screenshot · click & scroll to interact · esc close'}
        </span>
      </div>
    </div>
  )
}
