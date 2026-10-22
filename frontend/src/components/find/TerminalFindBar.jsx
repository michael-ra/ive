import { useCallback, useEffect, useRef, useState } from 'react'
import useStore from '../../state/store'
import FindBar, { openAndFocus } from './FindBar'
import { findInTerminalLines, formatFindStatus, stepIndex, MAX_FIND_MATCHES } from '../../lib/findText'
import { registerFindTarget } from '../../lib/findRouter'

// ⌘F in a terminal: searches the xterm buffer (scrollback + screen). The
// search addon (@xterm/addon-search) is not installed, so this walks the
// buffer itself: wrapped rows are joined, every match gets a decoration
// (current one stronger), the current one is also selected (⌘C copies it)
// and scrolled into view. Decorations do not exist on the alternate screen
// (full-screen TUIs); there only the selection marks the match.
//
// Terminal.jsx mounts this inside the element that holds the xterm, so focus
// in the terminal routes ⌘F here.

function bufferLines(term) {
  const buffer = term?.buffer?.active
  if (!buffer) return []
  const lines = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) { lines.push({ text: '', isWrapped: false }); continue }
    const nextWrapped = !!buffer.getLine(y + 1)?.isWrapped
    // Keep trailing cells when the row continues on the next one.
    lines.push({ text: line.translateToString(!nextWrapped), isWrapped: !!line.isWrapped })
  }
  return lines
}

const MAX_DECORATIONS = 500
const MATCH_BG = '#F5D547'
const CURRENT_BG = '#F59E0B'
const CURRENT_FG = '#15171A'

function decorate(term, matches, index) {
  const out = []
  const buffer = term?.buffer?.active
  if (!buffer || buffer.type === 'alternate' || !term.registerDecoration) return out
  const cursorAbs = buffer.baseY + buffer.cursorY
  const list = matches.length > MAX_DECORATIONS
    ? [matches[index]].filter(Boolean)
    : matches
  for (const m of list) {
    const current = m === matches[index]
    try {
      const marker = term.registerMarker(m.row - cursorAbs)
      if (!marker) continue
      const deco = term.registerDecoration({
        marker,
        x: m.col,
        width: Math.min(m.length, term.cols - m.col),
        backgroundColor: current ? CURRENT_BG : MATCH_BG,
        foregroundColor: CURRENT_FG,
        layer: 'top',
      })
      out.push(deco ? { deco, marker } : { marker })
    } catch { /* row left the buffer */ }
  }
  return out
}

export default function TerminalFindBar({ sessionId, termRef, openRef = null }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])
  const [index, setIndex] = useState(-1)
  const anchorRef = useRef(null)
  const inputRef = useRef(null)
  const decorationsRef = useRef([])
  const clearDecorations = useCallback(() => {
    for (const d of decorationsRef.current) { try { d.deco?.dispose(); d.marker?.dispose() } catch { /* gone */ } }
    decorationsRef.current = []
  }, [])
  const stateRef = useRef({ open, matches, index })
  stateRef.current = { open, matches, index, query }

  const getRoot = useCallback(() => anchorRef.current?.parentElement || null, [])

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setMatches([])
    setIndex(-1)
    clearDecorations()
    try { termRef.current?.clearSelection() } catch { /* disposed */ }
    if (restoreFocus) requestAnimationFrame(() => termRef.current?.focus())
  }, [termRef, clearDecorations])

  const openBar = useCallback(() => {
    const picked = (() => { try { return termRef.current?.getSelection?.()?.trim() || '' } catch { return '' } })()
    openAndFocus(() => {
      setOpen(true)
      if (picked && picked.length <= 200 && !picked.includes('\n')) setQuery(picked)
    }, inputRef)
  }, [termRef])

  if (openRef) openRef.current = openBar

  useEffect(() => registerFindTarget({
    sessionId,
    kind: 'terminal',
    getRoot,
    open: openBar,
    close: () => close(false),
    isOpen: () => stateRef.current.open,
  }), [sessionId, getRoot, openBar, close])

  useEffect(() => { close(false); setQuery('') }, [sessionId, close])
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.activeSessionId !== prev.activeSessionId && s.activeSessionId !== sessionId && stateRef.current.open) close(false)
  }), [sessionId, close])

  const reveal = useCallback((m) => {
    const term = termRef.current
    if (!term || !m) return
    try {
      const top = term.buffer.active.viewportY
      if (m.row < top || m.row >= top + term.rows) term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)))
      term.select(m.col, m.row, m.length)
    } catch { /* terminal disposed meanwhile */ }
  }, [termRef])

  const recompute = useCallback((jump) => {
    const term = termRef.current
    const q = stateRef.current.query || ''
    if (!term || !q.trim()) {
      setMatches([])
      setIndex(-1)
      try { term?.clearSelection() } catch { /* disposed */ }
      return
    }
    const found = findInTerminalLines(bufferLines(term), q, MAX_FIND_MATCHES + 1)
    setMatches(found)
    if (!found.length) {
      setIndex(-1)
      try { term.clearSelection() } catch { /* disposed */ }
      return
    }
    if (jump) {
      // Newest output is at the bottom: start at the last match on screen
      // (or above it).
      const bottom = term.buffer.active.viewportY + term.rows
      let i = -1
      for (let k = found.length - 1; k >= 0; k--) if (found[k].row < bottom) { i = k; break }
      if (i < 0) i = 0
      setIndex(i)
      reveal(found[i])
    } else {
      const i = Math.min(Math.max(stateRef.current.index, 0), found.length - 1)
      setIndex(i)
      try { term.select(found[i].col, found[i].row, found[i].length) } catch { /* disposed */ }
    }
  }, [termRef, reveal])

  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => recompute(true), 90)
    return () => clearTimeout(t)
  }, [open, query, recompute])

  // New output while the bar is open: recount, keep the view.
  useEffect(() => {
    const term = termRef.current
    if (!open || !term?.onWriteParsed) return undefined
    let timer = null
    const sub = term.onWriteParsed(() => {
      clearTimeout(timer)
      timer = setTimeout(() => recompute(false), 300)
    })
    return () => { clearTimeout(timer); sub.dispose() }
  }, [open, recompute, termRef])

  // Mark every match, the current one stronger.
  useEffect(() => {
    clearDecorations()
    if (!open || !matches.length) return
    decorationsRef.current = decorate(termRef.current, matches.slice(0, MAX_FIND_MATCHES), index)
  }, [open, matches, index, termRef, clearDecorations])
  useEffect(() => clearDecorations, [clearDecorations])

  const step = useCallback((dir) => {
    const { matches: list, index: cur } = stateRef.current
    if (!list.length) return
    const next = stepIndex(cur, list.length, dir)
    setIndex(next)
    reveal(list[next])
  }, [reveal])

  const shown = matches.slice(0, MAX_FIND_MATCHES)
  return (
    <>
      <span ref={anchorRef} hidden data-find-anchor="terminal" />
      {open && (
        <FindBar
          kind="terminal"
          query={query}
          onQueryChange={setQuery}
          status={formatFindStatus(query, shown.length, index, matches.length > MAX_FIND_MATCHES)}
          hasMatches={shown.length > 0}
          onStep={step}
          onClose={close}
          inputRef={inputRef}
          scopeLabel="This terminal, scrollback included"
        />
      )}
    </>
  )
}
