import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Camera, ExternalLink, X, Loader2, RefreshCw, Maximize2, Minimize2, Mic, StickyNote, Trash2, Zap, ChevronRight, Download, Paperclip, Search, Server, PictureInPicture2 } from 'lucide-react'
import useStore from '../../state/store'
import { api, rewriteLocalPreviewUrl, demoApi, localPreviewUrl } from '../../lib/api'
import useMediaQuery from '../../hooks/useMediaQuery'
import DemoPanel from './DemoPanel'
import { Button } from '../ui'

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
  const [pipOpen, setPipOpen] = useState(false)
  const pipWindowRef = useRef(null)
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

  // ── Desktop / Screen Share state ────────────────────────
  const [previewSource, setPreviewSource] = useState('playwright') // playwright | screen
  const screenStreamRef = useRef(null)
  const videoRef = useRef(null)
  const previewSourceRef = useRef(previewSource)

  useEffect(() => {
    previewSourceRef.current = previewSource
  }, [previewSource])

  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop())
      screenStreamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current = null
    }
  }, [])

  const startScreenShare = useCallback(async () => {
    stopScreenShare()
    try {
      setLoading(true)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: false,
      })
      screenStreamRef.current = stream

      const video = document.createElement('video')
      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      videoRef.current = video

      let active = true
      const drawFrame = () => {
        if (!active) return
        const canvas = canvasRef.current
        if (canvas && video.readyState >= 2) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
          }
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0)
        }
        requestAnimationFrame(drawFrame)
      }

      video.onloadedmetadata = () => {
        setLoading(false)
        drawFrame()
      }

      stream.getVideoTracks()[0].onended = () => {
        active = false
        setPreviewSource('playwright')
      }

    } catch (err) {
      console.error('Failed to start screen share:', err)
      setError(`Screen share failed: ${err.message}`)
      setTimeout(() => setError(null), 4000)
      setPreviewSource('playwright')
      setLoading(false)
    }
  }, [stopScreenShare])

  useEffect(() => {
    if (previewSource === 'screen') {
      startScreenShare()
    } else {
      stopScreenShare()
    }
    return () => {
      stopScreenShare()
    }
  }, [previewSource, startScreenShare, stopScreenShare])

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
        if (previewSourceRef.current !== 'playwright') return
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
  const grabCanvasShot = useCallback(() => {
    // In screen-share mode the on-screen canvas is driven by requestAnimationFrame,
    // which throttles or stops when Chrome is backgrounded — exactly when the
    // floating PiP controls are most likely being used. Draw directly from the
    // video element here so the captured frame is always live.
    if (previewSourceRef.current === 'screen' && videoRef.current && videoRef.current.videoWidth) {
      const v = videoRef.current
      const off = document.createElement('canvas')
      off.width = v.videoWidth
      off.height = v.videoHeight
      off.getContext('2d').drawImage(v, 0, 0)
      return off.toDataURL('image/png')
    }
    if (canvasRef.current) return canvasRef.current.toDataURL('image/png')
    return null
  }, [])

  const sendMouseEvent = useCallback((type, e) => {
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current !== 'playwright') return
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
    if (previewSourceRef.current === 'screen') {
      try {
        const dataUrl = grabCanvasShot()
        if (dataUrl) {
          const binaryString = atob(dataUrl.split(',')[1])
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          const blob = new Blob([bytes], { type: 'image/png' })
          onScreenshot(URL.createObjectURL(blob), 'Desktop capture')
        }
      } catch (e) {
        setError(`Capture failed: ${e.message}`)
        setTimeout(() => setError(null), 4000)
      } finally {
        setCapturing(false)
      }
      return
    }
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
  }, [currentUrl, onScreenshot, previewId, grabCanvasShot])

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

  // In Desktop / screen-share mode the iframe's currentUrl (the IVE app
  // itself) has nothing to do with what the user is actually capturing.
  // Use the MediaStreamTrack label — Chrome populates it with the window
  // title or display name — so saved notes describe the real source.
  const captureSourceLabel = useCallback(() => {
    if (previewSourceRef.current === 'screen' && screenStreamRef.current) {
      const track = screenStreamRef.current.getVideoTracks?.()[0]
      const label = track?.label?.trim()
      const surface = track?.getSettings?.().displaySurface || 'screen'
      if (label) return `Desktop · ${label}`
      return `Desktop capture (${surface})`
    }
    return currentUrl
  }, [currentUrl])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current || !recRef.current) return
    const screenshot = grabCanvasShot()
    const noteId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    pendingNoteId.current = noteId

    setNotes(prev => [...prev, {
      id: noteId, screenshot, transcript: null,
      url: captureSourceLabel(), timestamp: Date.now(), pending: true,
    }])
    setNotesOpen(true)
    recRef.current.stop()
  }, [grabCanvasShot, captureSourceLabel])

  // ── Document Picture-in-Picture controller ──────────────
  // In Desktop / screen-share mode the user clicks away from Chrome to work
  // in the app they're capturing, so window-level keyboard shortcuts never
  // fire. The PiP window stays on top across apps and gives the user
  // clickable Record / Screenshot buttons without refocusing Chrome.
  // Chromium-only; falls back to an error toast on unsupported browsers.
  const closePipController = useCallback(() => {
    const w = pipWindowRef.current
    pipWindowRef.current = null
    setPipOpen(false)
    if (w) { try { w.close() } catch {} }
  }, [])

  const openPipController = useCallback(async () => {
    if (pipWindowRef.current) return
    if (!('documentPictureInPicture' in window)) {
      setError('Picture-in-Picture not supported — use Chrome or Edge')
      setTimeout(() => setError(null), 4000)
      return
    }
    try {
      const pip = await window.documentPictureInPicture.requestWindow({ width: 260, height: 88 })
      pipWindowRef.current = pip
      setPipOpen(true)

      // Document Picture-in-Picture opens a fully separate document with its
      // own head — it can't inherit the app's CSS custom properties, so this
      // stays a literal stylesheet. It carries a small copy of the IVE brand tokens
      // because the separate document cannot inherit the app stylesheet.
      const style = pip.document.createElement('style')
      style.textContent = `
        :root { --x-bg: #F4F5F6; --x-surface: #FFFFFF; --x-surface-2: #EBEDEF; --x-ink: #15171A; --x-muted: #4A4F55; --x-line: #DDE0E3; --x-accent: #1647FF; --x-accent-ink: #0E36C7; --x-tint: #EDF1FF; --x-tint-line: #A6B8FF; }
        body { margin: 0; background: var(--x-bg); font-family: "Source Sans 3", system-ui, -apple-system, sans-serif; color: var(--x-ink); user-select: none; -webkit-user-select: none; }
        .row { display: flex; gap: 8px; padding: 10px; align-items: stretch; height: 100vh; box-sizing: border-box; }
        button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--x-line); background: var(--x-surface); color: var(--x-ink); font-size: 11px; font-weight: 500; font-family: inherit; cursor: pointer; transition: background 80ms cubic-bezier(0.2,0,0,1); }
        button:hover { background: var(--x-surface-2); }
        button.rec { background: var(--x-surface-2); border-color: var(--x-line); color: var(--x-ink); }
        button.rec.active { background: var(--x-tint); border-color: var(--x-tint-line); color: var(--x-accent-ink); animation: pulse 1.1s infinite; }
        button.shot { background: var(--x-tint); border-color: var(--x-tint-line); color: var(--x-accent-ink); }
        button.shot:hover { background: var(--x-surface); }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.65; } }
      `
      pip.document.head.appendChild(style)

      const wrap = pip.document.createElement('div')
      wrap.className = 'row'
      const recBtn = pip.document.createElement('button')
      recBtn.className = 'rec'
      recBtn.id = 'pip-rec'
      recBtn.textContent = '● Record'
      const shotBtn = pip.document.createElement('button')
      shotBtn.className = 'shot'
      shotBtn.id = 'pip-shot'
      shotBtn.textContent = '◉ Capture'
      wrap.appendChild(recBtn)
      wrap.appendChild(shotBtn)
      pip.document.body.appendChild(wrap)

      recBtn.addEventListener('click', () => {
        if (recordingRef.current) stopRecording()
        else startRecording()
      })
      shotBtn.addEventListener('click', () => { handleCapture() })

      pip.addEventListener('pagehide', () => {
        pipWindowRef.current = null
        setPipOpen(false)
      })
    } catch (e) {
      setError(`Floating controls failed: ${e.message}`)
      setTimeout(() => setError(null), 4000)
    }
  }, [startRecording, stopRecording, handleCapture])

  // Reflect recording state in the PiP button so the user can see it from
  // whichever app they're working in.
  useEffect(() => {
    const pip = pipWindowRef.current
    if (!pip) return
    const btn = pip.document.getElementById('pip-rec')
    if (btn) {
      btn.classList.toggle('active', recording)
      btn.textContent = recording ? '■ Stop' : '● Record'
    }
  }, [recording])

  // Close PiP when leaving Desktop mode — Browser mode has the canvas in
  // focus already and doesn't need the floating helper.
  useEffect(() => {
    if (previewSource !== 'screen' && pipWindowRef.current) closePipController()
  }, [previewSource, closePipController])

  useEffect(() => () => closePipController(), [closePipController])

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
      lines.push(`Source: ${n.url}`)
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
  const dedupForceRef = useRef(false)
  const createTaskFromNotes = useCallback(async () => {
    if (!wsId || notes.length === 0) return
    setSavingTask(true)
    const force = dedupForceRef.current
    try {
      const sourceShort = (() => {
        const first = notes[0].url || ''
        try { return new URL(first).hostname } catch {}
        // Desktop captures show up as "Desktop · <window title>" — strip the
        // prefix so the auto-title isn't "Preview notes: Desktop · ...".
        return first.replace(/^Desktop · /, '').slice(0, 40) || 'capture'
      })()
      const title = taskTitle.trim() || `Preview notes: ${sourceShort}`

      // Create task first (placeholder description)
      const task = await api.createTask({
        workspace_id: wsId, title,
        description: '(uploading preview notes...)',
        priority: 'normal',
        labels: JSON.stringify(['preview-notes']),
        ...(force && { force: true }),
      })
      dedupForceRef.current = false

      // Upload screenshots + build description with correct attachment URLs
      const { markdown } = await uploadNotesWithScreenshots(task.id, `Preview Notes\n${'—'.repeat(30)}\n`)

      // Update description with the real content
      await api.updateTask2(task.id, { description: markdown })
      const updated = await api.getTask(task.id)
      useStore.getState().updateTaskInStore(updated)

      setNotes([]); setTaskTitle(''); setNotesOpen(false)
    } catch (e) {
      if (e?.status === 409 && e.body?.candidates?.length) {
        const top = e.body.candidates[0]
        // Arm the next click as force-create so the user can confirm by
        // pressing Save again. Cleared after 8s with the error toast.
        dedupForceRef.current = true
        setError(
          `Possible duplicate: "${top.title}". Edit the title to differentiate, ` +
          `or click Save again to create anyway.`,
        )
        setTimeout(() => {
          setError(null)
          dedupForceRef.current = false
        }, 8000)
      } else {
        setError(`Task creation failed: ${e.message}`)
        setTimeout(() => setError(null), 4000)
      }
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
    <div className="fixed inset-0 z-50 flex flex-col bg-x-scrim backdrop-blur-[4px]">
      {/* ── Toolbar ──────────────────────────────────────── */}
      <div
        className={`flex items-center gap-2 px-3 py-2 bg-x-surface border-b border-x-line transition-all duration-[180ms] ease-x overflow-x-auto ${
          toolbarCollapsed ? 'opacity-30 hover:opacity-100 h-8' : ''
        }`}
        onMouseEnter={() => toolbarCollapsed && setToolbarCollapsed(false)}
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <Camera size={14} className="text-x-accent shrink-0" />
        <span className="text-[11px] text-x-muted shrink-0">Preview</span>
        {previewId && <span className="text-[11px] font-medium text-x-good/80 shrink-0">LIVE</span>}
        {previewId && shared && (
          isDriver ? (
            <span
              className="text-[11px] font-medium px-1.5 py-0.5 rounded-md border bg-x-tint text-x-accent border-x-accent/30 shrink-0"
              title="You are driving this shared preview"
            >
              DRIVING
            </span>
          ) : (
            <Button type="submit"
              onClick={ensureDriver}
              className={`text-[11px] font-medium px-1.5 py-0.5 border shrink-0 transition-colors duration-[80ms] ${
                Date.now() - driverDeniedAt < 800
                  ? 'bg-x-accent-ink/20 text-x-accent-ink border-x-accent-ink/40'
                  : 'bg-x-hover/50 text-x-muted border-x-line/60 hover:bg-x-hover/80 hover:text-x-ink'
              }`}
              title="Another peer is driving — click to take control"
            >
              WATCHING · take control
            </Button>
          )
        )}

        {/* Source Toggle */}
        <div className="flex bg-x-surface-2 border border-x-line rounded-md p-0.5 shrink-0 select-none">
          <button
            onClick={() => setPreviewSource('playwright')}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors duration-[80ms] ${
              previewSource === 'playwright'
                ? 'bg-x-tint text-x-accent border border-x-accent/30 font-medium'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            Browser
          </button>
          <button
            onClick={() => {
              // Desktop mode is unusable without the floating controls — once
              // the user picks a window to share, Chrome loses focus and
              // keyboard shortcuts stop reaching the page. Pop PiP here, in
              // the same synchronous task as the click, so the gesture is
              // still warm. getDisplayMedia gets its own activation check
              // when the useEffect fires next tick.
              if (previewSource !== 'screen' && 'documentPictureInPicture' in window && !pipWindowRef.current) {
                openPipController().catch(() => {})
              }
              setPreviewSource('screen')
            }}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors duration-[80ms] ${
              previewSource === 'screen'
                ? 'bg-x-tint text-x-accent border border-x-accent/30 font-medium'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            Desktop
          </button>
        </div>

        <input
          ref={urlInputRef} type="text"
          value={previewSource === 'screen' ? 'Desktop / Screen Capture' : currentUrl}
          onChange={(e) => setCurrentUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          disabled={previewSource === 'screen'}
          className={`flex-1 min-w-[140px] px-2.5 py-1 text-[11px] font-mono border rounded placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus ${
            previewSource === 'screen'
              ? 'bg-x-surface-2/50 border-x-line text-x-muted cursor-not-allowed select-none'
              : 'bg-x-surface-2 border-x-line text-x-ink-secondary'
          }`}
          placeholder="URL"
        />

        <Button type="submit" onClick={handleReload} disabled={previewSource === 'screen'} className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms] disabled:opacity-30 disabled:cursor-not-allowed" title="Reload">
          <RefreshCw size={13} />
        </Button>

        <Button type="submit" onClick={handleCapture} disabled={capturing || (previewSource === 'playwright' && needsInstall)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border border-x-accent/30 transition-colors duration-[80ms] disabled:opacity-50 shrink-0">
          {capturing ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
          <span className="hidden sm:inline">{capturing ? 'Capturing...' : 'Screenshot'}</span>
          <kbd className="text-[11px] text-x-accent/70 bg-x-accent/15 px-1 py-0.5 rounded hidden sm:inline">⌘↵</kbd>
        </Button>

        {/* Tap-to-record mic toggle — replaces hold-⌘R for touch devices.
            Click once to start recording, click again to stop and save the
            note. Works on desktop too as a click-friendly alternative. */}
        <Button type="submit"
          onClick={() => (recording ? stopRecording() : startRecording())}
          className={`flex items-center justify-center p-1.5 border transition-colors duration-[80ms] shrink-0 ${
            recording
              ? 'bg-x-accent-ink/20 border-x-accent-ink/40 text-x-accent-ink animate-pulse'
              : 'bg-x-hover/60 border-x-line text-x-muted hover:text-x-ink'
          }`}
          title={recording ? 'Stop recording' : 'Record voice note'}
        >
          <Mic size={13} />
        </Button>

        {/* Float controls in PiP — only useful in Desktop mode where the
            user is working in another app and can't reach Chrome's window
            shortcuts. */}
        {previewSource === 'screen' && (
          <Button type="submit"
            onClick={() => (pipOpen ? closePipController() : openPipController())}
            className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border transition-colors duration-[80ms] shrink-0 ${
              pipOpen
                ? 'bg-x-accent-ink/15 border-x-accent-ink/35 text-x-accent-ink'
                : 'bg-x-hover/60 border-x-line text-x-muted hover:text-x-ink'
            }`}
            title={pipOpen ? 'Close floating controls' : 'Open floating controls — always-on-top buttons that work while you\'re in another app'}
          >
            <PictureInPicture2 size={11} />
            <span className="hidden sm:inline">{pipOpen ? 'Floating' : 'Float'}</span>
          </Button>
        )}

        {/* Demo badge + Pull Latest */}
        {previewSource === 'playwright' && demoStatus && demoStatus.status !== 'stopped' && (
          <>
            <span
              className={`text-[11px] font-mono px-1.5 py-1 rounded-md border shrink-0 ${
                demoStatus.status === 'running' ? 'bg-x-good/10 text-x-good border-x-good/30'
                : demoStatus.status === 'error' ? 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30'
                : 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30'
              }`}
              title={`Demo: ${demoStatus.status}${demoStatus.port ? ` on :${demoStatus.port}` : ''}`}
            >
              demo{demoStatus.last_commit ? ` @ ${demoStatus.last_commit.slice(0, 7)}` : ''}
            </span>
            <Button type="submit"
              onClick={handlePullLatest}
              disabled={pullingDemo || demoStatus.status === 'building'}
              className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-x-accent/10 hover:bg-x-accent/20 text-x-accent border border-x-accent/30 transition-colors duration-[80ms] disabled:opacity-40 shrink-0"
              title="git pull + reinstall (if needed) + restart on same port"
            >
              {pullingDemo || demoStatus.status === 'building'
                ? <Loader2 size={10} className="animate-spin" />
                : <RefreshCw size={10} />}
              Pull Latest
            </Button>
          </>
        )}

        {/* Demo panel toggle */}
        <Button type="submit"
          onClick={() => setDemoOpen(!demoOpen)}
          className={`relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border transition-colors duration-[80ms] ${
            demoOpen
              ? 'bg-x-good/15 border-x-good/30 text-x-good'
              : 'bg-x-hover/60 border-x-line text-x-muted hover:text-x-ink-secondary'
          }`}
          title="Demo runner panel"
        >
          <Server size={12} />
        </Button>

        {/* Notes toggle */}
        <Button type="submit" onClick={() => setNotesOpen(!notesOpen)}
          className={`relative flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border transition-colors duration-[80ms] ${
            notesOpen
              ? 'bg-x-accent-ink/15 border-x-accent-ink/35 text-x-accent-ink'
              : 'bg-x-hover/60 border-x-line text-x-muted hover:text-x-ink-secondary'
          }`} title="Voice notes panel">
          <StickyNote size={12} />
          {notes.length > 0 && (
            <span className="text-[11px] font-medium tabular-nums bg-x-accent-ink/25 text-x-accent-ink px-1 rounded-full">{notes.length}</span>
          )}
        </Button>

        <Button type="submit" onClick={() => window.open(currentUrl, '_blank', 'noopener,noreferrer')}
          className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]" title="Open in new tab">
          <ExternalLink size={13} />
        </Button>

        <Button type="submit" onClick={() => setToolbarCollapsed(!toolbarCollapsed)}
          className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
          title={toolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'}>
          {toolbarCollapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
        </Button>

        <Button type="submit" onClick={onClose} className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]" title="Close (Esc)">
          <X size={14} />
        </Button>
      </div>

      {/* ── Error toast ──────────────────────────────────── */}
      {error && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 px-4 py-2 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md shadow-x-1 max-w-[500px] break-all">
          {error}
        </div>
      )}

      {/* ── Loading bar ──────────────────────────────────── */}
      {loading && !needsInstall && (
        <div className="absolute top-12 left-0 right-0 h-0.5 bg-x-hover z-10">
          <div className="h-full bg-x-accent/70 animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      {/* ── Main area ────────────────────────────────────── */}
      <div className="flex-1 flex relative overflow-hidden">
        {/* Browser viewport */}
        <div ref={containerRef} className="flex-1 relative">
          {needsInstall && previewSource !== 'screen' ? (
            /* ── Install prompt (no fallback) ──────────── */
            <div className="absolute inset-0 flex items-center justify-center bg-x-bg">
              <div className="w-[400px] bg-x-surface border border-x-line rounded-xl p-6 text-center space-y-4 shadow-x-3">
                <div className="text-3xl">🎭</div>
                <h3 className="text-sm font-semibold text-x-ink">Playwright Required</h3>
                <p className="text-[13px] text-x-ink-secondary leading-relaxed">
                  Live preview renders websites in a real Chromium browser via Playwright.
                  <br />Install it to use this feature.
                </p>
                <div className="flex flex-col items-center gap-3 pt-2">
                  <div className="flex items-center justify-center gap-3">
                    <Button type="submit"
                      onClick={installPlaywright}
                      disabled={installing}
                      className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border border-x-accent/30 transition-colors duration-[80ms] disabled:opacity-50"
                    >
                      {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                      {installing ? 'Installing...' : 'Install Playwright'}
                    </Button>
                    <Button type="submit" onClick={onClose}
                      className="px-4 py-2 text-[13px] font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]">
                      Close
                    </Button>
                  </div>
                  <div className="text-[11px] text-x-muted">
                    or{' '}
                    <button
                      onClick={() => setPreviewSource('screen')}
                      className="text-x-accent hover:text-x-accent-ink underline bg-transparent border-0 cursor-pointer p-0"
                    >
                      Use Desktop Share
                    </button>{' '}
                    to annotate any window/screen directly.
                  </div>
                </div>
                {installing && (
                  <p className="text-[11px] text-x-muted">
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
              <div className="absolute inset-0 border-4 border-x-accent-ink/60 animate-pulse rounded-sm" />
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-x-accent-ink rounded-full shadow-x-3">
                <Mic size={14} className="text-x-on-accent animate-pulse" />
                <span className="text-[12px] text-x-on-accent font-medium">Recording... release ⌘R to capture</span>
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
          <div className={`bg-x-surface border-l border-x-line flex flex-col shrink-0 ${
            isMobile
              ? 'absolute inset-y-0 right-0 left-0 z-30 border-l-0'
              : 'w-[280px]'
          }`}>
            {/* Panel header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-x-line">
              <StickyNote size={12} className="text-x-accent-ink" />
              <span className="text-[11px] text-x-ink-secondary font-medium">Notes</span>
              <span className="text-[11px] text-x-muted tabular-nums">{notes.length}</span>
              <div className="flex-1" />
              {notes.length > 0 && (
                <button onClick={() => { setNotes([]); setTaskTitle('') }}
                  className="text-[11px] text-x-muted hover:text-x-accent-ink transition-colors duration-[80ms]">
                  clear all
                </button>
              )}
              <Button type="submit" onClick={() => setNotesOpen(false)} className="p-0.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]">
                <ChevronRight size={12} />
              </Button>
            </div>

            {/* Notes list */}
            <div className="flex-1 overflow-y-auto">
              {notes.length === 0 ? (
                <div className="p-4 text-center">
                  <Mic size={20} className="text-x-faint mx-auto mb-2" />
                  <p className="text-[11px] text-x-muted leading-relaxed">
                    Hold <kbd className="px-1 py-0.5 bg-x-hover rounded font-mono text-x-ink-secondary">⌘R</kbd> to record a voice note.
                    <br />Screenshot is captured on release.
                  </p>
                </div>
              ) : (
                notes.map((note, i) => (
                  <div key={note.id} className="border-b border-x-line/50 group">
                    {note.screenshot && (
                      <div className="relative">
                        <img src={note.screenshot} alt={`Note ${i + 1}`}
                          className="w-full h-auto object-cover max-h-[140px]" />
                        <div className="absolute top-1 left-1.5 flex items-center gap-1 px-1.5 py-0.5 bg-black/70 rounded text-[11px] font-mono text-x-on-accent/80">
                          #{i + 1}
                          <span className="text-x-on-accent/60">{new Date(note.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <button onClick={() => deleteNote(note.id)}
                          className="absolute top-1 right-1.5 p-1 bg-black/60 rounded text-x-on-accent/70 hover:text-x-accent-ink opacity-0 group-hover:opacity-100 transition-opacity duration-[80ms]">
                          <Trash2 size={10} />
                        </button>
                      </div>
                    )}
                    <div className="px-2.5 py-2">
                      {note.pending ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-x-accent-ink/80">
                          <Loader2 size={10} className="animate-spin" /> transcribing...
                        </div>
                      ) : (
                        <p className="text-[11px] text-x-ink-secondary leading-relaxed">{note.transcript}</p>
                      )}
                      <p className="text-[11px] text-x-muted font-mono mt-1 truncate" title={note.url}>{note.url}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ── Save to task section ──────────────────── */}
            {notes.length > 0 && (
              <div className="border-t border-x-line p-2.5 space-y-2">
                {/* Task picker */}
                <div className="relative">
                  {selectedTask ? (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-x-tint border border-x-accent/25 rounded-md text-[11px] font-medium text-x-accent">
                      <Paperclip size={9} className="shrink-0" />
                      <span className="truncate flex-1">{selectedTask.title}</span>
                      <button onClick={() => setSelectedTaskId(null)} className="text-x-accent/50 hover:text-x-accent shrink-0">
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-x-muted" />
                      <input
                        ref={taskSearchRef}
                        type="text"
                        value={taskSearch}
                        onChange={(e) => { setTaskSearch(e.target.value); setShowTaskPicker(true) }}
                        onFocus={() => setShowTaskPicker(true)}
                        onBlur={() => setTimeout(() => setShowTaskPicker(false), 150)}
                        placeholder="Attach to existing task..."
                        className="w-full pl-6 pr-2 py-1.5 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                      />
                    </div>
                  )}

                  {/* Task dropdown */}
                  {showTaskPicker && !selectedTask && filteredTasks.length > 0 && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-x-surface border border-x-line rounded-md shadow-x-1 max-h-[200px] overflow-y-auto z-10">
                      {filteredTasks.map(t => (
                        <button key={t.id}
                          onMouseDown={(e) => { e.preventDefault(); setSelectedTaskId(t.id); setShowTaskPicker(false); setTaskSearch('') }}
                          className="w-full text-left px-2.5 py-1.5 text-[11px] text-x-muted hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms] flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            t.status === 'in_progress' ? 'bg-x-accent' :
                            t.status === 'todo' ? 'bg-x-accent-ink' :
                            t.status === 'done' ? 'bg-x-good' : 'bg-x-faint'
                          }`} />
                          <span className="truncate">{t.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                {selectedTask ? (
                  <Button type="submit" onClick={attachNotesToTask} disabled={savingTask || hasPending}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-tint hover:bg-x-accent/20 text-x-accent border border-x-accent/30 transition-colors duration-[80ms] disabled:opacity-40">
                    {savingTask ? <Loader2 size={10} className="animate-spin" /> : <Paperclip size={10} />}
                    {savingTask ? 'Attaching...' : `Attach ${notes.length} note${notes.length > 1 ? 's' : ''}`}
                  </Button>
                ) : (
                  <>
                    <input type="text" value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder={`Preview notes: ${(() => { try { return new URL(notes[0]?.url).hostname } catch { return 'site' } })()}`}
                      className="w-full px-2 py-1.5 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                    />
                    <Button type="submit" onClick={createTaskFromNotes} disabled={savingTask || hasPending}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-accent-ink/15 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/30 transition-colors duration-[80ms] disabled:opacity-40">
                      {savingTask ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                      {savingTask ? 'Creating...' : `Create Task (${notes.length} note${notes.length > 1 ? 's' : ''})`}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom hint bar ──────────────────────────────── */}
      <div className="px-3 py-1.5 bg-x-surface border-t border-x-line text-center">
        <span className="text-[11px] text-x-muted">
          {recording
            ? 'speaking... release ⌘R to capture screenshot + save note'
            : previewSource === 'screen'
              ? (pipOpen
                  ? 'floating controls active · click Record / Capture from any app · esc close'
                  : 'click Float to keep mic + screenshot buttons on top while you work · ⌘R / ⌘↵ only fire while Chrome is focused')
              : needsInstall
                ? 'install Playwright to enable live browser preview'
                : 'hold ⌘R voice note · ⌘↵ screenshot · click & scroll to interact · esc close'}
        </span>
      </div>
    </div>
  )
}
