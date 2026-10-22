import CommandQueue from './CommandQueue'
import PermissionModePicker from './PermissionModePicker'
import { changePermissionMode } from '../../lib/permissionMode'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { X, RotateCcw, MessageSquareQuote, Copy, Clipboard, Mic, MicOff, Send, Shield, ShieldAlert, Clock, AlertCircle, Search } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import useStore from '../../state/store'
import { terminalWriters, terminalControls, startedSessions, pendingPtyStarts } from '../../lib/terminalWriters'
import { matchesKey, isPtyControlKey, shouldTerminalIntercept, formatKeyCombo } from '../../lib/keybindings'
import { trackTerminalInput } from '../../lib/terminalInputTracker'
import ImageAnnotator from './ImageAnnotator'
import ForceBar from './ForceBar'
import TerminalTokenBadge from './TerminalTokenBadge'
import { getMessageMarkers, getCliCapability, getPermissionModesForCli } from '../../lib/constants'
import { sendTerminalCommand, cancelQueuedCommand } from '../../lib/terminal'
import { api } from '../../lib/api'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus, isShellSession, getShellStatusMeta } from '../../lib/sessionStatus'
import { getTheme, subscribeTheme } from '../../lib/theme'
import useEscapeToClose from '../../hooks/useEscapeToClose'
import TerminalFindBar from '../find/TerminalFindBar'
import { applyStickyCtrl, clampPhoneFont, readPhoneFont, writePhoneFont } from '../../lib/phoneKeys'
import { isShown } from '../../lib/sessionInputFocus'

// GPU rendering for terminals. Browsers cap live WebGL contexts (about 16 in
// Chromium/WebKit), so only the first few terminals get one; the rest and any
// terminal whose context is lost fall back to the regular DOM renderer.
const MAX_WEBGL_TERMINALS = 8
let webglTerminals = 0
function attachWebgl(term) {
  if (webglTerminals >= MAX_WEBGL_TERMINALS) return () => {}
  let addon
  try {
    addon = new WebglAddon()
    term.loadAddon(addon)
  } catch {
    try { addon?.dispose() } catch { /* already gone */ }
    return () => {}
  }
  webglTerminals += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    webglTerminals -= 1
    try { addon.dispose() } catch { /* terminal already disposed */ }
  }
  addon.onContextLoss(release)
  return release
}

// ── xterm fallback theme — resolved Xirp values are applied below ───────────
// xterm can't read CSS custom properties, so the token values are mirrored
// here and swapped live via subscribeTheme. Keep the resolved values in step
// with src/index.css.
const XTERM_THEMES = {
  dark: {
    background: '#07090E',
    foreground: '#EEF1F8',
    cursor: '#8B7CFF',
    cursorAccent: '#07090E',
    selectionBackground: 'rgba(139, 124, 255, 0.3)',
    black: '#151824',
    red: '#FF6B7A',
    green: '#2FD4AE',
    yellow: '#F5B544',
    blue: '#7FB8FF',
    magenta: '#B3A6FF',
    cyan: '#5CC8FF',
    white: '#EEF1F8',
    brightBlack: '#8A93A6',
    brightRed: '#FF8F9B',
    brightGreen: '#5FE0BD',
    brightYellow: '#FFD07A',
    brightBlue: '#A3CCFF',
    brightMagenta: '#CBC2FF',
    brightCyan: '#8FDBFF',
    brightWhite: '#FAFBFE',
  },
  light: {
    background: '#F8FAFD',
    foreground: '#1F2937',
    cursor: '#5648DE',
    cursorAccent: '#F8FAFD',
    selectionBackground: 'rgba(86, 72, 222, 0.22)',
    black: '#1F2937',
    red: '#D92D20',
    green: '#0E7A63',
    yellow: '#A15C07',
    blue: '#1D5FD6',
    magenta: '#6244D8',
    cyan: '#0C7AA8',
    white: '#E3E7EE',
    brightBlack: '#697586',
    brightRed: '#F04438',
    brightGreen: '#17A683',
    brightYellow: '#C77B0A',
    brightBlue: '#4487E8',
    brightMagenta: '#7E64E8',
    brightCyan: '#2596BE',
    brightWhite: '#F5F7FA',
  },
}
function cssColor(name, fallback) {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// xterm needs resolved colors rather than CSS var() strings. Read the Xirp
// tokens at mount/theme-change time so the terminal follows the app palette.
const xtermTheme = (theme) => {
  const dark = theme === 'dark'
  const bg = cssColor('--x-surface-2', dark ? '#0B0B0D' : '#EBEDEF')
  const surface = cssColor('--x-surface', dark ? '#17171A' : '#FFFFFF')
  const ink = cssColor('--x-ink', dark ? '#EDEDE9' : '#15171A')
  const muted = cssColor('--x-muted', dark ? '#A3A39E' : '#4A4F55')
  const accent = cssColor('--x-accent', dark ? '#5B8CFF' : '#1647FF')
  const danger = cssColor('--x-danger', dark ? '#F2545B' : '#A82F1B')
  const warning = cssColor('--x-warning', dark ? '#E5B86B' : '#925A10')
  const link = cssColor('--x-link', dark ? '#8AAEFF' : '#0E36C7')
  const good = cssColor('--x-good', dark ? '#7DCE82' : '#087A4B')
  const themeColors = XTERM_THEMES[theme] || XTERM_THEMES.light
  return {
    ...themeColors,
    background: bg,
    foreground: ink,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: cssColor('--x-tint', dark ? '#1B2744' : '#EDF1FF'),
    selectionForeground: ink,
    black: surface,
    red: danger,
    green: good,
    yellow: warning,
    blue: link,
    magenta: link,
    cyan: link,
    white: ink,
    brightBlack: muted,
    brightRed: danger,
    brightGreen: good,
    brightYellow: warning,
    brightBlue: link,
    brightMagenta: link,
    brightCyan: link,
    brightWhite: ink,
  }
}

// ── Message-start markers ────────────────────────────────────────────────
// Lines that begin a chat "message" in CLI TUIs. Detection is purely visual:
// we scan xterm's scrollback for the first non-whitespace character and check
// it against the per-CLI marker set. The live input box (`│ > _   │`) starts
// with `│`, not `>`, so it correctly does NOT match — only past message
// echoes do. Continuation/wrapped lines are skipped via `line.isWrapped`.
const MSG_MARKERS = {
  // Claude Code: ⏺ for assistant text + tool calls, > for echoed user msgs.
  claude: new Set(['\u23FA', '>']),
  // Gemini CLI: ✦ for assistant turns, > for user. Best-effort — adjust as needed.
  gemini: new Set(['\u2726', '>']),
}

const EMPTY_TERMINAL_IMAGES = Object.freeze([])

function lineStartsMessage(text, markerSet) {
  // Find first non-whitespace, non-box-drawing char.
  // Box-drawing chars (U+2500–U+257F) are used for the input frame and
  // shouldn't disqualify a line, but we also don't treat them as message
  // markers themselves.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = ch.codePointAt(0)
    if (ch === ' ' || ch === '\t') continue
    // Skip box-drawing range so framed input lines (`│ > … │`) don't match.
    if (code >= 0x2500 && code <= 0x257F) return false
    return markerSet.has(ch)
  }
  return false
}

// Minimum PTY dimensions. Claude Code's TUI needs ~80 columns — anything
// narrower breaks its layout (input box clipped, wrapped borders). Instead of
// shrinking the PTY to match a tiny grid cell, we hold the PTY at this floor
// and let the wrapper scroll inside the cell, following the cursor.
// Height is less critical: its input box plus status line need well under 16
// rows. The former 24-row floor was taller than the visible area in overview
// cells and in windows below ~760px, so the terminal always opened partially
// scrolled away with its first rows cut off.
const MIN_COLS = 80
const MIN_ROWS = 16
const BASE_FONT_SIZE = 13
// ── Who owns the PTY size in the grid (Overview ⇄ Session) ──────────────
// Decision: the Session level owns it. A PTY has exactly one size per window
// layout: the size its terminal gets when shown full size at the Session
// level (base font, fitted to the focused cell). Overview tiles never fit the
// PTY to the tile; they keep that same cols×rows and scale the *font* down
// toward the tile, but never below a readable floor (9px, 8px in very small
// tiles). Larger output stays scrollable in both directions. The tile follows
// the prompt until the reader scrolls back; no text is hidden behind a fade.
// The per-tile status line and prompt box are hidden in the overview.
// Switching Overview ⇄ Session therefore only changes the font size, which is
// local to xterm.js, and never sends SIGWINCH sizes back and forth (Claude
// Code redraws/garbles on every resize). The PTY only changes size when the
// window (and with it the Session-level box) changes.
// For a terminal that has not been shown at Session level yet (restored tabs,
// sessions started in the overview) the Session-level size is estimated from
// the grid container ([data-terminal-grid] in App.jsx) and the tile chrome;
// the first real Session-level fit is remembered per grid size, so at most
// one correction ever happens.
const MIN_PREVIEW_FONT_SIZE = 9
const MIN_PREVIEW_FONT_SIZE_TINY = 8 // tiles narrower than 360px or lower than 160px
// Grid box ("WxH" of [data-terminal-grid]) → cols×rows a Session-level fit
// produced. Shared so never-focused terminals reuse a real measurement.
const sessionGeometryByBox = new Map()
// Output flush interval for terminals that are visible but not focused.
const BACKGROUND_WRITE_MS = 100
// Phone (App.jsx passes `phone` below 768px): the terminal is the Session
// level of the phone, shown full screen. Its columns come from the width at
// the font the user picked (pinch or A− A+, remembered), not from the 80
// column floor, so nothing scrolls sideways. Background sessions have no
// terminal on the phone, so their PTYs are never resized from here.
const PHONE_MIN_COLS = 20
const PHONE_MIN_ROWS = 6
const LONG_PRESS_MS = 550

