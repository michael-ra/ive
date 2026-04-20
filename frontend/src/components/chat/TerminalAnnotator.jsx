import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, Send, MessageSquareQuote } from 'lucide-react'
import { terminalControls } from '../../lib/terminalWriters'

/**
 * TerminalAnnotator — select lines from Claude's terminal output and annotate them.
 *
 * Renders the xterm buffer with original colors and detects message boundaries
 * (⏺ = Claude, > = user) so you can see whose output is whose. Click to select
 * lines, Shift+click for range. Groups get inline comment inputs. Enter focuses
 * the comment input for the current selection. "Send to Composer" formats and
 * calls onSend(text).
 */

// ── Message detection (mirrors Terminal.jsx MSG_MARKERS) ─────────
const CLAUDE_MARKERS = new Set(['\u23FA']) // ⏺
const USER_MARKERS = new Set(['>'])
const BOX_LO = 0x2500
const BOX_HI = 0x257F

function classifyLine(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = ch.codePointAt(0)
    if (ch === ' ' || ch === '\t') continue
    if (code >= BOX_LO && code <= BOX_HI) return 'frame' // input box frame
    if (CLAUDE_MARKERS.has(ch)) return 'claude'
    if (USER_MARKERS.has(ch)) return 'user'
    return 'other'
  }
  return 'empty'
}

// Propagate message ownership to continuation lines
function assignMessageOwnership(lines) {
  let currentOwner = null // 'claude' | 'user' | null
  return lines.map((line) => {
    const cls = classifyLine(line.text)
    if (cls === 'claude') currentOwner = 'claude'
    else if (cls === 'user') currentOwner = 'user'
    else if (cls === 'empty') currentOwner = null
    return { ...line, owner: currentOwner, msgStart: cls === 'claude' || cls === 'user' ? cls : null }
  })
}

// Group consecutive selected indices: [[3,4,5], [8], [12,13]]
function groupConsecutive(indices) {
  if (!indices.length) return []
  const sorted = [...indices].sort((a, b) => a - b)
  const groups = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      groups[groups.length - 1].push(sorted[i])
    } else {
      groups.push([sorted[i]])
    }
  }
  return groups
}

