import { useState, useRef, useEffect } from 'react'
import { Search, X, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[600px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-border-primary">
          <Search size={14} className="text-text-faint" />
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
            className="flex-1 py-3 text-sm bg-transparent text-text-primary placeholder-text-faint focus:outline-none font-mono"
          />
          {loading && <span className="text-[10px] text-text-faint font-mono">searching...</span>}
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={i}
              data-result-idx={i}
              onClick={() => handleClick(r)}
              className={`w-full text-left px-4 py-2.5 border-b border-border-secondary transition-colors ${
                selectedIdx === i ? 'bg-accent-subtle' : 'hover:bg-bg-hover'
              }`}
            >
              <div className="flex items-center gap-1.5 text-[10px] text-text-faint font-mono mb-1">
                <MessageSquare size={10} />
                <span className="text-text-secondary">{r.session_name || r.session_id?.slice(0, 8)}</span>
                <span>{r.role}</span>
                <span className="ml-auto">{r.created_at}</span>
              </div>
              <div className="text-xs text-text-primary font-mono line-clamp-2">
                {highlightMatch(r.content, query)}
              </div>
            </button>
          ))}
          {query && !loading && results.length === 0 && (
            <div className="px-4 py-10 text-xs text-text-faint text-center">
              No results for "{query}"
            </div>
          )}
          {!query && (
            <div className="px-4 py-10 text-xs text-text-faint text-center">
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
      <mark className="bg-accent text-bg-primary rounded px-0.5">{matchText}</mark>
      {after}
    </>
  )
}
