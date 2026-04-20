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
      <div className="border-t border-border-primary bg-bg-primary px-3 py-1.5 flex items-center gap-2 cursor-pointer select-none" onClick={() => setCollapsed(false)}>
        <ChevronUp size={12} className="text-text-faint" />
        <span className="text-[11px] text-text-faint">Compose</span>
        <kbd className="text-[10px] text-text-faint bg-bg-tertiary px-1 rounded">⌘E</kbd>
        {value.trim() && <span className="text-[10px] text-amber-400 ml-1">draft</span>}
      </div>
    )
  }

  return (
    <div className="border-t border-border-primary bg-bg-primary flex flex-col" style={{ maxHeight: '50vh' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-secondary">
        <button onClick={() => setCollapsed(true)} className="p-0.5 text-text-faint hover:text-text-secondary">
          <ChevronDown size={12} />
        </button>
        <span className="text-[11px] text-text-secondary font-medium">Compose</span>
        <kbd className="text-[10px] text-text-faint bg-bg-tertiary px-1 rounded">⌘E</kbd>
        <div className="flex-1" />
        {marked.size > 0 && (
          <span className="text-[10px] text-cyan-400 font-mono">{marked.size} marked</span>
        )}
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-accent-primary hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          <Send size={10} /> submit
        </button>
        <kbd className="text-[10px] text-text-faint bg-bg-tertiary px-1 rounded">⌘↵</kbd>
        <button onClick={onClose} className="p-1 text-text-faint hover:text-text-secondary rounded hover:bg-bg-hover transition-colors">
          <X size={13} />
        </button>
      </div>

      {/* Editor: gutter + textarea */}
      <div className="flex flex-1 min-h-[120px] max-h-[40vh] overflow-hidden">
        {/* Gutter — line type indicators + checkboxes */}
        <div
          ref={gutterRef}
          className="w-10 overflow-hidden bg-bg-elevated border-r border-border-secondary select-none flex-shrink-0"
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
                  className={`w-5 h-5 flex items-center justify-center rounded text-[10px] transition-colors ${
                    marked.has(i)
                      ? 'text-cyan-400 bg-cyan-500/15'
                      : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover'
                  }`}
                  title={marked.has(i) ? 'Unmark' : 'Mark as key point'}
                >
                  {marked.has(i) ? '\u25C6' : '\u25C7'}
                </button>
              ) : p.isQuote ? (
                <span className="w-5 text-center text-[10px] text-indigo-400 font-mono">{'>'}</span>
              ) : p.isHeader ? (
                <span className="w-5 text-center text-[10px] text-amber-400 font-bold">#</span>
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
          className="flex-1 resize-none bg-bg-primary text-text-primary font-mono text-xs focus:outline-none p-2"
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
