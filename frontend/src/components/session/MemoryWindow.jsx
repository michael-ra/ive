import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Brain, ListChecks, MessageSquare, FileText, BookOpen, FolderOpen,
  Plus, Pencil, Trash2, RefreshCw, User, MessageCircle, Folder, ExternalLink,
  Check, ChevronDown, Download, Minimize2 } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

// ── W2W Search type metadata ──────────────────────────────────────
const SEARCH_TYPE_META = {
  entries:   { icon: Brain,         label: 'Entries',   color: 'text-amber-400' },
  tasks:     { icon: ListChecks,    label: 'Tasks',     color: 'text-blue-400' },
  digests:   { icon: Brain,         label: 'Sessions',  color: 'text-violet-400' },
  knowledge: { icon: BookOpen,      label: 'Knowledge', color: 'text-emerald-400' },
  messages:  { icon: MessageSquare, label: 'Messages',  color: 'text-yellow-400' },
  files:     { icon: FolderOpen,    label: 'Files',     color: 'text-cyan-400' },
}

// ── Memory entry type metadata ────────────────────────────────────
const ENTRY_TYPE_META = {
  user:      { icon: User,          label: 'User',      color: 'text-blue-400',    bg: 'bg-blue-500/15' },
  feedback:  { icon: MessageCircle, label: 'Feedback',  color: 'text-amber-400',   bg: 'bg-amber-500/15' },
  project:   { icon: Folder,        label: 'Project',   color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  reference: { icon: ExternalLink,  label: 'Reference', color: 'text-violet-400',  bg: 'bg-violet-500/15' },
}

export default function MemoryWindow({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const ws = useStore((s) => s.ws)
  const [tab, setTab] = useState('entries') // 'entries' | 'search'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[800px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-primary">
          <Brain size={16} className="text-accent-primary" />
          <h2 className="text-sm font-semibold text-text-primary">Memory</h2>
          <div className="flex gap-0.5 ml-2">
            {[['entries', 'Entries'], ['search', 'Search']].map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                  tab === id ? 'bg-accent-primary/20 text-accent-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                }`}>{label}</button>
            ))}
          </div>
          <span className="flex-1" />
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        {tab === 'entries'
          ? <EntriesTab workspaceId={activeWorkspaceId} ws={ws} />
          : <SearchTab workspaceId={activeWorkspaceId} onClose={onClose} />
        }
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
//  ENTRIES TAB — memory entries CRUD + sync status
// ══════════════════════════════════════════════════════════════════

function EntriesTab({ workspaceId, ws }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [editing, setEditing] = useState(null) // entry id or 'new'
  const [filterType, setFilterType] = useState(null) // null = all
  const didAutoImport = useRef(false)

  const loadEntries = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [data, status] = await Promise.all([
        api.listMemoryEntries(workspaceId),
        api.getWorkspaceMemory(workspaceId).catch(() => null),
      ])
      setEntries(data || [])
      setSyncStatus(status)
    } catch { /* ignore */ }
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { loadEntries() }, [loadEntries])

  // Pull any new on-disk entries (e.g. saved by Claude during a session)
  // once per workspace open, so the user doesn't have to press Import.
  useEffect(() => {
    if (!workspaceId || didAutoImport.current) return
    didAutoImport.current = true
    let cancelled = false
    ;(async () => {
      try {
        const r = await api.importMemoryFromCli(workspaceId)
        if (!cancelled && r?.imported > 0) await loadEntries()
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [workspaceId, loadEntries])

  // Stay in sync when the backend auto-imports entries from a hook event.
  useEffect(() => {
    if (!ws?.addEventListener) return
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg?.type === 'memory_entries_changed' && msg.workspace_id === workspaceId) {
          loadEntries()
        }
      } catch { /* ignore */ }
    }
    ws.addEventListener('message', onMsg)
    return () => ws.removeEventListener('message', onMsg)
  }, [workspaceId, loadEntries, ws])

  const handleDelete = async (id) => {
    try {
      await api.deleteMemoryEntry(id)
      setEntries(prev => prev.filter(e => e.id !== id))
    } catch { /* ignore */ }
  }

  const handleSync = async () => {
    if (!workspaceId) return
    setSyncing(true)
    try {
      await api.syncWorkspaceMemory(workspaceId)
      await loadEntries()
    } catch { /* ignore */ }
    setSyncing(false)
  }

  const handleImport = async () => {
    if (!workspaceId) return
    setSyncing(true)
    try {
      const r = await api.importMemoryFromCli(workspaceId)
      if (r?.imported > 0) await loadEntries()
    } catch { /* ignore */ }
    setSyncing(false)
  }

  const [compacting, setCompacting] = useState(false)
  const [compactReport, setCompactReport] = useState(null)
  const handleCompact = async () => {
    if (!workspaceId || compacting) return
    const eligible = entries.filter(e => (e.content || '').length >= 120)
    if (!eligible.length) {
      setCompactReport({ updated: 0, skipped: entries.length, results: [], note: 'All entries already terse.' })
      return
    }
    if (!confirm(`Compact ${eligible.length} memory entr${eligible.length === 1 ? 'y' : 'ies'} into dense form? Original content will be replaced.`)) return
    setCompacting(true)
    setCompactReport(null)
    try {
      const r = await api.compactMemoryEntries({ workspace_id: workspaceId, style: 'dense' })
      setCompactReport(r)
      if (r?.updated > 0) await loadEntries()
    } catch (e) {
      setCompactReport({ updated: 0, skipped: 0, results: [], error: String(e?.message || e) })
    }
    setCompacting(false)
  }

  const handleSaved = async () => {
    setEditing(null)
    await loadEntries()
  }

  const filtered = filterType ? entries.filter(e => e.type === filterType) : entries
  const grouped = {}
  for (const e of filtered) {
    ;(grouped[e.type] = grouped[e.type] || []).push(e)
  }

  return (
    <>
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-border-primary flex items-center gap-2">
        {/* Type filter pills */}
        <button onClick={() => setFilterType(null)}
          className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
            !filterType ? 'border-border-primary text-text-primary bg-bg-tertiary' : 'border-transparent text-text-faint hover:text-text-muted'
          }`}>All ({entries.length})</button>
        {Object.entries(ENTRY_TYPE_META).map(([type, meta]) => {
          const count = entries.filter(e => e.type === type).length
          const Icon = meta.icon
          return (
            <button key={type} onClick={() => setFilterType(filterType === type ? null : type)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                filterType === type ? `border-border-primary ${meta.color} bg-bg-tertiary` : 'border-transparent text-text-faint hover:text-text-muted'
              }`}>
              <Icon size={10} />
              {meta.label}
              {count > 0 && <span className="opacity-60">({count})</span>}
            </button>
          )
        })}
        <span className="flex-1" />
        <button onClick={handleImport} disabled={syncing}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
          title="Import from CLI memory">
          <Download size={11} />Import
        </button>
        <button onClick={handleSync} disabled={syncing}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
          title="Sync memory across CLIs">
          <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />Sync
        </button>
        <button onClick={handleCompact} disabled={compacting || syncing}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors disabled:opacity-50"
          title="Rewrite memory entries in dense form (Haiku-powered)">
          <Minimize2 size={11} className={compacting ? 'animate-pulse' : ''} />
          {compacting ? 'Compacting…' : 'Compact'}
        </button>
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30 transition-colors">
          <Plus size={11} />New
        </button>
      </div>

      {/* Compact report */}
      {compactReport && (
        <div className="px-4 py-2 border-b border-border-primary bg-amber-500/5 flex items-center gap-3 text-[11px]">
          <Minimize2 size={11} className="text-amber-400 shrink-0" />
          <div className="flex-1 text-text-secondary">
            {compactReport.error
              ? <span className="text-red-400">Compact failed: {compactReport.error}</span>
              : <>
                <span className="text-amber-400 font-medium">{compactReport.updated}</span> compacted
                {compactReport.skipped > 0 && <>, <span className="text-text-faint">{compactReport.skipped}</span> skipped</>}
                {compactReport.results?.length > 0 && (() => {
                  const c = compactReport.results.filter(r => r.status === 'compacted')
                  if (!c.length) return null
                  const before = c.reduce((a, r) => a + (r.before_chars || 0), 0)
                  const after  = c.reduce((a, r) => a + (r.after_chars || 0), 0)
                  return before > 0 ? <span className="ml-1 text-text-faint">· {before}→{after} chars ({Math.round((1 - after/before) * 100)}% reduction)</span> : null
                })()}
                {compactReport.note && <span className="ml-1 text-text-faint">· {compactReport.note}</span>}
              </>}
          </div>
          <button onClick={() => setCompactReport(null)} className="text-text-faint hover:text-text-primary"><X size={11} /></button>
        </div>
      )}

      {/* Editor (inline) */}
      {editing && (
        <div className="px-4 py-3 border-b border-border-primary bg-bg-secondary/50">
          <EntryEditor
            entry={editing === 'new' ? null : entries.find(e => e.id === editing)}
            workspaceId={workspaceId}
            onSaved={handleSaved}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {/* Entries list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && <div className="text-center text-text-faint text-[11px] py-8 animate-pulse">Loading memory...</div>}

        {!loading && entries.length === 0 && (
          <div className="text-center text-text-faint text-[11px] py-8">
            No memory entries yet. Click <span className="text-accent-primary">+ New</span> to create one,
            or <span className="text-text-muted">Import</span> from CLI memory files.
          </div>
        )}

        {!loading && Object.entries(ENTRY_TYPE_META).map(([type, meta]) => {
          const group = grouped[type]
          if (!group?.length) return null
          const Icon = meta.icon
          return (
            <div key={type}>
              <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${meta.color}`}>
                <Icon size={11} />
                {meta.label}
                <span className="opacity-50">({group.length})</span>
              </div>
              <div className="space-y-1.5">
                {group.map(entry => (
                  <div key={entry.id} className="group p-2.5 bg-bg-secondary rounded border border-border-secondary hover:border-border-primary transition-colors">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-text-primary font-medium">{entry.name}</span>
                          {entry.source_cli && entry.source_cli !== 'commander' && (
                            <span className="text-[9px] px-1 rounded bg-bg-tertiary text-text-faint">{entry.source_cli}</span>
                          )}
                        </div>
                        {entry.description && (
                          <div className="text-[10px] text-text-muted mt-0.5">{entry.description}</div>
                        )}
                        <div className="text-[10px] text-text-secondary mt-1 whitespace-pre-wrap line-clamp-3">{entry.content}</div>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button onClick={() => setEditing(entry.id)}
                          className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary" title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => handleDelete(entry.id)}
                          className="p-1 rounded hover:bg-red-500/20 text-text-muted hover:text-red-400" title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Sync status bar */}
      {syncStatus && (
        <div className="px-4 py-2 border-t border-border-primary flex items-center gap-3 text-[10px] text-text-faint">
          <span className="font-medium text-text-muted">Sync</span>
          {syncStatus.providers && Object.entries(syncStatus.providers).map(([cli, info]) => (
            <span key={cli} className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${info.file_exists ? (info.synced ? 'bg-green-400' : 'bg-amber-400') : 'bg-zinc-600'}`} />
              {cli}
              {info.file_exists && <span className="opacity-60">({Math.round(info.content_length / 1024)}k)</span>}
            </span>
          ))}
          {syncStatus.last_synced_at && (
            <span className="ml-auto opacity-60">last: {new Date(syncStatus.last_synced_at).toLocaleString()}</span>
          )}
        </div>
      )}
    </>
  )
}

// ── Entry editor (create / edit) ──────────────────────────────────

function EntryEditor({ entry, workspaceId, onSaved, onCancel }) {
  const [name, setName] = useState(entry?.name || '')
  const [type, setType] = useState(entry?.type || 'project')
  const [description, setDescription] = useState(entry?.description || '')
  const [content, setContent] = useState(entry?.content || '')
  const [saving, setSaving] = useState(false)
  const nameRef = useRef(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return
    setSaving(true)
    try {
      if (entry) {
        await api.updateMemoryEntry(entry.id, { name, type, description, content })
      } else {
        await api.createMemoryEntry({ name, type, description, content, workspace_id: workspaceId })
      }
      onSaved()
    } catch { /* ignore */ }
    setSaving(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input ref={nameRef} value={name} onChange={e => setName(e.target.value)}
          placeholder="Memory name"
          className="flex-1 bg-bg-primary text-text-primary text-[11px] px-2.5 py-1.5 rounded border border-border-secondary focus:border-accent-primary outline-none font-mono" />
        <div className="relative">
          <select value={type} onChange={e => setType(e.target.value)}
            className="appearance-none bg-bg-primary text-text-primary text-[11px] pl-2.5 pr-6 py-1.5 rounded border border-border-secondary focus:border-accent-primary outline-none font-mono">
            {Object.entries(ENTRY_TYPE_META).map(([t, meta]) => (
              <option key={t} value={t}>{meta.label}</option>
            ))}
          </select>
          <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint pointer-events-none" />
        </div>
      </div>
      <input value={description} onChange={e => setDescription(e.target.value)}
        placeholder="Short description (used for relevance matching)"
        className="w-full bg-bg-primary text-text-primary text-[11px] px-2.5 py-1.5 rounded border border-border-secondary focus:border-accent-primary outline-none" />
      <textarea value={content} onChange={e => setContent(e.target.value)}
        placeholder="Memory content..."
        rows={4}
        className="w-full bg-bg-primary text-text-primary text-[11px] px-2.5 py-1.5 rounded border border-border-secondary focus:border-accent-primary outline-none resize-y font-mono" />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-[10px] text-text-muted hover:text-text-primary">Cancel</button>
        <button onClick={handleSave} disabled={saving || !name.trim() || !content.trim()}
          className="flex items-center gap-1 px-3 py-1 rounded text-[10px] bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30 disabled:opacity-40 transition-colors">
          <Check size={11} />{entry ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
//  SEARCH TAB — existing W2W unified memory search
// ══════════════════════════════════════════════════════════════════

function SearchTab({ workspaceId, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [activeTypes, setActiveTypes] = useState(new Set(['entries', 'tasks', 'digests', 'knowledge', 'messages', 'files']))
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback(async (q) => {
    if (!q.trim() || !workspaceId) return
    setLoading(true)
    try {
      const w2wTypes = [...activeTypes].filter(t => t !== 'entries').join(',')
      // Memory entries live in a separate table from the W2W indices, so
      // hit both endpoints in parallel and merge into one result shape.
      const [w2w, entries] = await Promise.all([
        w2wTypes
          ? api.searchMemory(workspaceId, q.trim(), w2wTypes).catch(() => ({}))
          : Promise.resolve({}),
        activeTypes.has('entries')
          ? api.searchMemoryEntries(q.trim(), workspaceId).catch(() => [])
          : Promise.resolve([]),
      ])
      setResults({ ...(w2w || {}), entries: Array.isArray(entries) ? entries : [] })
    } catch { setResults(null) }
    setLoading(false)
  }, [workspaceId, activeTypes])

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
    <>
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
          {results && <span className="text-[10px] text-text-muted">{totalResults} results</span>}
        </div>
        {/* Type toggles */}
        <div className="flex gap-1 mt-2">
          {Object.entries(SEARCH_TYPE_META).map(([key, meta]) => {
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
          <div className="text-center text-text-faint text-[11px] py-8">No results for &ldquo;{query}&rdquo;</div>
        )}

        {/* Memory entries */}
        {results?.entries?.length > 0 && (
          <SearchSection type="entries">
            {results.entries.map(e => {
              const meta = ENTRY_TYPE_META[e.type] || ENTRY_TYPE_META.project
              const Icon = meta.icon
              return (
                <div key={e.id} className="p-2 bg-bg-secondary rounded border border-border-secondary">
                  <div className="flex items-center gap-2">
                    <Icon size={11} className={meta.color} />
                    <span className="text-[11px] text-text-primary font-medium">{e.name}</span>
                    <span className={`text-[9px] px-1.5 rounded ${meta.bg} ${meta.color}`}>{meta.label}</span>
                    {e.source_cli && e.source_cli !== 'commander' && (
                      <span className="text-[9px] text-text-faint">{e.source_cli}</span>
                    )}
                  </div>
                  {e.description && <div className="text-[10px] text-text-muted mt-1">{e.description}</div>}
                  {e.content && (
                    <div className="text-[10px] text-text-secondary mt-1 whitespace-pre-wrap line-clamp-3">
                      {e.content}
                    </div>
                  )}
                </div>
              )
            })}
          </SearchSection>
        )}

        {/* Tasks */}
        {results?.tasks?.length > 0 && (
          <SearchSection type="tasks">
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
          </SearchSection>
        )}

        {/* Sessions/Digests */}
        {results?.digests?.length > 0 && (
          <SearchSection type="digests">
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
          </SearchSection>
        )}

        {/* Knowledge */}
        {results?.knowledge?.length > 0 && (
          <SearchSection type="knowledge">
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
          </SearchSection>
        )}

        {/* Messages */}
        {results?.messages?.length > 0 && (
          <SearchSection type="messages">
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
          </SearchSection>
        )}

        {/* Files */}
        {results?.files?.length > 0 && (
          <SearchSection type="files">
            {results.files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 p-1.5 bg-bg-secondary rounded border border-border-secondary text-[10px]">
                <FileText size={10} className="text-text-muted" />
                <span className="text-text-primary font-mono">{f.file_path}</span>
                <span className="text-text-faint">— {f.session_name}</span>
                <span className="text-text-faint">({f.task_summary || f.task_title || '?'})</span>
              </div>
            ))}
          </SearchSection>
        )}
      </div>
    </>
  )
}

// ── Shared sub-components ─────────────────────────────────────────

function SearchSection({ type, children }) {
  const meta = SEARCH_TYPE_META[type]
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
