import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, ChevronUp, ChevronDown } from 'lucide-react'
import { sendTerminalCommand } from '../../lib/terminal'

/**
 * Composer — structured input panel for composing multi-point messages.
 *
 * Lines starting with `->`, `-`, `*`, or `>` are treated as bullet/quote points
 * and get a toggleable checkbox in the gutter. Marked bullets are **bold**
 * in the formatted output.
 *
 * Keyboard:
 *   ⌘E      Toggle open/close (handled by parent)
 *   ⌘Enter  Submit
 *   Escape  Close without sending
 *   Tab     Indent current line
 *   Shift+Tab  Outdent current line
 */

const LINE_HEIGHT = 20 // px — must match the textarea's line-height
const BULLET_RE = /^(\s*)(->|→|-|\*|•)\s/
const QUOTE_RE = /^>\s/
const HEADER_RE = /^#{1,3}\s/

function parseLine(raw) {
  const isBullet = BULLET_RE.test(raw)
  const isQuote = !isBullet && QUOTE_RE.test(raw.trimStart())
  const isHeader = HEADER_RE.test(raw.trimStart())
  const indent = raw.match(/^(\s*)/)[1].length
  let text = raw
  if (isBullet) text = raw.replace(BULLET_RE, '$1')
  return { raw, text, isBullet, isQuote, isHeader, indent }
}

