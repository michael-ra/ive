import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import useStore from '../../state/store'
import FindBar, { openAndFocus } from './FindBar'
import { findOffsets, formatFindStatus, stepIndex, MAX_FIND_MATCHES } from '../../lib/findText'
import { registerFindTarget } from '../../lib/findRouter'
import { isMacPlatform } from '../../lib/keybindings'

// ⌘F inside a chat: searches the transcript as it is shown (the messages the
// chat has rendered, including tool summaries), highlights every match and
// steps through them. Matching runs on the DOM so what is counted is what the
// user can see; older messages that are not loaded yet are offered through
// "Load earlier".
//
// ChatPanel mounts this as a direct child of its root element and hands over
// the transcript scroll container and a way to focus the composer.

const IGNORE = '[data-find-ignore], script, style, textarea, input, select, [data-testid="chat-show-earlier"], [aria-hidden="true"]'
const BLOCK = 'p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, td, th, tr, div, summary, section, article, details, table'
const HL_ALL = 'ive-find'
const HL_CURRENT = 'ive-find-current'
let highlightOwner = null

const supportsHighlights = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined'

function clearHighlights(owner) {
  if (!supportsHighlights() || (owner && highlightOwner !== owner)) return
  CSS.highlights.delete(HL_ALL)
  CSS.highlights.delete(HL_CURRENT)
  highlightOwner = null
}

/** DOM ranges for every visible match of `query` under `root`. */
export function collectRanges(root, query) {
  if (!root || !query.trim()) return { ranges: [], capped: false }
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      const el = node.parentElement
      if (!el || el.closest(IGNORE)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  // Join text nodes so matches across inline formatting (code tokens, bold)
  // are found; a newline between blocks keeps paragraphs apart.
  let text = ''
  const segs = []
  let prevBlock = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement.closest(BLOCK)
    if (prevBlock && block !== prevBlock) text += '\n'
    segs.push({ node, start: text.length })
    text += node.nodeValue
    prevBlock = block
  }
  const locate = (offset, isEnd) => {
    let lo = 0, hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].start <= offset - (isEnd ? 1 : 0)) lo = mid
      else hi = mid - 1
    }
    const seg = segs[lo]
    if (!seg) return null
    const local = offset - seg.start
    if (local < 0 || local > seg.node.nodeValue.length) return null
    return { node: seg.node, offset: local }
  }
  const offsets = findOffsets(text, query, MAX_FIND_MATCHES + 1)
  const capped = offsets.length > MAX_FIND_MATCHES
  const ranges = []
  for (const off of offsets.slice(0, MAX_FIND_MATCHES)) {
    const a = locate(off, false)
    const b = locate(off + query.length, true)
    if (!a || !b) continue
    const range = doc.createRange()
    try {
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
    } catch { continue }
    // Text inside collapsed or hidden parts has no boxes: not counted.
    if (range.getClientRects().length === 0) continue
    ranges.push(range)
  }
  return { ranges, capped }
}

