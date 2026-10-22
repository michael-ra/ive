import { useState, useRef, useEffect } from 'react'
import { Search, X, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { Button } from '../ui'

export default function SearchPanel({ onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const debounceRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Scroll selected result into view.
  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-result-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const handleSearch = (q) => {
    setQuery(q)
    setSelectedIdx(-1)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) {
      setResults([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await api.search(q.trim())
        setResults(res)
        setSelectedIdx(res.length > 0 ? 0 : -1)
      } catch (e) {
        console.error('Search failed:', e)
      }
      setLoading(false)
    }, 300)
  }

  const handleClick = (result) => {
    const store = useStore.getState()
    const sid = result.session_id
    if (store.sessions[sid]) {
      if (!store.openTabs.includes(sid)) {
        store.openSession(sid)
      } else {
        store.setActiveSession(sid)
      }
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[600px] x-panel shadow-x-3 overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-x-line">
          <Search size={14} className="text-x-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { onClose(); return }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIdx((i) => Math.min(results.length - 1, i + 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIdx((i) => Math.max(0, i - 1))
                return
              }
              if (e.key === 'Enter' && selectedIdx >= 0 && results[selectedIdx]) {
                e.preventDefault()
                handleClick(results[selectedIdx])
              }
            }}
            placeholder="search across all sessions..."
            className="flex-1 py-3 text-[13px] bg-transparent text-x-ink placeholder:text-x-muted focus:outline-none"
          />
          {loading && <span className="text-[11px] text-x-muted">searching...</span>}
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms] ease-x">
            <X size={15} />
          </Button>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={i}
              data-result-idx={i}
              onClick={() => handleClick(r)}
              className={`w-full text-left px-4 py-2.5 border-b border-x-line-subtle transition-colors duration-[80ms] ease-x ${
                selectedIdx === i ? 'bg-x-tint' : 'hover:bg-x-hover'
              }`}
            >
              <div className="flex items-center gap-1.5 text-[11px] text-x-muted mb-1">
                <MessageSquare size={10} />
                <span className="text-x-ink-secondary font-medium">{r.session_name || r.session_id?.slice(0, 8)}</span>
                <span>{r.role}</span>
                <span className="ml-auto tabular-nums">{r.created_at}</span>
              </div>
              <div className="text-xs text-x-ink font-mono line-clamp-2">
                {highlightMatch(r.content, query)}
              </div>
            </button>
          ))}
          {query && !loading && results.length === 0 && (
            <div className="px-4 py-10 text-xs text-x-muted text-center">
              No results for "{query}"
            </div>
          )}
          {!query && (
            <div className="px-4 py-10 text-xs text-x-muted text-center">
              Type to search across all session messages
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function highlightMatch(text, query) {
  if (!text || !query) return text
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  const lower = str.toLowerCase()
  const q = query.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx === -1) return str.substring(0, 200)

  const start = Math.max(0, idx - 60)
  const end = Math.min(str.length, idx + query.length + 60)
  const before = (start > 0 ? '...' : '') + str.substring(start, idx)
  const matchText = str.substring(idx, idx + query.length)
  const after = str.substring(idx + query.length, end) + (end < str.length ? '...' : '')
  return (
    <>
      {before}
      <mark className="bg-x-accent/30 text-x-ink rounded px-0.5">{matchText}</mark>
      {after}
    </>
  )
}
