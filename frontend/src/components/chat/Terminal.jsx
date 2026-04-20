import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X, RotateCcw, MessageSquareQuote, Copy, Clipboard } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import useStore from '../../state/store'
import { terminalWriters, terminalControls, startedSessions } from '../../lib/terminalWriters'
import { matchesKey } from '../../lib/keybindings'
import { trackTerminalInput } from '../../lib/terminalInputTracker'
import ImageAnnotator from './ImageAnnotator'
import ForceBar from './ForceBar'
import TerminalTokenBadge from './TerminalTokenBadge'
import { getMessageMarkers, getCliCapability } from '../../lib/constants'

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

// Minimum PTY dimensions. Claude Code's TUI assumes ~80x24 — anything smaller
// breaks its layout (input box clipped, conversation overflowing). Instead of
// shrinking the PTY to match a tiny grid cell, we hold the PTY at this floor
// and let the .xterm-viewport scroll inside the cell. The cell stays small,
// the terminal renders correctly, and the user can scroll/follow the cursor.
const MIN_COLS = 80
const MIN_ROWS = 24
const BASE_FONT_SIZE = 13

export default function TerminalView({ sessionId }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const [pastedImages, setPastedImages] = useState([]) // [{ url, path, filename }]
  const [annotatingImage, setAnnotatingImage] = useState(null) // { url, index }
  const [showForceBar, setShowForceBar] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y }
  const sessionStatus = useStore((s) => s.sessions[sessionId]?.status)
  const cliType = useStore((s) => s.sessions[sessionId]?.cli_type || 'claude')
  const isExternal = useStore((s) => !!s.sessions[sessionId]?.is_external)
  const sessionName = useStore((s) => s.sessions[sessionId]?.name || '')
  const isExited = sessionStatus === 'exited'
  const isActive = useStore((s) => s.activeSessionId === sessionId)

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
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: data.path + ' ' }))
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
      theme: {
        background: '#0a0a0f',
        foreground: '#e4e4e7',
        cursor: '#6366f1',
        cursorAccent: '#0a0a0f',
        selectionBackground: 'rgba(99, 102, 241, 0.3)',
        black: '#18181b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#6366f1',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#818cf8',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      },
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term

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
    const PALETTE_16 = [
      '#18181b', '#ef4444', '#22c55e', '#eab308', '#6366f1', '#a855f7', '#06b6d4', '#e4e4e7',
      '#71717a', '#f87171', '#4ade80', '#facc15', '#818cf8', '#c084fc', '#22d3ee', '#fafafa',
    ]
    const cellColor = (cell) => {
      try {
        const mode = cell.getFgColorMode()
        if (mode === 0) return null // default
        const c = cell.getFgColor()
        if (mode === 1 || mode === 2) return PALETTE_16[c] || null // palette 16 / 256 (fallback for 16-255)
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
      /** Clear terminal buffer (used before PTY restart for a clean slate). */
      clear: () => { term.reset() },
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

      // Cmd+Backspace → delete to beginning of line
      // xterm.js swallows Cmd+key combos (metaKey=true) so they never reach
      // the PTY. Translate to \x15 (Ctrl+U / readline "kill line") manually.
      if (e.key === 'Backspace' && e.metaKey && !e.shiftKey && !e.altKey) {
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: '\x15' }))
        }
        e.preventDefault()
        return false
      }

      // Shift+Enter → ForceBar (CLIs that support force_send)
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
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

      // @prompt: token expansion on Enter is handled SERVER-SIDE in the
      // WebSocket input handler (_maybe_expand_input). No client
      // interception needed — Enter flows to the server, which checks
      // _input_bufs for tokens, backspaces the raw text, and types the
      // expanded version before sending Enter to the PTY.

      // Cmd+Left/Right → readline beginning/end of line.
      // xterm.js swallows metaKey combos, so translate manually.
      if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          // \x01 = Ctrl+A (beginning-of-line), \x05 = Ctrl+E (end-of-line)
          const seq = e.key === 'ArrowLeft' ? '\x01' : '\x05'
          ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: seq }))
        }
        e.preventDefault()
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
    // terminal (≥ 80×24). When the cell (wrapper) is smaller, it scrolls
    // the entire .xterm element. xterm's viewport fills .xterm at full
    // size (no internal overflow), so its scrollTop reset is harmless.
    const wrapper = el.parentElement

    // ── Sizing helpers ───────────────────────────────────────────────
    // Sync the .xterm element's dimensions so the wrapper can scroll it.
    // When autoFit is ON we skip this — the container stays at height:100%
    // so the terminal never overflows the cell (background fills any
    // fractional-row gap).
    const syncElementSize = (skipIfAutoFit) => {
      if (skipIfAutoFit && useStore.getState().terminalAutoFit) return
      const screen = el.querySelector('.xterm-screen')
      if (!screen || !wrapper) return
      el.style.minWidth = screen.offsetWidth + 'px'
      el.style.minHeight = screen.offsetHeight + 'px'
    }

    // fit() with a floor: never let the PTY shrink below MIN_COLS x MIN_ROWS.
    // We clear min-dims first so FitAddon measures the wrapper's real available
    // space (not the previous terminal size), then clamp up to the floor.
    //
    // When the user enables `terminalAutoFit`, we additionally scale the font
    // size DOWN so the 80×24 PTY floor fits exactly in the cell — no clipping,
    // no scrolling, just smaller text. We never scale up (cells bigger than
    // 80×24 at base font just get more cols/rows naturally).
    let fitRetries = 0
    const fitWithMinimum = () => {
      const autoFit = useStore.getState().terminalAutoFit

      // Clear stale min-dims so proposeDimensions reads the wrapper's actual size
      el.style.minHeight = ''
      el.style.minWidth = ''

      // Always start from the base font size before measuring
      if (term.options.fontSize !== BASE_FONT_SIZE) {
        try { term.options.fontSize = BASE_FONT_SIZE } catch {}
      }

      let dims = fit.proposeDimensions()
      if (!dims || !dims.cols || !dims.rows) {
        // Renderer hasn't computed cell metrics yet (element not painted).
        // Retry up to 5 times — covers view-switch remounts where some
        // terminals get painted later than others.
        if (fitRetries < 5) {
          fitRetries++
          setTimeout(fitWithMinimum, 100)
        }
        return
      }
      fitRetries = 0

      if (autoFit) {
        // Auto-fit: if cell is too small for 80×24 at base font, shrink the
        // font proportionally. We pick the more constraining axis so both
        // dimensions fit. When the cell is already big enough, no scaling
        // occurs — proposeDimensions naturally gives us ≥ 80×24.
        if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) {
          const scaleW = dims.cols / MIN_COLS
          const scaleH = dims.rows / MIN_ROWS
          const scale = Math.min(scaleW, scaleH)
          const newSize = Math.max(6, Math.floor(BASE_FONT_SIZE * scale * 10) / 10)
          if (newSize !== term.options.fontSize) {
            try { term.options.fontSize = newSize } catch {}
            const dims2 = fit.proposeDimensions()
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
        // Standard mode: maintain 80×24 floor, overflow + scroll if needed.
        const cols = Math.max(MIN_COLS, dims.cols)
        const rows = Math.max(MIN_ROWS, dims.rows)
        if (term.cols !== cols || term.rows !== rows) {
          try { term.resize(cols, rows) } catch {}
        }
      }

      // In auto-fit mode, skip syncElementSize so the container stays at
      // height:100% — no minHeight forces overflow. The terminal background
      // fills any fractional-row gap at the bottom.
      requestAnimationFrame(() => syncElementSize(true))
    }

    // Scroll the external wrapper so the cursor row is visible.
    const ensureCursorVisible = () => {
      if (!wrapper) return
      if (wrapper.scrollHeight <= wrapper.clientHeight + 2) return
      const screen = el.querySelector('.xterm-screen')
      if (!screen) return
      let cursorY
      try { cursorY = term.buffer.active.cursorY } catch { return }
      if (cursorY == null) return
      const rowH = screen.clientHeight / Math.max(1, term.rows)
      const cursorTop = cursorY * rowH
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
      // No overflow — let xterm handle (scrollback, etc.)
      if (wrapper.scrollHeight <= wrapper.clientHeight + 2 &&
          wrapper.scrollWidth <= wrapper.clientWidth + 2) return
      // At scroll boundaries, let xterm handle for scrollback navigation
      if (e.deltaY < 0 && wrapper.scrollTop <= 0) return
      if (e.deltaY > 0 && wrapper.scrollTop >= wrapper.scrollHeight - wrapper.clientHeight - 2) return
      e.preventDefault()
      e.stopPropagation()
      wrapper.scrollTop += e.deltaY
      if (e.deltaX) wrapper.scrollLeft += e.deltaX
    }
    el.addEventListener('wheel', wheelHandler, { passive: false, capture: true })

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
            const ws = useStore.getState().ws
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: data.path + ' ' }))
            }
          } catch (err) {
            console.error('Paste upload failed:', err)
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
    const isAtBottom = () => {
      try {
        const buf = term.buffer.active
        return buf.viewportY >= buf.baseY
      } catch { return true }
    }

    // Batch writes per animation frame — prevents split ANSI sequences
    // from causing rendering artifacts
    let pendingData = ''
    let writeRaf = null
    const batchWrite = (data) => {
      pendingData += data
      if (!writeRaf) {
        writeRaf = requestAnimationFrame(() => {
          if (pendingData) {
            const shouldScroll = isAtBottom()
            term.write(pendingData, () => {
              // Scroll after xterm finishes parsing so we land at the true
              // bottom — but only if the user wasn't reviewing scrollback.
              if (shouldScroll) term.scrollToBottom()
            })
            pendingData = ''
            ensureCursorVisible()
          }
          writeRaf = null
        })
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
    const inputDisp = term.onData((data) => {
      trackTerminalInput(sessionId, data)
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data }))
      }
    })

    // Core resize: fit terminal + notify backend + fix scroll.
    // Extracted so tab activation can call it immediately (no debounce).
    const doResize = () => {
      fitWithMinimum()
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({
          action: 'resize',
          session_id: sessionId,
          cols: term.cols,
          rows: term.rows,
        }))
      }
      ensureCursorVisible()
    }

    // Resize — debounced, skips rapid intermediate sizes
    let resizeTimer = null
    const sendResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doResize, 200)
    }

    // Expose immediate refit on terminalControls so the tab-activation
    // effect can bypass the 200ms debounce and resize instantly.
    const ctrl = terminalControls.get(sessionId)
    if (ctrl) ctrl.refit = doResize

    const observer = new ResizeObserver(sendResize)
    observer.observe(wrapper || el)

    // Refit immediately on grid layout / workspace changes (dispatched by App.jsx).
    // Bypasses the 200ms debounce in sendResize since the event is already
    // appropriately timed (double-rAF from the grid refit effect).
    const refitListener = () => doResize()
    window.addEventListener('cc-terminal-refit', refitListener)

    // Refit when the page regains visibility (e.g. switching back from another
    // app/window). In grid view all terminals are always mounted so the
    // isActive-based refit effect doesn't fire, and ResizeObserver won't
    // trigger because container dimensions haven't changed — but the browser
    // may have deferred layout while the tab was hidden, leaving terminals
    // squished. A short delay lets the browser finish any pending layout work.
    const visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        setTimeout(() => sendResize(), 150)
      }
    }
    document.addEventListener('visibilitychange', visibilityListener)

    // Same for window focus — covers alt-tabbing between windows on the same
    // display where visibilitychange may not fire.
    const windowFocusListener = () => setTimeout(() => sendResize(), 150)
    window.addEventListener('focus', windowFocusListener)

    // Chrome focus mode (⌘↑) escapes here when the user presses Escape on a
    // focused chrome button. Only the active session's terminal should grab
    // focus, otherwise every mounted (hidden) terminal would fight for it.
    const focusListener = () => {
      if (useStore.getState().activeSessionId === sessionId) {
        term.focus()
      }
    }
    window.addEventListener('cc-focus-terminal', focusListener)

    // Start PTY — wait for layout to fully settle before measuring
    if (!startedSessions.has(sessionId)) {
      let retryTimer = null

      const tryStart = () => {
        if (startedSessions.has(sessionId)) return
        fitWithMinimum()

        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
          startedSessions.add(sessionId)
          ws.send(JSON.stringify({
            action: 'start_pty',
            session_id: sessionId,
            cols: term.cols,
            rows: term.rows,
          }))
          term.focus()
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
        termRef.current = null
        terminalWriters.delete(sessionId)
        terminalControls.delete(sessionId)
        inputDisp.dispose()
        xtermTextarea.removeEventListener('focus', focusHandler)
        observer.disconnect()
        window.removeEventListener('cc-terminal-refit', refitListener)
        window.removeEventListener('cc-focus-terminal', focusListener)
        document.removeEventListener('visibilitychange', visibilityListener)
        window.removeEventListener('focus', windowFocusListener)
        el.removeEventListener('wheel', wheelHandler, { capture: true })
        el.removeEventListener('paste', pasteHandler, { capture: true })
        el.removeEventListener('contextmenu', contextMenuHandler, { capture: true })
        term.dispose()
      }
    }

    // ── Remount onto existing PTY ──────────────────────────────────────
    // Terminal was recreated (e.g. custom template switch) but the PTY is
    // still running. Refit and send resize to trigger SIGWINCH so the CLI
    // redraws its TUI at the correct dimensions.
    term.focus()

    const remountTimer = setTimeout(() => {
      fitWithMinimum()
      const ws = useStore.getState().ws
      if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({
          action: 'resize',
          session_id: sessionId,
          cols: term.cols,
          rows: term.rows,
        }))
      }
      term.scrollToBottom()
      ensureCursorVisible()
    }, 300)

    return () => {
      clearTimeout(remountTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (writeRaf) cancelAnimationFrame(writeRaf)
      termRef.current = null
      terminalWriters.delete(sessionId)
      terminalControls.delete(sessionId)
      inputDisp.dispose()
      observer.disconnect()
      window.removeEventListener('cc-terminal-refit', refitListener)
      window.removeEventListener('cc-focus-terminal', focusListener)
      document.removeEventListener('visibilitychange', visibilityListener)
      window.removeEventListener('focus', windowFocusListener)
      el.removeEventListener('wheel', wheelHandler, { capture: true })
      el.removeEventListener('contextmenu', contextMenuHandler, { capture: true })
      term.dispose()
    }
  }, [sessionId])

  // ── Tab activation: refit + scroll when this terminal becomes visible ──
  // Terminals are hidden via CSS opacity (not display:none), so
  // ResizeObserver doesn't fire on tab switch. Call refit directly
  // (bypasses the 200ms debounce in sendResize) after a double-rAF
  // to let the browser flush layout from the opacity change. Without
  // this the terminal can flash at 1-row height until new output arrives.
  useEffect(() => {
    if (!isActive || !termRef.current) return
    let cancelled = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const ctrl = terminalControls.get(sessionId)
        if (ctrl?.refit) {
          ctrl.refit()
        } else {
          window.dispatchEvent(new Event('cc-terminal-refit'))
        }
        try { termRef.current?.scrollToBottom() } catch {}
      })
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
    const ws = useStore.getState().ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: paths }))
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
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: text }))
        }
      }
    } catch {}
    closeCtxMenu()
  }

  const ctxAnnotate = () => {
    closeCtxMenu()
    window.dispatchEvent(new CustomEvent('open-panel', { detail: 'annotate' }))
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
    const hookState = useStore.getState().hookStates?.[sessionId]
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: '#0a0a0f' }}>
        <div className="text-center space-y-3 max-w-sm px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/25">
            <div className={`w-2 h-2 rounded-full ${
              sessionStatus === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'
            }`} />
            <span className="text-[11px] font-mono text-teal-300">
              Running in native terminal
            </span>
          </div>
          <div className="text-sm text-text-secondary font-medium">{sessionName}</div>
          <div className="text-[11px] text-text-faint leading-relaxed">
            This session is running in an external terminal window.
            Hook-based tracking is active — state, tools, and subagents
            are being monitored by Commander.
          </div>
          <div className="flex items-center justify-center gap-4 text-[10px] text-text-faint font-mono pt-1">
            <span>cli: {cliType}</span>
            <span>hooks: active</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col relative" style={{ minHeight: 0 }}>
      {/* Scroll wrapper — xterm's internal viewport resets scrollTop for
          alt-screen, so we scroll the entire .xterm element from OUTSIDE. */}
      <div className="flex-1" style={{ overflow: 'auto', minHeight: 0, background: '#0a0a0f' }}>
        <div
          ref={containerRef}
          style={{ padding: '2px 4px', background: '#0a0a0f', height: '100%' }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        />
      </div>

      {/* Floating @token badge — positioned over the terminal, outside
          the scroll wrapper so it stays fixed when the user scrolls. */}
      <TerminalTokenBadge sessionId={sessionId} />

      {/* Inline restart banner — shows when the underlying process has exited */}
      {isExited && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 bg-yellow-500/10 border-t border-yellow-500/25 text-[11px] shrink-0">
          <span className="text-yellow-200/90 font-mono">process exited</span>
          <button
            onClick={() => useStore.getState().restartSession(sessionId)}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-100 rounded-md font-medium transition-colors"
            title="Restart this session"
          >
            <RotateCcw size={11} />
            click here to restart →
          </button>
        </div>
      )}

      {/* Shift+Enter force-message bar (CLIs that support force_send) */}
      {showForceBar && getCliCapability(cliType, 'force_send') && (
        <ForceBar sessionId={sessionId} onClose={() => setShowForceBar(false)} />
      )}

      {/* Pasted image preview strip */}
      {pastedImages.length > 0 && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-[#0e0e16] border-t border-zinc-800 overflow-x-auto">
          <span className="text-[11px] text-zinc-600 font-mono shrink-0">pasted:</span>
          {pastedImages.map((img, i) => (
            <div key={i} className="relative group shrink-0">
              <img
                src={img.previewUrl || img.url}
                className="h-12 rounded border border-zinc-700 object-cover cursor-pointer hover:ring-2 hover:ring-indigo-500/60 transition-all"
                title="Click to preview & annotate"
                onClick={() => setAnnotatingImage({ url: img.previewUrl || img.url, index: i })}
              />
              <button
                onClick={(e) => { e.stopPropagation(); removePastedImage(i) }}
                className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-800 border border-zinc-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={8} className="text-zinc-400" />
              </button>
            </div>
          ))}
          <button
            onClick={() => setPastedImages([])}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 font-mono shrink-0"
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

      {/* Right-click context menu */}
      {ctxMenu && (
        <TerminalContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onCopy={ctxCopySelection}
          onPaste={ctxPaste}
          onAnnotate={ctxAnnotate}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  )
}

// ── Terminal right-click context menu ────────────────────────────────
function TerminalContextMenu({ x, y, onCopy, onPaste, onAnnotate, onClose }) {
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
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] bg-bg-elevated border border-border-primary rounded-lg shadow-xl py-1 text-xs"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item === null ? (
          <div key={i} className="border-t border-border-secondary my-1" />
        ) : (
          <button
            key={i}
            onClick={item.action}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          >
            <item.icon size={12} className="text-text-faint shrink-0" />
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-text-faint font-mono">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  )
}
