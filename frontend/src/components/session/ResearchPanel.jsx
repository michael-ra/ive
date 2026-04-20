import { useState, useEffect, useRef } from 'react'
import { Search, X, Plus, ChevronDown, ChevronRight, ExternalLink, Globe, Tag, Trash2, RefreshCw, Play, ZoomIn, Clock, History } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function ResearchPanel({ onClose }) {
  const [entries, setEntries] = useState([])
  const [selected, setSelected] = useState(null) // full entry with sources
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('') // feature tag filter
  const [showCreate, setShowCreate] = useState(false)
  const [newTopic, setNewTopic] = useState('')
  const [newFeature, setNewFeature] = useState('')
  const [depth, setDepth] = useState('standard')             // quick | standard | deep
  const [crossTemporal, setCrossTemporal] = useState(false)   // old paradigms → new systems
  const [digDeeperRecent, setDigDeeperRecent] = useState(false)
  const [recencyMonths, setRecencyMonths] = useState(6)
  // Focus zone for L/R nav: 'list' = the entry list, 'detail' = action buttons
  const [focusZone, setFocusZone] = useState('list')
  const [detailBtnIdx, setDetailBtnIdx] = useState(0)
  const [progressLog, setProgressLog] = useState({})  // { entry_id: [lines] }
  const [showProgress, setShowProgress] = useState(true)
  const topicInputRef = useRef(null)
  const listRef = useRef(null)
  const progressEndRef = useRef(null)

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const wsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name || ''

  useEffect(() => {
    loadEntries()
  }, [activeWorkspaceId, filter])

  // Live progress from research jobs
  useEffect(() => {
    const onProgress = (e) => {
      const { entry_id, line, job_id } = e.detail || {}
      if (!entry_id || !line) return
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      setProgressLog((prev) => {
        const lines = prev[entry_id] || []
        // Cap at 200 lines to avoid memory bloat
        const next = [...lines, { ts, line, job_id }].slice(-200)
        return { ...prev, [entry_id]: next }
      })
    }
    const onDone = (e) => {
      loadEntries()
      const eid = e?.detail?.entry_id
      if (eid && selected?.id === eid) {
        api.getResearchEntry(eid).then(setSelected).catch(() => {})
      }
      // Add a "done" line to progress
      if (eid) {
        const status = e?.detail?.status || 'done'
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        setProgressLog((prev) => ({
          ...prev,
          [eid]: [...(prev[eid] || []), { ts, line: `Research ${status}`, done: true }],
        }))
      }
    }
    const onStarted = (e) => {
      const eid = e?.detail?.entry_id
      const backend = e?.detail?.backend || 'standalone'
      if (eid) {
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        setProgressLog((prev) => ({
          ...prev,
          [eid]: [{ ts, line: `Research started (${backend})`, start: true }],
        }))
      }
      loadEntries()
    }
    window.addEventListener('cc-research_progress', onProgress)
    window.addEventListener('cc-research-progress', onProgress)
    window.addEventListener('cc-research_done', onDone)
    window.addEventListener('cc-research-done', onDone)
    window.addEventListener('cc-research_started', onStarted)
    window.addEventListener('cc-research-started', onStarted)
    return () => {
      window.removeEventListener('cc-research_progress', onProgress)
      window.removeEventListener('cc-research-progress', onProgress)
      window.removeEventListener('cc-research_done', onDone)
      window.removeEventListener('cc-research-done', onDone)
      window.removeEventListener('cc-research_started', onStarted)
      window.removeEventListener('cc-research-started', onStarted)
    }
  }, [activeWorkspaceId, filter, selected?.id])

  // Auto-scroll progress log
  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [progressLog, selected?.id])

  const loadEntries = async () => {
    try {
      const data = await api.getResearch(activeWorkspaceId, filter || undefined)
      setEntries(Array.isArray(data) ? data : [])
    } catch {
      setEntries([])
    }
  }

  const handleSelect = async (entry) => {
    try {
      const full = await api.getResearchEntry(entry.id)
      setSelected(full)
    } catch {
      setSelected(entry)
    }
  }

  // Drive the right-pane detail off selectedIdx so keyboard nav and clicks
  // share one source of truth.
  useEffect(() => {
    if (selectedIdx < 0 || selectedIdx >= entries.length) return
    const entry = entries[selectedIdx]
    if (!entry) return
    if (selected?.id !== entry.id) handleSelect(entry)
    // Keep the highlighted row visible as the user pages through with arrows.
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, entries])

  // If the entries list reloads and our index is now out of bounds, snap back.
  useEffect(() => {
    if (selectedIdx >= entries.length) setSelectedIdx(entries.length - 1)
  }, [entries.length])

  const handleRun = async (entry, e, opts = {}) => {
    e?.stopPropagation()
    setEntries((prev) => prev.map((x) => x.id === entry.id ? { ...x, status: 'in_progress' } : x))
    if (selected?.id === entry.id) {
      setSelected({ ...selected, status: 'in_progress' })
    }
    try {
      await api.startResearch({
        query: entry.query || entry.topic,
        entry_id: entry.id,
        workspace_id: entry.workspace_id || activeWorkspaceId,
        depth: opts.depth || depth,
        cross_temporal: opts.cross_temporal ?? crossTemporal,
        recency_months: opts.recency_months || undefined,
        dig_deeper: opts.dig_deeper || false,
      })
    } catch (err) {
      setEntries((prev) => prev.map((x) => x.id === entry.id ? { ...x, status: 'pending' } : x))
      if (selected?.id === entry.id) {
        setSelected({ ...selected, status: 'pending' })
      }
      alert(`Failed to start research: ${err?.message || 'unknown error'}`)
    }
  }

  const handleDigDeeper = async (entry, e) => {
    e?.stopPropagation()
    handleRun(entry, e, {
      depth: 'deep',
      dig_deeper: true,
      recency_months: digDeeperRecent ? recencyMonths : undefined,
      cross_temporal: crossTemporal,
    })
  }

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!newTopic.trim()) return
    const created = await api.createResearch({
      workspace_id: activeWorkspaceId,
      topic: newTopic.trim(),
      feature_tag: newFeature.trim() || undefined,
    })
    setNewTopic('')
    setNewFeature('')
    setShowCreate(false)
    await loadEntries()
    // Auto-launch with the chosen depth and options
    if (created?.id) {
      handleRun(created, null, {
        depth,
        cross_temporal: crossTemporal,
      })
    }
  }

  // ⌘= opens the create form (and refocuses if already open); ⌘↵ saves it.
  usePanelCreate({
    onAdd: () => {
      setShowCreate(true)
      // Defer focus until React has rendered the form input
      requestAnimationFrame(() => topicInputRef.current?.focus())
    },
    onSubmit: () => { if (showCreate) handleCreate() },
  })

  // ↑/↓ navigates the entry list, Enter runs a pending entry, ⌘⌫ deletes.
  // Disabled while the create form is open so its inputs aren't shadowed.
  useListKeyboardNav({
    enabled: !showCreate,
    itemCount: entries.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const entry = entries[idx]
      if (entry?.status === 'pending' || entry?.status === 'failed') handleRun(entry)
    },
    onDelete: (idx) => {
      const entry = entries[idx]
      if (entry) handleDelete(entry.id)
    },
  })

  const handleDelete = async (id) => {
    await api.deleteResearch(id)
    if (selected?.id === id) setSelected(null)
    loadEntries()
  }

  const handleCopyFindings = () => {
    if (!selected) return
    const context = [
      `Research findings for: ${selected.topic}`,
      selected.findings_summary ? `\nSummary:\n${selected.findings_summary}` : '',
      selected.sources?.length ? `\nSources:\n${selected.sources.map((s) => `- ${s.title}: ${s.content_summary?.slice(0, 200)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')
    navigator.clipboard.writeText(context)
    alert('Research copied to clipboard — paste into any session')
  }

  // ── Available action buttons in the detail pane (status-dependent) ──
  // Order: [run/retry?, delete, copy] — used for L/R arrow navigation.
  const availableDetailBtns = (() => {
    if (!selected) return []
    const btns = []
    if (selected.status === 'pending' || selected.status === 'failed') btns.push('run')
    btns.push('delete')
    btns.push('copy')
    return btns
  })()

  // Reset the detail button index when the selection changes or buttons shift.
  useEffect(() => {
    setDetailBtnIdx(0)
  }, [selected?.id, selected?.status])

  // If selection vanishes while focused on detail, snap focus back to list.
  useEffect(() => {
    if (!selected && focusZone === 'detail') setFocusZone('list')
  }, [selected, focusZone])

  // ── L/R arrow navigation between list and detail buttons ──────────────
  // Capture phase so we run before useListKeyboardNav's Enter handler when
  // we're in the detail zone and want Enter to fire the focused action.
  useEffect(() => {
    if (showCreate) return
    const handler = (e) => {
      const t = e.target
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return

      if (focusZone === 'list') {
        if (e.key === 'ArrowRight' && selected && availableDetailBtns.length > 0) {
          e.preventDefault()
          setFocusZone('detail')
          setDetailBtnIdx(0)
        }
        return
      }

      // focusZone === 'detail'
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (detailBtnIdx === 0) setFocusZone('list')
        else setDetailBtnIdx((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setDetailBtnIdx((i) => Math.min(availableDetailBtns.length - 1, i + 1))
        return
      }
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const btn = availableDetailBtns[detailBtnIdx]
        if (btn === 'run') handleRun(selected)
        else if (btn === 'delete') handleDelete(selected.id)
        else if (btn === 'copy') handleCopyFindings()
        return
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => window.removeEventListener('keydown', handler, true)
  }, [focusZone, detailBtnIdx, availableDetailBtns.length, selected, showCreate])

  const isDetailBtnFocused = (name) =>
    focusZone === 'detail' && availableDetailBtns[detailBtnIdx] === name

  const handleSearch = async () => {
    if (!search.trim()) { loadEntries(); return }
    const data = await api.searchResearch(search.trim(), activeWorkspaceId)
    setEntries(Array.isArray(data) ? data : [])
  }

  // Get unique feature tags
  const featureTags = [...new Set(entries.map((e) => e.feature_tag).filter(Boolean))]

  const statusColor = (s) => s === 'complete' ? 'text-green-400' : s === 'in_progress' ? 'text-amber-400' : 'text-text-faint'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh] bg-black/50" onClick={onClose}>
      <div className="w-[800px] h-[80vh] ide-panel overflow-hidden flex flex-col scale-in" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Globe size={14} className="text-cyan-400" />
          <span className="text-xs text-text-primary font-medium">Research DB</span>
          <span className="text-[10px] text-text-faint">{wsName} · {entries.length} entries</span>
          <div className="flex-1" />
          <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors">
            <Plus size={11} /> new
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="border-b border-border-secondary bg-bg-elevated">
            <div className="flex items-center gap-2 px-4 py-2">
              <input ref={topicInputRef} value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="Research topic/question" className="flex-1 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" autoFocus />
              <input value={newFeature} onChange={(e) => setNewFeature(e.target.value)} placeholder="feature tag" className="w-28 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none font-mono" />
              <button type="submit" className="px-2.5 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md">create</button>
            </div>
            <div className="flex items-center gap-3 px-4 pb-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-faint">Depth:</span>
                {[
                  { id: 'quick', label: 'quick', hint: '1 pass' },
                  { id: 'standard', label: 'standard', hint: '1 pass, 3+ rounds' },
                  { id: 'deep', label: 'deep', hint: '3 iterations' },
                ].map(({ id, label, hint }) => (
                  <button key={id} type="button" onClick={() => setDepth(id)} title={hint}
                    className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${depth === id ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-text-faint hover:text-text-secondary border border-transparent'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary">
                <input type="checkbox" checked={crossTemporal} onChange={(e) => setCrossTemporal(e.target.checked)}
                  className="w-3 h-3 rounded border-border-primary accent-cyan-500" />
                <History size={9} /> cross-temporal (old paradigms → new systems)
              </label>
            </div>
          </form>
        )}

        {/* Search + filter bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary">
          <div className="flex-1 relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { handleSearch(); return }
                // Forward arrow keys into the list so the user can dive in
                // without first tabbing out of the search box.
                if (e.key === 'ArrowDown' && entries.length) {
                  e.preventDefault()
                  setSelectedIdx((i) => Math.min(entries.length - 1, (i < 0 ? 0 : i + 1)))
                } else if (e.key === 'ArrowUp' && entries.length) {
                  e.preventDefault()
                  setSelectedIdx((i) => Math.max(0, (i < 0 ? 0 : i - 1)))
                }
              }}
              placeholder="search findings..."
              className="w-full pl-6 pr-2 py-1.5 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
            />
          </div>
          {featureTags.length > 0 && (
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="px-2 py-1.5 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary font-mono">
              <option value="">all features</option>
              {featureTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button onClick={loadEntries} className="p-1.5 text-text-faint hover:text-text-secondary"><RefreshCw size={12} /></button>
        </div>

        {/* Split: entry list + detail */}
        <div className="flex flex-1 min-h-0">
          {/* Left: entry list */}
          <div ref={listRef} className="w-[280px] border-r border-border-primary overflow-y-auto">
            {entries.map((entry, idx) => (
              <div
                key={entry.id}
                data-idx={idx}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedIdx(idx)}
                className={`group w-full text-left px-3 py-2.5 border-b border-border-secondary transition-colors cursor-pointer ${
                  selectedIdx === idx
                    ? 'bg-accent-subtle ring-1 ring-inset ring-cyan-500/40'
                    : selected?.id === entry.id ? 'bg-accent-subtle' : 'hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-medium ${statusColor(entry.status)}`}>
                    {entry.status === 'complete' ? '✓' : entry.status === 'in_progress' ? '◉' : '○'}
                  </span>
                  <span className="text-xs text-text-primary truncate flex-1">{entry.topic}</span>
                  {entry.status === 'pending' && (
                    <button
                      type="button"
                      onClick={(e) => handleRun(entry, e)}
                      title="Run deep research now"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-cyan-400 hover:bg-cyan-500/20 transition-opacity"
                    >
                      <Play size={11} />
                    </button>
                  )}
                </div>
                {entry.feature_tag && (
                  <div className="flex items-center gap-1 mt-1">
                    <Tag size={9} className="text-text-faint" />
                    <span className="text-[10px] text-text-faint font-mono">{entry.feature_tag}</span>
                  </div>
                )}
                <span className="text-[10px] text-text-faint">{entry.updated_at?.slice(0, 16)}</span>
              </div>
            ))}
            {entries.length === 0 && (
              <div className="p-4 text-xs text-text-faint text-center">
                No research yet. Click <span className="text-text-secondary">+ new</span> to create and run a job.
              </div>
            )}
          </div>

          {/* Right: detail with sources */}
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm text-text-primary font-medium">{selected.topic}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-[10px] font-medium ${statusColor(selected.status)}`}>{selected.status}</span>
                      {selected.feature_tag && <span className="text-[10px] text-text-faint font-mono bg-bg-tertiary px-1.5 py-0.5 rounded">{selected.feature_tag}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {(selected.status === 'pending' || selected.status === 'failed') && (
                      <button
                        onClick={(e) => handleRun(selected, e)}
                        title="Run deep research now"
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded transition-colors ${
                          isDetailBtnFocused('run') ? 'ring-1 ring-cyan-400/70' : ''
                        }`}
                      >
                        <Play size={10} /> {selected.status === 'failed' ? 'retry' : 'run'}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(selected.id)}
                      className={`p-1 text-text-faint hover:text-red-400 transition-colors rounded ${
                        isDetailBtnFocused('delete') ? 'ring-1 ring-red-400/70 text-red-400' : ''
                      }`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Live progress log */}
                {(() => {
                  const lines = progressLog[selected.id]
                  if (!lines?.length && selected.status !== 'in_progress') return null
                  return (
                    <div>
                      <button
                        onClick={() => setShowProgress((p) => !p)}
                        className="flex items-center gap-1.5 text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 hover:text-text-secondary transition-colors"
                      >
                        {showProgress ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                        Progress {lines?.length ? `(${lines.length})` : ''}
                        {selected.status === 'in_progress' && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse ml-1" />
                        )}
                      </button>
                      {showProgress && (
                        <div className="bg-bg-primary border border-border-secondary rounded-md p-2 max-h-36 overflow-y-auto font-mono text-[10px] leading-relaxed">
                          {lines?.length ? lines.map((l, i) => (
                            <div key={i} className={`flex gap-2 ${l.done ? 'text-green-400' : l.start ? 'text-cyan-400' : 'text-text-muted'}`}>
                              <span className="text-text-faint shrink-0">{l.ts}</span>
                              <span className={l.line.startsWith('Tool:') ? 'text-amber-400/80' : ''}>{l.line}</span>
                            </div>
                          )) : (
                            <div className="text-text-faint">Waiting for progress events...</div>
                          )}
                          <div ref={progressEndRef} />
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Findings summary */}
                {selected.findings_summary && (
                  <div>
                    <h4 className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1">Findings</h4>
                    <div className="text-xs text-text-secondary font-mono bg-bg-inset rounded-md p-3 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                      {selected.findings_summary}
                    </div>
                  </div>
                )}

                {/* Sources */}
                {selected.sources?.length > 0 && (
                  <div>
                    <h4 className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-2">
                      Sources ({selected.sources.length})
                    </h4>
                    <div className="space-y-2">
                      {selected.sources.map((src, i) => (
                        <details key={i} className="border border-border-secondary rounded-md overflow-hidden group">
                          <summary className="flex items-center gap-2 px-3 py-2 bg-bg-elevated hover:bg-bg-hover cursor-pointer text-xs transition-colors">
                            <ChevronRight size={10} className="text-text-faint group-open:rotate-90 transition-transform" />
                            <span className="text-text-primary flex-1 truncate">{src.title || src.url}</span>
                            {src.url && (
                              <a href={src.url} target="_blank" rel="noopener" className="text-text-faint hover:text-accent-primary" onClick={(e) => e.stopPropagation()}>
                                <ExternalLink size={10} />
                              </a>
                            )}
                          </summary>
                          <div className="px-3 py-2 text-[11px] text-text-muted font-mono whitespace-pre-wrap leading-relaxed border-t border-border-secondary max-h-40 overflow-y-auto">
                            {src.content_summary || 'No summary available'}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {!selected.findings_summary && (!selected.sources || selected.sources.length === 0) && (
                  <p className="text-xs text-text-faint">
                    {selected.status === 'in_progress'
                      ? 'Research is running — watch the Progress log above for live updates.'
                      : selected.status === 'failed'
                        ? 'The last run failed. Click retry or check the Progress log above for details.'
                        : 'No findings yet. Click run above to start research.'}
                  </p>
                )}

                {/* Dig Deeper — for completed/failed entries */}
                {(selected.status === 'complete' || selected.status === 'completed') && (
                  <div className="border border-border-secondary rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => handleDigDeeper(selected, e)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded transition-colors"
                      >
                        <ZoomIn size={11} /> Dig Deeper
                      </button>
                      <span className="text-[10px] text-text-faint">Continue research with new angles</span>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary">
                        <input type="checkbox" checked={digDeeperRecent} onChange={(e) => setDigDeeperRecent(e.target.checked)}
                          className="w-3 h-3 rounded border-border-primary accent-amber-500" />
                        <Clock size={9} /> recent only
                      </label>
                      {digDeeperRecent && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-text-faint">last</span>
                          <select value={recencyMonths} onChange={(e) => setRecencyMonths(Number(e.target.value))}
                            className="px-1 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary">
                            <option value={1}>1 month</option>
                            <option value={3}>3 months</option>
                            <option value={6}>6 months</option>
                            <option value={12}>12 months</option>
                          </select>
                        </div>
                      )}
                      <label className="flex items-center gap-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary">
                        <input type="checkbox" checked={crossTemporal} onChange={(e) => setCrossTemporal(e.target.checked)}
                          className="w-3 h-3 rounded border-border-primary accent-amber-500" />
                        <History size={9} /> cross-temporal
                      </label>
                    </div>
                  </div>
                )}

                {/* Send to agent button */}
                <button
                  onClick={handleCopyFindings}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-md transition-colors ${
                    isDetailBtnFocused('copy') ? 'ring-1 ring-cyan-400/70' : ''
                  }`}
                >
                  Copy findings to clipboard
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-text-faint text-xs">
                Select a research entry to view findings and sources
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