export default function ChatFindBar({ sessionId, scrollRef, focusComposer }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ ranges: [], capped: false })
  const [index, setIndex] = useState(-1)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [top, setTop] = useState(null)
  const anchorRef = useRef(null)
  const inputRef = useRef(null)
  const ownerRef = useRef({})
  const pendingScrollRef = useRef(false)
  const stateRef = useRef({ open, query, index, ranges: result.ranges })
  stateRef.current = { open, query, index, ranges: result.ranges }

  const focusComposerRef = useRef(focusComposer)
  focusComposerRef.current = focusComposer

  const getRoot = useCallback(() => anchorRef.current?.parentElement || null, [])

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setIndex(-1)
    setResult({ ranges: [], capped: false })
    clearHighlights(ownerRef.current)
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      focusComposerRef.current?.()
      // Composer disabled (agent working, read-only): keep the keyboard in
      // this chat on the transcript instead of losing it to <body>.
      const ae = document.activeElement
      const box = scrollRef.current
      if (box && (!ae || ae === document.body || !getRoot()?.contains(ae))) {
        if (!box.hasAttribute('tabindex')) box.tabIndex = -1
        box.focus({ preventScroll: true })
      }
    })
  }, [getRoot, scrollRef])

  const openBar = useCallback(() => {
    // Sit just inside the transcript, below the chat's status strip.
    const box = scrollRef.current
    // Prefill with the selected transcript text, like the browser's find.
    const sel = window.getSelection?.()
    const picked = sel && !sel.isCollapsed && scrollRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : ''
    openAndFocus(() => {
      setTop(box ? box.offsetTop + 8 : null)
      setOpen(true)
      if (picked && picked.length <= 200 && !picked.includes('\n')) setQuery(picked)
    }, inputRef)
  }, [scrollRef])

  useEffect(() => registerFindTarget({
    sessionId,
    kind: 'chat',
    getRoot,
    open: openBar,
    close: () => close(false),
    isOpen: () => stateRef.current.open,
  }), [sessionId, getRoot, openBar, close])

  // Another session, or this chat no longer the active one: start over.
  useEffect(() => { close(false); setQuery('') }, [sessionId, close])
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.activeSessionId !== prev.activeSessionId && s.activeSessionId !== sessionId && stateRef.current.open) close(false)
  }), [sessionId, close])
  useEffect(() => () => clearHighlights(ownerRef.current), [])

  const scrollToRange = useCallback((range) => {
    const box = scrollRef.current
    if (!range || !box) return
    const r = range.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.top < b.top + 56 || r.bottom > b.bottom - 16) {
      box.scrollTop += r.top - b.top - box.clientHeight / 3
    }
  }, [scrollRef])

  // Recompute matches. `jump` picks the first match from the viewport on.
  const recompute = useCallback((jump) => {
    const box = scrollRef.current
    const q = stateRef.current.query
    setHasEarlier(!!box?.querySelector('[data-testid="chat-show-earlier"]'))
    if (!box || !q.trim()) {
      setResult({ ranges: [], capped: false })
      setIndex(-1)
      clearHighlights(ownerRef.current)
      return
    }
    const next = collectRanges(box, q)
    setResult(next)
    if (!next.ranges.length) { setIndex(-1); return }
    if (jump) {
      pendingScrollRef.current = true
      const top = box.getBoundingClientRect().top
      const i = next.ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top)
      setIndex(i < 0 ? next.ranges.length - 1 : i)
    } else {
      setIndex((i) => Math.min(Math.max(i, 0), next.ranges.length - 1))
    }
  }, [scrollRef])

  // New query: search after a short pause and jump to the first match.
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => recompute(true), 90)
    return () => clearTimeout(t)
  }, [open, query, recompute])

  // Transcript changes (new messages, streaming, Load earlier): recount
  // without moving the view.
  useEffect(() => {
    const box = scrollRef.current
    if (!open || !box || typeof MutationObserver === 'undefined') return undefined
    let timer = null
    const mo = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => recompute(false), 250)
    })
    mo.observe(box, { subtree: true, childList: true, characterData: true })
    return () => { clearTimeout(timer); mo.disconnect() }
  }, [open, recompute, scrollRef])

  // Paint highlights and bring the current match into view.
  useLayoutEffect(() => {
    if (!open) return
    const { ranges } = result
    if (supportsHighlights()) {
      if (!ranges.length) clearHighlights(ownerRef.current)
      else {
        highlightOwner = ownerRef.current
        CSS.highlights.set(HL_ALL, new Highlight(...ranges))
        const cur = ranges[index]
        if (cur) CSS.highlights.set(HL_CURRENT, new Highlight(cur))
        else CSS.highlights.delete(HL_CURRENT)
      }
    }
  }, [open, result, index])

  const step = useCallback((dir) => {
    const n = stateRef.current.ranges.length
    if (!n) return
    const next = stepIndex(stateRef.current.index, n, dir)
    pendingScrollRef.current = true
    setIndex(next)
    scrollToRange(stateRef.current.ranges[next])
  }, [scrollToRange])

  // A new query or a step brings the current match into view; a recount
  // while messages stream in does not move the transcript.
  useEffect(() => {
    if (!open || !pendingScrollRef.current) return
    const r = result.ranges[index]
    if (!r) return
    pendingScrollRef.current = false
    scrollToRange(r)
  }, [open, result, index, scrollToRange])

  // ⌘G / ⇧⌘G while the focus is elsewhere in this chat (the transcript):
  // next / previous match instead of Guidelines.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || e.key.toLowerCase() !== 'g') return
      const root = getRoot()
      if (!root?.contains(document.activeElement) || inputRef.current === document.activeElement) return
      e.preventDefault()
      e.stopPropagation()
      step(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, getRoot, step])

  const loadEarlier = () => {
    scrollRef.current?.querySelector('[data-testid="chat-show-earlier"]')?.click()
  }

  return (
    <>
      <span ref={anchorRef} hidden data-find-anchor="chat" />
      {open && (
        <FindBar
          kind="chat"
          query={query}
          onQueryChange={setQuery}
          status={formatFindStatus(query, result.ranges.length, index, result.capped)}
          hasMatches={result.ranges.length > 0}
          onStep={step}
          onClose={close}
          inputRef={inputRef}
          scopeLabel={hasEarlier ? 'This chat, loaded messages' : 'This chat'}
          scopeAction={hasEarlier ? { label: 'Load earlier', onClick: loadEarlier } : null}
          top={top}
        />
      )}
    </>
  )
}