export default function TerminalAnnotator({ sessionId, onSend, onClose }) {
  const [lines, setLines] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [comments, setComments] = useState({}) // groupKey -> comment text
  const [lastClicked, setLastClicked] = useState(null)
  const listRef = useRef(null)
  const commentRefs = useRef({}) // groupKey -> textarea ref
  const [scrolledToBottom, setScrolledToBottom] = useState(false)

  // Load buffer lines on mount
  useEffect(() => {
    const ctrl = terminalControls.get(sessionId)
    if (!ctrl?.getBufferLines) return
    const raw = ctrl.getBufferLines()
    // Merge wrapped lines (combine segments too)
    const merged = []
    for (const line of raw) {
      if (line.isWrapped && merged.length > 0) {
        merged[merged.length - 1].text += line.text
        merged[merged.length - 1].segments = [
          ...(merged[merged.length - 1].segments || []),
          ...(line.segments || []),
        ]
      } else {
        merged.push({ y: line.y, text: line.text, segments: line.segments || [] })
      }
    }
    // Assign message ownership
    setLines(assignMessageOwnership(merged))
  }, [sessionId])

  // Auto-scroll to bottom
  useEffect(() => {
    if (lines.length > 0 && !scrolledToBottom && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
      setScrolledToBottom(true)
    }
  }, [lines, scrolledToBottom])

  // Click handler — toggle selection, Shift for range (add or remove)
  const handleLineClick = useCallback((idx, e) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && lastClicked != null) {
        const lo = Math.min(lastClicked, idx)
        const hi = Math.max(lastClicked, idx)
        // If the entire range is already selected → deselect it
        let allSelected = true
        for (let i = lo; i <= hi; i++) {
          if (!prev.has(i)) { allSelected = false; break }
        }
        if (allSelected) {
          for (let i = lo; i <= hi; i++) next.delete(i)
        } else {
          for (let i = lo; i <= hi; i++) next.add(i)
        }
      } else {
        next.has(idx) ? next.delete(idx) : next.add(idx)
      }
      return next
    })
    setLastClicked(idx)
  }, [lastClicked])

  // Compute groups from selection
  const groups = useMemo(() => groupConsecutive([...selected]), [selected])

  // Auto-create comment entries for new groups so the input appears immediately
  useEffect(() => {
    if (!groups.length) return
    const lastGroup = groups[groups.length - 1]
    const lastKey = lastGroup[0]
    setComments((prev) => {
      let changed = false
      const next = { ...prev }
      for (const g of groups) {
        if (!(g[0] in next)) { next[g[0]] = ''; changed = true }
      }
      return changed ? next : prev
    })
    // Auto-focus the last group's comment input
    requestAnimationFrame(() => {
      commentRefs.current[lastKey]?.focus()
    })
  }, [groups])

  const setComment = useCallback((groupKey, text) => {
    setComments((prev) => ({ ...prev, [groupKey]: text }))
  }, [])

  // Format output and send
  const handleSend = useCallback(() => {
    if (!groups.length) return
    const parts = []
    for (const group of groups) {
      const groupKey = group[0]
      for (const idx of group) {
        const line = lines[idx]
        if (line) parts.push(`> ${line.text.trimEnd()}`)
      }
      const comment = (comments[groupKey] || '').trim()
      if (comment) {
        for (const cl of comment.split('\n')) {
          parts.push(`-> ${cl}`)
        }
      }
      parts.push('')
    }
    while (parts.length && parts[parts.length - 1] === '') parts.pop()
    onSend(parts.join('\n'))
  }, [groups, lines, comments, onSend])

  // Keyboard
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); return }
      // Enter (no modifier) → focus comment input for last group
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        // Only if we have groups and not already in a textarea
        if (groups.length > 0 && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault()
          const lastGroup = groups[groups.length - 1]
          const key = lastGroup[0]
          // Ensure comment entry exists
          if (!(key in comments)) setComment(key, '')
          requestAnimationFrame(() => {
            commentRefs.current[key]?.focus()
          })
        }
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [onClose, handleSend, groups, comments, setComment])

  const clearSelection = () => { setSelected(new Set()); setComments({}) }

  // Remove an entire group from selection
  const removeGroup = useCallback((groupIndices) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const i of groupIndices) next.delete(i)
      return next
    })
    // Clean up the comment for this group
    const key = groupIndices[0]
    setComments((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // Map: lastIdx of each group -> groupKey (for comment inputs)
  const groupEnds = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g[g.length - 1], g[0])
    return map
  }, [groups])

  // Map: firstIdx of each group -> group array (for "x" button)
  const groupStarts = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g[0], g)
    return map
  }, [groups])

  // Owner colors
  const ownerGutterColor = { claude: 'border-l-indigo-500', user: 'border-l-emerald-500' }
  const ownerBg = { claude: 'bg-indigo-500/5', user: 'bg-emerald-500/5' }
  const ownerLabel = { claude: '\u23FA', user: '>' }
  const ownerLabelColor = { claude: 'text-indigo-400', user: 'text-emerald-400' }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/60 backdrop-blur-sm">
      <div className="flex-1 flex flex-col max-w-5xl mx-auto my-4 bg-[#0a0a0f] border border-border-primary rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-secondary bg-bg-elevated shrink-0">
          <MessageSquareQuote size={14} className="text-indigo-400" />
          <span className="text-xs font-medium text-text-secondary">Annotate Output</span>
          <span className="text-[10px] text-text-faint font-mono">{lines.length} lines</span>
          <div className="flex-1" />
          {selected.size > 0 && (
            <span className="text-[10px] text-cyan-400 font-mono">
              {selected.size} selected &middot; {groups.length} group{groups.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={clearSelection}
            disabled={!selected.size}
            className="text-[10px] text-text-faint hover:text-text-secondary disabled:opacity-30 font-mono"
          >
            clear
          </button>
          <button
            onClick={handleSend}
            disabled={!groups.length}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-accent-primary hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            <Send size={10} /> Composer
          </button>
          <kbd className="text-[10px] text-text-faint bg-bg-tertiary px-1 rounded">{'\u2318\u21B5'}</kbd>
          <button onClick={onClose} className="p-1 text-text-faint hover:text-text-secondary rounded hover:bg-bg-hover transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Line list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto font-mono text-xs"
          style={{ background: '#0a0a0f' }}
        >
          {lines.map((line, idx) => {
            const isSel = selected.has(idx)
            const groupEndKey = groupEnds.get(idx)
            const commentForGroup = groupEndKey != null ? (comments[groupEndKey] ?? '') : null
            const groupAtStart = groupStarts.get(idx) // group array if this is the first line
            const owner = line.owner
            const isMsgStart = !!line.msgStart

            return (
              <div key={idx}>
                {/* Message start indicator */}
                {isMsgStart && (
                  <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">
                    <span className={`text-[9px] font-semibold uppercase tracking-wider ${ownerLabelColor[line.msgStart]}`}>
                      {line.msgStart === 'claude' ? 'Claude' : 'You'}
                    </span>
                    <div className={`flex-1 h-px ${line.msgStart === 'claude' ? 'bg-indigo-500/20' : 'bg-emerald-500/20'}`} />
                  </div>
                )}

                {/* The line row */}
                <div
                  className={`flex items-start cursor-pointer transition-colors border-l-2 ${
                    isSel
                      ? 'bg-cyan-500/10 border-l-cyan-400'
                      : owner
                        ? `${ownerBg[owner] || ''} ${ownerGutterColor[owner] || 'border-l-transparent'}`
                        : 'border-l-transparent hover:bg-white/[0.02]'
                  }`}
                  onClick={(e) => handleLineClick(idx, e)}
                >
                  {/* Gutter: owner icon + line number */}
                  <span className="w-14 shrink-0 flex items-center justify-end gap-1 pr-2 py-px select-none">
                    {isMsgStart && (
                      <span className={`text-[10px] ${ownerLabelColor[line.msgStart]}`}>
                        {ownerLabel[line.msgStart]}
                      </span>
                    )}
                    <span className="text-text-faint tabular-nums text-[10px] leading-[18px]">
                      {idx + 1}
                    </span>
                  </span>

                  {/* Selection indicator */}
                  <span className={`w-3 shrink-0 py-px text-center text-[10px] leading-[18px] ${
                    isSel ? 'text-cyan-400' : 'text-transparent'
                  }`}>
                    {isSel ? '\u25A0' : '\u00B7'}
                  </span>

                  {/* Line content with colors */}
                  <span className="flex-1 py-px whitespace-pre leading-[18px] overflow-hidden">
                    {line.segments && line.segments.length > 0
                      ? line.segments.map((seg, si) => (
                          <span
                            key={si}
                            style={seg.fg ? { color: seg.fg } : undefined}
                            className={seg.bold ? 'font-bold' : undefined}
                          >
                            {seg.text}
                          </span>
                        ))
                      : <span className="text-text-secondary">{line.text.trimEnd() || '\u00A0'}</span>
                    }
                  </span>

                  {/* "x" to remove entire group — shown on first line of each group */}
                  {groupAtStart ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeGroup(groupAtStart) }}
                      className="shrink-0 w-5 h-[18px] flex items-center justify-center text-cyan-400/60 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors mr-1"
                      title={`Deselect ${groupAtStart.length} line${groupAtStart.length !== 1 ? 's' : ''}`}
                    >
                      <X size={10} />
                    </button>
                  ) : isSel ? (
                    <span className="w-5 shrink-0 mr-1" />
                  ) : null}
                </div>

                {/* Comment input — after last line of each group */}
                {commentForGroup != null && (
                  <div className="flex items-start ml-14 mr-4 my-1 pl-3 pr-2 py-1.5 bg-amber-500/8 border border-amber-500/20 rounded-md">
                    <span className="text-amber-400 text-[11px] font-semibold shrink-0 pt-0.5 mr-2">{'\u2192'}</span>
                    <textarea
                      ref={(el) => { if (el) commentRefs.current[groupEndKey] = el }}
                      value={commentForGroup}
                      onChange={(e) => setComment(groupEndKey, e.target.value)}
                      placeholder="your comment..."
                      className="flex-1 bg-transparent text-amber-200/90 text-xs font-mono resize-none focus:outline-none placeholder:text-amber-200/30 min-h-[22px]"
                      rows={Math.max(1, commentForGroup.split('\n').length)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.stopPropagation()
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); handleSend() }
                        if (e.key === 'Escape') { e.stopPropagation(); e.target.blur() }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <div className="h-8" />
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-1.5 border-t border-border-secondary bg-bg-elevated/50 text-[10px] text-text-faint flex items-center gap-4">
          <span>Click to select</span>
          <span>Shift+click range</span>
          <span>Enter to comment</span>
          <span>{'\u2318\u21B5'} send to Composer</span>
          <span>Esc close</span>
          <div className="flex-1" />
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-indigo-500/60" /> Claude
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500/60" /> You
          </span>
        </div>
      </div>
    </div>
  )
}
