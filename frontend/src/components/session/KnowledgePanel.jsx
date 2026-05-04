import { useState, useEffect, useRef, useMemo } from 'react'
import { BookOpen, Plus, Trash2, X, Pencil, Search, ChevronDown, ChevronRight, ThumbsUp, Tag, User, Globe } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const CATEGORIES = ['architecture', 'convention', 'gotcha', 'pattern', 'api', 'setup']

const CATEGORY_COLORS = {
  architecture: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  convention: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  gotcha: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  pattern: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  api: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  setup: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
}

const CATEGORY_ACCENT = {
  architecture: 'border-cyan-500/40',
  convention: 'border-violet-500/40',
  gotcha: 'border-amber-500/40',
  pattern: 'border-emerald-500/40',
  api: 'border-blue-500/40',
  setup: 'border-orange-500/40',
}

export default function KnowledgePanel({ onClose }) {
  const [entries, setEntries] = useState([])
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(null) // null = all
  const [collapsed, setCollapsed] = useState({}) // category → boolean
  const [mode, setMode] = useState('list') // 'list' | 'create' | 'edit'
  const [editingId, setEditingId] = useState(null)
  const [formContent, setFormContent] = useState('')
  const [formCategory, setFormCategory] = useState('convention')
  const [formScope, setFormScope] = useState('')
  const panelRef = useRef(null)
  const searchRef = useRef(null)

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const [viewWsId, setViewWsId] = useState(activeWorkspaceId || '__global__') // '__global__' = all workspaces
  const isGlobal = viewWsId === '__global__'
  const viewWsName = isGlobal ? 'All Workspaces' : (workspaces.find((w) => w.id === viewWsId)?.name || '')

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    loadEntries()
  }, [viewWsId])

  const loadEntries = async () => {
    try {
      let data
      if (isGlobal) {
        data = await api.getAllKnowledge()
      } else {
        data = await api.getWorkspaceKnowledge(viewWsId)
      }
      const arr = Array.isArray(data) ? data : []
      // code_catalog rows have their own dedicated panel — keep them out of the regular knowledge view
      setEntries(arr.filter((e) => e.category !== 'code_catalog'))
    } catch {
      setEntries([])
    }
  }

  // Filter entries by search text and category
  const filtered = useMemo(() => {
    let result = entries
    if (categoryFilter) {
      result = result.filter((e) => e.category === categoryFilter)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (e) =>
          e.content?.toLowerCase().includes(q) ||
          e.scope?.toLowerCase().includes(q) ||
          e.category?.toLowerCase().includes(q) ||
          e.contributor?.toLowerCase().includes(q)
      )
    }
    return result
  }, [entries, categoryFilter, search])

  // Group by category
  const grouped = useMemo(() => {
    const groups = {}
    for (const cat of CATEGORIES) {
      groups[cat] = []
    }
    for (const entry of filtered) {
      const cat = entry.category || 'convention'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(entry)
    }
    return groups
  }, [filtered])

  // Count per category (for tabs, before search filter)
  const categoryCounts = useMemo(() => {
    const counts = {}
    for (const cat of CATEGORIES) counts[cat] = 0
    for (const e of entries) {
      const cat = e.category || 'convention'
      if (counts[cat] !== undefined) counts[cat]++
    }
    return counts
  }, [entries])

  const toggleCollapse = (cat) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }))
  }

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!formContent.trim() || isGlobal || !viewWsId) return
    try {
      const created = await api.createKnowledgeEntry(viewWsId, {
        content: formContent.trim(),
        category: formCategory,
        scope: formScope.trim() || undefined,
      })
      setEntries((prev) => [...prev, created])
      resetForm()
    } catch (err) {
      console.error('create knowledge entry failed:', err)
    }
  }

  const handleEdit = (entry) => {
    setEditingId(entry.id)
    setFormContent(entry.content || '')
    setFormCategory(entry.category || 'convention')
    setFormScope(entry.scope || '')
    setMode('edit')
  }

  const handleUpdate = async (e) => {
    e?.preventDefault?.()
    if (!formContent.trim() || !editingId) return
    try {
      const updated = await api.updateKnowledgeEntry(editingId, {
        content: formContent.trim(),
        category: formCategory,
        scope: formScope.trim() || undefined,
      })
      setEntries((prev) => prev.map((x) => (x.id === editingId ? { ...x, ...updated } : x)))
      resetForm()
    } catch (err) {
      console.error('update knowledge entry failed:', err)
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.deleteKnowledgeEntry(id)
      setEntries((prev) => prev.filter((x) => x.id !== id))
    } catch (err) {
      console.error('delete knowledge entry failed:', err)
    }
  }

  const handleConfirm = async (id) => {
    try {
      const updated = await api.confirmKnowledgeEntry(id)
      setEntries((prev) =>
        prev.map((x) =>
          x.id === id
            ? { ...x, confirmed_count: updated?.confirmed_count ?? (x.confirmed_count || 0) + 1 }
            : x
        )
      )
    } catch (err) {
      console.error('confirm knowledge entry failed:', err)
    }
  }

  const resetForm = () => {
    setMode('list')
    setEditingId(null)
    setFormContent('')
    setFormCategory('convention')
    setFormScope('')
  }

  // Non-empty categories for the grouped view
  const activeCategories = CATEGORIES.filter((cat) => grouped[cat]?.length > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[700px] max-h-[80vh] flex flex-col outline-none scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-accent-primary" />
            <h2 className="text-sm font-semibold text-text-primary">Knowledge</h2>
            <select
              value={viewWsId}
              onChange={(e) => setViewWsId(e.target.value)}
              className="px-1.5 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary font-mono focus:outline-none ide-focus-ring"
            >
              <option value="__global__">All Workspaces</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
            <span className="text-[10px] text-text-faint font-mono">{entries.length} entries</span>
          </div>
          <div className="flex items-center gap-1">
            {!isGlobal && (
              <button
                onClick={() => (mode === 'list' ? setMode('create') : resetForm())}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
              >
                {mode === 'list' ? <><Plus size={11} /> new</> : 'back'}
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Create / Edit form */}
        {(mode === 'create' || mode === 'edit') && (
          <form onSubmit={mode === 'edit' ? handleUpdate : handleCreate} className="p-4 space-y-2.5 border-b border-border-primary">
            <div className="text-[10px] text-text-faint font-mono uppercase tracking-wider">
              {mode === 'edit' ? 'edit entry' : 'new knowledge entry'}
            </div>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder="knowledge content..."
              rows={4}
              className="w-full px-2.5 py-1.5 text-[11px] bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none leading-relaxed transition-colors"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                className="px-2 py-1.5 text-[11px] bg-bg-inset border border-border-primary rounded-md text-text-secondary font-mono focus:outline-none ide-focus-ring"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <input
                value={formScope}
                onChange={(e) => setFormScope(e.target.value)}
                placeholder="scope (optional, e.g. backend, auth)"
                className="flex-1 px-2.5 py-1.5 text-[11px] bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono transition-colors"
              />
            </div>
            <div className="flex gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors">
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button type="button" onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors">
                cancel
              </button>
            </div>
          </form>
        )}

        {/* Search bar */}
        {mode === 'list' && (
          <div className="px-4 py-2 border-b border-border-secondary">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search knowledge..."
                className="w-full pl-6 pr-2 py-1.5 text-[11px] bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
              />
            </div>
          </div>
        )}

        {/* Category filter tabs */}
        {mode === 'list' && (
          <div className="flex items-center gap-1 px-4 py-2 border-b border-border-secondary overflow-x-auto">
            <button
              onClick={() => setCategoryFilter(null)}
              className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors shrink-0 ${
                categoryFilter === null
                  ? 'bg-accent-primary/15 text-accent-primary border border-accent-primary/30'
                  : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-transparent'
              }`}
            >
              all ({entries.length})
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                className={`px-2 py-1 text-[10px] font-medium font-mono rounded-md transition-colors shrink-0 ${
                  categoryFilter === cat
                    ? `${CATEGORY_COLORS[cat]} border`
                    : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-transparent'
                }`}
              >
                {cat} ({categoryCounts[cat] || 0})
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        {mode === 'list' && (
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-10 text-xs text-text-faint text-center">
                {search.trim() || categoryFilter
                  ? 'No entries match the current filters'
                  : <>No knowledge entries yet — click <span className="text-text-secondary">+ new</span> to add one</>
                }
              </div>
            ) : categoryFilter ? (
              // Flat list when filtered to a single category
              <div>
                {filtered.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    showWorkspace={isGlobal}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onConfirm={handleConfirm}
                  />
                ))}
              </div>
            ) : (
              // Grouped by category with collapsible sections
              activeCategories.map((cat) => (
                <div key={cat}>
                  <button
                    onClick={() => toggleCollapse(cat)}
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left border-b border-border-secondary hover:bg-bg-hover/50 transition-colors ${
                      CATEGORY_ACCENT[cat] ? `border-l-2 ${CATEGORY_ACCENT[cat]}` : ''
                    }`}
                  >
                    {collapsed[cat]
                      ? <ChevronRight size={11} className="text-text-faint" />
                      : <ChevronDown size={11} className="text-text-faint" />
                    }
                    <span className={`text-[10px] font-medium font-mono uppercase tracking-wider ${CATEGORY_COLORS[cat]?.split(' ')[0] || 'text-text-faint'}`}>
                      {cat}
                    </span>
                    <span className="text-[10px] text-text-faint">({grouped[cat].length})</span>
                  </button>
                  {!collapsed[cat] && grouped[cat].map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      showWorkspace={isGlobal}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      onConfirm={handleConfirm}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function EntryRow({ entry, showWorkspace, onEdit, onDelete, onConfirm }) {
  const catColor = CATEGORY_COLORS[entry.category] || 'text-text-faint bg-bg-tertiary border-border-secondary'

  return (
    <div className="group flex items-start gap-2 px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-text-primary font-mono leading-relaxed whitespace-pre-wrap">
          {entry.content}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium font-mono rounded border ${catColor}`}>
            {entry.category}
          </span>
          {showWorkspace && entry.workspace_name && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] text-text-faint font-mono bg-bg-tertiary border border-border-secondary rounded">
              <Globe size={7} />
              {entry.workspace_name}
            </span>
          )}
          {entry.scope && (
            <span className="inline-flex items-center gap-0.5 text-[9px] text-text-faint font-mono">
              <Tag size={8} />
              {entry.scope}
            </span>
          )}
          {entry.contributor && (
            <span className="inline-flex items-center gap-0.5 text-[9px] text-text-faint font-mono">
              <User size={8} />
              {entry.contributor}
            </span>
          )}
        </div>
      </div>

      {/* Confirm button + count */}
      <div className="flex items-center gap-1 shrink-0 mt-0.5">
        <button
          onClick={() => onConfirm(entry.id)}
          title="Confirm this knowledge"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-text-faint hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
        >
          <ThumbsUp size={10} />
          <span>{entry.confirmed_count || 0}</span>
        </button>

        <button
          onClick={() => onEdit(entry)}
          className="opacity-0 group-hover:opacity-100 p-1 text-text-faint hover:text-accent-primary transition-all rounded"
          title="Edit entry"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={() => onDelete(entry.id)}
          className="opacity-0 group-hover:opacity-100 p-1 text-text-faint hover:text-red-400 transition-all rounded"
          title="Delete entry"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}
