import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Brain, ListChecks, MessageSquare, FileText, BookOpen, FolderOpen } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const TYPE_META = {
  tasks:     { icon: ListChecks,    label: 'Tasks',     color: 'text-blue-400' },
  digests:   { icon: Brain,         label: 'Sessions',  color: 'text-violet-400' },
  knowledge: { icon: BookOpen,      label: 'Knowledge', color: 'text-emerald-400' },
  messages:  { icon: MessageSquare, label: 'Messages',  color: 'text-yellow-400' },
  files:     { icon: FolderOpen,    label: 'Files',     color: 'text-cyan-400' },
}

export default function MemoryWindow({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [activeTypes, setActiveTypes] = useState(new Set(['tasks', 'digests', 'knowledge', 'messages', 'files']))
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback(async (q) => {
    if (!q.trim() || !activeWorkspaceId) return
    setLoading(true)
    try {
      const types = [...activeTypes].join(',')
      const r = await api.searchMemory(activeWorkspaceId, q.trim(), types)
      setResults(r)
    } catch { setResults(null) }
    setLoading(false)
  }, [activeWorkspaceId, activeTypes])

  const handleKey = (e) => {
    if (e.key === 'Enter') doSearch(query)
    if (e.key === 'Escape') onClose()
  }

  const toggleType = (t) => {
    setActiveTypes(prev => {
      const next = new Set(prev)
      next.has(t) ? next.delete(t) : next.add(t)
      return next
    })
  }

  const totalResults = results ? Object.values(results).reduce((sum, arr) => sum + (arr?.length || 0), 0) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[750px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-primary">
          <Brain size={16} className="text-accent-primary" />
          <h2 className="text-sm font-semibold text-text-primary">Memory Search</h2>
          <span className="flex-1" />
          {results && <span className="text-[10px] text-text-muted">{totalResults} results</span>}
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        {/* Search bar */}
        <div className="px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2 bg-bg-secondary rounded px-3 py-2 border border-border-secondary focus-within:border-accent-primary">
            <Search size={14} className="text-text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Search across all workspace memory..."
              className="flex-1 bg-transparent text-text-primary text-[12px] outline-none placeholder:text-text-faint font-mono"
            />
            {loading && <span className="text-[10px] text-text-muted animate-pulse">searching...</span>}
          </div>
          {/* Type toggles */}
          <div className="flex gap-1 mt-2">
            {Object.entries(TYPE_META).map(([key, meta]) => {
              const Icon = meta.icon
              const active = activeTypes.has(key)
              return (
                <button key={key} onClick={() => toggleType(key)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                    active ? `border-border-primary ${meta.color} bg-bg-tertiary` : 'border-transparent text-text-faint hover:text-text-muted'
                  }`}>
                  <Icon size={10} />
                  {meta.label}
                  {results?.[key]?.length > 0 && <span className="text-[9px] opacity-60">({results[key].length})</span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!results && !loading && (
            <div className="text-center text-text-faint text-[11px] py-8">
              Search tasks, sessions, knowledge, messages, and file activity.
              <br />Press Enter to search.
            </div>
          )}

          {results && totalResults === 0 && (
            <div className="text-center text-text-faint text-[11px] py-8">No results for "{query}"</div>
          )}

          {/* Tasks */}
          {results?.tasks?.length > 0 && (
            <Section type="tasks">
              {results.tasks.map(t => (
                <div key={t.id} className="p-2 bg-bg-secondary rounded border border-border-secondary">
                  <div className="flex items-center gap-2">
                    {t.score && <Score value={t.score} />}
                    <span className="text-[11px] text-text-primary font-medium">{t.title}</span>
                    <span className={`text-[9px] px-1.5 rounded ${t.status === 'done' ? 'bg-green-500/20 text-green-400' : 'bg-bg-tertiary text-text-muted'}`}>{t.status}</span>
                  </div>
                  {t.result_summary && <div className="text-[10px] text-text-secondary mt-1">{t.result_summary}</div>}
                  {t.lessons_learned && (
                    <div className="text-[10px] text-amber-400/80 mt-1 border-l-2 border-amber-500/30 pl-2">
                      {t.lessons_learned.length > 150 ? t.lessons_learned.slice(0, 150) + '...' : t.lessons_learned}
                    </div>
                  )}
                  {t.important_notes && (
                    <div className="text-[10px] text-cyan-400/80 mt-1 border-l-2 border-cyan-500/30 pl-2">
                      {t.important_notes.length > 150 ? t.important_notes.slice(0, 150) + '...' : t.important_notes}
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* Sessions/Digests */}
          {results?.digests?.length > 0 && (
            <Section type="digests">
              {results.digests.map(d => (
                <div key={d.id} className="p-2 bg-bg-secondary rounded border border-border-secondary">
                  <div className="flex items-center gap-2">
                    {d.score && <Score value={d.score} />}
                    <span className="text-[11px] text-text-primary font-medium">{d.name || d.id?.slice(0, 8)}</span>
                    <span className="text-[9px] text-text-faint">{d.cli_type}/{d.model}</span>
                    <span className={`text-[9px] px-1.5 rounded ${d.status === 'running' ? 'bg-green-500/20 text-green-400' : 'bg-bg-tertiary text-text-muted'}`}>{d.status}</span>
                  </div>
                  {d.task_summary && <div className="text-[10px] text-text-secondary mt-1">{d.task_summary}</div>}
                  {d.current_focus && <div className="text-[10px] text-text-muted mt-0.5">Focus: {d.current_focus}</div>}
                  {d.files_touched?.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {d.files_touched.slice(-5).map((f, i) => (
                        <span key={i} className="text-[9px] bg-bg-tertiary text-text-muted px-1 rounded">{f.split('/').pop()}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* Knowledge */}
          {results?.knowledge?.length > 0 && (
            <Section type="knowledge">
              {results.knowledge.map(k => (
                <div key={k.id} className="p-2 bg-bg-secondary rounded border border-border-secondary">
                  <div className="flex items-center gap-2">
                    {k.score && <Score value={k.score} />}
                    <span className={`text-[9px] px-1.5 rounded ${
                      k.category === 'gotcha' ? 'bg-amber-500/20 text-amber-400' :
                      k.category === 'architecture' ? 'bg-cyan-500/20 text-cyan-400' :
                      k.category === 'convention' ? 'bg-violet-500/20 text-violet-400' :
                      'bg-bg-tertiary text-text-muted'
                    }`}>{k.category}</span>
                    {k.scope && <span className="text-[9px] text-text-faint">[{k.scope}]</span>}
                    <span className="text-[9px] text-text-faint">confirmed: {k.confirmed_count}</span>
                  </div>
                  <div className="text-[10px] text-text-primary mt-1">{k.content}</div>
                </div>
              ))}
            </Section>
          )}

          {/* Messages */}
          {results?.messages?.length > 0 && (
            <Section type="messages">
              {results.messages.map(m => (
                <div key={m.id} className="p-2 bg-bg-secondary rounded border border-border-secondary">
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] px-1.5 rounded ${
                      m.priority === 'blocking' ? 'bg-red-500/20 text-red-400' :
                      m.priority === 'heads_up' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-bg-tertiary text-text-muted'
                    }`}>{m.priority}</span>
                    <span className="text-[9px] text-text-faint">topic: {m.topic}</span>
                    <span className="text-[9px] text-text-faint">from: {m.from_session_name || m.from_session_id?.slice(0, 8)}</span>
                  </div>
                  <div className="text-[10px] text-text-primary mt-1">{m.content}</div>
                </div>
              ))}
            </Section>
          )}

          {/* Files */}
          {results?.files?.length > 0 && (
            <Section type="files">
              {results.files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 p-1.5 bg-bg-secondary rounded border border-border-secondary text-[10px]">
                  <FileText size={10} className="text-text-muted" />
                  <span className="text-text-primary font-mono">{f.file_path}</span>
                  <span className="text-text-faint">— {f.session_name}</span>
                  <span className="text-text-faint">({f.task_summary || f.task_title || '?'})</span>
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ type, children }) {
  const meta = TYPE_META[type]
  const Icon = meta.icon
  return (
    <div>
      <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${meta.color}`}>
        <Icon size={11} />
        {meta.label}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Score({ value }) {
  const pct = Math.round(value * 100)
  return (
    <span className={`text-[9px] font-mono px-1 rounded ${
      pct >= 70 ? 'bg-green-500/20 text-green-400' :
      pct >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
      'bg-bg-tertiary text-text-faint'
    }`}>{pct}%</span>
  )
}
