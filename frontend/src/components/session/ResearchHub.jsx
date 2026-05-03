import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Plus, Search, Play, Trash2, Send, RefreshCw, History,
  ChevronDown, ChevronRight, ExternalLink, Globe, Tag, ZoomIn,
  Telescope, BookOpen, ToggleLeft, ToggleRight,
  GitBranch, Rocket, Newspaper, Layers, Loader2, Shuffle, Users,
  Copy, Timer, Settings, ArrowUpRight, Activity,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import FindingCard from '../observatory/FindingCard'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MermaidBlock from './MermaidBlock'

// ── Constants ───────────────────────────────────────────────────────

const SOURCE_TABS = [
  { key: 'all', label: 'All', icon: Layers },
  { key: 'github', label: 'GitHub', icon: GitBranch },
  { key: 'producthunt', label: 'PH', icon: Rocket },
  { key: 'hackernews', label: 'HN', icon: Newspaper },
]

const DEFAULT_OBS = {
  github: { enabled: false, interval_hours: 24, mode: 'both', keywords: '' },
  producthunt: { enabled: false, interval_hours: 24, mode: 'integrate', keywords: '' },
  hackernews: { enabled: false, interval_hours: 12, mode: 'both', keywords: '' },
}

const OBS_META = {
  github: { icon: GitBranch, label: 'GitHub', color: 'text-zinc-400' },
  producthunt: { icon: Rocket, label: 'Product Hunt', color: 'text-orange-400' },
  hackernews: { icon: Newspaper, label: 'Hacker News', color: 'text-amber-400' },
}

const PHASE_ICON = {
  init: '◈', decompose: '◇', search: '⊕', extract: '↓',
  evaluate: '✦', synthesize: '◆', verify: '✓', steer: '→',
}
const PHASE_COLOR = {
  init: 'bg-blue-500', decompose: 'bg-purple-500', search: 'bg-cyan-500',
  extract: 'bg-amber-500', evaluate: 'bg-orange-500', synthesize: 'bg-green-500',
  verify: 'bg-emerald-500', steer: 'bg-pink-500',
}
const PHASE_LABEL = {
  init: 'Init', decompose: 'Decompose', search: 'Search',
  extract: 'Extract', evaluate: 'Evaluate', synthesize: 'Synthesize',
  verify: 'Verify', steer: 'Steered',
}

const statusColor = (s) =>
  s === 'complete' || s === 'completed' ? 'text-green-400' : s === 'in_progress' ? 'text-amber-400' : s === 'failed' ? 'text-red-400' : 'text-text-faint'

// ── Component ───────────────────────────────────────────────────────