export default function TerminalView({ sessionId, inDrawer = false, slotMode, overviewPreview = false, phone = false }) {
  const containerRef = useRef(null)
  const composerRef = useRef(null)
  // Overview tile: show the Session-level PTY size scaled down (see above).
  const overviewPreviewRef = useRef(overviewPreview)
  overviewPreviewRef.current = overviewPreview
  const phoneRef = useRef(phone)
  phoneRef.current = phone
  // Long-press in the phone terminal: a Paste bubble at the finger.
  const [phonePaste, setPhonePaste] = useState(null) // { x, y }
  // Scrolled back into the scrollback on the phone: offer a way back to live.
  const [phoneScrolledBack, setPhoneScrolledBack] = useState(false)
  const phoneLiveRef = useRef(null)
  const termRef = useRef(null)
  // Applies an Overview ⇄ Session switch to this terminal (set up below).
  const applyLevelRef = useRef(null)
  const [annotatingImage, setAnnotatingImage] = useState(null) // { url, index }
  const [showForceBar, setShowForceBar] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y }
  const session = useStore((s) => s.sessions[sessionId])
  const isReadOnly = !!session?.read_only
  const writableSessionId = isReadOnly ? session?.annotation_target_session_id : sessionId
  const writableSession = useStore((s) => writableSessionId ? s.sessions[writableSessionId] : null)
  const inputVal = useStore((s) => s.sessionInputs[sessionId] || '')
  const setSessionInput = useStore((s) => s.setSessionInput)
  const terminalPastedImages = useStore((s) => s.chatDrafts[sessionId]?.terminalPastedImages || EMPTY_TERMINAL_IMAGES)
  const updateChatDraft = useStore((s) => s.updateChatDraft)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const sessionStatus = session?.status
  const sessionAgentState = session?.agentState
  const cliType = useStore((s) => s.sessions[sessionId]?.cli_type || 'claude')
  const isExternal = useStore((s) => !!s.sessions[sessionId]?.is_external)
  const sessionName = useStore((s) => s.sessions[sessionId]?.name || '')
  const isExited = sessionStatus === 'exited'
  const sessionHasStarted = hasSessionStarted(session, sessionStarted)
  // A plain terminal (cli_type "shell") is Running or Exited, never Working.
  const isShell = isShellSession(session)
  const statusMeta = isShell
    ? getShellStatusMeta(session, sessionStarted)
    : getSessionStatusMeta(sessionStatus, sessionAgentState, sessionHasStarted)
  // Words shown to the user match the header and overview ("Needs you").
  const displayMeta = getSessionDisplayStatus(session, sessionStarted)
  const isActive = useStore((s) => s.activeSessionId === sessionId)
  const queuedCommands = useStore((s) => s.queuedCommands?.[sessionId] || EMPTY_TERMINAL_IMAGES)
  const setInputVal = useCallback((action) => {
    const current = useStore.getState().sessionInputs[sessionId] || ''
    const next = typeof action === 'function' ? action(current) : action
    setSessionInput(sessionId, next)
  }, [sessionId, setSessionInput])
  const pastedImages = terminalPastedImages
  const setPastedImages = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => {
      const current = draft.terminalPastedImages || EMPTY_TERMINAL_IMAGES
      const next = typeof action === 'function' ? action(current) : action
      return { terminalPastedImages: Array.isArray(next) ? next : [] }
    })
  }, [sessionId, updateChatDraft])

  // Embedded Prompt Composer & Voice Dictation state
  const [isListening, setIsListening] = useState(false)
  const [hasSpeechSupport, setHasSpeechSupport] = useState(false)
  const recognitionRef = useRef(null)
  const baseTextRef = useRef('')
  const [elapsedTime, setElapsedTime] = useState(0)
  const [turnDurations, setTurnDurations] = useState({})
  const workingStartTimeRef = useRef(null)

  const getWritableSessionId = useCallback(() => {
    const current = useStore.getState().sessions[sessionId]
    return current?.read_only ? current?.annotation_target_session_id : sessionId
  }, [sessionId])
  const notifyNoWritableTarget = useCallback(() => {
    useStore.getState().addNotification?.({
      type: 'error',
      sessionId,
      message: 'Open your own Brainstormer before adding notes to a public view.',
    })
  }, [sessionId])
  const formatReadOnlyNote = useCallback((text) => {
    const current = useStore.getState().sessions[sessionId]
    if (!current?.read_only) return text
    const sourceName = current?.name || 'public Brainstormer'
    return `[Note from read-only Brainstormer: ${sourceName}]\n\n${text}`
  }, [sessionId])

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (SpeechRecognition) {
      setHasSpeechSupport(true)
      const recognition = new SpeechRecognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'en-US'

      recognition.onstart = () => {
        setIsListening(true)
      }

      recognition.onresult = (event) => {
        let transcript = ''
        for (let i = 0; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript
        }
        const trimmedBase = baseTextRef.current.trim()
        if (trimmedBase) {
          setInputVal(`${trimmedBase} ${transcript.trim()}`)
        } else {
          setInputVal(transcript.trim())
        }
      }

      recognition.onerror = (event) => {
        console.error('Speech recognition error in terminal:', event.error)
        setIsListening(false)
      }

      recognition.onend = () => {
        setIsListening(false)
      }

      recognitionRef.current = recognition
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch (e) {}
      }
    }
  }, [])

  const toggleListening = () => {
    if (!recognitionRef.current) return
    if (isListening) {
      recognitionRef.current.stop()
    } else {
      baseTextRef.current = inputVal
      recognitionRef.current.start()
    }
  }

  // Worked duration ticking
  useEffect(() => {
    setElapsedTime(0)
  }, [sessionId])

  useEffect(() => {
    const isWorking = getSessionStatusMeta(sessionStatus, sessionAgentState, sessionHasStarted).isWorking
    let timer = null

    if (isWorking) {
      workingStartTimeRef.current = Date.now()
      setElapsedTime(0)
      timer = setInterval(() => {
        if (workingStartTimeRef.current) {
          setElapsedTime(Math.round((Date.now() - workingStartTimeRef.current) / 1000))
        }
      }, 1000)
    } else {
      if (workingStartTimeRef.current) {
        const finalTime = Math.round((Date.now() - workingStartTimeRef.current) / 1000)
        if (finalTime > 0) {
          setTurnDurations(prev => ({
            ...prev,
            [sessionId]: finalTime
          }))
        }
        workingStartTimeRef.current = null
      }
      setElapsedTime(0)
    }

    return () => {
      if (timer) clearInterval(timer)
    }
  }, [sessionStatus, sessionAgentState, sessionHasStarted, sessionId])

  const cyclePermissionMode = async () => {
    const s = useStore.getState().sessions[sessionId]
    if (s?.read_only) return
    if (!sessionId || !s) return
    const modes = getPermissionModesForCli(s.cli_type || 'claude')
    if (!modes || !modes.length) return
    const currentIndex = modes.findIndex(m => m.id === (s.permission_mode || 'default'))
    const nextIndex = (currentIndex + 1) % modes.length
    const nextMode = modes[nextIndex].id
    await changePermissionMode(sessionId, nextMode)
  }

  const handleSend = (e, options = {}) => {
    e?.preventDefault()
    const trimmed = inputVal.trim()
    if (!trimmed) return

    const targetId = getWritableSessionId()
    if (!targetId) {
      notifyNoWritableTarget()
      return
    }
    setInputVal('')
    const payload = formatReadOnlyNote(trimmed)
    sendTerminalCommand(targetId, payload, { delivery: options.delivery || 'auto' })
    useStore.getState().setLastSentPrompt(targetId, payload)
  }

  // Save annotated image: upload as new paste, REPLACE the original in the
  // preview strip (so you don't accumulate old + annotated duplicates), and
  // type the new path into the terminal.
  const handleAnnotationSave = async (blob) => {
    try {
      const formData = new FormData()
      formData.append('file', blob, 'annotated.png')
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      const data = await res.json()
      const idx = annotatingImage?.index
      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(blob),
      }
      setPastedImages((prev) => {
        if (idx != null && idx >= 0 && idx < prev.length) {
          // Replace the original at the same position
          const old = prev[idx]
          if (old.previewUrl) URL.revokeObjectURL(old.previewUrl)
          return prev.map((img, i) => (i === idx ? newEntry : img))
        }
        // Fallback: append (shouldn't happen, but safety)
        return [...prev, newEntry]
      })
      // Type the annotated file path into terminal
      const targetId = getWritableSessionId()
      const ws = useStore.getState().ws
      if (targetId && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'input', session_id: targetId, data: data.path + ' ' }))
      } else if (!targetId) {
        notifyNoWritableTarget()
      }
    } catch (err) {
      console.error('Failed to save annotated image:', err)
    }
    setAnnotatingImage(null)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      theme: xtermTheme(getTheme()),
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.2,
      cursorBlink: true,
      drawBoldTextInBrightColors: true,
      scrollback: 10000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const releaseWebgl = attachWebgl(term)
    termRef.current = term
    // All terminal modes subscribe, including newly started and read-only
    // sessions. Their text palette must follow the surrounding surface.
    const unsubscribeTheme = subscribeTheme((theme) => {
      try { term.options.theme = xtermTheme(theme) } catch { /* disposed */ }
    })

    // ── Jump to previous/next "message start" in scrollback ────────────────
    // Scans the active xterm buffer (scrollback + viewport) for lines whose
    // first non-whitespace, non-box-drawing char is a message marker for the
    // current CLI (⏺/> for Claude, ✦/> for Gemini). Wrapped continuation rows
    // are skipped so we always land on the first physical line of a message.
    // Returns true if it scrolled, false if no marker was found.
    const jumpToMessage = (direction) => {
      try {
        const buffer = term.buffer.active
        const total = buffer.length
        if (!total) return false

        const ct = useStore.getState().sessions[sessionId]?.cli_type || 'claude'
        const markers = getMessageMarkers(ct)

        const startY = buffer.viewportY
        const step = direction === 'next' ? 1 : -1
        const limit = direction === 'next' ? total : -1

        for (let y = startY + step; direction === 'next' ? y < limit : y > limit; y += step) {
          const line = buffer.getLine(y)
          if (!line) continue
          if (line.isWrapped) continue // skip wrapped continuation rows
          const text = line.translateToString(true)
          if (lineStartsMessage(text, markers)) {
            term.scrollToLine(y)
            return true
          }
        }
        return false
      } catch (err) {
        console.warn('jumpToMessage failed:', err)
        return false
      }
    }

    // ── Color palette for cell extraction ──────────────────────────
    // Derived from the same XTERM_THEMES the terminal renders with, in ANSI
    // index order, so extracted colors always match what's on screen — in
    // either theme.
    const palette16 = () => {
      const t = xtermTheme(getTheme())
      return [
        t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white,
        t.brightBlack, t.brightRed, t.brightGreen, t.brightYellow, t.brightBlue, t.brightMagenta, t.brightCyan, t.brightWhite,
      ]
    }
    const cellColor = (cell) => {
      try {
        const mode = cell.getFgColorMode()
        if (mode === 0) return null // default
        const c = cell.getFgColor()
        if (mode === 1 || mode === 2) return palette16()[c] || null // palette 16 / 256 (fallback for 16-255)
        if (mode === 3) { // RGB
          return '#' + ((c >> 16) & 0xFF).toString(16).padStart(2, '0')
            + ((c >> 8) & 0xFF).toString(16).padStart(2, '0')
            + (c & 0xFF).toString(16).padStart(2, '0')
        }
      } catch {}
      return null
    }

    terminalControls.set(sessionId, {
      jumpToMessage,
      /** Return current terminal dimensions for accurate PTY restart. */
      getSize: () => ({ cols: term.cols, rows: term.rows }),
      getFontSize: () => term.options.fontSize,
      /** Scroll position: viewportY === baseY means the live bottom is shown. */
      getViewport: () => ({ viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY }),
      /** Fit to the current layout right now and return the resulting size. */
      fitNow: () => {
        try { fitWithMinimum() } catch { /* not measurable yet */ }
        return { cols: term.cols, rows: term.rows }
      },
      /** Clear terminal buffer (used before PTY restart for a clean slate). */
      clear: () => { resetScreen() },
      /** Return all lines with per-cell color segments for the annotator. */
      getBufferLines: () => {
        try {
          const buffer = term.buffer.active
          const lines = []
          for (let y = 0; y < buffer.length; y++) {
            const line = buffer.getLine(y)
            if (!line) continue
            // Build color segments
            const segments = []
            let curText = ''
            let curFg = null
            let curBold = false
            for (let x = 0; x < line.length; x++) {
              const cell = line.getCell(x)
              if (!cell) continue
              const ch = cell.getChars()
              // In xterm.js, space cells return '' with width 1.
              // Wide char trailing cells return '' with width 0 — skip those.
              if (!ch && cell.getWidth() === 0) continue
              const char = ch || ' '
              const fg = cellColor(cell)
              const bold = !!cell.isBold()
              if (fg !== curFg || bold !== curBold) {
                if (curText) segments.push({ text: curText, fg: curFg, bold: curBold })
                curText = char
                curFg = fg
                curBold = bold
              } else {
                curText += char
              }
            }
            if (curText) segments.push({ text: curText, fg: curFg, bold: curBold })
            lines.push({
              y,
              text: line.translateToString(true),
              isWrapped: line.isWrapped,
              segments,
            })
          }
          return lines
        } catch { return [] }
      },
    })

    // ── Custom key event handler ────────────────────────────────────────────
    // Runs before xterm processes the key, so we can swallow keys we want to
    // handle ourselves (Shift+Enter → ForceBar, Cmd+Shift+Up/Down → message
    // navigation). Returning false tells xterm to ignore the key — but we
    // ALSO call preventDefault + stopPropagation so the global handler in
    // useKeyboard.js doesn't double-handle it (e.g. as grid navigation).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Keep the native permission shortcut on the same live apply path as
      // both IVE pickers, instead of changing the CLI alone behind their back.
      const liveSession = useStore.getState().sessions[sessionId]
      if (e.key === 'Tab' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !isShellSession(liveSession)) {
        e.preventDefault()
        e.stopPropagation()
        cyclePermissionMode()
        return false
      }

      // Cmd+Backspace → delete to beginning of line
      // xterm.js swallows Cmd+key combos (metaKey=true) so they never reach
      // the PTY. Translate to \x15 (Ctrl+U / readline "kill line") manually.
      if (e.key === 'Backspace' && e.metaKey && !e.shiftKey && !e.altKey) {
        if (useStore.getState().sessions[sessionId]?.read_only) return false
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: '\x15' }))
        }
        e.preventDefault()
        return false
      }

      // Shift+Enter → ForceBar (CLIs that support force_send)
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (useStore.getState().sessions[sessionId]?.read_only) return false
        const sess = useStore.getState().sessions[sessionId]
        const ct = sess?.cli_type || 'claude'
        if (getCliCapability(ct, 'force_send')) {
          setShowForceBar(true)
          return false // swallow — don't send to PTY
        }
      }

      // Cmd+Shift+Up/Down → jump to message start (configurable)
      const kb = useStore.getState().keybindings
      if (matchesKey(e, kb.msgPrev)) {
        jumpToMessage('prev')
        e.preventDefault()
        e.stopPropagation()
        return false
      }
      if (matchesKey(e, kb.msgNext)) {
        jumpToMessage('next')
        e.preventDefault()
        e.stopPropagation()
        return false
      }

      // IVE shortcuts (⌘ combos, explicit ⌃ bindings such as ⌃1-9 and, in a
      // Mac browser, the ⌃ remaps of browser-reserved ⌘N/⌘W/⌘T…) go to IVE
      // instead of becoming control bytes. Keep bubbling so the global
      // handler performs the action exactly once.
      if (shouldTerminalIntercept(e, kb)) {
        e.preventDefault()
        return false
      }

      // Every other readline / agent Control key (Ctrl+C/E/K/U/G/J …) reaches
      // the PTY. Mark it so no global handler acts on it as well.
      if (isPtyControlKey(e)) {
        e._ivePtyKey = true
        return true
      }

      // @prompt: token expansion on Enter is handled SERVER-SIDE in the
      // WebSocket input handler (_maybe_expand_input). No client
      // interception needed — Enter flows to the server, which checks
      // _input_bufs for tokens, backspaces the raw text, and types the
      // expanded version before sending Enter to the PTY.

      // Cmd+Left/Right → readline beginning/end of line.
      // xterm.js swallows metaKey combos, so translate manually.
      if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (useStore.getState().sessions[sessionId]?.read_only) return false
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          // \x01 = Ctrl+A (beginning-of-line), \x05 = Ctrl+E (end-of-line)
          const seq = e.key === 'ArrowLeft' ? '\x01' : '\x05'
          ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: seq }))
        }
        e.preventDefault()
        return false
      }

      // Let the toggle terminal / grid cell view shortcut bubble up to useKeyboard
      if (matchesKey(e, kb.toggleTerminal) || (e.key === '`' && e.ctrlKey)) {
        return false
      }

      // Ctrl+Opt+Arrow → grid navigation (handled by useKeyboard.js).
      // Return false so xterm doesn't send escape sequences and the event
      // bubbles to the global handler.
      if (e.altKey && e.ctrlKey && !e.metaKey && !e.shiftKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        return false
      }

      // Opt+Arrow passes through to xterm for word-by-word cursor movement.

      return true // let everything else through
    })

    // ── Scroll architecture ──────────────────────────────────────────
    // Problem: xterm.js owns .xterm-viewport (which has overflow-y:scroll)
    // and resets its scrollTop to 0 for alt-screen mode on every render.
    // So we CANNOT use xterm's viewport for scrolling small grid cells.
    //
    // Solution: the scroll wrapper (el.parentElement) handles scrolling
    // externally. We set el's min-width/min-height to match the rendered
    // terminal (≥ MIN_COLS×MIN_ROWS). When the cell (wrapper) is smaller, it scrolls
    // the entire .xterm element. xterm's viewport fills .xterm at full
    // size (no internal overflow), so its scrollTop reset is harmless.
    const wrapper = el.parentElement
    let geometryRole = 'unknown'
    let phoneFont = readPhoneFont()
    // Phone remote: this terminal holds the PTY size (claim_geometry) only
    // while it is on screen full size.
    let phoneClaimed = false
    let phoneReclaimAt = 0
    const phoneVisible = () => !wrapper || (wrapper.clientWidth >= 20 && wrapper.clientHeight >= 20)
    const releasePhoneGeometry = () => {
      if (!phoneClaimed) return
      phoneClaimed = false
      geometryRole = 'unknown'
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'release_geometry', session_id: sessionId }))
    }

    // ── Sizing helpers ───────────────────────────────────────────────
    // Sync the .xterm element's dimensions so the wrapper can scroll it.
    // When autoFit is ON we skip this — the container stays at height:100%
    // so the terminal never overflows the cell (background fills any
    // fractional-row gap).
    const syncElementSize = () => {
      const screen = el.querySelector('.xterm-screen')
      if (!screen || !wrapper) return

      const paddingTop = 4
      const paddingBottom = 4
      const paddingLeft = 6
      const paddingRight = 6

      // Ensure we keep the wrapper's dimensions as a floor (so height: 100% behaves
      // correctly), but expand if xterm's screen + paddings actually overflows it.
      const minW = Math.max(wrapper.clientWidth, screen.offsetWidth + paddingLeft + paddingRight)
      const minH = Math.max(wrapper.clientHeight, screen.offsetHeight + paddingTop + paddingBottom)

      el.style.minWidth = minW + 'px'
      el.style.minHeight = minH + 'px'
    }

    // fit() with a floor: never let the PTY shrink below MIN_COLS x MIN_ROWS.
    // We clear min-dims first so FitAddon measures the wrapper's real available
    // space (not the previous terminal size), then clamp up to the floor.
    //
    // When the user enables `terminalAutoFit`, we additionally scale the font
    // size DOWN so the PTY floor (MIN_COLS×MIN_ROWS) fits exactly in the cell — no clipping,
    // no scrolling, just smaller text. We never scale up (cells bigger than
    // 80×24 at base font just get more cols/rows naturally).
    // FitAddon measures the parent's computed `height`. Two problems with
    // that here: (1) with Tailwind's border-box sizing that height includes
    // this container's 4px+4px padding, which FitAddon never subtracts, so it
    // proposed one row too many near a row boundary and the last line (Claude
    // Code's prompt row) was cut off behind a scrolling wrapper; (2) the
    // container grows with the xterm screen inside it, so the measured height
    // can never be smaller than the current rows: a terminal could grow but
    // never shrink (it stayed at 24 rows in a 17-row window). The scroll
    // wrapper's height comes from layout only, so rows are computed from it.
    // Width is unaffected: FitAddon reserves 14px for a scrollbar, more than
    // the 12px horizontal padding, and a block's width ignores its content.
    const proposeDimensions = () => {
      const dims = fit.proposeDimensions()
      if (!dims || !dims.rows) return dims
      try {
        const cell = term._core?._renderService?.dimensions?.css?.cell
        const cs = window.getComputedStyle(el)
        if (cell?.height && wrapper) {
          const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
          const contentH = wrapper.clientHeight - padV
          // +0.5px: clientHeight is rounded from fractional layout heights.
          if (contentH > 0) dims.rows = Math.max(1, Math.floor((contentH + 0.5) / cell.height))
        }
      } catch { /* keep FitAddon's proposal */ }
      return dims
    }

    // ── Overview preview (Session level owns the PTY size, see top) ─────
    const readCell = () => {
      try { return term._core?._renderService?.dimensions?.css?.cell } catch { return null } // disposed
    }
    const syncViewport = () => {
      try {
        // xterm 5.5 caches scrollTop across DOM moves. A same-size fit does
        // not invalidate that cache, so also restore the actual DOM offset.
        term._core?.viewport?.syncScrollArea(true)
        const viewport = el.querySelector('.xterm-viewport')
        const cell = readCell()
        if (viewport && cell?.height) viewport.scrollTop = term.buffer.active.viewportY * cell.height
      } catch { /* disposed */ }
    }
    const setFontSize = (size) => {
      if (term.options.fontSize !== size) { try { term.options.fontSize = size } catch {} }
    }
    const viewportScrollbar = () => {
      try { return term.options.scrollback === 0 ? 0 : (term._core?.viewport?.scrollBarWidth || 0) } catch { return 0 }
    }
    const gridBox = () => {
      const grid = el.closest('[data-terminal-grid]')
      if (!grid) return null
      const r = grid.getBoundingClientRect()
      if (r.width < 20 || r.height < 20) return null
      return { key: `${Math.round(r.width)}x${Math.round(r.height)}`, w: r.width, h: r.height }
    }
    let ownerGeometry = null // { key, cols, rows } from this terminal's last Session-level fit
    const rememberSessionGeometry = () => {
      if (overviewPreviewRef.current || !el.closest('[data-terminal-grid]')) return
      const box = gridBox()
      if (!box || !(term.cols > 0) || !(term.rows > 0)) return
      ownerGeometry = { key: box.key, cols: term.cols, rows: term.rows }
      sessionGeometryByBox.set(box.key, { cols: term.cols, rows: term.rows })
    }
    // What a Session-level fit would produce: App.jsx shows the focused tile
    // at `position:absolute; inset:4px` in the grid with a 2px border; the
    // tile chrome (header, banners) is the same as in the overview. Mirrors
    // FitAddon (width incl. scrollbar reserve) + proposeDimensions (rows).
    const estimateSessionGeometry = (box, cell) => {
      const tile = el.closest('[data-session-view], [data-grid-cell-session]')
      if (!tile || !wrapper || !cell?.width || !cell?.height) return null
      // The composer is hidden in the overview but shown at Session level:
      // unhide it for this synchronous measurement (no paint in between).
      const composer = composerRef.current
      const composerHidden = composer && composer.style.display === 'none'
      if (composerHidden) composer.style.display = ''
      const chromeW = tile.clientWidth - wrapper.offsetWidth
      const chromeH = tile.clientHeight - wrapper.offsetHeight
      if (composerHidden) composer.style.display = 'none'
      // Grid padding (2 x 4px) and the focused cell's border (2 x 1px, see
      // App.jsx: constant width, focus adds a shadow ring only).
      const wrapW = box.w - 8 - 2 - chromeW
      const wrapH = box.h - 8 - 2 - chromeH
      const cs = window.getComputedStyle(el)
      const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      return {
        cols: Math.max(MIN_COLS, Math.floor((Math.floor(wrapW) - viewportScrollbar()) / cell.width)),
        rows: Math.max(MIN_ROWS, Math.floor((wrapH - padV + 0.5) / cell.height)),
      }
    }
    // Largest font (≤ base, ≥ the readable floor) at which cols×rows fit the
    // tile. Returns which edges are cropped at that font.
    const scaleFontToTile = (cols, rows, baseCell) => {
      if (!wrapper || !baseCell?.width) return { right: false, top: false }
      const cs = window.getComputedStyle(el)
      const padH = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const wr = wrapper.getBoundingClientRect()
      // No scrollbar reserve: .is-overview-preview hides xterm's viewport
      // scrollbar (index.css), the preview is not scrolled by the user.
      const availW = wr.width - padH
      const availH = wr.height - padV
      const minSize = wr.width < 360 || wr.height < 160 ? MIN_PREVIEW_FONT_SIZE_TINY : MIN_PREVIEW_FONT_SIZE
      const scale = Math.min(1, availW / (cols * baseCell.width), availH / (rows * baseCell.height))
      let size = Math.max(minSize, Math.floor(BASE_FONT_SIZE * scale * 10) / 10)
      setFontSize(size)
      // Glyph metrics round to device pixels, so verify and step down.
      const fits = (cell) => cols * cell.width <= availW + 0.5 && rows * cell.height <= availH + 0.5
      for (let i = 0; i < 12 && size > minSize; i++) {
        const cell = readCell()
        if (!cell?.width || fits(cell)) break
        size = Math.max(minSize, Math.round((size - 0.2) * 10) / 10)
        setFontSize(size)
      }
      const cell = readCell()
      if (!cell?.width) return { right: false, top: false }
      return { right: cols * cell.width > availW + 0.5, top: rows * cell.height > availH + 0.5 }
    }
    // Bottom-anchor the preview: the latest output and the prompt sit at the
    // bottom of the screen, which is what people scan the overview for.
    let previewFollowing = true
    const anchorPreview = () => {
      if (!wrapper || !previewFollowing) return
      wrapper.scrollTop = wrapper.scrollHeight
    }
    // Re-fitting an unchanged tile must not temporarily restore the base font:
    // WebKit can treat the resulting scroll-area shrink as a user scroll.
    let previewLayout = null
    const fitPreview = () => {
      const box = gridBox()
      const layoutKey = `${wrapper?.clientWidth}x${wrapper?.clientHeight}:${box?.key}:${geometryRole}:${term.cols}x${term.rows}:${window.devicePixelRatio}`
      if (previewLayout?.key === layoutKey && previewLayout.font === term.options.fontSize) {
        syncElementSize()
        anchorPreview()
        return true
      }
      el.classList.add('is-overview-preview')
      setFontSize(BASE_FONT_SIZE)
      const c = readCell()
      const baseCell = c?.width && c?.height ? { width: c.width, height: c.height } : null
      if (!baseCell) return false
      if (geometryRole !== 'viewer') {
        const target = box && ((ownerGeometry?.key === box.key && ownerGeometry)
          || sessionGeometryByBox.get(box.key)
          || estimateSessionGeometry(box, baseCell))
        if (target && (term.cols !== target.cols || term.rows !== target.rows)) {
          try { term.resize(target.cols, target.rows) } catch {}
        }
      }
      scaleFontToTile(term.cols, term.rows, baseCell)
      previewLayout = {
        key: `${wrapper?.clientWidth}x${wrapper?.clientHeight}:${box?.key}:${geometryRole}:${term.cols}x${term.rows}:${window.devicePixelRatio}`,
        font: term.options.fontSize,
      }
      el.style.minWidth = ''
      el.style.minHeight = wrapper ? `${wrapper.clientHeight}px` : ''
      requestAnimationFrame(() => {
        syncElementSize()
        anchorPreview()
      })
      return true
    }

    // A font size change (Overview ⇄ Session, auto-fit) must not cost the
    // live bottom. xterm re-syncs its scroll area a frame or two after the
    // change and the browser moves scrollTop in between; xterm reads that
    // as "the user scrolled up" and stops following the output. The tile,
    // and then the Session level, kept showing old scrollback (stale lines,
    // blank areas left by earlier screen clears) while new output landed
    // below. For a moment after the change, such a scroll goes straight
    // back to the live bottom (before it is painted); a wheel ends that.
    const atLiveBottom = () => {
      try { const b = term.buffer.active; return b.viewportY >= b.baseY } catch { return true }
    }
    let keepLiveUntil = 0
    const keepLiveBottom = () => {
      keepLiveUntil = performance.now() + 500
      scrollToLiveOutput()
    }
    el.querySelector('.xterm-viewport')?.addEventListener('scroll', () => {
      if (performance.now() < keepLiveUntil && !atLiveBottom()) { try { term.scrollToBottom() } catch { /* disposed */ } }
    })
    el.addEventListener('wheel', () => { keepLiveUntil = 0 }, { passive: true, capture: true })
    // Same for a size change (window resize, side panel): xterm reflows
    // and the wrapper keeps its old scrollTop, which left the Session view a
    // few lines above the live output.
    const fitWithMinimum = () => {
      const fontBefore = term.options.fontSize
      const colsBefore = term.cols, rowsBefore = term.rows
      const wasLive = atLiveBottom()
      fitLayout()
      syncViewport()
      if (wasLive && (term.options.fontSize !== fontBefore || term.cols !== colsBefore || term.rows !== rowsBefore)) keepLiveBottom()
    }

    let fitRetries = 0
    const fitLayout = () => {
      if (wrapper && (wrapper.clientWidth < 20 || wrapper.clientHeight < 20)) return
      if (overviewPreviewRef.current) {
        if (fitPreview()) fitRetries = 0
        else if (fitRetries < 10) { fitRetries++; setTimeout(fitWithMinimum, 100) }
        return
      }
      previewLayout = null
      el.classList.remove('is-overview-preview')
      // Phone: always fitted to the phone's width. While shown it claims the
      // PTY size (doResize), so it is never a viewer of the Mac's 80+ columns.
      if (phoneRef.current) {
        el.style.minHeight = wrapper ? `${wrapper.clientHeight}px` : ''
        el.style.minWidth = ''
        setFontSize(phoneFont)
        const pd = proposeDimensions()
        if (!pd || !pd.cols || !pd.rows) {
          if (fitRetries < 10) { fitRetries++; setTimeout(fitWithMinimum, 100) }
          return
        }
        fitRetries = 0
        const cols = Math.max(PHONE_MIN_COLS, pd.cols)
        const rows = Math.max(PHONE_MIN_ROWS, pd.rows)
        if (term.cols !== cols || term.rows !== rows) {
          try { term.resize(cols, rows) } catch {}
        }
        requestAnimationFrame(() => syncElementSize())
        return
      }
      if (geometryRole === 'viewer') {
        setFontSize(BASE_FONT_SIZE)
        requestAnimationFrame(syncElementSize)
        return
      }
      const autoFit = useStore.getState().terminalAutoFit

      // Clear stale min-dims so proposeDimensions reads the wrapper's actual size
      // The host has auto height, so removing its minimum makes FitAddon
      // measure the *old terminal screen*. Seed the available wrapper height
      // instead; otherwise expanding a grid cell never adds terminal rows.
      el.style.minHeight = wrapper ? `${wrapper.clientHeight}px` : ''
      el.style.minWidth = ''

      // Always start from the base font size before measuring
      if (term.options.fontSize !== BASE_FONT_SIZE) {
        try { term.options.fontSize = BASE_FONT_SIZE } catch {}
      }

      let dims = proposeDimensions()
      if (!dims || !dims.cols || !dims.rows) {
        // Renderer hasn't computed cell metrics yet (element not painted).
        // Retry up to 10 times — covers view-switch remounts and returning
        // from overlays (MissionControl, etc.) where opacity transitions
        // delay when the element becomes measurable.
        if (fitRetries < 10) {
          fitRetries++
          setTimeout(fitWithMinimum, 100)
        }
        return
      }
      fitRetries = 0

      if (autoFit) {
        // Auto-fit: if cell is too small for the floor at base font, shrink the
        // font proportionally. We pick the more constraining axis so both
        // dimensions fit. When the cell is already big enough, no scaling
        // occurs — proposeDimensions naturally gives us ≥ the floor.
        if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) {
          const scaleW = dims.cols / MIN_COLS
          const scaleH = dims.rows / MIN_ROWS
          const scale = Math.min(scaleW, scaleH)
          const newSize = Math.max(6, Math.floor(BASE_FONT_SIZE * scale * 10) / 10)
          if (newSize !== term.options.fontSize) {
            try { term.options.fontSize = newSize } catch {}
            const dims2 = proposeDimensions()
            if (dims2 && dims2.cols && dims2.rows) dims = dims2
          }
        }
        // Use proposed dims directly (already ≥ MIN after scaling).
        // DON'T clamp with Math.max — that could push the terminal larger
        // than the cell and cause overflow, defeating auto-fit.
        const cols = Math.max(MIN_COLS, dims.cols)
        const rows = dims.rows < MIN_ROWS ? MIN_ROWS : dims.rows
        if (term.cols !== cols || term.rows !== rows) {
          try { term.resize(cols, rows) } catch {}
        }
      } else {
        // Standard mode: maintain the MIN_COLS×MIN_ROWS floor, overflow + scroll if needed.
        const cols = Math.max(MIN_COLS, dims.cols)
        const rows = Math.max(MIN_ROWS, dims.rows)
        if (term.cols !== cols || term.rows !== rows) {
          try { term.resize(cols, rows) } catch {}
        }
      }

      rememberSessionGeometry()
      // Always synchronize element dimensions, keeping container padded and scrollable.
      requestAnimationFrame(() => syncElementSize())
    }

    // Scroll the external wrapper so the cursor row is visible.
    const ensureCursorVisible = () => {
      if (!wrapper) return
      if (el.classList.contains('is-overview-preview')) { anchorPreview(); return }
      if (wrapper.scrollHeight <= wrapper.clientHeight + 2) return
      const screen = el.querySelector('.xterm-screen')
      if (!screen) return
      let cursorY
      try { cursorY = term.buffer.active.cursorY } catch { return }
      if (cursorY == null) return

      const paddingTop = 4
      const rowH = screen.clientHeight / Math.max(1, term.rows)
      const cursorTop = cursorY * rowH + paddingTop
      const cursorBot = cursorTop + rowH
      const margin = Math.min(rowH * 2, 32)
      if (cursorTop < wrapper.scrollTop + margin) {
        wrapper.scrollTop = Math.max(0, cursorTop - margin)
      } else if (cursorBot > wrapper.scrollTop + wrapper.clientHeight - margin) {
        wrapper.scrollTop = cursorBot - wrapper.clientHeight + margin
      }
    }

    // Wheel passthrough: when the wrapper overflows (min-size mode), capture
    // wheel before xterm's mouse-tracking mode swallows it, and scroll the
    // wrapper. When there is no overflow, fall through so xterm handles
    // wheel normally (scrollback in tabs view, etc.).
    const wheelHandler = (e) => {
      if (!wrapper) return
      const preview = el.classList.contains('is-overview-preview')
      const horizontal = e.deltaX || (e.shiftKey ? e.deltaY : 0)
      if (horizontal && wrapper.scrollWidth > wrapper.clientWidth + 2) {
        e.preventDefault()
        e.stopPropagation()
        wrapper.scrollLeft += horizontal
        return
      }
      if (preview && e.deltaY < 0) previewFollowing = false
      // No overflow — let xterm handle (scrollback, etc.)
      if (wrapper.scrollHeight <= wrapper.clientHeight + 2 &&
          wrapper.scrollWidth <= wrapper.clientWidth + 2) return
      // At scroll boundaries, let xterm handle for scrollback navigation
      if (e.deltaY < 0 && wrapper.scrollTop <= 0) return
      if (e.deltaY > 0 && wrapper.scrollTop >= wrapper.scrollHeight - wrapper.clientHeight - 2) return
      e.preventDefault()
      e.stopPropagation()
      wrapper.scrollTop += e.deltaY
      if (preview) previewFollowing = wrapper.scrollTop >= wrapper.scrollHeight - wrapper.clientHeight - 2
    }
    el.addEventListener('wheel', wheelHandler, { passive: false, capture: true })
    const previewScrollHandler = () => {
      if (wrapper && el.classList.contains('is-overview-preview')) {
        previewFollowing = wrapper.scrollTop >= wrapper.scrollHeight - wrapper.clientHeight - 2
      }
    }
    wrapper?.addEventListener('scroll', previewScrollHandler, { passive: true })

    // Image paste capture: xterm.js calls stopPropagation + preventDefault on
    // paste events before they reach the React onPaste handler. We intercept
    // in capture phase (fires before xterm's bubble-phase handler) so image
    // pastes are uploaded and shown in the preview strip. Text pastes fall
    // through to xterm's normal clipboard handling.
    const pasteHandler = async (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          e.stopPropagation()
          const blob = item.getAsFile()
          if (!blob) return
          try {
            const formData = new FormData()
            formData.append('file', blob, `paste.${item.type.split('/')[1]}`)
            const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
            const data = await res.json()
            setPastedImages((prev) => [...prev, {
              url: data.url,
              path: data.path,
              filename: data.filename,
              previewUrl: URL.createObjectURL(blob),
            }])
            // Type the file path into terminal so Claude can reference it
            const targetId = getWritableSessionId()
            const ws = useStore.getState().ws
            if (targetId && ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ action: 'input', session_id: targetId, data: data.path + ' ' }))
            } else if (!targetId) {
              notifyNoWritableTarget()
            }
          } catch (err) {
            console.error('Paste upload failed:', err)
            useStore.getState().addNotification?.({ type: 'error', message: 'Image paste failed' })
          }
          return
        }
      }
      // No image found — let xterm handle it (text paste)
    }
    el.addEventListener('paste', pasteHandler, { capture: true })

    // Right-click context menu: intercept in capture phase (same reason as
    // paste — xterm swallows the event before React's bubble-phase handler).
    const contextMenuHandler = (e) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('contextmenu', contextMenuHandler, { capture: true })

    // Check if xterm's scrollback viewport is at the very bottom.
    // Used to decide whether to auto-scroll after writing output — if the
    // user has manually scrolled up to review history, we leave them there.
    const isWrapperNearBottom = () => {
      if (!wrapper) return true
      return wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 120
    }

    const scrollToLiveOutput = () => {
      try { term.scrollToBottom() } catch {}
      requestAnimationFrame(() => {
        if (wrapper) wrapper.scrollTop = wrapper.scrollHeight
        ensureCursorVisible()
        forceRefresh()
      })
    }

    const isAtBottom = () => {
      try {
        const buf = term.buffer.active
        const xtermAtBottom = buf.viewportY >= buf.baseY
        const wrapperAtBottom = isWrapperNearBottom()
        return xtermAtBottom && wrapperAtBottom
      } catch { return true }
    }

    // ── Render activity tracking ───────────────────────────────────────
    // The 1Hz safety-net poll below uses this to suppress refresh when
    // the terminal has been quiet — avoids waking the renderer for idle
    // sessions. Bumped on every PTY write and every user keystroke.
    let lastActivityAt = Date.now()
    const bumpActivity = () => { lastActivityAt = Date.now() }

    // Force a full visible-rows refresh. Used after writes settle, after
    // resize/fit, and on visibility transitions where xterm's dirty
    // tracking can desync from the buffer (e.g. when the element was
    // hidden via opacity:0 during the last paint).
    const forceRefresh = () => {
      try {
        const rows = term.rows
        if (rows > 0) term.refresh(0, rows - 1)
      } catch {}
    }

    // Batch writes per animation frame — prevents split ANSI sequences
    // from causing rendering artifacts
    let pendingData = ''
    let writeRaf = null
    // Terminals that are not the focused one flush at most every
    // BACKGROUND_WRITE_MS instead of every frame. With xterm's DOM renderer a
    // streaming terminal repaints its whole screen on each flush, so five
    // agents printing at once kept the main thread busy and made clicks and
    // typing feel sluggish. The focused terminal still updates every frame.
    let writeTimer = null
    let streamGeneration = null
    let lastSequence = 0
    // Reset the screen and drop output still waiting for its flush, so old
    // buffered output never lands on the fresh screen.
    const resetScreen = () => {
      pendingData = ''
      if (writeRaf) cancelAnimationFrame(writeRaf)
      writeRaf = null
      if (writeTimer) clearTimeout(writeTimer)
      writeTimer = null
      term.reset()
    }
    const batchWrite = (data, metadata = {}) => {
      if (metadata.stream_generation) {
        if (streamGeneration && streamGeneration !== metadata.stream_generation) {
          resetScreen()
          lastSequence = 0
        }
        streamGeneration = metadata.stream_generation
      }
      if (Number.isInteger(metadata.sequence)) {
        if (metadata.sequence <= lastSequence) return
        lastSequence = metadata.sequence
      }
      pendingData += data
      bumpActivity()
      if (writeRaf || writeTimer) return
      const flush = () => {
        if (pendingData) {
          const shouldScroll = isAtBottom()
          const dataToWrite = pendingData
          pendingData = ''
          term.write(dataToWrite, () => {
            // Scroll after xterm finishes parsing so we land at the true
            // bottom, but only if the user wasn't reviewing scrollback.
            if (shouldScroll) scrollToLiveOutput()
          })
        }
        writeRaf = null
      }
      if (useStore.getState().activeSessionId === sessionId) {
        writeRaf = requestAnimationFrame(flush)
      } else {
        writeTimer = setTimeout(() => {
          writeTimer = null
          writeRaf = requestAnimationFrame(flush)
        }, BACKGROUND_WRITE_MS)
      }
    }

    terminalWriters.set(sessionId, batchWrite)

    // When xterm receives focus (e.g. user clicks in the terminal),
    // sync the active session so the grid border / tab highlight updates.
    // xterm.js 5.5+ removed term.onFocus — use a DOM focus listener instead.
    const focusHandler = () => {
      const store = useStore.getState()
      if (store.activeSessionId !== sessionId) {
        store.setActiveSession(sessionId)
      }
    }
    const xtermTextarea = el.querySelector('.xterm-helper-textarea') || el
    xtermTextarea.addEventListener('focus', focusHandler)

    // Forward keystrokes to backend, and feed each chunk through the
    // input tracker so the floating @token badge stays in sync with
    // what the user has typed into Claude's input box.
    const sendInput = (raw) => {
      const session = useStore.getState().sessions[sessionId]
      // auth_failed does not block typing: signing in (e.g. /login) happens here.
      if (session?.read_only) return
      // Phone key bar: a sticky ⌃ turns the next typed key into its control byte.
      const data = applyStickyCtrl(sessionId, raw)
      trackTerminalInput(sessionId, data)
      bumpActivity()
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data }))
      }
    }
    const inputDisp = term.onData(sendInput)

    // Core resize: fit terminal + notify backend + fix scroll.
    const doResize = () => {
      if (!phoneVisible()) {
        // Phone left the terminal view (chat view, overview): give the size back.
        releasePhoneGeometry()
        return
      }
      if (geometryRole !== 'viewer' || overviewPreviewRef.current || phoneRef.current) fitWithMinimum()
      const ws = useStore.getState().ws
      if (phoneRef.current) {
        // Phone Session level: claim the PTY at the phone's size, even from a
        // Mac that owned it; the Mac follows as a viewer until it is released.
        if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0 && startedSessions.has(sessionId) && !pendingPtyStarts.has(sessionId)
          && !useStore.getState().sessions[sessionId]?.read_only) {
          ws.send(JSON.stringify({ action: 'claim_geometry', session_id: sessionId, cols: term.cols, rows: term.rows }))
          phoneClaimed = true
        }
        ensureCursorVisible()
        requestAnimationFrame(() => requestAnimationFrame(forceRefresh))
        setTimeout(forceRefresh, 250)
        return
      }
      // Skip the WS send until start_pty has been sent. ResizeObserver,
      // IntersectionObserver, and the cc-terminal-refit listener all fire on
      // mount, but start_pty is deferred by 2 frames + 200ms so layout can
      // settle before measuring. Backend WS messages are processed serially,
      // so any resize arriving before start_pty hits is_alive() → False and
      // replies "Session not running", which then renders as a red error
      // line in the xterm buffer.
      if (
        ws?.readyState === WebSocket.OPEN
        && term.cols > 0
        && term.rows > 0
        && startedSessions.has(sessionId)
        && !pendingPtyStarts.has(sessionId)
        && geometryRole !== 'viewer'
      ) {
        ws.send(JSON.stringify({
          action: 'resize',
          session_id: sessionId,
          cols: term.cols,
          rows: term.rows,
        }))
      }
      ensureCursorVisible()
      // After fit, xterm's renderer may still hold stale row state from the
      // previous size — force a full repaint once layout settles. Two rAFs +
      // a short timeout cover both fast tab-switch repaints and slow opacity
      // transitions (MissionControl, overlays) where dimensions stabilize late.
      requestAnimationFrame(() => requestAnimationFrame(forceRefresh))
      setTimeout(forceRefresh, 250)
    }

    // Resize — debounced, skips rapid intermediate sizes
    let resizeTimer = null
    const sendResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doResize, 200)
    }

    // Every layout/focus source shares the same debounce.
    const ctrl = terminalControls.get(sessionId)
    if (ctrl) ctrl.refit = sendResize
    const setPhoneFont = (size) => {
      phoneFont = writePhoneFont(size)
      if (!phoneRef.current) return phoneFont
      setFontSize(phoneFont)
      sendResize()
      return phoneFont
    }
    if (ctrl) Object.assign(ctrl, {
      /** Bytes typed by the phone key bar; same path as the keyboard. */
      input: sendInput,
      /** Paste text (bracketed when the CLI asked for it). */
      paste: (text) => { try { term.paste(text) } catch { /* disposed */ } },
      /** DECCKM: arrows send SS3 instead of CSI (vim, less). */
      appCursor: () => { try { return !!term.modes.applicationCursorKeysMode } catch { return false } },
      focus: () => term.focus(),
      blur: () => term.blur(),
      hasFocus: () => document.activeElement === xtermTextarea,
      stepPhoneFont: (delta) => setPhoneFont(phoneFont + delta),
      setPhoneFont,
    })

    // ── Phone touch: swipe scrolls the scrollback, pinch sets the font,
    // long-press offers Paste, a tap focuses (opens the keyboard). The phone
    // wrapper has touch-action:none, so these pointers are ours alone.
    const pointers = new Map()
    let gesture = null
    let longPressTimer = null
    let scrollRest = 0
    let momentumRaf = null
    const stopMomentum = () => { if (momentumRaf) cancelAnimationFrame(momentumRaf); momentumRaf = null }
    const scrollPhoneLines = (lines) => {
      if (!lines) return
      keepLiveUntil = 0
      try {
        if (term.buffer.active.type === 'alternate') {
          // Full-screen apps (less, vim) have no scrollback: page with arrows.
          const seq = (lines < 0 ? 'A' : 'B')
          const prefix = term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
          sendInput((prefix + seq).repeat(Math.min(Math.abs(lines), 5)))
        } else {
          term.scrollLines(lines)
        }
      } catch { /* disposed */ }
    }
    const distance = () => {
      const [a, b] = [...pointers.values()]
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }
    const onPointerDown = (e) => {
      if (!phoneRef.current || e.pointerType !== 'touch') return
      stopMomentum()
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      setPhonePaste(null)
      if (pointers.size === 1) {
        gesture = { type: 'press', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), v: 0 }
        clearTimeout(longPressTimer)
        longPressTimer = setTimeout(() => {
          if (gesture?.type !== 'press') return
          gesture.type = 'longpress'
          const box = wrapper?.getBoundingClientRect()
          setPhonePaste({ x: gesture.x0 - (box?.left || 0), y: gesture.y0 - (box?.top || 0) })
        }, LONG_PRESS_MS)
      } else if (pointers.size === 2) {
        clearTimeout(longPressTimer)
        gesture = { type: 'pinch', d0: distance() || 1, f0: term.options.fontSize }
      }
    }
    const onPointerMove = (e) => {
      if (e.pointerType !== 'touch') return
      const p = pointers.get(e.pointerId)
      if (!p || !gesture) return
      p.x = e.clientX; p.y = e.clientY
      if (gesture.type === 'pinch') {
        if (pointers.size < 2) return
        const size = clampPhoneFont(gesture.f0 * distance() / gesture.d0)
        if (size !== term.options.fontSize) { setFontSize(size); phoneFont = size; sendResize() }
        e.preventDefault()
        return
      }
      if (gesture.type === 'press' && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) {
        gesture.type = 'pan'
        clearTimeout(longPressTimer)
      }
      if (gesture.type !== 'pan') return
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y
      const now = performance.now()
      gesture.v = dy / Math.max(1, now - gesture.t) // px per ms, finger direction
      gesture.x = e.clientX; gesture.y = e.clientY; gesture.t = now
      const cellH = readCell()?.height || 15
      // Finger down = older lines (scroll up), like any touch list.
      scrollRest -= dy / cellH
      const lines = Math.trunc(scrollRest)
      if (lines) { scrollRest -= lines; scrollPhoneLines(lines); updateBehind() }
      if (dx && wrapper) wrapper.scrollLeft -= dx
      e.preventDefault()
    }
    const onPointerEnd = (e) => {
      if (e.pointerType !== 'touch' || !pointers.has(e.pointerId)) return
      pointers.delete(e.pointerId)
      clearTimeout(longPressTimer)
      const g = gesture
      if (g?.type === 'pinch') {
        if (pointers.size < 2) { setPhoneFont(term.options.fontSize); gesture = null }
        return
      }
      gesture = null
      if (!g || e.type === 'pointercancel') return
      if (g.type === 'press') { try { term.focus() } catch { /* disposed */ } return }
      if (g.type === 'pan' && Math.abs(g.v) > 0.3 && performance.now() - g.t < 80) {
        // A flick keeps scrolling and slows down.
        let v = g.v
        let last = performance.now()
        const cellH = readCell()?.height || 15
        const step = (now) => {
          const dt = now - last; last = now
          v *= Math.pow(0.95, dt / 16)
          if (Math.abs(v) < 0.05) { momentumRaf = null; return }
          scrollRest -= (v * dt) / cellH
          const lines = Math.trunc(scrollRest)
          if (lines) { scrollRest -= lines; scrollPhoneLines(lines); updateBehind() }
          momentumRaf = requestAnimationFrame(step)
        }
        momentumRaf = requestAnimationFrame(step)
      }
    }
    // xterm scrolls its own viewport on touchmove; on the phone the pointer
    // handlers above own the gesture, so its handlers must not run as well.
    const swallowTouch = (e) => { if (phoneRef.current) { e.stopPropagation(); if (e.cancelable && e.type === 'touchmove') e.preventDefault() } }
    const gestureHost = wrapper || el
    // Lines between the shown rows and the live bottom (data attribute for
    // tests, a "Live" button when > 0).
    const updateBehind = () => {
      if (!phoneRef.current) return
      try {
        const b = term.buffer.active
        const behind = Math.max(0, b.baseY - b.viewportY)
        gestureHost.dataset.linesBehind = String(behind)
        setPhoneScrolledBack(behind > 0)
      } catch { /* disposed */ }
    }
    const scrollDisp = term.onScroll(updateBehind)
    const writeDisp = term.onWriteParsed(updateBehind)
    phoneLiveRef.current = () => { stopMomentum(); try { term.scrollToBottom() } catch { /* disposed */ } updateBehind() }
    gestureHost.addEventListener('pointerdown', onPointerDown, { capture: true })
    gestureHost.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
    gestureHost.addEventListener('pointerup', onPointerEnd, { capture: true })
    gestureHost.addEventListener('pointercancel', onPointerEnd, { capture: true })
    gestureHost.addEventListener('touchmove', swallowTouch, { capture: true, passive: false })
    const removePhoneGestures = () => {
      releasePhoneGeometry()
      scrollDisp.dispose()
      writeDisp.dispose()
      clearTimeout(longPressTimer)
      stopMomentum()
      gestureHost.removeEventListener('pointerdown', onPointerDown, { capture: true })
      gestureHost.removeEventListener('pointermove', onPointerMove, { capture: true })
      gestureHost.removeEventListener('pointerup', onPointerEnd, { capture: true })
      gestureHost.removeEventListener('pointercancel', onPointerEnd, { capture: true })
      gestureHost.removeEventListener('touchmove', swallowTouch, { capture: true })
    }
    // Reparenting resets DOM scroll offsets. xterm also pauses its renderer
    // while parked, so a resize may not reach the canvas until its next render.
    // Restore geometry and scroll together before exposing that rendered frame.
    let revealPending = false
    let revealFrame = null
    const settleRevealedViewport = () => {
      syncElementSize()
      syncViewport()
      if (atLiveBottom()) ensureCursorVisible()
    }
    const revealDisp = term.onRender(() => {
      if (!revealPending || revealFrame !== null) return
      revealFrame = requestAnimationFrame(() => {
        revealFrame = null
        settleRevealedViewport()
        revealPending = false
        el.style.opacity = ''
      })
    })
    applyLevelRef.current = () => {
      if (!isShown(wrapper)) return
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null }
      if (revealFrame !== null) cancelAnimationFrame(revealFrame)
      revealFrame = null
      revealPending = true
      el.style.opacity = '0'
      doResize()
      if (overviewPreviewRef.current) keepLiveBottom()
      settleRevealedViewport()
      forceRefresh()
    }

    const observer = new ResizeObserver(() => {
      // The slot can finish laying out after the portal commit. Keep the
      // wrapper aligned before paint, while PTY resizes remain debounced.
      if (isShown(wrapper)) {
        syncElementSize()
        if (overviewPreviewRef.current) anchorPreview()
      }
      sendResize()
    })
    // Observe the element itself (not the wrapper) so the observer fires
    // when React moves the element to a different parent (e.g. grid hidden
    // container → visible grid cell).  Also observe the wrapper if it exists
    // so layout changes on the parent still trigger a refit.
    observer.observe(el)
    if (wrapper && wrapper !== el) observer.observe(wrapper)

    // Refit on grid layout / workspace changes (dispatched by App.jsx).
    // Also bump activity so the 1Hz safety net runs for ~3s after a refit —
    // the most common refit trigger is a tab becoming active (isActive effect
    // dispatches cc-terminal-refit), and a freshly-revealed terminal whose
    // last write was minutes ago needs the safety net to cover slow opacity
    // transitions and renderer resync without us having to stagger a dozen
    // explicit forceRefresh timeouts here.
    const refitListener = () => { bumpActivity(); sendResize() }
    window.addEventListener('cc-terminal-refit', refitListener)


    // IntersectionObserver: detect when this terminal transitions from
    // hidden (1x1px off-screen container in grid mode) to visible (real
    // grid cell).  The ResizeObserver alone can miss this because the
    // observed wrapper node may be stale after React reparents the element.
    let wasVisible = el.offsetWidth > 10
    const intersectionObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const nowVisible = entry.isIntersecting && entry.boundingClientRect.width > 10
        if (nowVisible && !wasVisible) {
          // Became visible — refit after layout settles. doResize already
          // schedules a forceRefresh, so stale rows that accumulated while
          // hidden (opacity:0 tab, off-screen grid cell) get repainted here.
          // Bump activity so the 1Hz safety net keeps an eye on it for a
          // few ticks after re-entry.
          bumpActivity()
          sendResize()
          // Belt-and-suspenders refresh in case the doResize-triggered
          // refresh races with the opacity transition.
          setTimeout(forceRefresh, 500)
        }
        wasVisible = nowVisible
      }
    }, { threshold: 0.01 })
    intersectionObs.observe(el)

    // ── 1Hz safety-net refresh ─────────────────────────────────────────
    // xterm's renderer occasionally desyncs from buffer state on rapid
    // writes — symptoms: cursor in the wrong column, missing fragments,
    // stale rows that only repaint after another event. A periodic full
    // refresh forces the renderer back in sync. We gate on:
    //   1. Recent activity (writes or keystrokes within 3s) — idle
    //      sessions don't need repainting.
    //   2. Visibility — skip when the page is hidden, the element is
    //      offscreen (offsetParent === null when display:none), or the
    //      IntersectionObserver last reported it as not visible.
    // refresh(0, rows-1) is cheap (single frame, no DOM thrash) but we
    // still suppress it in the common idle case to keep CPU at zero.
    const SAFETY_NET_INTERVAL_MS = 1000
    const ACTIVITY_WINDOW_MS = 3000
    const safetyNetTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (!wasVisible) return
      if (!el.offsetParent && el.style.display !== '') return
      if (Date.now() - lastActivityAt > ACTIVITY_WINDOW_MS) return
      forceRefresh()
    }, SAFETY_NET_INTERVAL_MS)

    // Refit when the page regains visibility (e.g. switching back from another
    // app/window). In grid view all terminals are always mounted so the
    // isActive-based refit effect doesn't fire, and ResizeObserver won't
    // trigger because container dimensions haven't changed — but the browser
    // may have deferred layout while the tab was hidden, leaving terminals
    // squished. A short delay lets the browser finish any pending layout work.
    const visibilityListener = () => {
      if (document.visibilityState === 'hidden' && phoneRef.current) releasePhoneGeometry()
      if (document.visibilityState === 'visible') {
        // Bump activity so the safety-net poll fires for a few ticks after
        // the tab is re-shown — covers the case where the browser deferred
        // paints while hidden and rows are stale.
        bumpActivity()
        sendResize()
      }
    }
    document.addEventListener('visibilitychange', visibilityListener)

    // Same for window focus — covers alt-tabbing between windows on the same
    // display where visibilitychange may not fire.
    const windowFocusListener = sendResize
    window.addEventListener('focus', windowFocusListener)

    // Chrome focus mode (⌘↑) escapes here when the user presses Escape on a
    // focused chrome button. Only the active session's terminal should grab
    // focus, otherwise every mounted (hidden) terminal would fight for it.
    // A terminal that is mounted but not on screen (closed drawer, hidden
    // cell, chat view) leaves the keyboard to the chat composer
    // (lib/sessionInputFocus.js).
    const focusListener = () => {
      if (useStore.getState().activeSessionId === sessionId && isShown(wrapper)) {
        term.focus()
      }
    }
    window.addEventListener('cc-focus-terminal', focusListener)

    const requestResume = (fullReplay = false) => {
      if (useStore.getState().sessions[sessionId]?.read_only) return
      if (geometryRole !== 'viewer') fitWithMinimum()
      const ws = useStore.getState().ws
      if (ws?.readyState !== WebSocket.OPEN) return
      const keepSize = phoneRef.current && !phoneVisible()
      ws.send(JSON.stringify({
        action: 'resume_pty',
        session_id: sessionId,
        cols: keepSize ? undefined : (term.cols > 0 ? term.cols : MIN_COLS),
        rows: keepSize ? undefined : (term.rows > 0 ? term.rows : MIN_ROWS),
        after_sequence: fullReplay ? null : lastSequence,
        stream_generation: fullReplay ? null : streamGeneration,
      }))
    }

    const reconnectListener = () => requestResume(false)
    const processReplacedListener = (event) => {
      if (event.detail?.session_id !== sessionId) return
      geometryRole = 'unknown'
      streamGeneration = null
      lastSequence = 0
      resetScreen()
      requestResume(true)
    }
    const terminalResetListener = (event) => {
      if (event.detail?.session_id !== sessionId) return
      resetScreen()
      streamGeneration = event.detail.stream_generation || null
      lastSequence = 0
    }
    const terminalResumedListener = (event) => {
      if (event.detail?.session_id !== sessionId) return
      if (event.detail.stream_generation) {
        streamGeneration = event.detail.stream_generation
      }
      if (Number.isInteger(event.detail.latest_sequence)) {
        lastSequence = Math.max(lastSequence, event.detail.latest_sequence)
      }
    }
    const terminalGeometryListener = (event) => {
      const geometry = event.detail
      if (geometry?.session_id !== sessionId) return
      geometryRole = geometry.authoritative ? 'owner' : 'viewer'
      if (phoneRef.current) {
        if (geometry.authoritative && !phoneVisible()) {
          // Attached in chat view and got the size by default: not ours to hold.
          phoneClaimed = true
          releasePhoneGeometry()
          return
        }
        if (phoneVisible()) {
          phoneClaimed = phoneClaimed || !!geometry.authoritative
          // Someone took it while the phone shows it full size: take it back
          // once (not in a loop with a second phone doing the same).
          if (!geometry.authoritative && performance.now() - phoneReclaimAt > 3000) {
            phoneReclaimAt = performance.now()
            sendResize()
            return
          }
        }
      }
      const cols = Number(geometry.cols)
      const rows = Number(geometry.rows)
      if (cols > 0 && rows > 0 && (term.cols !== cols || term.rows !== rows)) {
        try { term.resize(cols, rows) } catch {}
      }
      requestAnimationFrame(() => {
        if (overviewPreviewRef.current) {
          fitWithMinimum()
          // The preview may pick a different Session-level size (the grid
          // box changed). xterm and the PTY must never differ in size: a TUI
          // positions its cursor for the PTY size and garbles otherwise.
          if (geometryRole === 'owner' && (term.cols !== cols || term.rows !== rows)) sendResize()
        }
        syncElementSize()
        forceRefresh()
      })
    }
    const geometryAvailableListener = (event) => {
      if (event.detail?.session_id !== sessionId || geometryRole !== 'viewer') return
      geometryRole = 'unknown'
      sendResize()
    }
    window.addEventListener('cc-websocket-reconnected', reconnectListener)
    window.addEventListener('cc-terminal-process-replaced', processReplacedListener)
    window.addEventListener('cc-terminal-reset', terminalResetListener)
    window.addEventListener('cc-terminal-resumed', terminalResumedListener)
    window.addEventListener('cc-terminal-geometry', terminalGeometryListener)
    window.addEventListener('cc-terminal-geometry-available', geometryAvailableListener)

    const removeTerminalProtocolListeners = () => {
      window.removeEventListener('cc-websocket-reconnected', reconnectListener)
      window.removeEventListener('cc-terminal-process-replaced', processReplacedListener)
      window.removeEventListener('cc-terminal-reset', terminalResetListener)
      window.removeEventListener('cc-terminal-resumed', terminalResumedListener)
      window.removeEventListener('cc-terminal-geometry', terminalGeometryListener)
      window.removeEventListener('cc-terminal-geometry-available', geometryAvailableListener)
    }

    // Public Brainstormer views are read-only: render captured output, but
    // never create or control a PTY from this browser.
    if (useStore.getState().sessions[sessionId]?.read_only) {
      let cancelled = false
      const loadReadOnlyOutput = async () => {
        try {
          const data = await api.getSessionOutput(sessionId, 600)
          if (cancelled) return
          const text = data?.text || data?.output || ''
          if (text) {
            term.write(text)
          } else {
            term.writeln('Read-only public Brainstormer. No terminal output has been captured yet.')
          }
          fitWithMinimum()
          scrollToLiveOutput()
        } catch (err) {
          if (!cancelled) {
            term.writeln(`Unable to load public Brainstormer output: ${err?.message || err}`)
          }
        }
      }
      const readOnlyTimer = setTimeout(loadReadOnlyOutput, 120)
      return () => {
        cancelled = true
        clearTimeout(readOnlyTimer)
        if (resizeTimer) clearTimeout(resizeTimer)
        if (writeRaf) cancelAnimationFrame(writeRaf)
        if (writeTimer) clearTimeout(writeTimer)
        clearInterval(safetyNetTimer)
        revealDisp.dispose()
        if (revealFrame !== null) cancelAnimationFrame(revealFrame)
        unsubscribeTheme()
        termRef.current = null
        terminalWriters.delete(sessionId)
        terminalControls.delete(sessionId)
        inputDisp.dispose()
        xtermTextarea.removeEventListener('focus', focusHandler)
        observer.disconnect()
        intersectionObs.disconnect()
        window.removeEventListener('cc-terminal-refit', refitListener)
        window.removeEventListener('cc-focus-terminal', focusListener)
        document.removeEventListener('visibilitychange', visibilityListener)
        window.removeEventListener('focus', windowFocusListener)
        removeTerminalProtocolListeners()
        el.removeEventListener('wheel', wheelHandler, { capture: true })
        wrapper?.removeEventListener('scroll', previewScrollHandler)
        el.removeEventListener('paste', pasteHandler, { capture: true })
        el.removeEventListener('contextmenu', contextMenuHandler, { capture: true })
        removePhoneGestures()
        releaseWebgl(); term.dispose()
      }
    }

    // Start PTY — wait for layout to fully settle before measuring
    if (!startedSessions.has(sessionId)) {
      let retryTimer = null

      const tryStart = () => {
        if (startedSessions.has(sessionId)) return
        const currentSession = useStore.getState().sessions[sessionId]
        const currentStatus = currentSession?.status
        if (!currentSession || currentSession.archived || !useStore.getState().openTabs.includes(sessionId) || currentStatus === 'exited' || currentStatus === 'error') {
          return
        }
        if (!currentSession.pty_alive) return
        fitWithMinimum()

        const ws = useStore.getState().ws
        // Fall back to MIN_COLS/MIN_ROWS when terminal is in a hidden container
        // (e.g. background tab in grid mode at 1x1px). The refit on tab
        // activation will send a resize with the correct dimensions later.
        const cols = term.cols > 0 ? term.cols : MIN_COLS
        const rows = term.rows > 0 ? term.rows : MIN_ROWS
        if (ws?.readyState === WebSocket.OPEN) {
          startedSessions.add(sessionId)
          useStore.getState().setSessionStarted?.(sessionId, true)
          ws.send(JSON.stringify({
            action: 'start_pty',
            session_id: sessionId,
            cols,
            rows,
            // Phone in chat view: attach to a running PTY without resizing it.
            ...(phoneRef.current && !phoneVisible() ? { keep_size: true } : {}),
          }))
          // Only the active session may take keyboard focus. Every mounted
          // terminal runs this on page load; an unconditional focus() let the
          // last one to start steal the active session (focus listener).
          if (useStore.getState().activeSessionId === sessionId && isShown(wrapper)) term.focus()
          // First paint may not have happened yet — wait two frames so the
          // .xterm-screen has its real height before we measure for scrolling.
          requestAnimationFrame(() => requestAnimationFrame(ensureCursorVisible))
        } else {
          retryTimer = setTimeout(tryStart, 300)
        }
      }

      // Wait 2 frames + 200ms for layout to settle before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(tryStart, 200)
        })
      })

      return () => {
        if (retryTimer) clearTimeout(retryTimer)
        if (resizeTimer) clearTimeout(resizeTimer)
        if (writeRaf) cancelAnimationFrame(writeRaf)
        if (writeTimer) clearTimeout(writeTimer)
        clearInterval(safetyNetTimer)
        revealDisp.dispose()
        if (revealFrame !== null) cancelAnimationFrame(revealFrame)
        unsubscribeTheme()
        termRef.current = null
        terminalWriters.delete(sessionId)
        terminalControls.delete(sessionId)
        inputDisp.dispose()
        xtermTextarea.removeEventListener('focus', focusHandler)
        observer.disconnect()
        intersectionObs.disconnect()
        window.removeEventListener('cc-terminal-refit', refitListener)
        window.removeEventListener('cc-focus-terminal', focusListener)
        document.removeEventListener('visibilitychange', visibilityListener)
        window.removeEventListener('focus', windowFocusListener)
        removeTerminalProtocolListeners()
        el.removeEventListener('wheel', wheelHandler, { capture: true })
        wrapper?.removeEventListener('scroll', previewScrollHandler)
        el.removeEventListener('paste', pasteHandler, { capture: true })
        el.removeEventListener('contextmenu', contextMenuHandler, { capture: true })
        removePhoneGestures()
        releaseWebgl(); term.dispose()
      }
    }

    // ── Remount onto existing PTY ──────────────────────────────────────
    // The new xterm has no sequence watermark, so request an explicit reset
    // plus all retained complete frames. The same protocol requests geometry
    // ownership; a non-owner keeps the authoritative PTY dimensions.
    if (useStore.getState().activeSessionId === sessionId && isShown(wrapper)) term.focus()

    const remountTimer = setTimeout(() => {
      requestResume(true)
      term.scrollToBottom()
      ensureCursorVisible()
    }, 300)

    return () => {
      clearTimeout(remountTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (writeRaf) cancelAnimationFrame(writeRaf)
      if (writeTimer) clearTimeout(writeTimer)
      clearInterval(safetyNetTimer)
      revealDisp.dispose()
      if (revealFrame !== null) cancelAnimationFrame(revealFrame)
      unsubscribeTheme()
      termRef.current = null
      terminalWriters.delete(sessionId)
      terminalControls.delete(sessionId)
      inputDisp.dispose()
      observer.disconnect()
      intersectionObs.disconnect()
      window.removeEventListener('cc-terminal-refit', refitListener)
      window.removeEventListener('cc-focus-terminal', focusListener)
      document.removeEventListener('visibilitychange', visibilityListener)
      window.removeEventListener('focus', windowFocusListener)
      removeTerminalProtocolListeners()
      el.removeEventListener('wheel', wheelHandler, { capture: true })
        wrapper?.removeEventListener('scroll', previewScrollHandler)
      el.removeEventListener('paste', pasteHandler, { capture: true })
      el.removeEventListener('contextmenu', contextMenuHandler, { capture: true })
      removePhoneGestures()
      releaseWebgl(); term.dispose()
    }
  }, [sessionId])

  // Phone ⇄ desktop width: refit with the other sizing rule.
  const phoneMounted = useRef(false)
  useEffect(() => {
    if (!phoneMounted.current) { phoneMounted.current = true; return }
    window.dispatchEvent(new Event('cc-terminal-refit'))
  }, [phone])

  const pastePhoneClipboard = async () => {
    setPhonePaste(null)
    try {
      const text = await navigator.clipboard.readText()
      if (text) terminalControls.get(sessionId)?.paste?.(text)
    } catch {
      useStore.getState().addNotification?.({ type: 'info', message: 'The browser did not allow reading the clipboard.' })
    }
  }
  useEffect(() => {
    if (!phonePaste) return
    const t = setTimeout(() => setPhonePaste(null), 4000)
    return () => clearTimeout(t)
  }, [phonePaste])

  // Every portal placement matters, including parked → drawer and
  // drawer → full (neither changes overviewPreview). Prepare the new
  // viewport before paint; xterm's first rendered frame completes the reveal.
  const placementMounted = useRef(false)
  useLayoutEffect(() => {
    if (!placementMounted.current) { placementMounted.current = true; return }
    if (termRef.current) applyLevelRef.current?.()
  }, [overviewPreview, inDrawer, slotMode, sessionId])

  // ── Tab activation: refit + scroll when this terminal becomes visible ──
  // Terminals are hidden via CSS opacity (not display:none), so
  // ResizeObserver doesn't fire on tab switch. Call refit directly
  // after a double-rAF to let the browser flush layout from the opacity
  // change. The terminal-level handler applies the shared debounce.
  useEffect(() => {
    if (!isActive || !termRef.current) return
    let cancelled = false
    const doRefit = () => {
      if (cancelled) return
      // In grid mode multiple terminals are visible — broadcast so ALL
      // of them refit, not just the newly-active one.
      window.dispatchEvent(new Event('cc-terminal-refit'))
      try { termRef.current?.scrollToBottom() } catch {}
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => doRefit())
    })
    return () => { cancelled = true }
  }, [isActive, sessionId])

  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = files.map((f) => f.path || f.name).join(' ')
    const targetId = getWritableSessionId()
    if (!targetId) {
      notifyNoWritableTarget()
      return
    }
    const ws = useStore.getState().ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'input', session_id: targetId, data: paths }))
    }
  }

  const closeCtxMenu = () => setCtxMenu(null)

  const ctxCopySelection = () => {
    const sel = window.getSelection()?.toString()
    if (sel) navigator.clipboard.writeText(sel)
    closeCtxMenu()
  }

  const ctxPaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        const targetId = getWritableSessionId()
        if (!targetId) {
          notifyNoWritableTarget()
          closeCtxMenu()
          return
        }
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'input', session_id: targetId, data: text }))
        }
      }
    } catch {}
    closeCtxMenu()
  }

  const ctxAnnotate = () => {
    closeCtxMenu()
    window.dispatchEvent(new CustomEvent('open-panel', { detail: 'annotate' }))
  }
  const findRef = useRef(null)
  const ctxFind = () => {
    closeCtxMenu()
    findRef.current?.()
  }

  const removePastedImage = (idx) => {
    setPastedImages((prev) => {
      const img = prev[idx]
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  // External sessions render a status card instead of a terminal
  if (isExternal) {
    return (
      <div className="flex-1 flex items-center justify-center bg-x-surface-2">
        <div className="text-center space-y-3 max-w-sm px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-x-tint border border-x-accent/30">
            <div className={`w-2 h-2 rounded-full ${
              statusMeta.dotClass
            }`} />
            <span className="text-[11px] font-medium text-x-accent">
              Running in native terminal
            </span>
          </div>
          <div className="text-sm text-x-ink-secondary font-medium">{sessionName}</div>
          <div className="text-[11px] text-x-muted leading-relaxed">
            This session is running in an external terminal window.
            Hook-based tracking is active — state, tools, and subagents
            are being monitored by Commander.
          </div>
          <div className="flex items-center justify-center gap-4 text-[11px] text-x-faint font-mono pt-1">
            <span>cli: {cliType}</span>
            <span>hooks: active</span>
          </div>
        </div>
      </div>
    )
  }

  const composerOffline = isReadOnly
    ? !writableSessionId || writableSession?.status === 'exited'
    : sessionStatus === 'exited'

  return (
    <div className="flex-1 flex flex-col relative" style={{ minHeight: 0 }}>
      {inDrawer && !isReadOnly && !isShell && <div className="px-3 py-1 border-b border-x-line text-[11px]">
        <PermissionModePicker sessionId={sessionId} testId="terminal-perms" />
      </div>}
      {/* Scroll wrapper — xterm's internal viewport resets scrollTop for
          alt-screen, so we scroll the entire .xterm element from OUTSIDE. */}
      <div className="flex-1 flex flex-col relative" style={{ minHeight: 0 }}>
        <div className={`flex-1 bg-x-surface-2${phone ? ' ive-phone-terminal' : ''}`} data-phone-terminal={phone ? sessionId : undefined} data-terminal-session={sessionId} style={{ overflow: 'auto', minHeight: 0, minWidth: 0 }}>
          {/* Clip xterm's off-screen input helper to the sized host. Its stale
              cursor position must not enlarge the wrapper's scroll range. */}
          <div
            ref={containerRef}
            className="bg-x-surface-2"
            style={{ padding: '4px 6px', minHeight: '100%', overflow: 'hidden' }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDoubleClickCapture={overviewPreview ? (event) => {
              if (event.button !== 0 || event.target.closest('a, button, input')) return
              event.preventDefault()
              event.stopPropagation()
              useStore.getState().goSession(sessionId)
              requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
            } : undefined}
          />
        </div>
        {/* ⌘F: find in this terminal's buffer (components/find). */}
        {!overviewPreview && <TerminalFindBar sessionId={sessionId} termRef={termRef} openRef={findRef} />}
        {phone && phonePaste && (
          <button
            type="button"
            className="ive-phone-paste"
            style={{ left: Math.max(8, phonePaste.x - 40), top: Math.max(8, phonePaste.y - 56) }}
            onTouchEnd={(e) => { if (e.cancelable) e.preventDefault(); pastePhoneClipboard() }}
            onClick={pastePhoneClipboard}
          >Paste</button>
        )}
        {phone && phoneScrolledBack && (
          <button type="button" className="ive-phone-live" onClick={() => phoneLiveRef.current?.()} aria-label="Back to the live output">
            ↓ Live
          </button>
        )}
      </div>

      {/* Floating @token badge — positioned over the terminal, outside
          the scroll wrapper so it stays fixed when the user scrolls. */}
      <TerminalTokenBadge sessionId={sessionId} />

      {/* Inline restart banner — shows when the underlying process has exited */}
      {!isReadOnly && isExited && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 bg-x-surface-2 border-t border-x-line text-[11px] shrink-0">
          <span className="text-x-accent-ink font-medium">{isShell ? 'shell exited' : 'process exited'}</span>
          <button
            onClick={() => useStore.getState().restartSession(sessionId)}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink rounded-md font-medium transition-colors duration-[80ms]"
            title={isShell ? 'Open a new shell in this folder' : 'Restart this session'}
          >
            <RotateCcw size={11} />
            {isShell ? 'new shell →' : 'click here to restart →'}
          </button>
        </div>
      )}

      {/* Shift+Enter force-message bar (CLIs that support force_send) */}
      {!isReadOnly && showForceBar && getCliCapability(cliType, 'force_send') && (
        <ForceBar sessionId={sessionId} onClose={() => setShowForceBar(false)} />
      )}

      {/* Pasted image preview strip */}
      {pastedImages.length > 0 && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-t border-x-line overflow-x-auto">
          <span className="text-[11px] text-x-faint font-mono shrink-0">pasted:</span>
          {pastedImages.map((img, i) => (
            <div key={i} className="relative group shrink-0">
              <img
                src={img.previewUrl || img.url}
                className="h-12 rounded border border-x-line object-cover cursor-pointer hover:ring-2 hover:ring-x-accent/60 transition-colors duration-[80ms]"
                title="Click to preview & annotate"
                onClick={() => setAnnotatingImage({ url: img.previewUrl || img.url, index: i })}
              />
              <button
                onClick={(e) => { e.stopPropagation(); removePastedImage(i) }}
                className="absolute -top-1 -right-1 w-4 h-4 bg-x-surface border border-x-line-strong rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-[80ms]"
              >
                <X size={8} className="text-x-muted" />
              </button>
            </div>
          ))}
          <button
            onClick={() => setPastedImages((prev) => {
              prev.forEach((img) => {
                if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
              })
              return []
            })}
            className="text-[11px] text-x-faint hover:text-x-ink-secondary font-mono shrink-0 transition-colors duration-[80ms]"
          >
            clear
          </button>
        </div>
      )}

      {/* Image annotator modal */}
      {annotatingImage && (
        <ImageAnnotator
          imageSrc={annotatingImage.url}
          onSave={handleAnnotationSave}
          onClose={() => setAnnotatingImage(null)}
        />
      )}

      {/* Embedded Prompt Composer at bottom */}
      {/* Hidden (not unmounted) in overview tiles: the tile header shows
          name + status, the session view has the full composer. */}
      {!inDrawer && (
        <div ref={composerRef} data-terminal-composer="" style={overviewPreview ? { display: 'none' } : undefined} className="border-t border-x-line bg-x-surface px-3 py-2 flex flex-col gap-2 shrink-0 select-none">
          {isReadOnly && (
            <div className="flex items-center gap-2 rounded-md border border-x-line bg-x-surface-2 px-2.5 py-1.5 text-[11px] text-x-accent">
              <MessageSquareQuote size={11} className="text-x-accent shrink-0" />
              <span className="min-w-0 truncate">
                Read-only public Brainstormer. Notes send to {writableSession?.name || 'your Brainstormer'}.
              </span>
            </div>
          )}
          {/* Row 1: Telemetry, Controls & Status */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {statusMeta.isWorking ? (
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-x-good opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-x-good"></span>
                  </span>
                  <span className="text-x-good font-semibold text-[11px] font-mono">
                    {cliType === 'gemini' ? 'Running' : 'Working'} ({elapsedTime}s)
                  </span>
                </div>
              ) : !isShell && turnDurations[sessionId] && displayMeta.tone !== 'waiting' ? (
                <div className="flex items-center gap-1.5 text-x-muted text-[11px] font-mono">
                  <Clock size={10} className="text-x-accent-ink/80" />
                  <span>Last: {turnDurations[sessionId]}s</span>
                </div>
              ) : (
                <div className={`flex items-center gap-1.5 ${displayMeta.textClass} text-[11px] font-mono`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${displayMeta.dotClass}`} />
                  <span>{displayMeta.label}</span>
                </div>
              )}

              {!isReadOnly && !isShell && <PermissionModePicker sessionId={sessionId} testId="terminal-perms" />}

            </div>

            <div className="text-[11px] font-mono text-x-muted flex items-center gap-2">
              <span>{isShell ? 'Terminal' : cliType}</span>
              {sessionName && <span className="opacity-60">| {sessionName}</span>}
            </div>
          </div>

          {!isShell && <CommandQueue items={queuedCommands} onCancel={(id) => cancelQueuedCommand(sessionId, id)} />}

          {/* Row 2: Input Field (agents only: in a shell you type in the terminal) */}
          {!isShell && <form onSubmit={handleSend} className="x-composer flex items-center gap-1.5 p-1 pl-3">
            <input
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault()
                  cyclePermissionMode()
                }
              }}
              placeholder={isReadOnly
                ? "Add a note to your Brainstormer..."
                : sessionStatus === 'exited'
                  ? "Process offline. Click above to restart."
                  : "Type a task or instruction..."}
              disabled={composerOffline}
              className="flex-1 bg-transparent text-x-ink placeholder-x-muted text-xs focus:outline-none py-1 disabled:cursor-not-allowed"
            />

            {hasSpeechSupport && (
              <button
                type="button"
                onClick={toggleListening}
                disabled={composerOffline}
                className={`w-7 h-7 flex items-center justify-center rounded-lg border transition-colors duration-[80ms] ${
                  isListening
                    ? 'x-mic-listening'
                    : 'bg-x-surface border-x-line text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
                }`}
                title={isListening ? "Stop listening" : "Dictate prompt (Voice Input)"}
              >
                {isListening ? <MicOff size={12} className="animate-pulse" /> : <Mic size={12} />}
              </button>
            )}

            {cliType === 'antigravity' && statusMeta.isWorking && (
              <button
                type="button"
                onClick={(e) => handleSend(e, { delivery: 'wait_for_ready' })}
                disabled={!inputVal.trim() || composerOffline}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-x-accent-ink/30 bg-x-accent-ink/15 text-x-accent-ink hover:bg-x-accent-ink/25 hover:border-x-accent-ink/45 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-[80ms] shrink-0"
                title="Send when Antigravity is ready"
              >
                <Clock size={12} />
              </button>
            )}

            <button
              type="submit"
              disabled={!inputVal.trim() || composerOffline}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-x-accent hover:bg-x-accent-ink text-x-on-accent disabled:opacity-40 disabled:hover:bg-x-accent transition-colors duration-[80ms] shrink-0"
              title={isReadOnly ? 'Send note to your Brainstormer' : cliType === 'antigravity' && statusMeta.isWorking ? 'Steer Antigravity now (Enter)' : 'Submit command (Enter)'}
            >
              <Send size={12} />
            </button>
          </form>}
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <TerminalContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onCopy={ctxCopySelection}
          onPaste={ctxPaste}
          onAnnotate={ctxAnnotate}
          onFind={ctxFind}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  )
}

// ── Terminal right-click context menu ────────────────────────────────
function TerminalContextMenu({ x, y, onCopy, onPaste, onAnnotate, onFind, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    window.addEventListener('contextmenu', handler)
    return () => {
      window.removeEventListener('click', handler)
      window.removeEventListener('contextmenu', handler)
    }
  }, [onClose])

  // Escape closes the menu and only the menu (not sent to the agent, no
  // level change). Any other typed key closes it too and is swallowed, so a
  // keystroke never lands in the CLI while the menu is up.
  useEscapeToClose(true, onClose)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`
    }
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${window.innerHeight - rect.height - 8}px`
    }
  }, [])

  const items = [
    { icon: Copy, label: 'Copy', shortcut: '⌘C', action: onCopy },
    { icon: Clipboard, label: 'Paste', shortcut: '⌘V', action: onPaste },
    null, // divider
    { icon: MessageSquareQuote, label: 'Annotate Output', shortcut: '⌘⇧A', action: onAnnotate },
    { icon: Search, label: 'Find in Terminal', shortcut: formatKeyCombo(useStore.getState().keybindings?.search), action: onFind },
  ]

  return (
    <div
      ref={menuRef}
      role="menu"
      data-ive-popover
      className="fixed z-50 min-w-[180px] bg-x-surface border border-x-line rounded-[10px] shadow-x-1 py-1 text-xs"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item === null ? (
          <div key={i} className="border-t border-x-line-subtle my-1" />
        ) : (
          <button
            key={i}
            role="menuitem"
            onClick={item.action}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-x-hover text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms]"
          >
            <item.icon size={12} className="text-x-faint shrink-0" />
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="text-[11px] text-x-faint font-mono">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  )
}
