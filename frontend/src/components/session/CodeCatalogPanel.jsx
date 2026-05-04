import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  FileCode2, X, Search, ChevronDown, ChevronRight, ThumbsUp,
  RefreshCw, History, AlertTriangle, Trash2, Pencil, Sparkles, Loader2,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const KIND_COLORS = {
  function: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  method:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  class:    'text-violet-400 bg-violet-500/10 border-violet-500/20',
  hook:     'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  endpoint: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  module:   'text-orange-400 bg-orange-500/10 border-orange-500/20',
}

function kindBadge(kind) {
  return KIND_COLORS[kind] || 'text-text-faint bg-bg-tertiary border-border-secondary'
}

function parseFlow(flow) {
  if (!flow) return { deps: [], callers: [] }
  const deps = []
  const callers = []
  for (const part of String(flow).split(/\s+/)) {
    if (!part) continue
    if (part.startsWith('→')) deps.push(part.slice(1))
    else if (part.startsWith('←')) callers.push(part.slice(1))
    else deps.push(part)
  }
  return { deps, callers }
}

function parseEffects(effects) {
  if (!effects) return []
  if (Array.isArray(effects)) return effects
  return String(effects).split(/[,;]\s*/).filter(Boolean)
}

export default function CodeCatalogPanel({ onClose }) {
  const [entries, setEntries] = useState([])
  const [history, setHistory] = useState([])
  const [search, setSearch] = useState('')
  const [view, setView] = useState('by-file') // 'by-file' | 'history'
  const [showStaleOnly, setShowStaleOnly] = useState(false)
  const [collapsed, setCollapsed] = useState({}) // file → boolean
  const [busyFile, setBusyFile] = useState(null)
  const [bootstrapJob, setBootstrapJob] = useState(null)
  const [bootstrapEstimate, setBootstrapEstimate] = useState(null)
  const [confirmingBootstrap, setConfirmingBootstrap] = useState(false)
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  const panelRef = useRef(null)

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const [viewWsId, setViewWsId] = useState(activeWorkspaceId || workspaces[0]?.id || '')

  useEffect(() => { panelRef.current?.focus() }, [])

  const loadEntries = useCallback(async () => {
    if (!viewWsId) return
    try {
      const data = await api.getCodeCatalog(viewWsId)
      setEntries(Array.isArray(data) ? data : [])
    } catch {
      setEntries([])
    }
  }, [viewWsId])

  const loadHistory = useCallback(async () => {
    if (!viewWsId) return
    try {
      const data = await api.getCodeCatalogHistory(viewWsId, { limit: 100 })
      setHistory(Array.isArray(data) ? data : [])
    } catch {
      setHistory([])
    }
  }, [viewWsId])

  const loadBootstrap = useCallback(async () => {
    if (!viewWsId) return
    try {
      const data = await api.getCodeCatalogBootstrap(viewWsId)
      setBootstrapJob(data?.job || null)
      setBootstrapEstimate(data?.estimate || null)
    } catch {
      setBootstrapJob(null)
      setBootstrapEstimate(null)
    }
  }, [viewWsId])

  useEffect(() => {
    if (!viewWsId) return
    loadEntries()
    loadBootstrap()
    if (view === 'history') loadHistory()
  }, [viewWsId, view, loadEntries, loadBootstrap, loadHistory])

  // Live updates from the event bus.
  useEffect(() => {
    if (!viewWsId) return
    const matches = (e) => !e?.detail?.workspace_id || e.detail.workspace_id === viewWsId

    const onCatalogUpdated = (e) => { if (matches(e)) loadEntries() }
    const onBootstrapStarted = (e) => {
      if (!matches(e)) return
      setBootstrapJob((prev) => ({
        ...(prev || {}),
        workspace_id: viewWsId,
        status: 'running',
        total_files: e.detail?.total_files,
        completed_files: 0,
        model: e.detail?.model,
        cli: e.detail?.cli,
        counts: { inserted: 0, confirmed: 0, replaced: 0, rejected: 0 },
        started_at: new Date().toISOString(),
      }))
    }
    const onBootstrapProgress = (e) => {
      if (!matches(e)) return
      setBootstrapJob((prev) => ({
        ...(prev || {}),
        status: 'running',
        completed_files: e.detail?.completed_files,
        total_files: e.detail?.total_files,
        counts: e.detail?.counts || prev?.counts,
        current_files: e.detail?.recent_files || [],
      }))
      // Each batch upserts new rows; refresh the catalog list too.
      loadEntries()
    }
    const onBootstrapDone = (e) => {
      if (!matches(e)) return
      loadEntries()
      loadBootstrap()
    }

    window.addEventListener('cc-code_catalog_updated', onCatalogUpdated)
    window.addEventListener('cc-code_catalog_bootstrap_started', onBootstrapStarted)
    window.addEventListener('cc-code_catalog_bootstrap_progress', onBootstrapProgress)
    window.addEventListener('cc-code_catalog_bootstrap_completed', onBootstrapDone)
    window.addEventListener('cc-code_catalog_bootstrap_failed', onBootstrapDone)
    return () => {
      window.removeEventListener('cc-code_catalog_updated', onCatalogUpdated)
      window.removeEventListener('cc-code_catalog_bootstrap_started', onBootstrapStarted)
      window.removeEventListener('cc-code_catalog_bootstrap_progress', onBootstrapProgress)
      window.removeEventListener('cc-code_catalog_bootstrap_completed', onBootstrapDone)
      window.removeEventListener('cc-code_catalog_bootstrap_failed', onBootstrapDone)
    }
  }, [viewWsId, loadEntries, loadBootstrap])

  const filtered = useMemo(() => {
    let result = entries
    if (showStaleOnly) result = result.filter((e) => e.stale_since)
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (e) =>
          e.symbol_name?.toLowerCase().includes(q) ||
          e.symbol_file?.toLowerCase().includes(q) ||
          e.purpose?.toLowerCase().includes(q) ||
          e.content?.toLowerCase().includes(q)
      )
    }
    return result
  }, [entries, showStaleOnly, search])

  const grouped = useMemo(() => {
    const groups = {}
    for (const e of filtered) {
      const f = e.symbol_file || '(unknown file)'
      if (!groups[f]) groups[f] = []
      groups[f].push(e)
    }
    for (const f of Object.keys(groups)) {
      groups[f].sort((a, b) => (a.symbol_name || '').localeCompare(b.symbol_name || ''))
    }
    return groups
  }, [filtered])

  const fileList = useMemo(() => Object.keys(grouped).sort(), [grouped])

  const summary = useMemo(() => {
    const total = entries.length
    const stale = entries.filter((e) => e.stale_since).length
    const files = new Set(entries.map((e) => e.symbol_file || '')).size
    return { total, stale, files }
  }, [entries])

  const toggleCollapse = (file) => {
    setCollapsed((prev) => ({ ...prev, [file]: !prev[file] }))
  }

  const handleRefreshFile = async (file) => {
    setBusyFile(file)
    try {
      await api.refreshFileCodeCatalog(viewWsId, file)
      await loadEntries()
    } catch (err) {
      console.error('refresh file failed:', err)
    } finally {
      setBusyFile(null)
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
      console.error('confirm catalog entry failed:', err)
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.deleteKnowledgeEntry(id)
      setEntries((prev) => prev.filter((x) => x.id !== id))
    } catch (err) {
      console.error('delete catalog entry failed:', err)
    }
  }

  const openBootstrapConfirm = async () => {
    // Refresh estimate first so the dialog reflects the current file count.
    try {
      const data = await api.getCodeCatalogBootstrap(viewWsId, 'estimate')
      if (data?.estimate) setBootstrapEstimate(data.estimate)
    } catch {}
    setConfirmingBootstrap(true)
  }

  const handleStartBootstrap = async () => {
    setBootstrapBusy(true)
    try {
      const result = await api.startCodeCatalogBootstrap(viewWsId)
      if (result?.job) setBootstrapJob(result.job)
      setConfirmingBootstrap(false)
    } catch (err) {
      console.error('start bootstrap failed:', err)
    } finally {
      setBootstrapBusy(false)
    }
  }

  const handleCancelBootstrap = async () => {
    setBootstrapBusy(true)
    try {
      const result = await api.cancelCodeCatalogBootstrap(viewWsId)
      if (result?.job) setBootstrapJob(result.job)
      else await loadBootstrap()
    } catch (err) {
      console.error('cancel bootstrap failed:', err)
    } finally {
      setBootstrapBusy(false)
    }
  }

  const isRunning = bootstrapJob?.status === 'running'
  const progressPct = isRunning && bootstrapJob.total_files
    ? Math.min(100, Math.round((bootstrapJob.completed_files / bootstrapJob.total_files) * 100))
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[820px] max-h-[85vh] flex flex-col outline-none scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <FileCode2 size={14} className="text-accent-primary" />
            <h2 className="text-sm font-semibold text-text-primary">Code Catalog</h2>
            <select
              value={viewWsId}
              onChange={(e) => setViewWsId(e.target.value)}
              className="px-1.5 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary font-mono focus:outline-none ide-focus-ring"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
            <span className="text-[10px] text-text-faint font-mono">
              {summary.total} symbols · {summary.files} files
              {summary.stale > 0 && (
                <span className="ml-1.5 text-amber-400">
                  · {summary.stale} stale
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {entries.length > 0 && !isRunning && view === 'by-file' && (
              <button
                onClick={openBootstrapConfirm}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-accent-primary hover:bg-accent-primary/10 rounded-md transition-colors"
                title="Re-bootstrap catalog from scratch"
              >
                <Sparkles size={11} /> re-bootstrap
              </button>
            )}
            <button
              onClick={() => setView(view === 'by-file' ? 'history' : 'by-file')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
              title={view === 'by-file' ? 'Show replace history' : 'Back to catalog'}
            >
              {view === 'by-file' ? <><History size={11} /> history</> : <><FileCode2 size={11} /> catalog</>}
            </button>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {isRunning && (
          <div className="px-4 py-2.5 border-b border-border-secondary bg-accent-primary/5">
            <div className="flex items-center justify-between mb-1.5 gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 size={11} className="animate-spin text-accent-primary shrink-0" />
                <span className="text-[11px] font-mono text-text-secondary">
                  Bootstrapping catalog…{' '}
                  <span className="text-text-faint">
                    {bootstrapJob.completed_files || 0}/{bootstrapJob.total_files || 0} files
                  </span>
                </span>
                {bootstrapJob.model && (
                  <span className="text-[10px] font-mono text-text-faint shrink-0">
                    · {bootstrapJob.model}
                  </span>
                )}
              </div>
              <button
                onClick={handleCancelBootstrap}
                disabled={bootstrapBusy}
                className="px-2 py-0.5 text-[10px] font-mono text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-40"
              >
                cancel
              </button>
            </div>
            <div className="h-1 w-full rounded bg-bg-inset overflow-hidden">
              <div
                className="h-full bg-accent-primary transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {bootstrapJob.counts && (
              <div className="mt-1.5 text-[10px] font-mono text-text-faint flex items-center gap-3">
                <span>+{bootstrapJob.counts.inserted || 0} new</span>
                <span>~{bootstrapJob.counts.confirmed || 0} confirmed</span>
                <span>↻{bootstrapJob.counts.replaced || 0} replaced</span>
                {(bootstrapJob.counts.rejected || 0) > 0 && (
                  <span className="text-amber-400">×{bootstrapJob.counts.rejected} rejected</span>
                )}
              </div>
            )}
          </div>
        )}

        {view === 'by-file' && (
          <>
            {/* Search bar + filters */}
            <div className="px-4 py-2 border-b border-border-secondary flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="search symbol, file, purpose..."
                  className="w-full pl-6 pr-2 py-1.5 text-[11px] bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
                />
              </div>
              <button
                onClick={() => setShowStaleOnly((v) => !v)}
                className={`flex items-center gap-1 px-2 py-1.5 text-[10px] font-mono rounded-md border transition-colors shrink-0 ${
                  showStaleOnly
                    ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                    : 'text-text-faint border-border-secondary hover:bg-bg-hover'
                }`}
                title="Show only stale rows"
              >
                <AlertTriangle size={10} />
                stale {summary.stale > 0 ? `(${summary.stale})` : ''}
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {fileList.length === 0 ? (
                <div className="px-4 py-10 text-xs text-text-faint text-center">
                  {search.trim() || showStaleOnly ? (
                    'No catalog entries match the current filters'
                  ) : isRunning ? (
                    <>Bootstrap in progress — first symbols will appear after the first batch finishes…</>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      <div>No code catalog entries yet.</div>
                      <button
                        onClick={openBootstrapConfirm}
                        disabled={!bootstrapEstimate || (bootstrapEstimate.total_files || 0) === 0}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] font-mono rounded-md border border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Sparkles size={12} />
                        Bootstrap catalog
                        {bootstrapEstimate && (
                          <span className="text-text-faint">
                            ({bootstrapEstimate.total_files} files · {bootstrapEstimate.model})
                          </span>
                        )}
                      </button>
                      <div className="text-[10px] text-text-faint">
                        Or run <span className="text-text-secondary font-mono">/code-catalog-init</span> in a worker session.
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                fileList.map((file) => {
                  const rows = grouped[file]
                  const isCollapsed = collapsed[file]
                  const staleN = rows.filter((r) => r.stale_since).length
                  return (
                    <div key={file}>
                      <div className="w-full flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-bg-secondary/30 hover:bg-bg-hover/30 transition-colors">
                        <button
                          onClick={() => toggleCollapse(file)}
                          className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        >
                          {isCollapsed
                            ? <ChevronRight size={11} className="text-text-faint shrink-0" />
                            : <ChevronDown size={11} className="text-text-faint shrink-0" />
                          }
                          <span className="text-[11px] font-mono text-text-secondary truncate">{file}</span>
                          <span className="text-[10px] text-text-faint font-mono shrink-0">({rows.length})</span>
                          {staleN > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded shrink-0">
                              <AlertTriangle size={8} />
                              {staleN}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => handleRefreshFile(file)}
                          disabled={busyFile === file}
                          className="p-1 rounded text-text-faint hover:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
                          title="Mark all rows for this file as stale (next worker re-emits them)"
                        >
                          <RefreshCw size={10} className={busyFile === file ? 'animate-spin' : ''} />
                        </button>
                      </div>
                      {!isCollapsed && rows.map((entry) => (
                        <CatalogRow
                          key={entry.id}
                          entry={entry}
                          onConfirm={handleConfirm}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}

        {view === 'history' && (
          <div className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-4 py-10 text-xs text-text-faint text-center">
                No replace history yet
              </div>
            ) : (
              history.map((h) => (
                <HistoryRow key={h.id} row={h} />
              ))
            )}
          </div>
        )}

        {confirmingBootstrap && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-lg"
            onClick={() => !bootstrapBusy && setConfirmingBootstrap(false)}
          >
            <div
              className="bg-bg-secondary border border-border-primary rounded-md shadow-lg w-[420px] p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={13} className="text-accent-primary" />
                <h3 className="text-sm font-semibold text-text-primary">Bootstrap catalog?</h3>
              </div>
              {bootstrapEstimate ? (
                <div className="text-[11px] font-mono text-text-secondary space-y-1 mb-3">
                  <div>Files: <span className="text-text-primary">{bootstrapEstimate.total_files}</span> {bootstrapEstimate.total_files >= bootstrapEstimate.max_files && <span className="text-amber-400">(capped)</span>}</div>
                  <div>Model: <span className="text-text-primary">{bootstrapEstimate.model}</span> <span className="text-text-faint">via {bootstrapEstimate.cli}</span></div>
                  <div>Source: <span className="text-text-faint">{bootstrapEstimate.model_source}</span></div>
                  <div>Batches: ~<span className="text-text-primary">{Math.ceil(bootstrapEstimate.total_files / bootstrapEstimate.files_per_batch)}</span> LLM calls</div>
                </div>
              ) : (
                <div className="text-[11px] text-text-faint mb-3">Loading estimate…</div>
              )}
              <p className="text-[11px] text-text-faint mb-3 leading-relaxed">
                This walks your repo and asks the model to emit one wire-format line per public symbol.
                Existing rows are confirmed/replaced — duplicates are dedup'd. You can cancel any time.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmingBootstrap(false)}
                  disabled={bootstrapBusy}
                  className="px-2.5 py-1 text-[11px] font-mono text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded transition-colors disabled:opacity-40"
                >
                  cancel
                </button>
                <button
                  onClick={handleStartBootstrap}
                  disabled={bootstrapBusy || !bootstrapEstimate || (bootstrapEstimate.total_files || 0) === 0}
                  className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono rounded border border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors disabled:opacity-40"
                >
                  {bootstrapBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  Start bootstrap
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CatalogRow({ entry, onConfirm, onDelete }) {
  const stale = !!entry.stale_since
  const flow = parseFlow(entry.symbol_flow || entry.flow)
  const effects = parseEffects(entry.symbol_effects || entry.effects)
  const args = entry.symbol_args
  const kind = entry.symbol_kind || 'function'

  return (
    <div className={`group flex items-start gap-2 px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover/40 transition-colors ${stale ? 'opacity-60' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium font-mono rounded border ${kindBadge(kind)}`}>
            {kind}
          </span>
          <span className="text-[12px] font-mono text-text-primary font-semibold">
            {entry.symbol_name || '(unparseable)'}
            {args !== undefined && args !== null && (
              <span className="text-text-faint">({args})</span>
            )}
          </span>
          {stale && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono rounded border text-amber-400 bg-amber-500/10 border-amber-500/30">
              <AlertTriangle size={8} />
              stale
            </span>
          )}
        </div>
        {entry.purpose && (
          <p className="text-[11px] text-text-secondary font-mono mt-1 leading-relaxed">
            {entry.purpose}
          </p>
        )}
        {(flow.deps.length > 0 || flow.callers.length > 0 || effects.length > 0) && (
          <div className="flex flex-col gap-0.5 mt-1.5 text-[10px] font-mono text-text-faint">
            {flow.deps.length > 0 && (
              <div className="flex items-start gap-1">
                <span className="text-cyan-400">→</span>
                <span className="break-all">{flow.deps.join(', ')}</span>
              </div>
            )}
            {flow.callers.length > 0 && (
              <div className="flex items-start gap-1">
                <span className="text-violet-400">←</span>
                <span className="break-all">{flow.callers.join(', ')}</span>
              </div>
            )}
            {effects.length > 0 && (
              <div className="flex items-start gap-1">
                <span className="text-amber-400">◆</span>
                <span className="break-all">{effects.join(', ')}</span>
              </div>
            )}
          </div>
        )}
        {!entry.symbol_name && entry.content && (
          <p className="text-[10px] text-text-faint font-mono mt-1 italic">
            raw: {entry.content}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          {entry.contributor && (
            <span className="text-[9px] text-text-faint font-mono">
              by {entry.contributor}
            </span>
          )}
          {entry.scope && (
            <span className="text-[9px] text-text-faint font-mono">
              [{entry.scope}]
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 mt-0.5">
        <button
          onClick={() => onConfirm(entry.id)}
          title="Confirm this entry"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-text-faint hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
        >
          <ThumbsUp size={10} />
          <span>{entry.confirmed_count || 0}</span>
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

function HistoryRow({ row }) {
  const replacedAt = row.replaced_at
    ? new Date(row.replaced_at).toLocaleString()
    : ''
  return (
    <div className="px-4 py-2.5 border-b border-border-secondary hover:bg-bg-hover/40 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] text-text-faint font-mono">{replacedAt}</span>
        {row.replaced_by && (
          <span className="text-[10px] text-text-faint font-mono">
            by {row.replaced_by}
          </span>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-[10px] font-mono text-red-300/90 line-through">
          − {row.prior_content}
        </div>
        <div className="text-[10px] font-mono text-emerald-300/90">
          + {row.new_content}
        </div>
      </div>
    </div>
  )
}