export default function ResearchHub({ onClose, initialTab = 'library' }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const wsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name || ''

  const [tab, setTab] = useState(initialTab)

  // ── Shared ────────────────────────────────────────────────
  const [activeJobId, setActiveJobId] = useState(null)
  const [progressLog, setProgressLog] = useState({})

  // ── Feed ──────────────────────────────────────────────────
  const [findings, setFindings] = useState([])
  const [sourceFilter, setSourceFilter] = useState('all')
  const [feedSearch, setFeedSearch] = useState('')
  const [scanning, setScanning] = useState(false)

  // ── Active ────────────────────────────────────────────────
  const [jobs, setJobs] = useState([])
  const [steerInputs, setSteerInputs] = useState({})    // per-job draft text
  const [steerSending, setSteerSending] = useState({})   // per-job send-in-flight
  const [pendingSteers, setPendingSteers] = useState({}) // per-job queued queries
  const [awaiting, setAwaiting] = useState({})          // per-entry-id { round, next_round, total_rounds, findings_count, elapsed }
  const [resumeSending, setResumeSending] = useState({})// per-job resume-in-flight

  // ── Library ───────────────────────────────────────────────
  const [entries, setEntries] = useState([])
  const [selected, setSelected] = useState(null)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [libSearch, setLibSearch] = useState('')
  const [featureFilter, setFeatureFilter] = useState('')
  const [showProgress, setShowProgress] = useState(true)

  // ── Create ────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false)
  const [newTopic, setNewTopic] = useState('')
  const [depth, setDepth] = useState('standard')
  const [crossTemporal, setCrossTemporal] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)

  // ── Schedules ─────────────────────────────────────────────
  const [showSchedules, setShowSchedules] = useState(false)
  const [researchScheds, setResearchScheds] = useState([])
  const [obsSettings, setObsSettings] = useState(DEFAULT_OBS)
  const [obsDirty, setObsDirty] = useState(false)
  const [newSchedQ, setNewSchedQ] = useState('')
  const [newSchedHrs, setNewSchedHrs] = useState(24)

  const listRef = useRef(null)
  const progressEndRef = useRef(null)
  const topicRef = useRef(null)

  // ═══════════════════════════════════════════════════════════
  //  Data loading
  // ═══════════════════════════════════════════════════════════

  const loadEntries = async () => {
    try {
      const data = await api.getResearch(activeWorkspaceId, featureFilter || undefined)
      setEntries(Array.isArray(data) ? data : [])
    } catch { setEntries([]) }
  }

  const loadFindings = useCallback(async () => {
    try {
      const params = {}
      if (activeWorkspaceId) params.workspace_id = activeWorkspaceId
      if (sourceFilter !== 'all') params.source = sourceFilter
      const result = await api.getObservatoryFindings(params)
      setFindings(Array.isArray(result) ? result : result?.findings || [])
    } catch { setFindings([]) }
  }, [activeWorkspaceId, sourceFilter])

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.listResearchJobs()
      const list = Array.isArray(data) ? data : []
      setJobs(list)
      const running = list.find((j) => j.status === 'running')
      if (running && !activeJobId) setActiveJobId(running.job_id)
    } catch { setJobs([]) }
  }, [activeJobId])

  const loadScheds = async () => {
    try {
      const data = await api.getResearchSchedules(activeWorkspaceId)
      setResearchScheds(Array.isArray(data) ? data : [])
    } catch { setResearchScheds([]) }
  }

  const loadObsSettings = async () => {
    if (!activeWorkspaceId) return
    try {
      const res = await api.getObservatorySettings(activeWorkspaceId)
      if (res?.sources) setObsSettings((prev) => ({ ...prev, ...res.sources }))
    } catch {}
  }

  // Initial + tab-driven loads
  useEffect(() => { loadEntries(); loadJobs(); loadScheds() }, [activeWorkspaceId, featureFilter])
  useEffect(() => { if (tab === 'feed') loadFindings() }, [tab, loadFindings])
  useEffect(() => { if (showSchedules) loadObsSettings() }, [showSchedules, activeWorkspaceId])

  // Poll jobs while Active tab is visible
  useEffect(() => {
    if (tab !== 'active') return
    loadJobs()
    const iv = setInterval(loadJobs, 5000)
    return () => clearInterval(iv)
  }, [tab])

  // ═══════════════════════════════════════════════════════════
  //  WebSocket events — research progress / done / started
  // ═══════════════════════════════════════════════════════════

  useEffect(() => {
    const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

    const onProgress = (e) => {
      const d = e.detail || {}
      if (!d.entry_id || !d.line) return
      setProgressLog((prev) => {
        const lines = prev[d.entry_id] || []
        return {
          ...prev,
          [d.entry_id]: [...lines, {
            ts: ts(), line: d.line, job_id: d.job_id, phase: d.phase,
            round: d.round, total_rounds: d.total_rounds, confidence: d.confidence,
            elapsed: d.elapsed, findings_count: d.findings_count,
          }].slice(-200),
        }
      })
      // When the loop reports it consumed steered queries, drain the pending chips
      if (d.phase === 'steer' && d.consumed && d.job_id) {
        setPendingSteers((m) => ({ ...m, [d.job_id]: [] }))
      }
      // Awaiting: agent paused and is waiting for human to resume.
      if (d.phase === 'awaiting' && !d.auto_resumed) {
        setAwaiting((m) => ({
          ...m,
          [d.entry_id]: {
            job_id: d.job_id,
            round: d.round,
            next_round: d.next_round,
            total_rounds: d.total_rounds,
            findings_count: d.findings_count,
            elapsed: d.elapsed,
            proposed_queries: d.proposed_queries || [],
          },
        }))
      }
      // Any non-steer/awaiting phase event after awaiting means the loop resumed.
      else if (d.phase && d.phase !== 'awaiting' && d.phase !== 'steer') {
        setAwaiting((m) => {
          if (!m[d.entry_id]) return m
          const { [d.entry_id]: _, ...rest } = m
          return rest
        })
      }
    }

    const onDone = (e) => {
      loadEntries(); loadJobs()
      const eid = e?.detail?.entry_id
      const status = e?.detail?.status || 'done'
      const err = e?.detail?.error
      if (eid && selected?.id === eid) api.getResearchEntry(eid).then(setSelected).catch(() => {})
      if (eid) {
        const line = err ? `Research ${status}: ${err}` : `Research ${status}`
        setProgressLog((prev) => ({
          ...prev,
          [eid]: [...(prev[eid] || []), { ts: ts(), line, done: true, failed: status === 'failed' }],
        }))
      }
      setActiveJobId(null)
    }

    const onStarted = (e) => {
      const eid = e?.detail?.entry_id
      const jid = e?.detail?.job_id
      if (eid) setProgressLog((prev) => ({ ...prev, [eid]: [{ ts: ts(), line: `Research started (${e?.detail?.backend || 'standalone'})`, start: true }] }))
      if (jid) setActiveJobId(jid)
      loadEntries(); loadJobs()
    }

    const pairs = [
      ['cc-research_progress', onProgress], ['cc-research-progress', onProgress],
      ['cc-research_done', onDone], ['cc-research-done', onDone],
      ['cc-research_started', onStarted], ['cc-research-started', onStarted],
    ]
    pairs.forEach(([ev, fn]) => window.addEventListener(ev, fn))
    return () => pairs.forEach(([ev, fn]) => window.removeEventListener(ev, fn))
  }, [activeWorkspaceId, selected?.id])

  // Auto-scroll progress log
  useEffect(() => { progressEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [progressLog, selected?.id])

  // ═══════════════════════════════════════════════════════════
  //  Handlers
  // ═══════════════════════════════════════════════════════════

  // Library: select
  const handleSelect = async (entry) => {
    try { setSelected(await api.getResearchEntry(entry.id)) } catch { setSelected(entry) }
  }
  useEffect(() => {
    if (selectedIdx < 0 || selectedIdx >= entries.length) return
    const entry = entries[selectedIdx]
    if (entry && selected?.id !== entry.id) handleSelect(entry)
  }, [selectedIdx, entries])

  // Library: run
  const handleRun = async (entry, e, opts = {}) => {
    e?.stopPropagation()
    setEntries((prev) => prev.map((x) => (x.id === entry.id ? { ...x, status: 'in_progress' } : x)))
    if (selected?.id === entry.id) setSelected((s) => ({ ...s, status: 'in_progress' }))
    try {
      const res = await api.startResearch({
        query: entry.query || entry.topic,
        entry_id: entry.id,
        workspace_id: entry.workspace_id || activeWorkspaceId,
        depth: opts.depth || depth,
        cross_temporal: opts.cross_temporal ?? crossTemporal,
        dig_deeper: opts.dig_deeper || false,
      })
      if (res?.job_id) setActiveJobId(res.job_id)
    } catch {
      setEntries((prev) => prev.map((x) => (x.id === entry.id ? { ...x, status: 'pending' } : x)))
      if (selected?.id === entry.id) setSelected((s) => ({ ...s, status: 'pending' }))
    }
  }

  const handleDelete = async (id) => {
    await api.deleteResearch(id)
    if (selected?.id === id) setSelected(null)
    loadEntries()
  }

  const handleCopy = () => {
    if (!selected) return
    navigator.clipboard.writeText(
      [selected.topic, selected.findings_summary, selected.sources?.length ? `Sources:\n${selected.sources.map((s) => `- ${s.title || s.url}`).join('\n')}` : ''].filter(Boolean).join('\n\n'),
    )
  }

  const handlePromoteToBoard = async (opts = {}) => {
    if (!selected || !activeWorkspaceId) return
    try {
      await api.createTask({
        workspace_id: activeWorkspaceId,
        title: `[Research] ${selected.topic}`,
        description: selected.findings_summary || `Research on: ${selected.topic}`,
        status: 'backlog',
        labels: JSON.stringify(['research']),
        ...(opts.force && { force: true }),
      })
      useStore.getState().addNotification({
        type: 'success',
        message: `Promoted "${selected.topic}" to board.`,
      })
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates?.length) {
        const titles = err.body.candidates.slice(0, 3).map((c) => `"${c.title}"`).join(', ')
        useStore.getState().addNotification({
          type: 'warning',
          message: `Possible duplicate: ${titles}. Click promote again to create anyway.`,
          action: {
            label: 'Create anyway',
            onClick: () => handlePromoteToBoard({ force: true }),
          },
        })
      } else {
        useStore.getState().addNotification({
          type: 'error',
          message: `Promote failed: ${err?.message || 'unknown error'}`,
        })
      }
    }
  }

  // Create: decompose
  const handleDecompose = async () => {
    if (!newTopic.trim()) return
    setPlanLoading(true)
    try {
      const res = await api.decomposeResearchPlan(newTopic.trim())
      setPlan(res?.plan || { sub_queries: [newTopic], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } catch {
      setPlan({ sub_queries: [newTopic], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } finally { setPlanLoading(false) }
  }

  // Create: launch
  const handleCreate = async () => {
    if (!newTopic.trim()) return
    try {
      const created = await api.createResearch({ workspace_id: activeWorkspaceId, topic: newTopic.trim() })
      if (created?.id) {
        const res = await api.startResearch({
          query: newTopic.trim(), entry_id: created.id, workspace_id: activeWorkspaceId,
          depth, cross_temporal: crossTemporal, interactive,
          plan: plan || undefined,
        })
        if (res?.job_id) setActiveJobId(res.job_id)
      }
      setNewTopic(''); setPlan(null); setShowCreate(false); setTab('active'); loadEntries()
    } catch (err) { alert(`Failed: ${err?.message || 'unknown'}`) }
  }

  // Feed: research a finding
  const handleResearchFinding = async (finding) => {
    try {
      const created = await api.createResearch({ workspace_id: activeWorkspaceId, topic: finding.title })
      handleFindingStatus(finding, 'accepted')
      if (created?.id) {
        const res = await api.startResearch({ query: finding.title, entry_id: created.id, workspace_id: activeWorkspaceId, depth: 'standard' })
        if (res?.job_id) setActiveJobId(res.job_id)
      }
      setTab('active'); loadEntries()
    } catch (err) { alert(`Failed: ${err?.message || 'unknown'}`) }
  }

  const handlePromoteFinding = async (finding) => {
    if (!activeWorkspaceId) return
    try {
      await api.promoteObservatoryFinding(finding.id, activeWorkspaceId)
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status: 'promoted' } : f)))
    } catch {}
  }

  const handleFindingStatus = async (finding, status) => {
    setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status } : f)))
    try { await api.updateObservatoryFinding(finding.id, { status }) } catch {
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? finding : f)))
    }
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      await api.triggerObservatoryScan({ workspace_id: activeWorkspaceId })
      await loadFindings()
    } catch {} finally { setScanning(false) }
  }

  // Active: steer
  const handleSteer = async (jobId) => {
    if (!jobId) return
    const draft = (steerInputs[jobId] || '').trim()
    if (!draft) return
    const queries = draft.split(/[\n;]/).map((q) => q.trim()).filter(Boolean)
    if (!queries.length) return
    setSteerSending((m) => ({ ...m, [jobId]: true }))
    try {
      await api.steerResearchJob(jobId, queries)
      setSteerInputs((m) => ({ ...m, [jobId]: '' }))
      setPendingSteers((m) => ({ ...m, [jobId]: [...(m[jobId] || []), ...queries] }))
    } catch {}
    finally { setSteerSending((m) => ({ ...m, [jobId]: false })) }
  }
  const removePending = (jobId, idx) => {
    setPendingSteers((m) => ({ ...m, [jobId]: (m[jobId] || []).filter((_, i) => i !== idx) }))
  }

  // Active: resume a paused interactive job
  const handleResume = async (jobId, entryId, opts = {}) => {
    if (!jobId) return
    const draft = (steerInputs[jobId] || '').trim()
    const queries = draft
      ? draft.split(/[\n;]/).map((q) => q.trim()).filter(Boolean)
      : []
    setResumeSending((m) => ({ ...m, [jobId]: true }))
    try {
      await api.resumeResearchJob(jobId, opts.skip ? { skip: true } : { queries })
      if (queries.length) {
        setPendingSteers((m) => ({ ...m, [jobId]: [...(m[jobId] || []), ...queries] }))
      }
      setSteerInputs((m) => ({ ...m, [jobId]: '' }))
      // Optimistically clear awaiting so the UI doesn't lag the next "search" event.
      if (entryId) {
        setAwaiting((m) => {
          if (!m[entryId]) return m
          const { [entryId]: _, ...rest } = m
          return rest
        })
      }
    } catch {}
    finally { setResumeSending((m) => ({ ...m, [jobId]: false })) }
  }

  // Findings: deepen — if a research job is running, offer to steer it;
  // otherwise prefill a new-research draft with the finding as seed.
  const handleDeepenFinding = async (finding) => {
    const text = `Investigate further: ${finding.title}${finding.proposal ? ` — ${String(finding.proposal).slice(0, 200)}` : ''}`
    const running = jobs.find((j) => j.status === 'running')
    if (running) {
      const ok = window.confirm(
        `A research job is currently running ("${(running.query || '').slice(0, 60)}…").\n\n` +
        `OK → inject this as a steer query into that job\n` +
        `Cancel → start a new research instead`,
      )
      if (ok) {
        try {
          await api.steerResearchJob(running.job_id, [text])
          setPendingSteers((m) => ({ ...m, [running.job_id]: [...(m[running.job_id] || []), text] }))
          setTab('active')
        } catch {}
        return
      }
    }
    // Prefill a new research draft. The create form renders above the active
    // tab, so the user stays where they are and just sees the form open.
    setNewTopic(text)
    setShowCreate(true)
    requestAnimationFrame(() => topicRef.current?.focus())
  }

  // Schedules
  const handleCreateSched = async () => {
    if (!newSchedQ.trim()) return
    await api.createResearchSchedule({ workspace_id: activeWorkspaceId, query: newSchedQ.trim(), interval_hours: newSchedHrs })
    setNewSchedQ(''); loadScheds()
  }
  const handleToggleSched = async (s) => { await api.updateResearchSchedule(s.id, { enabled: !s.enabled }); loadScheds() }
  const handleDeleteSched = async (id) => { await api.deleteResearchSchedule(id); loadScheds() }
  const handleSaveObs = async () => {
    if (!activeWorkspaceId) return
    try { await api.updateObservatorySettings({ workspace_id: activeWorkspaceId, sources: obsSettings }); setObsDirty(false) } catch {}
  }
  const updateObs = (src, key, val) => { setObsSettings((prev) => ({ ...prev, [src]: { ...prev[src], [key]: val } })); setObsDirty(true) }

  // Plan editing
  const updatePlan = (key, idx, val) => setPlan((p) => ({ ...p, [key]: p[key].map((v, i) => (i === idx ? val : v)) }))
  const removePlan = (key, idx) => setPlan((p) => ({ ...p, [key]: p[key].filter((_, i) => i !== idx) }))
  const addPlan = (key) => setPlan((p) => ({ ...p, [key]: [...(p[key] || []), ''] }))

  // Library search
  const handleLibSearch = async () => {
    if (!libSearch.trim()) { loadEntries(); return }
    const data = await api.searchResearch(libSearch.trim(), activeWorkspaceId)
    setEntries(Array.isArray(data) ? data : [])
  }

  // ═══════════════════════════════════════════════════════════
  //  Computed
  // ═══════════════════════════════════════════════════════════

  const featureTags = [...new Set(entries.map((e) => e.feature_tag).filter(Boolean))]
  const runningJobs = jobs.filter((j) => j.status === 'running')
  const newCount = findings.filter((f) => f.status === 'new').length
  const filteredFindings = findings.filter((f) => {
    if (sourceFilter !== 'all' && f.source !== sourceFilter) return false
    if (!feedSearch.trim()) return true
    const q = feedSearch.toLowerCase()
    return (f.title || '').toLowerCase().includes(q) || (f.proposal || '').toLowerCase().includes(q)
  })

  // Keyboard navigation for Library list
  useListKeyboardNav({
    enabled: tab === 'library' && !showCreate && !showSchedules,
    itemCount: entries.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const entry = entries[idx]
      if (entry?.status === 'pending' || entry?.status === 'failed') handleRun(entry)
    },
    onDelete: (idx) => { const entry = entries[idx]; if (entry) handleDelete(entry.id) },
  })

  // ═══════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col m-3 bg-bg-primary border border-border-primary rounded-lg shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ──────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-primary shrink-0">
          <Telescope size={14} className="text-cyan-400" />
          <span className="text-xs text-text-primary font-medium">Research</span>
          <span className="text-[10px] text-text-faint">{wsName}</span>

          {/* Tabs */}
          <div className="flex items-center gap-0.5 ml-4">
            {[
              { key: 'feed', label: 'Feed', badge: newCount, icon: Globe },
              { key: 'active', label: 'Active', badge: runningJobs.length, icon: Activity },
              { key: 'library', label: 'Library', badge: entries.length, icon: BookOpen },
            ].map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md transition-colors ${
                  tab === t.key ? 'bg-accent-subtle text-cyan-400 border border-cyan-500/30' : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-transparent'
                }`}>
                <t.icon size={10} />
                {t.label}
                {t.badge > 0 && <span className={`ml-0.5 text-[9px] px-1 py-px rounded-full ${tab === t.key ? 'bg-cyan-500/20 text-cyan-400' : 'bg-bg-tertiary text-text-faint'}`}>{t.badge}</span>}
              </button>
            ))}
          </div>

          <div className="flex-1" />
          <button onClick={() => { setShowCreate(!showCreate); if (!showCreate) requestAnimationFrame(() => topicRef.current?.focus()) }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors">
            <Plus size={11} /> new
          </button>
          <button onClick={() => setShowSchedules(!showSchedules)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${showSchedules ? 'text-amber-400 bg-amber-500/10' : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover'}`}>
            <Timer size={11} /> schedules
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Create form ─────────────────────────────────── */}
        {showCreate && (
          <div className="border-b border-border-secondary bg-bg-elevated px-4 py-3 space-y-2 shrink-0">
            <div className="flex items-center gap-2">
              <input ref={topicRef} value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate(); else if (e.key === 'Enter' && !plan) handleDecompose() }}
                placeholder="Research question..."
                className="flex-1 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" autoFocus />
              <button onClick={handleDecompose} disabled={planLoading || !newTopic.trim()}
                className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-md transition-colors disabled:opacity-40">
                {planLoading ? <Loader2 size={10} className="animate-spin" /> : <Shuffle size={10} />}
                {plan ? 'Re-plan' : 'Decompose'}
              </button>
              <button onClick={handleCreate} disabled={!newTopic.trim()}
                className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 border border-cyan-500/25 rounded-md transition-colors disabled:opacity-40">
                <Play size={10} /> Launch
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-faint">Depth:</span>
                {['quick', 'standard', 'deep'].map((d) => (
                  <button key={d} onClick={() => setDepth(d)}
                    className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${depth === d ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-text-faint hover:text-text-secondary border border-transparent'}`}>
                    {d}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary">
                <input type="checkbox" checked={crossTemporal} onChange={(e) => setCrossTemporal(e.target.checked)}
                  className="w-3 h-3 rounded border-border-primary accent-cyan-500" />
                <History size={9} /> cross-temporal
              </label>
              <label
                className="flex items-center gap-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary"
                title="Pause between rounds so you can review findings and inject sub-queries before the agent continues. CLI-brain mode only."
              >
                <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)}
                  className="w-3 h-3 rounded border-border-primary accent-amber-400" />
                <Activity size={9} /> pause for steering each round
              </label>
            </div>
            {plan && (
              <div className="border border-border-secondary rounded-md p-3 bg-bg-primary space-y-2.5">
                {[
                  { key: 'sub_queries', label: 'Sub-Queries', icon: Globe, color: 'text-cyan-400', ph: 'search query...' },
                  { key: 'reformulations', label: 'Reformulations', icon: Shuffle, color: 'text-purple-400', ph: 'different vocabulary...' },
                  { key: 'cross_domain_queries', label: 'Cross-Domain', icon: Users, color: 'text-green-400', ph: 'analogous concept...' },
                  { key: 'key_entities', label: 'Key Entities', icon: Tag, color: 'text-amber-400', ph: 'person, framework...' },
                ].map(({ key, label, icon: Icon, color, ph }) => (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Icon size={10} className={color} />
                      <span className="text-[10px] font-medium text-text-faint uppercase tracking-wider">{label}</span>
                      <span className="text-[10px] text-text-faint">({(plan[key] || []).length})</span>
                      <button onClick={() => addPlan(key)} className="ml-auto p-0.5 text-text-faint hover:text-text-secondary rounded hover:bg-bg-hover"><Plus size={9} /></button>
                    </div>
                    {(plan[key] || []).map((item, idx) => (
                      <div key={idx} className="flex items-center gap-1">
                        <input value={item} onChange={(e) => updatePlan(key, idx, e.target.value)} placeholder={ph}
                          className="flex-1 px-2 py-1 text-[11px] bg-bg-inset border border-border-secondary rounded text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" />
                        <button onClick={() => removePlan(key, idx)} className="p-0.5 text-text-faint hover:text-red-400"><Trash2 size={9} /></button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Schedules ───────────────────────────────────── */}
        {showSchedules && (
          <div className="border-b border-border-secondary bg-bg-elevated px-4 py-3 space-y-3 shrink-0 max-h-[40vh] overflow-y-auto">
            {/* Research crons */}
            <div>
              <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider mb-2">Recurring Research</div>
              <div className="flex items-center gap-2 mb-2">
                <input value={newSchedQ} onChange={(e) => setNewSchedQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSched() }}
                  placeholder="Research query..."
                  className="flex-1 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" />
                <select value={newSchedHrs} onChange={(e) => setNewSchedHrs(Number(e.target.value))}
                  className="px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded text-text-secondary">
                  <option value={6}>6h</option><option value={12}>12h</option><option value={24}>daily</option>
                  <option value={72}>3 days</option><option value={168}>weekly</option>
                </select>
                <button onClick={handleCreateSched} disabled={!newSchedQ.trim()}
                  className="px-2 py-1.5 text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-md disabled:opacity-40">
                  <Plus size={11} />
                </button>
              </div>
              {researchScheds.length === 0 && <div className="text-[10px] text-text-faint text-center py-1">No scheduled research.</div>}
              {researchScheds.map((s) => (
                <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 bg-bg-primary rounded border border-border-secondary mb-1">
                  <button onClick={() => handleToggleSched(s)} className="shrink-0">
                    {s.enabled ? <ToggleRight size={14} className="text-green-400" /> : <ToggleLeft size={14} className="text-text-faint" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-text-primary truncate font-mono">{s.query}</div>
                    <div className="text-[10px] text-text-faint">every {s.interval_hours}h{s.last_run_at ? ` · last: ${s.last_run_at.slice(0, 16)}` : ' · never run'}</div>
                  </div>
                  <button onClick={() => handleDeleteSched(s.id)} className="p-0.5 text-text-faint hover:text-red-400"><Trash2 size={10} /></button>
                </div>
              ))}
            </div>

            {/* Observatory sources */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider">Observatory Sources</div>
                <div className="flex-1" />
                <button onClick={() => { onClose(); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'api-keys' }))) }}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-amber-400 hover:bg-amber-500/10 rounded transition-colors">
                  <Settings size={9} /> API Keys
                </button>
                {obsDirty && (
                  <button onClick={handleSaveObs} className="px-2 py-0.5 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded hover:bg-cyan-500/20">Save</button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {['github', 'producthunt', 'hackernews'].map((src) => {
                  const cfg = obsSettings[src] || DEFAULT_OBS[src]
                  const meta = OBS_META[src]
                  const SrcIcon = meta.icon
                  return (
                    <div key={src} className="p-2.5 bg-bg-primary border border-border-secondary rounded-md space-y-1.5">
                      <div className="flex items-center gap-1">
                        <SrcIcon size={10} className={meta.color} />
                        <span className="text-[11px] text-text-primary font-medium">{meta.label}</span>
                        <div className="flex-1" />
                        <button onClick={() => updateObs(src, 'enabled', !cfg.enabled)}>
                          {cfg.enabled ? <ToggleRight size={14} className="text-green-400" /> : <ToggleLeft size={14} className="text-text-faint" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input type="number" min={1} max={168} value={cfg.interval_hours}
                          onChange={(e) => updateObs(src, 'interval_hours', parseInt(e.target.value) || 6)}
                          className="w-12 px-1.5 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary font-mono focus:outline-none" />
                        <span className="text-[10px] text-text-faint">hrs</span>
                        <select value={cfg.mode} onChange={(e) => updateObs(src, 'mode', e.target.value)}
                          className="px-1.5 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary focus:outline-none">
                          <option value="integrate">integrate</option><option value="steal">steal</option><option value="both">both</option>
                        </select>
                      </div>
                      <input value={cfg.keywords} onChange={(e) => updateObs(src, 'keywords', e.target.value)}
                        placeholder="keywords"
                        className="w-full px-1.5 py-0.5 text-[10px] bg-bg-inset border border-border-secondary rounded text-text-secondary placeholder-text-faint font-mono focus:outline-none" />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ═════ Tab content ═════════════════════════════════ */}
        <div className="flex-1 min-h-0 overflow-hidden">

          {/* ── FEED ─────────────────────────────────────── */}
          {tab === 'feed' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary shrink-0">
                <div className="flex items-center gap-0.5">
                  {SOURCE_TABS.map((st) => {
                    const Icon = st.icon
                    return (
                      <button key={st.key} onClick={() => setSourceFilter(st.key)}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                          sourceFilter === st.key ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25' : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-transparent'
                        }`}>
                        <Icon size={10} /> {st.label}
                      </button>
                    )
                  })}
                </div>
                <div className="flex-1 relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
                  <input value={feedSearch} onChange={(e) => setFeedSearch(e.target.value)} placeholder="filter findings..."
                    className="w-full pl-6 pr-2 py-1 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" />
                </div>
                <button onClick={handleScan} disabled={scanning}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                    scanning ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover border-border-secondary'
                  }`}>
                  <RefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
                  {scanning ? 'Scanning...' : 'Scan Now'}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {filteredFindings.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-text-faint text-xs gap-2">
                    <Telescope size={24} className="text-text-faint/30" />
                    <div>No findings yet. Click <span className="text-text-secondary">Scan Now</span> to discover tools and features.</div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                    {filteredFindings.map((f) => (
                      <FindingCard key={f.id} finding={f}
                        onPromote={handlePromoteFinding} onStatusChange={handleFindingStatus}
                        onResearch={handleResearchFinding} onDeepen={handleDeepenFinding} />
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-4 px-4 py-1.5 border-t border-border-secondary shrink-0 text-[10px] text-text-faint font-mono">
                <span>{filteredFindings.length} findings</span>
                <span className="text-cyan-400/70">{newCount} new</span>
              </div>
            </div>
          )}

          {/* ── ACTIVE ───────────────────────────────────── */}
          {tab === 'active' && (
            <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4">
              {runningJobs.length === 0 && (
                <div className="flex flex-col items-center justify-center flex-1 text-text-faint text-xs gap-2">
                  <Activity size={24} className="text-text-faint/30" />
                  <div>No research running.</div>
                  <div className="flex items-center gap-2 mt-2">
                    <button onClick={() => { setShowCreate(true); requestAnimationFrame(() => topicRef.current?.focus()) }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-md">
                      <Plus size={10} /> New Research
                    </button>
                    <button onClick={() => setTab('feed')}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-bg-hover hover:bg-bg-tertiary text-text-secondary border border-border-secondary rounded-md">
                      <Telescope size={10} /> Browse Feed
                    </button>
                  </div>
                </div>
              )}
              {runningJobs.map((job) => {
                const lines = progressLog[job.entry_id] || []
                const lastPhase = [...lines].reverse().find((l) => l.phase)
                const pending = pendingSteers[job.job_id] || []
                const draft = steerInputs[job.job_id] || ''
                const wait = awaiting[job.entry_id]
                const cardCls = wait
                  ? 'border border-amber-500/40 ring-1 ring-amber-500/20 rounded-lg bg-bg-elevated overflow-hidden'
                  : 'border border-border-primary rounded-lg bg-bg-elevated overflow-hidden'
                return (
                  <div key={job.job_id} className={cardCls}>
                    {/* Header */}
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-secondary">
                      <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${wait ? 'bg-amber-400' : 'bg-cyan-400'}`} />
                      <span className="text-xs text-text-primary font-medium flex-1 truncate">{job.query || job.topic || 'Research'}</span>
                      {job.interactive && (
                        <span className="text-[9px] uppercase tracking-wider text-amber-400/80 px-1.5 py-0.5 bg-amber-500/8 rounded border border-amber-500/15 font-mono" title="Pauses each round for your review">
                          interactive
                        </span>
                      )}
                      <span className="text-[10px] text-text-faint font-mono">{wait ? 'awaiting you' : job.status}</span>
                    </div>

                    {/* Phase row */}
                    {lastPhase && (
                      <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-primary border-b border-border-secondary">
                        <div className={`w-1.5 h-1.5 rounded-full ${PHASE_COLOR[lastPhase.phase] || 'bg-gray-500'} animate-pulse`} />
                        <span className="text-[10px] font-medium text-text-secondary">{PHASE_LABEL[lastPhase.phase] || lastPhase.phase}</span>
                        {lastPhase.round && <span className="text-[10px] text-text-faint">Round {lastPhase.round}{lastPhase.total_rounds ? `/${lastPhase.total_rounds}` : ''}</span>}
                        {lastPhase.findings_count != null && <span className="text-[10px] text-text-faint">{lastPhase.findings_count} findings</span>}
                        {lastPhase.elapsed != null && <span className="text-[10px] text-text-faint">{lastPhase.elapsed}s</span>}
                        {lastPhase.confidence != null && (
                          <span className={`text-[10px] font-mono ${lastPhase.confidence >= 0.8 ? 'text-green-400' : lastPhase.confidence >= 0.5 ? 'text-amber-400' : 'text-text-faint'}`}>
                            {Math.round(lastPhase.confidence * 100)}%
                          </span>
                        )}
                      </div>
                    )}

                    {/* Awaiting banner — only when paused */}
                    {wait && (
                      <div className="px-4 py-3 bg-amber-500/5 border-b border-amber-500/20 space-y-2">
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-medium text-amber-300">
                            Round {wait.round} done — agent is waiting for you
                          </span>
                          {wait.findings_count != null && (
                            <span className="text-[10px] text-text-faint">{wait.findings_count} findings so far</span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-faint leading-relaxed">
                          Add sub-queries below to steer round {wait.next_round}, or skip to let the agent decide.
                        </div>
                        {Array.isArray(wait.proposed_queries) && wait.proposed_queries.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-[9px] uppercase tracking-wider text-text-faint font-mono">Agent proposes:</div>
                            <ul className="space-y-0.5">
                              {wait.proposed_queries.map((q, i) => (
                                <li key={i} className="text-[10px] text-text-secondary font-mono pl-3 border-l border-amber-500/30">
                                  {q}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => handleResume(job.job_id, job.entry_id)}
                            disabled={resumeSending[job.job_id]}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-amber-500 hover:bg-amber-400 text-zinc-900 rounded-md transition-colors disabled:opacity-40"
                          >
                            {resumeSending[job.job_id] ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                            {draft.trim() ? `Resume with ${draft.split(/[\n;]/).filter((s) => s.trim()).length} steers` : 'Resume next round'}
                          </button>
                          <button
                            onClick={() => handleResume(job.job_id, job.entry_id, { skip: true })}
                            disabled={resumeSending[job.job_id]}
                            className="px-2.5 py-1.5 text-[11px] text-text-faint hover:text-text-secondary border border-border-secondary hover:border-border-primary rounded-md transition-colors"
                            title="Resume without injecting any steers"
                          >
                            Skip
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Progress log */}
                    <div className="px-4 py-2 max-h-32 overflow-y-auto font-mono text-[10px] leading-relaxed bg-bg-inset">
                      {lines.length ? lines.map((l, i) => (
                        <div key={i} className={`flex gap-2 ${l.done ? 'text-green-400' : l.start ? 'text-cyan-400' : 'text-text-muted'}`}>
                          <span className="text-text-faint shrink-0">{l.ts}</span>
                          {l.phase && <span className="text-text-faint shrink-0 w-3 text-center">{PHASE_ICON[l.phase] || '·'}</span>}
                          <span className={l.failed ? 'text-red-400' : l.line.startsWith('Tool:') ? 'text-amber-400/80' : l.phase === 'steer' ? 'text-pink-400' : l.phase === 'awaiting' ? 'text-amber-300' : ''}>{l.line}</span>
                        </div>
                      )) : <div className="text-text-faint">Waiting for progress...</div>}
                      <div ref={progressEndRef} />
                    </div>

                    {/* Steer / queued chips / textarea */}
                    <div className="px-4 py-2 border-t border-border-secondary space-y-1.5">
                      {pending.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[9px] uppercase tracking-wider text-text-faint font-mono py-0.5">
                            {wait ? 'Will inject on resume:' : 'Queued for next round:'}
                          </span>
                          {pending.map((q, i) => (
                            <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-pink-500/10 text-pink-400 border border-pink-500/20 rounded font-mono">
                              {q}
                              <button onClick={() => removePending(job.job_id, i)} className="hover:text-pink-200" title="Remove (UI only — already sent)">
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-start gap-2">
                        <textarea
                          value={draft}
                          onChange={(e) => setSteerInputs((m) => ({ ...m, [job.job_id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault()
                              wait ? handleResume(job.job_id, job.entry_id) : handleSteer(job.job_id)
                            }
                          }}
                          placeholder={wait
                            ? 'Type sub-queries to inject when you resume (one per line)'
                            : 'Inject sub-queries — one per line — picked up next round'}
                          rows={2}
                          className="flex-1 px-2 py-1 text-[11px] bg-bg-inset border border-border-secondary rounded text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none" />
                        {!wait && (
                          <div className="flex flex-col items-stretch gap-1">
                            <button onClick={() => handleSteer(job.job_id)}
                              disabled={steerSending[job.job_id] || !draft.trim()}
                              className="flex items-center justify-center gap-1 px-2 py-1 text-[11px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded transition-colors disabled:opacity-40">
                              {steerSending[job.job_id] ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />} Steer
                            </button>
                            <span className="text-[9px] text-text-faint font-mono text-center">⌘↵</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {/* Upcoming schedules */}
              {researchScheds.filter((s) => s.enabled).length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider mb-1.5">Upcoming</div>
                  {researchScheds.filter((s) => s.enabled).slice(0, 5).map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-2 py-1 text-[11px] text-text-muted font-mono">
                      <Timer size={10} className="text-text-faint" />
                      <span className="truncate flex-1">{s.query}</span>
                      <span className="text-[10px] text-text-faint">{s.next_run_at ? `next: ${s.next_run_at.slice(0, 16)}` : 'pending'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── LIBRARY ──────────────────────────────────── */}
          {tab === 'library' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary shrink-0">
                <div className="flex-1 relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
                  <input value={libSearch} onChange={(e) => setLibSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleLibSearch() }}
                    placeholder="search findings..."
                    className="w-full pl-6 pr-2 py-1.5 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring font-mono" />
                </div>
                {featureTags.length > 0 && (
                  <select value={featureFilter} onChange={(e) => setFeatureFilter(e.target.value)}
                    className="px-2 py-1.5 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary font-mono">
                    <option value="">all features</option>
                    {featureTags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <button onClick={loadEntries} className="p-1.5 text-text-faint hover:text-text-secondary"><RefreshCw size={12} /></button>
              </div>
              <div className="flex flex-1 min-h-0">
                {/* Entry list */}
                <div ref={listRef} className="w-[280px] border-r border-border-primary overflow-y-auto shrink-0">
                  {entries.map((entry, idx) => (
                    <div key={entry.id} data-idx={idx} role="button" tabIndex={0}
                      onClick={() => setSelectedIdx(idx)}
                      className={`group w-full text-left px-3 py-2.5 border-b border-border-secondary transition-colors cursor-pointer ${
                        selectedIdx === idx ? 'bg-accent-subtle ring-1 ring-inset ring-cyan-500/40' : 'hover:bg-bg-hover'
                      }`}>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-medium ${statusColor(entry.status)}`}>
                          {entry.status === 'complete' || entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◉' : entry.status === 'failed' ? '✗' : '○'}
                        </span>
                        <span className="text-xs text-text-primary truncate flex-1">{entry.topic}</span>
                        {entry.status === 'pending' && (
                          <button onClick={(e) => handleRun(entry, e)} className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-cyan-400 hover:bg-cyan-500/20">
                            <Play size={11} />
                          </button>
                        )}
                      </div>
                      {entry.feature_tag && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Tag size={9} className="text-text-faint" />
                          <span className="text-[10px] text-text-faint font-mono">{entry.feature_tag}</span>
                        </div>
                      )}
                      <span className="text-[10px] text-text-faint">{entry.updated_at?.slice(0, 16)}</span>
                    </div>
                  ))}
                  {entries.length === 0 && <div className="p-4 text-xs text-text-faint text-center">No research yet.</div>}
                </div>

                {/* Detail pane */}
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
                            <button onClick={(e) => handleRun(selected, e)}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded transition-colors">
                              <Play size={10} /> {selected.status === 'failed' ? 'retry' : 'run'}
                            </button>
                          )}
                          <button onClick={() => handleDelete(selected.id)} className="p-1 text-text-faint hover:text-red-400 rounded">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Progress log */}
                      {(() => {
                        const lines = progressLog[selected.id]
                        if (!lines?.length && selected.status !== 'in_progress') return null
                        return (
                          <div>
                            <button onClick={() => setShowProgress((p) => !p)}
                              className="flex items-center gap-1.5 text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 hover:text-text-secondary">
                              {showProgress ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                              Progress {lines?.length ? `(${lines.length})` : ''}
                              {selected.status === 'in_progress' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse ml-1" />}
                            </button>
                            {(() => {
                              const last = [...(lines || [])].reverse().find((l) => l.phase)
                              if (!last) return null
                              return (
                                <div className="flex items-center gap-2 mb-1">
                                  <div className={`w-1.5 h-1.5 rounded-full ${PHASE_COLOR[last.phase] || 'bg-gray-500'} ${selected.status === 'in_progress' ? 'animate-pulse' : ''}`} />
                                  <span className="text-[10px] font-medium text-text-secondary">{PHASE_LABEL[last.phase] || last.phase}</span>
                                  {last.round && <span className="text-[10px] text-text-faint">Round {last.round}{last.total_rounds ? `/${last.total_rounds}` : ''}</span>}
                                  {last.findings_count != null && <span className="text-[10px] text-text-faint">{last.findings_count} findings</span>}
                                  {last.elapsed != null && <span className="text-[10px] text-text-faint">{last.elapsed}s</span>}
                                  {last.confidence != null && (
                                    <span className={`text-[10px] font-mono ${last.confidence >= 0.8 ? 'text-green-400' : last.confidence >= 0.5 ? 'text-amber-400' : 'text-text-faint'}`}>
                                      {Math.round(last.confidence * 100)}%
                                    </span>
                                  )}
                                </div>
                              )
                            })()}
                            {showProgress && (
                              <div className="bg-bg-primary border border-border-secondary rounded-md p-2 max-h-36 overflow-y-auto font-mono text-[10px] leading-relaxed">
                                {lines?.length ? lines.map((l, i) => (
                                  <div key={i} className={`flex gap-2 ${l.done ? 'text-green-400' : l.start ? 'text-cyan-400' : 'text-text-muted'}`}>
                                    <span className="text-text-faint shrink-0">{l.ts}</span>
                                    {l.phase && <span className="text-text-faint shrink-0 w-3 text-center">{PHASE_ICON[l.phase] || '·'}</span>}
                                    <span className={l.failed ? 'text-red-400' : l.line.startsWith('Tool:') ? 'text-amber-400/80' : l.phase === 'steer' ? 'text-pink-400' : ''}>{l.line}</span>
                                  </div>
                                )) : <div className="text-text-faint">Waiting for progress events...</div>}
                                <div ref={progressEndRef} />
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Findings */}
                      {selected.findings_summary && (
                        <div>
                          <h4 className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1">Findings</h4>
                          <div className="text-xs text-text-secondary bg-bg-inset rounded-md p-3 leading-relaxed max-h-[50vh] overflow-y-auto prose prose-invert prose-xs max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-secondary [&_p]:text-text-secondary [&_li]:text-text-secondary [&_a]:text-cyan-400 [&_code]:text-amber-400 [&_code]:bg-bg-primary [&_code]:px-1 [&_code]:rounded [&_pre]:bg-bg-primary [&_pre]:border [&_pre]:border-border-secondary [&_pre]:rounded-md [&_table]:text-[11px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_th]:bg-bg-tertiary [&_th]:text-text-primary [&_tr]:border-b [&_tr]:border-border-secondary [&_blockquote]:border-l-2 [&_blockquote]:border-cyan-500/30 [&_blockquote]:pl-3 [&_blockquote]:text-text-muted">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}
                              components={{
                                code({ className, children, ...props }) {
                                  const match = /language-(\w+)/.exec(className || '')
                                  if (match?.[1] === 'mermaid') return <MermaidBlock code={String(children).trim()} />
                                  if (!className) return <code {...props}>{children}</code>
                                  return <pre className={className}><code>{children}</code></pre>
                                },
                                pre({ children }) {
                                  const child = Array.isArray(children) ? children[0] : children
                                  if (child?.type === MermaidBlock) return child
                                  if (child?.props?.className?.includes('language-mermaid')) return child
                                  return <pre>{children}</pre>
                                },
                              }}>
                              {selected.findings_summary}
                            </ReactMarkdown>
                          </div>
                        </div>
                      )}

                      {/* Sources */}
                      {selected.sources?.length > 0 && (
                        <div>
                          <h4 className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-2">Sources ({selected.sources.length})</h4>
                          <div className="space-y-1.5">
                            {selected.sources.map((src, i) => (
                              <details key={i} className="border border-border-secondary rounded-md overflow-hidden group">
                                <summary className="flex items-center gap-2 px-3 py-1.5 bg-bg-elevated hover:bg-bg-hover cursor-pointer text-xs">
                                  <ChevronRight size={10} className="text-text-faint group-open:rotate-90 transition-transform" />
                                  <span className="text-text-primary flex-1 truncate">{src.title || src.url}</span>
                                  {src.url && <a href={src.url} target="_blank" rel="noopener" className="text-text-faint hover:text-accent-primary" onClick={(e) => e.stopPropagation()}><ExternalLink size={10} /></a>}
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
                          {selected.status === 'in_progress' ? 'Research is running — watch the Progress log above.'
                            : selected.status === 'failed' ? 'Last run failed. Click retry above.'
                            : 'No findings yet. Click run above to start research.'}
                        </p>
                      )}

                      {/* Dig deeper */}
                      {(selected.status === 'complete' || selected.status === 'completed') && (
                        <button onClick={(e) => handleRun(selected, e, { depth: 'deep', dig_deeper: true })}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded transition-colors">
                          <ZoomIn size={11} /> Dig Deeper
                        </button>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2 border-t border-border-secondary">
                        <button onClick={handleCopy}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-md transition-colors">
                          <Copy size={10} /> Copy
                        </button>
                        {(selected.status === 'complete' || selected.status === 'completed') && (
                          <button onClick={handlePromoteToBoard}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-md transition-colors">
                            <ArrowUpRight size={10} /> Promote to Board
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-text-faint text-xs">
                      Select a research entry to view findings and sources
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