export default function Composer({ sessionId, initialValue, onClose }) {
  const [value, setValue] = useState(initialValue || '')
  const [marked, setMarked] = useState(new Set())
  const [collapsed, setCollapsed] = useState(false)
  const textareaRef = useRef(null)
  const gutterRef = useRef(null)

  // If initialValue changes (e.g. from annotator), update the text
  useEffect(() => {
    if (initialValue) {
      setValue(initialValue)
      setMarked(new Set())
    }
  }, [initialValue])

  // Focus textarea on mount / un-collapse
  useEffect(() => {
    if (!collapsed) textareaRef.current?.focus()
  }, [collapsed])

  // Sync gutter scroll with textarea
  const handleScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const lines = value.split('\n')
  const parsed = lines.map(parseLine)

  const toggleMark = (idx) => {
    setMarked((prev) => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  // ── Keyboard handling inside the textarea ──────────────────────
  const handleKeyDown = (e) => {
    // ⌘Enter → submit
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
      return
    }

    // Escape → close
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }

    // Tab / Shift+Tab → indent / outdent current line
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = value.slice(0, start)
      const after = value.slice(end)
      const lineStart = before.lastIndexOf('\n') + 1
      const lineEnd = value.indexOf('\n', start)
      const curLine = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)

      let newLine
      if (e.shiftKey) {
        newLine = curLine.replace(/^ {1,2}/, '')
      } else {
        newLine = '  ' + curLine
      }
      const diff = newLine.length - curLine.length
      const newVal =
        value.slice(0, lineStart) + newLine + (lineEnd === -1 ? '' : value.slice(lineEnd))
      setValue(newVal)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start + diff)
      })
      return
    }

    // Enter on a bullet line → auto-insert `-> ` on the next line
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const ta = textareaRef.current
      const pos = ta.selectionStart
      const before = value.slice(0, pos)
      const lineStart = before.lastIndexOf('\n') + 1
      const curLine = before.slice(lineStart)
      const m = curLine.match(/^(\s*)(->|→|-|\*|•)\s/)
      if (m) {
        e.preventDefault()
        const prefix = m[1] + m[2] + ' '
        const insert = '\n' + prefix
        const newVal = value.slice(0, pos) + insert + value.slice(ta.selectionEnd)
        setValue(newVal)
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos + insert.length
        })
      }
    }
  }

  // ── Submit: format + send to terminal ──────────────────────────
  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || !sessionId) return

    const formatted = formatOutput(parsed, marked)
    sendTerminalCommand(sessionId, formatted)

    setValue('')
    setMarked(new Set())
    onClose()
  }

  if (collapsed) {
    return (
      <div className="border-t border-x-line bg-x-bg px-3 py-1.5 md:py-1.5 flex items-center gap-2 cursor-pointer select-none touch-manipulation" style={{ minHeight: 44 }} onClick={() => setCollapsed(false)}>
        <ChevronUp size={12} className="text-x-muted" />
        <span className="text-[11px] text-x-muted">Compose</span>
        <kbd className="hidden md:inline text-[11px] font-mono text-x-muted bg-x-surface-2 border border-x-line px-1 rounded">⌘E</kbd>
        {value.trim() && <span className="text-[11px] text-x-accent-ink ml-1">draft</span>}
      </div>
    )
  }

  return (
    <div className="border-t border-x-line bg-x-bg flex flex-col" style={{ maxHeight: '50vh' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-x-line-subtle">
        <button onClick={() => setCollapsed(true)} className="p-0.5 text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
          <ChevronDown size={12} />
        </button>
        <span className="text-[11px] text-x-ink-secondary font-medium">Compose</span>
        <kbd className="text-[11px] font-mono text-x-muted bg-x-surface-2 border border-x-line px-1 rounded">⌘E</kbd>
        <div className="flex-1" />
        {marked.size > 0 && (
          <span className="text-[11px] text-x-accent tabular-nums">{marked.size} marked</span>
        )}
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="flex items-center gap-1 px-3 py-2 md:px-2 md:py-1 text-[12px] md:text-[11px] font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 disabled:cursor-not-allowed text-x-on-accent rounded-md transition-colors duration-[80ms] active:scale-[.98] touch-manipulation"
        >
          <Send size={12} /> submit
        </button>
        <kbd className="hidden md:inline text-[11px] font-mono text-x-muted bg-x-surface-2 border border-x-line px-1 rounded">⌘↵</kbd>
        <button onClick={onClose} className="p-1 text-x-muted hover:text-x-ink rounded hover:bg-x-hover transition-colors duration-[80ms]">
          <X size={13} />
        </button>
      </div>

      {/* Editor: gutter + textarea */}
      <div className="flex flex-1 min-h-[120px] max-h-[40vh] overflow-hidden">
        {/* Gutter — line type indicators + checkboxes */}
        <div
          ref={gutterRef}
          className="w-10 overflow-hidden bg-x-surface-2 border-r border-x-line-subtle select-none flex-shrink-0"
          style={{ paddingTop: 8 }}
        >
          {parsed.map((p, i) => (
            <div
              key={i}
              className="flex items-center justify-center"
              style={{ height: LINE_HEIGHT }}
            >
              {p.isBullet ? (
                <button
                  onClick={() => toggleMark(i)}
                  className={`w-5 h-5 flex items-center justify-center rounded text-[11px] transition-colors duration-[80ms] ${
                    marked.has(i)
                      ? 'text-x-accent bg-x-tint'
                      : 'text-x-muted hover:text-x-ink hover:bg-x-hover'
                  }`}
                  title={marked.has(i) ? 'Unmark' : 'Mark as key point'}
                >
                  {marked.has(i) ? '\u25C6' : '\u25C7'}
                </button>
              ) : p.isQuote ? (
                <span className="w-5 text-center text-[11px] text-x-accent font-mono">{'>'}</span>
              ) : p.isHeader ? (
                <span className="w-5 text-center text-[11px] text-x-accent-ink font-medium">#</span>
              ) : (
                <span className="w-5" />
              )}
            </div>
          ))}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none bg-x-bg text-x-ink placeholder:text-x-muted font-mono text-xs focus:outline-none p-2"
          style={{ lineHeight: `${LINE_HEIGHT}px`, whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto' }}
          placeholder={"-> type your points here...\n-> mark key items with the \u25C7 in the gutter\n-> \u2318Enter to send"}
          spellCheck={false}
        />
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Format output for terminal
// ═══════════════════════════════════════════════════════════════

function formatOutput(parsed, marked) {
  const out = []
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]

    if (p.raw.trim() === '') {
      out.push('')
      continue
    }

    if (p.isHeader) {
      out.push(p.raw.trim())
      continue
    }

    if (p.isQuote) {
      // Pass quoted lines through as-is
      out.push(p.raw)
      continue
    }

    if (p.isBullet) {
      const indent = ' '.repeat(p.indent)
      const text = marked.has(i) ? `**${p.text.trim()}**` : p.text.trim()
      out.push(`${indent}\u2192 ${text}`)
      continue
    }

    // Plain text
    out.push(p.raw)
  }

  return out.join('\n')
}
