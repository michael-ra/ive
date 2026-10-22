import { Fragment, useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Brain, FileText, BookOpen, Plus, Pencil, Trash2, RefreshCw,
  Check, ChevronDown, Download, AlertTriangle, GitBranch, Database } from 'lucide-react'
import { api } from '../../lib/api'
import { isExtensionAvailable, resolveExtensionPanel } from '../../lib/extensionRegistry'
import { ENTRY_TYPE_META } from '../../lib/memoryEntryTypes'
import useStore from '../../state/store'
import { Button } from '../ui'

// ── W2W Search type metadata ──────────────────────────────────────
// ── Memory entry type metadata ────────────────────────────────────
const KnowledgeInlineTab = resolveExtensionPanel('myelin', 'KnowledgeInlineTab')
const IntelligencePromptTab = resolveExtensionPanel('myelin', 'PromptTab')
const IntelligenceSearchTab = resolveExtensionPanel('myelin', 'SearchTab')
const MemoryEntryActions = resolveExtensionPanel('myelin', 'MemoryCompaction')

export default function MemoryWindow({ onClose, initialTab = 'entries' }) {
  const myelinAvailable = isExtensionAvailable('myelin')
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const ws = useStore((s) => s.ws)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const [tab, setTab] = useState(initialTab) // 'entries' | 'knowledge' | 'search' | 'sync'

  useEffect(() => {
    setTab(initialTab || 'entries')
  }, [initialTab])

  const tabs = [
    { id: 'entries', label: 'Memories', icon: Brain },
    { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
    { id: 'prompt', label: 'Prompt', icon: FileText },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'sync', label: 'Sync', icon: GitBranch },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-3" onClick={onClose}>
      <div className="w-[min(980px,calc(100vw-1.5rem))] max-h-[88vh] flex flex-col overflow-hidden x-panel scale-in" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-x-line px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-x-tint-line bg-x-tint">
            <Database size={15} className="text-x-accent" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-x-ink">Context</h2>
            <div className="truncate text-[11px] text-x-muted">{workspace?.name || 'No workspace selected'}</div>
          </div>
          <div className="ml-2 flex max-w-[58vw] gap-1 overflow-x-auto rounded-lg border border-x-line bg-x-surface-2 p-1 tab-scroll-hide">
            {tabs.map(({ id, label, icon: Icon }) => (
              <Button type="submit"
                key={id}
                onClick={() => setTab(id)}
                className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  tab === id
                    ? 'border border-x-tint-line bg-x-tint text-x-accent'
                    : 'border border-transparent text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                }`}
              >
                <Icon size={11} />
                {label}
              </Button>
            ))}
          </div>
          <span className="flex-1" />
          <Button type="submit" onClick={onClose} className=" p-1.5 text-x-muted transition-colors hover:bg-x-hover hover:text-x-ink-secondary"><X size={16} /></Button>
        </div>

        {!workspace ? (
          <div role="status" className="p-4 text-[12px] text-x-muted">Select or add a workspace in the sidebar to view and save its memories. No global memory is created here.</div>
        ) : (
          // A scope change discards editors, previews, and pending results from
          // the previous workspace, including optional extension panels.
          <Fragment key={workspace.id}>
            {tab === 'entries' && <EntriesTab workspaceId={workspace.id} ws={ws} />}
            {tab === 'knowledge' && (myelinAvailable
              ? <KnowledgeInlineTab workspaceId={workspace.id} />
              : <div role="status" className="p-4 text-[12px] text-x-muted">Workspace knowledge requires the Myelin extension. Ordinary memories and file sync remain available in their tabs.</div>)}
            {tab === 'prompt' && (myelinAvailable ? <IntelligencePromptTab workspaceId={workspace.id} /> : <PromptTab workspaceId={workspace.id} />)}
            {tab === 'search' && (myelinAvailable ? <IntelligenceSearchTab workspaceId={workspace.id} onClose={onClose} /> : <SearchTab workspaceId={workspace.id} onClose={onClose} />)}
            {tab === 'sync' && <MemorySyncTab workspaceId={workspace.id} />}
          </Fragment>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
//  ENTRIES TAB — memory entries CRUD + sync status
// ══════════════════════════════════════════════════════════════════

function EntriesTab({ workspaceId, ws }) {
  const myelinAvailable = isExtensionAvailable('myelin')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // entry id or 'new'
  const [filterType, setFilterType] = useState(null) // null = all
  const [entrySearch, setEntrySearch] = useState('')
  const loadVersion = useRef(0)

  const loadEntries = useCallback(async () => {
    const version = ++loadVersion.current
    if (!workspaceId) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await api.listMemoryEntries(workspaceId)
      if (version !== loadVersion.current) return
      setEntries(data || [])
    } catch { /* ignore */ }
    if (version === loadVersion.current) setLoading(false)
  }, [workspaceId])

  useEffect(() => {
    loadEntries()
    return () => { loadVersion.current += 1 }
  }, [loadEntries])

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

  const [actionStatus, setActionStatus] = useState(null)

  const handleSaved = async () => {
    setEditing(null)
    await loadEntries()
  }

  const filtered = entries.filter((entry) => {
    if (filterType && entry.type !== filterType) return false
    const q = entrySearch.trim().toLowerCase()
    if (!q) return true
    return `${entry.name || ''} ${entry.description || ''} ${entry.content || ''} ${entry.source_cli || ''}`.toLowerCase().includes(q)
  })
  const grouped = {}
  for (const e of filtered) {
    ;(grouped[e.type] = grouped[e.type] || []).push(e)
  }

  return (
    <>
      {/* Toolbar */}
      <div className="border-b border-x-line px-4 py-2.5">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-x-faint" />
            <input
              value={entrySearch}
              onChange={(e) => setEntrySearch(e.target.value)}
              placeholder="Filter memories..."
              className="w-full rounded-md border border-x-line bg-x-surface-2 py-1.5 pl-7 pr-2 text-[12px] text-x-ink outline-none placeholder:text-x-muted focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            />
          </div>
          <MemoryEntryActions workspaceId={workspaceId} entries={entries} onUpdated={loadEntries} onReport={setActionStatus} />
          <Button type="submit" onClick={() => { if (workspaceId) setEditing('new') }} disabled={!workspaceId}
            className="inline-flex items-center gap-1.5 bg-x-accent px-2.5 py-1.5 text-[11px] font-medium text-x-on-accent transition-colors hover:bg-x-accent-ink active:scale-[.98]">
            <Plus size={11} />New
          </Button>
        </div>
        {!myelinAvailable && <p role="status" className="mb-2 text-[11px] text-x-muted">Compaction requires Myelin. Adding, editing, searching, and syncing ordinary memories remain available.</p>}
        {/* Type filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" onClick={() => setFilterType(null)}
            className={` border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              !filterType ? 'border-x-tint-line bg-x-tint text-x-accent' : 'border-transparent text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
            }`}>All ({entries.length})</Button>
          {Object.entries(ENTRY_TYPE_META).map(([type, meta]) => {
            const count = entries.filter(e => e.type === type).length
            const Icon = meta.icon
            return (
              <Button type="submit" key={type} onClick={() => setFilterType(filterType === type ? null : type)}
                className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  filterType === type ? `border-x-tint-line ${meta.color} bg-x-tint` : 'border-transparent text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                }`}>
                <Icon size={10} />
                {meta.label}
                {count > 0 && <span className="opacity-60">({count})</span>}
              </Button>
            )
          })}
        </div>
      </div>

      {actionStatus}

      {/* Editor (inline) */}
      {editing && (
        <div className="px-4 py-3 border-b border-x-line bg-x-surface">
          <EntryEditor
            key={editing}
            entry={editing === 'new' ? null : entries.find(e => e.id === editing)}
            workspaceId={workspaceId}
            onSaved={handleSaved}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {/* Entries list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && <div className="text-center text-x-faint text-[11px] py-8 animate-pulse">Loading memory...</div>}

        {!loading && entries.length === 0 && (
          <div className="text-center text-x-faint text-[11px] py-8">
            No memory entries yet. Click <span className="text-x-accent">+ New</span> to create one,
            or <span className="text-x-muted">Import</span> from CLI memory files.
          </div>
        )}

        {!loading && entries.length > 0 && filtered.length === 0 && (
          <div className="py-8 text-center font-mono text-[11px] text-x-faint">
            No memories match the current filter.
          </div>
        )}

        {!loading && Object.entries(ENTRY_TYPE_META).map(([type, meta]) => {
          const group = grouped[type]
          if (!group?.length) return null
          const Icon = meta.icon
          return (
            <div key={type}>
              <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-1.5 ${meta.color}`}>
                <Icon size={11} />
                {meta.label}
                <span className="opacity-50">({group.length})</span>
              </div>
              <div className="space-y-1.5">
                {group.map(entry => (
                  <div key={entry.id} className="group rounded-md border border-x-line bg-x-surface p-2.5 transition-colors hover:border-x-line-strong hover:bg-x-hover">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-x-ink font-medium">{entry.name}</span>
                          {entry.source_cli && entry.source_cli !== 'commander' && (
                            <span className="text-[11px] px-1 rounded bg-x-surface text-x-faint">{entry.source_cli}</span>
                          )}
                        </div>
                        {entry.description && (
                          <div className="text-[11px] text-x-muted mt-0.5">{entry.description}</div>
                        )}
                        <div className="text-[11px] text-x-ink-secondary mt-1 whitespace-pre-wrap line-clamp-3">{entry.content}</div>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button onClick={() => setEditing(entry.id)}
                          className="p-1 rounded hover:bg-x-surface text-x-muted hover:text-x-ink" title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => handleDelete(entry.id)}
                          className="p-1 rounded hover:bg-x-accent-ink/10 text-x-muted hover:text-x-accent-ink" title="Delete">
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
    if (!workspaceId || saving || !name.trim() || !content.trim()) return
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
          className="flex-1 bg-x-surface-2 text-x-ink text-[11px] px-2.5 py-1.5 rounded-md border border-x-line focus:border-x-accent focus:ring-[3px] focus:ring-x-focus outline-none" />
        <div className="relative">
          <select value={type} onChange={e => setType(e.target.value)}
            className="appearance-none bg-x-surface-2 text-x-ink text-[11px] pl-2.5 pr-6 py-1.5 rounded-md border border-x-line focus:border-x-accent focus:ring-[3px] focus:ring-x-focus outline-none">
            {Object.entries(ENTRY_TYPE_META).map(([t, meta]) => (
              <option key={t} value={t}>{meta.label}</option>
            ))}
          </select>
          <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-x-faint pointer-events-none" />
        </div>
      </div>
      <input value={description} onChange={e => setDescription(e.target.value)}
        placeholder="Short description (used for relevance matching)"
        className="w-full bg-x-surface-2 text-x-ink text-[11px] px-2.5 py-1.5 rounded-md border border-x-line focus:border-x-accent focus:ring-[3px] focus:ring-x-focus outline-none" />
      <textarea value={content} onChange={e => setContent(e.target.value)}
        placeholder="Memory content..."
        rows={4}
        className="w-full bg-x-surface-2 text-x-ink text-[11px] px-2.5 py-1.5 rounded-md border border-x-line focus:border-x-accent focus:ring-[3px] focus:ring-x-focus outline-none resize-y font-mono" />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-[11px] text-x-muted hover:text-x-ink">Cancel</button>
        <Button type="submit" onClick={handleSave} disabled={!workspaceId || saving || !name.trim() || !content.trim()}
          className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium bg-x-accent text-x-on-accent hover:bg-x-accent-ink active:scale-[.98] disabled:opacity-40 transition-colors">
          <Check size={11} />{entry ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

// ── Workspace knowledge tab ──────────────────────────────────────

// ── Notes and file prompt preview ───────────────────────────────────────

function PromptTab({ workspaceId }) {
  const [surfaces, setSurfaces] = useState(null)
  const [files, setFiles] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activePreview, setActivePreview] = useState('preview')

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [entryPrompt, fileData, entries, settings] = await Promise.all([
        api.getMemoryPrompt(workspaceId),
        api.getWorkspaceMemory(workspaceId, { include_content: 1 }),
        api.listMemoryEntries(workspaceId),
        api.getWorkspaceMemorySettings(workspaceId),
      ])
      const counts = Object.entries((entries || []).reduce((result, entry) => {
        result[entry.type] = (result[entry.type] || 0) + 1
        return result
      }, {})).map(([type, n]) => ({ type, n }))
      setSurfaces({
        prompts: {
          preview: [fileData?.content, entryPrompt?.prompt].filter(Boolean).join('\n\n'),
          project_memory: fileData?.content || '',
          memory_entries: entryPrompt?.prompt || '',
        },
        settings,
        workspace_memory: { chars: fileData?.content?.length || 0, providers: fileData?.providers || {} },
        memory_entries: { total: entries?.length || 0, by_type: counts },
      })
      setFiles(fileData)
    } catch {
      setSurfaces(null)
      setFiles(null)
    }
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  const prompts = surfaces?.prompts || {}
  const previewOptions = [
    ['preview', 'Combined'],
    ['project_memory', 'Project'],
    ['memory_entries', 'Entries'],
  ]
  const activeText = prompts[activePreview] || ''
  const providerContents = files?.provider_contents || {}

  const statRows = surfaces ? [
    ['Project file', surfaces.workspace_memory?.chars || 0, `${Object.keys(surfaces.workspace_memory?.providers || {}).length} providers`],
    ['Entries', surfaces.memory_entries?.total || 0, byCountLabel(surfaces.memory_entries?.by_type, 'type')],
  ] : []

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <div className="font-mono text-[11px] uppercase tracking-wide text-x-faint">Context surfaces</div>
          <div className="font-mono text-[11px] text-x-muted">Prompt budget: {surfaces?.settings?.memory_max_chars || 4000} chars</div>
        </div>
        <Button type="submit"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 border border-x-line px-2.5 py-1.5 text-[11px] font-medium text-x-ink-secondary transition-colors hover:border-x-line-strong hover:bg-x-hover hover:text-x-ink disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />Refresh
        </Button>
      </div>

      {loading && <div className="py-8 text-center font-mono text-[11px] text-x-faint animate-pulse">Loading context...</div>}

      {!loading && surfaces && (
        <>
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            {statRows.map(([label, count, meta]) => (
              <div key={label} className="rounded-md border border-x-line bg-x-surface p-3">
                <div className="font-mono text-[11px] uppercase tracking-wide text-x-faint">{label}</div>
                <div className="mt-1 text-lg font-semibold text-x-ink">{count}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-x-muted">{meta || '-'}</div>
              </div>
            ))}
          </div>

          <div className="mb-3 rounded-md border border-x-line bg-x-surface">
            <div className="flex flex-wrap items-center gap-1 border-b border-x-line p-2">
              {previewOptions.map(([id, label]) => (
                <Button type="submit"
                  key={id}
                  onClick={() => setActivePreview(id)}
                  className={` border px-2 py-1 text-[11px] font-medium transition-colors ${
                    activePreview === id
                      ? 'border-x-tint-line bg-x-tint text-x-accent'
                      : 'border-transparent text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                  }`}
                >
                  {label}
                </Button>
              ))}
              <span className="ml-auto font-mono text-[11px] text-x-faint">{activeText.length} chars</span>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-5 text-x-ink-secondary">
              {activeText || '(empty)'}
            </pre>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {Object.entries(providerContents).map(([cli, info]) => (
              <details key={cli} className="rounded-md border border-x-line bg-x-surface">
                <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-x-ink-secondary hover:text-x-ink">
                  {cli} · {info.filename || 'memory file'} · {info.exists ? `${info.content_length || 0} chars` : 'missing'}
                </summary>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap border-t border-x-line bg-x-surface-2 p-3 font-mono text-[11px] leading-5 text-x-muted">
                  {info.content || '(empty)'}
                </pre>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function byCountLabel(rows, key) {
  if (!Array.isArray(rows) || !rows.length) return '-'
  return rows
    .slice(0, 3)
    .map((row) => `${row[key] || 'other'}:${row.n || 0}`)
    .join(' · ')
}

// ── CLI memory sync tab ──────────────────────────────────────────

function MemorySyncTab({ workspaceId }) {
  const [status, setStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [resolveContent, setResolveContent] = useState('')
  const [diffData, setDiffData] = useState(null)

  const loadStatus = useCallback(async () => {
    if (!workspaceId) return
    try {
      setStatus(await api.getWorkspaceMemory(workspaceId))
    } catch {
      setStatus(null)
    }
  }, [workspaceId])

  useEffect(() => { loadStatus() }, [loadStatus])

  const handleImport = async () => {
    if (!workspaceId) return
    if (!window.confirm('Import existing CLI memories for this workspace into IVE? Existing entries may be updated. This does not enable automatic sync.')) return
    setImporting(true)
    try {
      const result = await api.importMemoryFromCli(workspaceId, { consent: true })
      setSyncResult(result)
      await loadStatus()
    } catch (error) { setSyncResult({ error: error?.message || 'Import failed' }) }
    setImporting(false)
  }

  const handleSync = async () => {
    if (!workspaceId) return
    if (!window.confirm('Read existing CLI memory files and synchronize them with IVE now? This can update those files. Automatic sync remains unchanged.')) return
    setSyncing(true)
    try {
      const result = await api.syncWorkspaceMemory(workspaceId, undefined, { consent: true })
      setSyncResult(result)
      await loadStatus()
    } catch (error) { setSyncResult({ error: error?.message || 'Sync failed' }) }
    setSyncing(false)
  }

  const handleStartResolve = async () => {
    if (!window.confirm('Read existing CLI memory files to preview the differences?')) return
    try {
      const diff = await api.getWorkspaceMemoryDiff(workspaceId, { consent: true })
      setDiffData(diff)
      setResolveContent(syncResult?.merged_content || status?.content || '')
      setResolving(true)
    } catch (error) { setSyncResult({ error: error?.message || 'Could not load the memory differences' }) }
  }

  const handleSubmitResolve = async () => {
    if (!window.confirm('Write this resolved content to the selected CLI memory files?')) return
    try {
      const result = await api.resolveWorkspaceMemory(workspaceId, resolveContent, undefined, { consent: true })
      if (result.error || result.status === 'error' || result.status === 'disabled') {
        setSyncResult({ ...result, error: result.error || 'Memory resolution was not saved' })
        return
      }
      setResolving(false)
      setDiffData(null)
      setSyncResult(null)
      await loadStatus()
    } catch (error) { setSyncResult({ error: error?.message || 'Memory resolution was not saved' }) }
  }

  const providers = status?.providers || {}
  const hasConflicts = syncResult?.status === 'conflicts' && syncResult?.conflict_count > 0

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button type="submit"
          onClick={handleImport}
          disabled={importing || syncing}
          className="inline-flex items-center gap-1.5 border border-x-line px-2.5 py-1.5 text-[11px] font-medium text-x-ink-secondary transition-colors hover:border-x-line-strong hover:bg-x-hover hover:text-x-ink disabled:opacity-50"
        >
          <Download size={11} />{importing ? 'Importing' : 'Import CLI'}
        </Button>
        <Button type="submit"
          onClick={handleSync}
          disabled={syncing || importing}
          className="inline-flex items-center gap-1.5 bg-x-accent px-2.5 py-1.5 text-[11px] font-medium text-x-on-accent transition-colors hover:bg-x-accent-ink active:scale-[.98] disabled:opacity-50"
        >
          <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing' : 'Sync now'}
        </Button>
        {status?.last_synced_at && (
          <span className="ml-auto font-mono text-[11px] text-x-faint">
            {new Date(status.last_synced_at).toLocaleString()}
          </span>
        )}
      </div>

      {syncResult?.error && (
        <div role="alert" className="mb-3 text-[11px] text-x-accent-ink">{syncResult.error}</div>
      )}
      {syncResult && !syncResult.error && !hasConflicts && (
        <div className="mb-3 rounded-md border border-x-good/30 bg-x-good/10 px-3 py-2 font-mono text-[11px] text-x-good">
          {syncResult.imported != null ? `${syncResult.imported} imported` : (syncResult.status || 'Synced')}
        </div>
      )}

      {hasConflicts && !resolving && (
        <Button type="submit"
          onClick={handleStartResolve}
          className="mb-3 flex w-full items-center gap-2 border border-x-accent-ink/30 bg-x-accent-ink/10 px-3 py-2 font-mono text-[11px] text-x-accent-ink transition-colors hover:bg-x-accent-ink/15"
        >
          <AlertTriangle size={13} />
          {syncResult.conflict_count} conflict{syncResult.conflict_count !== 1 ? 's' : ''} detected
        </Button>
      )}

      {resolving && (
        <div className="mb-3 space-y-2 rounded-md border border-x-line bg-x-surface-2 p-3">
          <div className="font-mono text-[11px] uppercase tracking-wide text-x-accent-ink">Resolve conflicts</div>
          {Array.isArray(syncResult?.conflicts) && syncResult.conflicts.length > 0 && (
            <div className="space-y-1">
              {syncResult.conflicts.map((hunk) => (
                <details key={hunk.id} className="rounded border border-x-accent-ink/20 bg-x-surface-2 text-[11px] text-x-faint">
                  <summary className="cursor-pointer px-2 py-1.5 font-mono hover:text-x-ink-secondary">Conflict {hunk.id + 1}</summary>
                  <div className="grid gap-2 p-2 md:grid-cols-2">
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-x-surface-2 p-2 font-mono text-[11px] leading-4 text-x-muted">{hunk.ours || '(empty)'}</pre>
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-x-surface-2 p-2 font-mono text-[11px] leading-4 text-x-muted">{hunk.theirs || '(empty)'}</pre>
                  </div>
                </details>
              ))}
            </div>
          )}
          {diffData && Object.entries(diffData).map(([cli, data]) => (
            <details key={cli} className="rounded border border-x-line bg-x-surface-2 text-[11px] text-x-faint">
              <summary className="cursor-pointer px-2 py-1.5 font-mono hover:text-x-ink-secondary">{cli}: {data.filename}</summary>
              <pre className="max-h-36 overflow-auto rounded-none border-0 bg-x-surface-2 p-2 font-mono text-[11px] leading-4">{data.diff}</pre>
            </details>
          ))}
          <textarea
            value={resolveContent}
            onChange={(e) => setResolveContent(e.target.value)}
            rows={10}
            className="w-full resize-y rounded-md border border-x-line bg-x-surface-2 p-2 font-mono text-[11px] leading-5 text-x-ink outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
          />
          <div className="flex gap-2">
            <Button type="submit" onClick={handleSubmitResolve} className=" bg-x-accent px-2.5 py-1.5 text-[11px] font-medium text-x-on-accent hover:bg-x-accent-ink">
              Save resolution
            </Button>
            <Button type="submit" onClick={() => { setResolving(false); setDiffData(null) }} className=" px-2.5 py-1.5 font-mono text-[11px] text-x-faint hover:text-x-ink-secondary">
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-2">
        {Object.keys(providers).length === 0 && (
          <div className="rounded-md border border-x-line bg-x-surface p-4 text-center font-mono text-[11px] text-x-faint md:col-span-2">
            No CLI memory providers reported.
          </div>
        )}
        {Object.entries(providers).map(([cli, info]) => (
          <div key={cli} className="rounded-md border border-x-line bg-x-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${
                !info.file_exists ? 'bg-x-faint/40'
                  : info.synced ? 'bg-x-good'
                    : info.changed ? 'bg-x-accent-ink'
                      : 'bg-x-faint/60'
              }`} />
              <span className="font-mono text-[11px] font-semibold uppercase text-x-ink">{cli}</span>
              <span className="ml-auto font-mono text-[11px] text-x-faint">
                {info.file_exists ? (info.synced ? 'synced' : 'changed') : 'missing'}
              </span>
            </div>
            <div className="truncate font-mono text-[11px] text-x-muted">{info.filename || '-'}</div>
            {info.file_exists && (
              <div className="mt-1 font-mono text-[11px] text-x-faint">{Math.round((info.content_length || 0) / 1024)}k chars</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
//  SEARCH TAB — ordinary IVE note search
// ══════════════════════════════════════════════════════════════════

function SearchTab({ workspaceId, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback(async (q) => {
    if (!q.trim() || !workspaceId) return
    setLoading(true)
    try {
      const entries = await api.searchMemoryEntries(q.trim(), workspaceId)
      setResults({ entries: Array.isArray(entries) ? entries : [] })
    } catch { setResults(null) }
    setLoading(false)
  }, [workspaceId])

  const handleKey = (event) => {
    if (event.key === 'Enter') doSearch(query)
    if (event.key === 'Escape') onClose?.()
  }

  return (
    <>
      <div className="border-b border-x-line px-4 py-3">
        <div className="flex items-center gap-2 rounded-md border border-x-line bg-x-surface-2 px-3 py-2 focus-within:border-x-accent focus-within:ring-[3px] focus-within:ring-x-focus">
          <Search size={14} className="text-x-faint" />
          <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKey}
            placeholder="Search memory entries..."
            className="flex-1 bg-transparent font-mono text-[12px] text-x-ink outline-none placeholder:text-x-muted" />
          {loading && <span className="text-[11px] text-x-muted animate-pulse">searching...</span>}
          {results && <span className="text-[11px] text-x-muted">{results.entries.length} results</span>}
        </div>
        <p role="status" className="mt-2 text-[11px] text-x-muted">Search ordinary memory entries. Additional search providers appear when installed.</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!results && !loading && <div className="py-8 text-center font-mono text-[11px] text-x-faint">Search ordinary memory entries in this workspace.<br />Press Enter to search.</div>}
        {results && results.entries.length === 0 && <div className="py-8 text-center font-mono text-[11px] text-x-faint">No results for &ldquo;{query}&rdquo;</div>}
        {/* Memory entries */}
        {results?.entries?.length > 0 && (
          <div className="space-y-1.5">
            {results.entries.map(e => {
              const meta = ENTRY_TYPE_META[e.type] || ENTRY_TYPE_META.project
              const Icon = meta.icon
              return (
                <div key={e.id} className="rounded-md border border-x-line bg-x-surface p-2">
                  <div className="flex items-center gap-2">
                    <Icon size={11} className={meta.color} />
                    <span className="text-[11px] text-x-ink font-medium">{e.name}</span>
                    <span className={`text-[11px] px-1.5 rounded ${meta.bg} ${meta.color}`}>{meta.label}</span>
                    {e.source_cli && e.source_cli !== 'commander' && (
                      <span className="text-[11px] text-x-faint">{e.source_cli}</span>
                    )}
                  </div>
                  {e.description && <div className="text-[11px] text-x-muted mt-1">{e.description}</div>}
                  {e.content && (
                    <div className="text-[11px] text-x-ink-secondary mt-1 whitespace-pre-wrap line-clamp-3">
                      {e.content}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}


      </div>
    </>
  )
}
