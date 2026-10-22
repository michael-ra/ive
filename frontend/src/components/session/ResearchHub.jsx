import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Plus, Search, Play, Trash2, Send, RefreshCw, History,
  ChevronDown, ChevronRight, ExternalLink, Globe, Tag, ZoomIn,
  Telescope, BookOpen, ToggleLeft, ToggleRight,
  GitBranch, Rocket, Newspaper, Layers, Loader2, Shuffle, Users,
  Copy, Timer, ArrowUpRight, Activity,
} from 'lucide-react'
import { api } from '../../lib/api'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import { researchOutputOptions } from '../../lib/researchContributions'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import FindingCard from '../observatory/FindingCard'
import MonitorView from '../observatory/MonitorView'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MermaidBlock from './MermaidBlock'
import Chip from '../ui/Chip'
import ResearchModePicker from '../research/ResearchModePicker'
import {
  buildResearchQuery,
  researchModeLabel,
  researchScopeForModes,
} from '../../lib/researchModes'
import { Button } from '../ui'

// ── Constants ───────────────────────────────────────────────────────

const ResearchOutputSettings = resolveExtensionPanel('company', 'ResearchOutputSettings')
const ResearchScheduleOutput = resolveExtensionPanel('company', 'ResearchScheduleOutput')
const ResearchActions = resolveExtensionPanel('myelin', 'ResearchActions')

const SOURCE_TABS = [
  { key: 'all', label: 'All', icon: Layers },
  { key: 'github', label: 'GitHub', icon: GitBranch },
  { key: 'producthunt', label: 'PH', icon: Rocket },
  { key: 'hackernews', label: 'HN', icon: Newspaper },
]

const PHASE_ICON = {
  init: '◈', decompose: '◇', search: '⊕', extract: '↓',
  evaluate: '✦', synthesize: '◆', verify: '✓', steer: '→',
}
const PHASE_COLOR = {
  init: 'bg-x-accent', decompose: 'bg-x-accent', search: 'bg-x-accent',
  extract: 'bg-x-accent-ink', evaluate: 'bg-x-accent-ink', synthesize: 'bg-x-good',
  verify: 'bg-x-good', steer: 'bg-x-accent',
}
const PHASE_LABEL = {
  init: 'Init', decompose: 'Decompose', search: 'Search',
  extract: 'Extract', evaluate: 'Evaluate', synthesize: 'Synthesize',
  verify: 'Verify', steer: 'Steered',
}

const statusColor = (s) =>
  s === 'complete' || s === 'completed' ? 'text-x-good' : s === 'in_progress' ? 'text-x-accent-ink' : s === 'failed' ? 'text-x-accent-ink' : 'text-x-faint'

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
  const [scanProgress, setScanProgress] = useState(null) // { done, total } during a scan
  const scanPollRef = useRef(null)

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
  const [newTopic, setNewTopic] = useState('')
  const [researchModes, setResearchModes] = useState(['technical_decision'])
  const [depth, setDepth] = useState('standard')
  const [crossTemporal, setCrossTemporal] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const [recurring, setRecurring] = useState(false)
  const [outputOptions, setOutputOptions] = useState({})
  const [plan, setPlan] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)

  // ── Schedules ─────────────────────────────────────────────
  const [researchScheds, setResearchScheds] = useState([])
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

  // Initial + tab-driven loads
  useEffect(() => { loadEntries(); loadJobs(); loadScheds() }, [activeWorkspaceId, featureFilter])
  useEffect(() => { if (tab === 'feed') loadFindings() }, [tab, loadFindings])

  // Cancel any in-flight scan-poll timer when the panel unmounts so we don't
  // leak setTimeouts (and don't keep refreshing findings against a stale ws).
  useEffect(() => () => {
    if (scanPollRef.current) {
      clearTimeout(scanPollRef.current)
      scanPollRef.current = null
    }
  }, [])

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
      ['cc-research_progress', onProgress],
      ['cc-research_done', onDone],
      ['cc-research_started', onStarted],
    ]
    pairs.forEach(([ev, fn]) => window.addEventListener(ev, fn))
    return () => pairs.forEach(([ev, fn]) => window.removeEventListener(ev, fn))
  }, [activeWorkspaceId, selected?.id])

  // Live-refresh on observatory scan completion (manual + scheduled). The bus
  // emits per-source completed events; useWebSocket.js unwraps the
  // commander_event envelope into cc-observatory_scan_completed. Without this
  // hook, findings from cron-fired scans stayed invisible until a tab bounce.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const onScanCompleted = (e) => {
      if (e?.detail?.workspace_id !== activeWorkspaceId) return
      loadFindings()
    }
    window.addEventListener('cc-observatory_scan_completed', onScanCompleted)
    return () => window.removeEventListener('cc-observatory_scan_completed', onScanCompleted)
  }, [activeWorkspaceId, loadFindings])

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
        workspace_id: activeWorkspaceId,
        scope: entry.scope || 'workspace',
        modes: entry.modes,
        ...await researchOutputOptions({ entry }),
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
      const res = await api.decomposeResearchPlan(buildResearchQuery(newTopic.trim(), researchModes))
      setPlan(res?.plan || { sub_queries: [newTopic], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } catch {
      setPlan({ sub_queries: [newTopic], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } finally { setPlanLoading(false) }
  }

  // Create: launch
  const handleCreate = async () => {
    if (!newTopic.trim()) return
    try {
      const query = buildResearchQuery(newTopic.trim(), researchModes)
      const scope = researchScopeForModes(researchModes)
      const outputFields = await researchOutputOptions({ draft: outputOptions })
      if (recurring) {
        await api.createResearchSchedule({
          workspace_id: activeWorkspaceId,
          context_workspace_id: activeWorkspaceId,
          scope,
          query,
          modes: researchModes,
          depth,
          cross_temporal: crossTemporal,
          ...outputFields,
          interval_hours: newSchedHrs,
          plan: plan || undefined,
        })
        setNewTopic(''); setPlan(null); setRecurring(false); setOutputOptions({})
        setTab('schedules'); loadScheds()
        return
      }
      const created = await api.createResearch({
        workspace_id: scope === 'workspace' ? activeWorkspaceId : undefined,
        scope,
        topic: newTopic.trim(),
        query,
        feature_tag: researchModes[0],
        modes: researchModes,
        ...outputFields,
      })
      if (created?.id) {
        const res = await api.startResearch({
          query, entry_id: created.id, workspace_id: activeWorkspaceId,
          depth, cross_temporal: crossTemporal, interactive,
          scope, modes: researchModes, ...outputFields,
          plan: plan || undefined,
        })
        if (res?.job_id) setActiveJobId(res.job_id)
      }
      setNewTopic(''); setPlan(null); setOutputOptions({}); setTab('active'); loadEntries()
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

  // POST /observatory/scan is fire-and-forget — it returns 200 in ~200ms while
  // the per-source LLM work continues in the background for 30s+. Without
  // polling, the spinner flickers and the user thinks nothing happened. We
  // poll observatory_scans (status='running' → 'completed'/'failed') until all
  // per-source rows for this workspace flip, refreshing findings each tick so
  // they appear progressively.
  const handleScan = async () => {
    if (scanning) return
    setScanning(true)
    setScanProgress(null)
    const startedAt = Date.now()
    let resp
    try {
      resp = await api.triggerObservatorySmartScan({ workspace_id: activeWorkspaceId, source: 'all' })
    } catch {
      setScanning(false)
      return
    }
    const expectedSources = Array.isArray(resp?.sources) ? resp.sources.length : 3
    setScanProgress({ done: 0, total: expectedSources })
    // SQLite datetime('now') format: 'YYYY-MM-DD HH:MM:SS' (UTC). Build a
    // matching string from our trigger time minus a 3s grace window so the
    // INSERT we just caused is on or after this floor.
    const t = new Date(startedAt - 3000)
    const pad = (n) => String(n).padStart(2, '0')
    const sinceIso = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} `
      + `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`

    const tick = async () => {
      try {
        const [allScans] = await Promise.all([
          api.getObservatoryScans(),
          loadFindings(),
        ])
        const mine = (allScans || []).filter(
          (s) => s.workspace_id === activeWorkspaceId && (s.started_at || '') >= sinceIso,
        )
        const running = mine.filter((s) => s.status === 'running').length
        const finished = mine.length - running
        const total = Math.max(mine.length, expectedSources)
        setScanProgress({ done: finished, total })

        const allDone = mine.length > 0 && running === 0
        const timedOut = Date.now() - startedAt > 90_000
        if (allDone || timedOut) {
          setScanning(false)
          setScanProgress(null)
          scanPollRef.current = null
          return
        }
      } catch {
        // Transient failure — keep polling so a single 5xx doesn't strand the
        // spinner forever; the timeout above is the upper bound.
      }
      scanPollRef.current = setTimeout(tick, 2000)
    }
    scanPollRef.current = setTimeout(tick, 1500)
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
    // Prefill the single composer rather than opening a second form.
    setNewTopic(text)
    setTab('new')
    requestAnimationFrame(() => topicRef.current?.focus())
  }

  // Schedules
  const handleToggleSched = async (s) => { await api.updateResearchSchedule(s.id, { enabled: !s.enabled }); loadScheds() }
  const handleCadenceSched = async (s, intervalHours) => { await api.updateResearchSchedule(s.id, { interval_hours: Number(intervalHours) }); loadScheds() }
  const handleDeleteSched = async (id) => { await api.deleteResearchSchedule(id); loadScheds() }

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
    enabled: tab === 'library',
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
    <div className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col m-3 x-panel overflow-hidden" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ──────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-x-line shrink-0">
          <Telescope size={14} className="text-x-accent" />
          <span className="text-xs text-x-ink font-medium">Research</span>
          <span className="text-[11px] text-x-faint">{wsName}</span>
          <span className="text-[11px] text-x-faint/70 ml-2 hidden md:inline">
            Ask a question, steer active investigations, and keep reports for later decisions.
          </span>

          {/* Tabs */}
          <div className="flex items-center gap-0.5 ml-4">
            {[
              { key: 'new', label: 'New', icon: Plus },
              { key: 'active', label: 'Active', badge: runningJobs.length, icon: Activity },
              { key: 'library', label: 'Library', badge: entries.length, icon: BookOpen },
              { key: 'schedules', label: 'Schedules', badge: researchScheds.length, icon: Timer },
            ].map((t) => (
              <Button type="submit" key={t.key} onClick={() => setTab(t.key)}
                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${
                  tab === t.key ? 'bg-x-accent-subtle text-x-accent border border-x-accent/30' : 'text-x-faint hover:text-x-ink-secondary hover:bg-x-hover border border-transparent'
                }`}>
                <t.icon size={10} />
                {t.label}
                {t.badge > 0 && <span className={`ml-0.5 text-[11px] px-1 py-px rounded-full ${tab === t.key ? 'bg-x-accent/20 text-x-accent' : 'bg-x-surface text-x-faint'}`}>{t.badge}</span>}
              </Button>
            ))}
          </div>

          <div className="flex-1" />
          <Button type="submit" onClick={onClose} className="p-1.5 hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors">
            <X size={15} />
          </Button>
        </div>

        {/* ═════ Tab content ═════════════════════════════════ */}
        <div className="flex-1 min-h-0 overflow-hidden">

          {/* ── MONITOR ──────────────────────────────────── */}
          {tab === 'monitor' && (
            <MonitorView
              onOpenFeed={(finding) => {
                setTab('feed')
                if (finding?.source) setSourceFilter(finding.source)
                if (finding?.title) setFeedSearch(finding.title.slice(0, 40))
              }}
            />
          )}

          {/* ── FEED ─────────────────────────────────────── */}
          {tab === 'feed' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-x-line-subtle shrink-0">
                <div className="flex items-center gap-0.5">
                  {SOURCE_TABS.map((st) => {
                    const Icon = st.icon
                    return (
                      <button key={st.key} onClick={() => setSourceFilter(st.key)}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                          sourceFilter === st.key ? 'bg-x-accent/15 text-x-accent border border-x-accent/25' : 'text-x-faint hover:text-x-ink-secondary hover:bg-x-hover border border-transparent'
                        }`}>
                        <Icon size={10} /> {st.label}
                      </button>
                    )
                  })}
                </div>
                <div className="flex-1 relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-x-faint" />
                  <input value={feedSearch} onChange={(e) => setFeedSearch(e.target.value)} placeholder="filter findings..."
                    className="w-full pl-6 pr-2 py-1 text-xs bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary placeholder-x-faint focus:outline-none x-focus-ring font-mono" />
                </div>
                <Button type="submit" onClick={handleScan} disabled={scanning}
                  title={scanning ? 'Scan in progress — sources are being polled. Findings appear as each source completes.' : 'Run all enabled observatory sources now'}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] border transition-colors ${
                    scanning ? 'bg-x-accent/10 text-x-accent border-x-accent/30' : 'text-x-faint hover:text-x-ink-secondary hover:bg-x-hover border-x-line-subtle'
                  }`}>
                  <RefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
                  {scanning
                    ? (scanProgress && scanProgress.total > 0
                        ? `Scanning… ${scanProgress.done}/${scanProgress.total}`
                        : 'Scanning…')
                    : 'Scan Now'}
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {filteredFindings.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-x-faint text-xs gap-2">
                    <Telescope size={24} className={`text-x-faint/30 ${scanning ? 'animate-pulse' : ''}`} />
                    {scanning ? (
                      <div className="text-x-accent">
                        Scanning {scanProgress?.total || 3} source{(scanProgress?.total || 3) > 1 ? 's' : ''}…
                        {scanProgress?.done > 0 && ` (${scanProgress.done} done)`} findings will appear as they're ingested.
                      </div>
                    ) : (
                      <div>No findings yet. Click <span className="text-x-ink-secondary">Scan Now</span> to discover tools and features.</div>
                    )}
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
              <div className="flex items-center gap-4 px-4 py-1.5 border-t border-x-line-subtle shrink-0 text-[11px] text-x-faint font-mono">
                <span>{filteredFindings.length} findings</span>
                <span className="text-x-accent/70">{newCount} new</span>
              </div>
            </div>
          )}

          {/* ── NEW ──────────────────────────────────────── */}
          {tab === 'new' && (
            <div className="h-full overflow-y-auto p-5">
              <div className="max-w-5xl mx-auto space-y-5">
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
                  <section className="rounded-md border border-x-line bg-x-surface overflow-hidden">
                    <div className="px-4 py-3 border-b border-x-line-subtle">
                      <div className="text-sm font-medium text-x-ink">Start research</div>
                      <div className="text-[11px] text-x-faint mt-0.5">
                        Papers, repos, competitors, and technical decisions all end in saved reports.
                      </div>
                    </div>
                    <div className="p-4 space-y-4">
                      <textarea
                        ref={topicRef}
                        value={newTopic}
                        onChange={(e) => setNewTopic(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate()
                        }}
                        placeholder="What should the agent investigate?"
                        className="w-full min-h-[130px] resize-none px-3 py-2 text-sm bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-faint focus:outline-none x-focus-ring"
                        autoFocus
                      />

                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[11px] uppercase tracking-[0.12em] text-x-faint">Research scopes</span>
                          <Chip color={researchScopeForModes(researchModes) === 'company' ? 'amber' : 'neutral'} className="rounded-full">
                            {researchScopeForModes(researchModes) === 'company' ? 'Company' : wsName || 'Workspace'}
                          </Chip>
                        </div>
                        <ResearchModePicker value={researchModes} onChange={setResearchModes} />
                        {researchModes.includes('competitors') && (
                          <p className="text-[11px] text-x-faint mt-2">Competitor and market findings are shared across every workspace.</p>
                        )}
                      </div>

                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-x-faint">Depth:</span>
                          {['quick', 'standard', 'deep'].map((d) => (
                            <button key={d} onClick={() => setDepth(d)}
                              className={`px-2 py-1 text-[11px] rounded transition-colors ${depth === d ? 'bg-x-accent/20 text-x-accent border border-x-accent/30' : 'text-x-faint hover:text-x-ink-secondary border border-transparent'}`}>
                              {d}
                            </button>
                          ))}
                        </div>
                        <label className="flex items-center gap-1 text-[11px] text-x-faint cursor-pointer hover:text-x-ink-secondary">
                          <input type="checkbox" checked={crossTemporal} onChange={(e) => setCrossTemporal(e.target.checked)}
                            className="w-3 h-3 rounded border-x-line accent-x-accent" />
                          cross-temporal
                        </label>
                        <label className="flex items-center gap-1 text-[11px] text-x-faint cursor-pointer hover:text-x-ink-secondary">
                          <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)}
                            className="w-3 h-3 rounded border-x-line accent-warn" />
                          pause for steering
                        </label>
                      </div>

                      <div className="rounded-md border border-x-line-subtle bg-x-bg/50 px-3 py-2.5 space-y-2">
                        <div className="flex flex-wrap items-center gap-4">
                          <label className="flex items-center gap-2 text-xs text-x-ink-secondary cursor-pointer">
                            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)}
                              className="w-3.5 h-3.5 rounded border-x-line accent-x-accent" />
                            Recurring
                          </label>
                          {recurring && (
                            <label className="flex items-center gap-2 text-[11px] text-x-faint">
                              Cadence
                              <select aria-label="Research cadence" value={newSchedHrs} onChange={(e) => setNewSchedHrs(Number(e.target.value))}
                                className="px-2 py-1 text-xs bg-x-surface-2 border border-x-line rounded text-x-ink-secondary">
                                <option value={6}>Every 6 hours</option>
                                <option value={12}>Every 12 hours</option>
                                <option value={24}>Daily</option>
                                <option value={72}>Every 3 days</option>
                                <option value={168}>Weekly</option>
                              </select>
                            </label>
                          )}
                        </div>
                        <ResearchOutputSettings options={outputOptions} onChange={setOutputOptions} />
                      </div>

                      <div className="flex items-center gap-2">
                        <Button type="submit" onClick={handleDecompose} disabled={planLoading || !newTopic.trim()}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/20 transition-colors disabled:opacity-40">
                          {planLoading ? <Loader2 size={12} className="animate-spin" /> : <Shuffle size={12} />}
                          {plan ? 'Re-plan' : 'Decompose'}
                        </Button>
                        <Button type="submit" onClick={handleCreate} disabled={!newTopic.trim()}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border border-x-accent/25 transition-colors disabled:opacity-40">
                          {recurring ? <Timer size={12} /> : <Play size={12} />} {recurring ? 'Create schedule' : 'Launch'}
                        </Button>
                      </div>
                    </div>
                  </section>

                  <aside className="space-y-3">
                    <div className="rounded-md border border-x-line-subtle bg-x-bg/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-x-faint mb-2">Recent reports</div>
                      {entries.slice(0, 5).length === 0 ? (
                        <div className="text-xs text-x-faint py-4">No saved reports yet.</div>
                      ) : entries.slice(0, 5).map((entry) => (
                        <button
                          key={entry.id}
                          onClick={() => { handleSelect(entry); setTab('library') }}
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-x-hover text-xs"
                        >
                          <div className="text-x-ink-secondary truncate">{entry.topic}</div>
                          <div className="text-[11px] text-x-faint">{entry.status}</div>
                        </button>
                      ))}
                    </div>

                    <div className="rounded-md border border-x-line-subtle bg-x-bg/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-x-faint mb-2">Development handoff</div>
                      <div className="space-y-2 text-[11px] text-x-faint">
                        <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-x-accent" /> Reports can become board tasks.</div>
                        <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-x-accent-ink" /> Discovery items can start research.</div>
                        <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-x-good" /> Accepted work can run through pipelines.</div>
                      </div>
                    </div>
                  </aside>
                </div>

                {plan && (
                  <div className="border border-x-line-subtle rounded-md p-3 bg-x-bg space-y-2.5">
                    {[
                      { key: 'sub_queries', label: 'Sub-Queries', icon: Globe, color: 'text-x-accent', ph: 'search query...' },
                      { key: 'reformulations', label: 'Reformulations', icon: Shuffle, color: 'text-x-accent', ph: 'different vocabulary...' },
                      { key: 'cross_domain_queries', label: 'Cross-Domain', icon: Users, color: 'text-x-good', ph: 'analogous concept...' },
                      { key: 'key_entities', label: 'Key Entities', icon: Tag, color: 'text-x-accent-ink', ph: 'person, framework...' },
                    ].map(({ key, label, icon: Icon, color, ph }) => (
                      <div key={key} className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <Icon size={10} className={color} />
                          <span className="text-[11px] font-medium text-x-faint uppercase tracking-wider">{label}</span>
                          <span className="text-[11px] text-x-faint">({(plan[key] || []).length})</span>
                          <button onClick={() => addPlan(key)} className="ml-auto p-0.5 text-x-faint hover:text-x-ink-secondary rounded hover:bg-x-hover"><Plus size={9} /></button>
                        </div>
                        {(plan[key] || []).map((item, idx) => (
                          <div key={idx} className="flex items-center gap-1">
                            <input value={item} onChange={(e) => updatePlan(key, idx, e.target.value)} placeholder={ph}
                              className="flex-1 px-2 py-1 text-[11px] bg-x-surface-2 border border-x-line-subtle rounded text-x-ink placeholder-x-faint focus:outline-none x-focus-ring font-mono" />
                            <button onClick={() => removePlan(key, idx)} className="p-0.5 text-x-faint hover:text-x-accent-ink"><Trash2 size={9} /></button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── SCHEDULES ─────────────────────────────────── */}
          {tab === 'schedules' && (
            <div className="h-full overflow-y-auto p-5">
              <div className="max-w-5xl mx-auto space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-medium text-x-ink">Research schedules</h2>
                    <p className="text-[11px] text-x-faint mt-1">Create recurring work from the New composer; manage existing schedules here.</p>
                  </div>
                  <Button type="submit"
                    onClick={() => { onClose(); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'discovery-setup' }))) }}
                    className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-x-faint hover:text-x-accent border border-x-line-subtle hover:bg-x-hover transition-colors"
                  >
                    <Telescope size={10} /> Observatory configuration
                  </Button>
                </div>

                {researchScheds.length === 0 && (
                  <div className="rounded-md border border-dashed border-x-line p-8 text-center">
                    <Timer size={20} className="mx-auto text-x-faint/40 mb-2" />
                    <p className="text-xs text-x-faint">No scheduled research.</p>
                    <button onClick={() => setTab('new')} className="mt-3 text-xs text-x-accent hover:underline">Create one from the composer</button>
                  </div>
                )}

                {[
                  ['company', 'Company', 'Visible in every workspace'],
                  ['workspace', wsName || 'Workspace', 'Only this workspace'],
                ].map(([scope, label, description]) => {
                  const scoped = researchScheds.filter((schedule) => (schedule.scope || 'workspace') === scope)
                  if (!scoped.length) return null
                  return (
                    <section key={scope} data-schedule-scope={scope}>
                      <div className="flex items-baseline gap-2 mb-2">
                        <h3 className="text-[11px] uppercase tracking-[0.12em] text-x-ink-secondary">{label}</h3>
                        <span className="text-[11px] text-x-faint">{description}</span>
                      </div>
                      <div className="space-y-2">
                        {scoped.map((schedule) => (
                          <div key={schedule.id} className="rounded-md border border-x-line bg-x-surface px-3 py-2.5">
                            <div className="flex items-start gap-3">
                              <button onClick={() => handleToggleSched(schedule)} className="shrink-0 mt-0.5" aria-label={`${schedule.enabled ? 'Disable' : 'Enable'} schedule`}>
                                {schedule.enabled ? <ToggleRight size={16} className="text-x-good" /> : <ToggleLeft size={16} className="text-x-faint" />}
                              </button>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-x-ink whitespace-pre-wrap line-clamp-2">{schedule.query}</div>
                                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                  {(schedule.modes || []).map((mode) => <Chip key={mode} color="neutral" className="rounded-full">{researchModeLabel(mode)}</Chip>)}
                                  <Chip color={scope === 'company' ? 'amber' : 'neutral'} className="rounded-full">{label}</Chip>
                                  <select aria-label="Schedule cadence" value={schedule.interval_hours} onChange={(event) => handleCadenceSched(schedule, event.target.value)}
                                    className="px-1.5 py-0.5 text-[11px] bg-x-surface-2 border border-x-line-subtle rounded text-x-faint">
                                    <option value={6}>every 6h</option><option value={12}>every 12h</option><option value={24}>daily</option>
                                    <option value={72}>every 3 days</option><option value={168}>weekly</option>
                                  </select>
                                  <span className="text-[11px] text-x-faint">{schedule.last_run_at ? `last ${schedule.last_run_at.slice(0, 16)}` : 'never run'}</span>
                                </div>
                                <ResearchScheduleOutput schedule={schedule} onSaved={loadScheds} />
                              </div>
                              <button onClick={() => handleDeleteSched(schedule.id)} aria-label="Delete schedule" className="p-1 text-x-faint hover:text-x-accent-ink rounded hover:bg-x-hover">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── ACTIVE ───────────────────────────────────── */}
          {tab === 'active' && (
            <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4">
              {runningJobs.length === 0 && (
                <div className="flex flex-col items-center justify-center flex-1 text-x-faint text-xs gap-2">
                  <Activity size={24} className="text-x-faint/30" />
                  <div>No research running.</div>
                  <div className="flex items-center gap-2 mt-2">
                    <Button type="submit" onClick={() => { setTab('new'); requestAnimationFrame(() => topicRef.current?.focus()) }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-x-accent/10 hover:bg-x-accent/20 text-x-accent border border-x-accent/20 ">
                      <Plus size={10} /> New Research
                    </Button>
                    <Button type="submit" onClick={() => { onClose(); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'observatory' }))) }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-x-hover hover:bg-x-surface text-x-ink-secondary border border-x-line-subtle ">
                      <Telescope size={10} /> Discovery
                    </Button>
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
                  ? 'border border-x-line-strong rounded-lg bg-x-surface overflow-hidden'
                  : 'border border-x-line rounded-lg bg-x-surface overflow-hidden'
                return (
                  <div key={job.job_id} className={cardCls}>
                    {/* Header */}
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line-subtle">
                      <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${wait ? 'bg-x-accent-ink' : 'bg-x-accent'}`} />
                      <span className="text-xs text-x-ink font-medium flex-1 truncate">{job.query || job.topic || 'Research'}</span>
                      {job.interactive && (
                        <span className="text-[11px] uppercase tracking-wider text-x-accent-ink/80 px-1.5 py-0.5 bg-x-surface-2 rounded border border-x-line font-mono" title="Pauses each round for your review">
                          interactive
                        </span>
                      )}
                      <span className="text-[11px] text-x-faint font-mono">{wait ? 'awaiting you' : job.status}</span>
                    </div>

                    {/* Phase row */}
                    {lastPhase && (
                      <div className="flex items-center gap-2 px-4 py-1.5 bg-x-bg border-b border-x-line-subtle">
                        <div className={`w-1.5 h-1.5 rounded-full ${PHASE_COLOR[lastPhase.phase] || 'bg-x-faint'} animate-pulse`} />
                        <span className="text-[11px] font-medium text-x-ink-secondary">{PHASE_LABEL[lastPhase.phase] || lastPhase.phase}</span>
                        {lastPhase.round && <span className="text-[11px] text-x-faint">Round {lastPhase.round}{lastPhase.total_rounds ? `/${lastPhase.total_rounds}` : ''}</span>}
                        {lastPhase.findings_count != null && <span className="text-[11px] text-x-faint">{lastPhase.findings_count} findings</span>}
                        {lastPhase.elapsed != null && <span className="text-[11px] text-x-faint">{lastPhase.elapsed}s</span>}
                        {lastPhase.confidence != null && (
                          <span className={`text-[11px] font-mono ${lastPhase.confidence >= 0.8 ? 'text-x-good' : lastPhase.confidence >= 0.5 ? 'text-x-accent-ink' : 'text-x-faint'}`}>
                            {Math.round(lastPhase.confidence * 100)}%
                          </span>
                        )}
                      </div>
                    )}

                    {/* Awaiting banner — only when paused */}
                    {wait && (
                      <div className="px-4 py-3 bg-x-surface-2 border-b border-x-line space-y-2">
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-medium text-x-accent-ink">
                            Round {wait.round} done — agent is waiting for you
                          </span>
                          {wait.findings_count != null && (
                            <span className="text-[11px] text-x-faint">{wait.findings_count} findings so far</span>
                          )}
                        </div>
                        <div className="text-[11px] text-x-faint leading-relaxed">
                          Add sub-queries below to steer round {wait.next_round}, or skip to let the agent decide.
                        </div>
                        {Array.isArray(wait.proposed_queries) && wait.proposed_queries.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-[11px] uppercase tracking-wider text-x-faint font-mono">Agent proposes:</div>
                            <ul className="space-y-0.5">
                              {wait.proposed_queries.map((q, i) => (
                                <li key={i} className="text-[11px] text-x-ink-secondary font-mono pl-3 border-l border-x-line">
                                  {q}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          <Button type="submit"
                            onClick={() => handleResume(job.job_id, job.entry_id)}
                            disabled={resumeSending[job.job_id]}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-accent-ink/15 hover:bg-x-accent-ink/25 text-x-accent-ink border border-x-accent-ink/30 transition-colors disabled:opacity-40"
                          >
                            {resumeSending[job.job_id] ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                            {draft.trim() ? `Resume with ${draft.split(/[\n;]/).filter((s) => s.trim()).length} steers` : 'Resume next round'}
                          </Button>
                          <Button type="submit"
                            onClick={() => handleResume(job.job_id, job.entry_id, { skip: true })}
                            disabled={resumeSending[job.job_id]}
                            className="px-2.5 py-1.5 text-[11px] text-x-faint hover:text-x-ink-secondary border border-x-line-subtle hover:border-x-line transition-colors"
                            title="Resume without injecting any steers"
                          >
                            Skip
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Progress log */}
                    <div className="px-4 py-2 max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed bg-x-surface-2">
                      {lines.length ? lines.map((l, i) => (
                        <div key={i} className={`flex gap-2 ${l.done ? 'text-x-good' : l.start ? 'text-x-accent' : 'text-x-muted'}`}>
                          <span className="text-x-faint shrink-0">{l.ts}</span>
                          {l.phase && <span className="text-x-faint shrink-0 w-3 text-center">{PHASE_ICON[l.phase] || '·'}</span>}
                          <span className={l.failed ? 'text-x-accent-ink' : l.line.startsWith('Tool:') ? 'text-x-accent-ink/80' : l.phase === 'steer' ? 'text-x-accent' : l.phase === 'awaiting' ? 'text-x-accent-ink' : ''}>{l.line}</span>
                        </div>
                      )) : <div className="text-x-faint">Waiting for progress...</div>}
                      <div ref={progressEndRef} />
                    </div>

                    {/* Steer / queued chips / textarea */}
                    <div className="px-4 py-2 border-t border-x-line-subtle space-y-1.5">
                      {pending.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[11px] uppercase tracking-wider text-x-faint font-mono py-0.5">
                            {wait ? 'Will inject on resume:' : 'Queued for next round:'}
                          </span>
                          {pending.map((q, i) => (
                            <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] bg-x-surface-2 text-x-ink-secondary border border-x-line rounded font-mono">
                              {q}
                              <button onClick={() => removePending(job.job_id, i)} className="hover:text-x-accent" title="Remove (UI only — already sent)">
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
                          className="flex-1 px-2 py-1 text-[11px] bg-x-surface-2 border border-x-line-subtle rounded text-x-ink placeholder-x-faint focus:outline-none x-focus-ring font-mono resize-none" />
                        {!wait && (
                          <div className="flex flex-col items-stretch gap-1">
                            <button onClick={() => handleSteer(job.job_id)}
                              disabled={steerSending[job.job_id] || !draft.trim()}
                              className="flex items-center justify-center gap-1 px-2 py-1 text-[11px] bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/20 rounded transition-colors disabled:opacity-40">
                              {steerSending[job.job_id] ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />} Steer
                            </button>
                            <span className="text-[11px] text-x-faint font-mono text-center">⌘↵</span>
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
                  <div className="text-[11px] font-medium text-x-faint uppercase tracking-wider mb-1.5">Upcoming</div>
                  {researchScheds.filter((s) => s.enabled).slice(0, 5).map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-2 py-1 text-[11px] text-x-muted font-mono">
                      <Timer size={10} className="text-x-faint" />
                      <span className="truncate flex-1">{s.query}</span>
                      <span className="text-[11px] text-x-faint">{s.next_run_at ? `next: ${s.next_run_at.slice(0, 16)}` : 'pending'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── LIBRARY ──────────────────────────────────── */}
          {tab === 'library' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-x-line-subtle shrink-0">
                <div className="flex-1 relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-x-faint" />
                  <input value={libSearch} onChange={(e) => setLibSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleLibSearch() }}
                    placeholder="Search research reports..."
                    className="w-full pl-6 pr-2 py-1.5 text-xs bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary placeholder-x-faint focus:outline-none x-focus-ring font-mono" />
                </div>
                {featureTags.length > 0 && (
                  <select value={featureFilter} onChange={(e) => setFeatureFilter(e.target.value)}
                    className="px-2 py-1.5 text-xs bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary font-mono">
                    <option value="">all features</option>
                    {featureTags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <button onClick={loadEntries} className="p-1.5 text-x-faint hover:text-x-ink-secondary"><RefreshCw size={12} /></button>
              </div>
              <div className="flex flex-1 min-h-0">
                {/* Entry list */}
                <div ref={listRef} className="w-[320px] border-r border-x-line overflow-y-auto shrink-0 bg-x-surface-2/25">
                  <div className="sticky top-0 z-10 px-3 py-2 border-b border-x-line-subtle bg-x-surface">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-x-faint">Reports</div>
                  </div>
                  {entries.map((entry, idx) => (
                    <div key={entry.id} data-idx={idx} role="button" tabIndex={0}
                      onClick={() => setSelectedIdx(idx)}
                      className={`group w-full text-left px-3 py-2.5 border-b border-x-line-subtle transition-colors cursor-pointer ${
                        selectedIdx === idx ? 'bg-x-accent-subtle ring-1 ring-inset ring-x-accent/40' : 'hover:bg-x-hover'
                      }`}>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[11px] font-medium ${statusColor(entry.status)}`}>
                          {entry.status === 'complete' || entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◉' : entry.status === 'failed' ? '✗' : '○'}
                        </span>
                        <span className="text-xs text-x-ink truncate flex-1">{entry.topic}</span>
                        {entry.status === 'pending' && (
                          <button onClick={(e) => handleRun(entry, e)} className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-x-accent hover:bg-x-accent/20">
                            <Play size={11} />
                          </button>
                        )}
                      </div>
                      {entry.feature_tag && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Tag size={9} className="text-x-faint" />
                          <span className="text-[11px] text-x-faint font-mono">{entry.feature_tag}</span>
                        </div>
                      )}
                      <span className="text-[11px] text-x-faint">{entry.updated_at?.slice(0, 16)}</span>
                    </div>
                  ))}
                  {entries.length === 0 && <div className="p-4 text-xs text-x-faint text-center">No research yet.</div>}
                </div>

                {/* Detail pane */}
                <div className="flex-1 overflow-y-auto p-4">
                  {selected ? (
                    <div className="space-y-4">
                      <div className="rounded-md border border-x-line bg-x-surface p-3 flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm text-x-ink font-medium">{selected.topic}</h3>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[11px] font-medium ${statusColor(selected.status)}`}>{selected.status}</span>
                            {selected.feature_tag && <span className="text-[11px] text-x-faint font-mono bg-x-surface px-1.5 py-0.5 rounded">{selected.feature_tag}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {(selected.status === 'pending' || selected.status === 'failed') && (
                            <button onClick={(e) => handleRun(selected, e)}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-accent/10 hover:bg-x-accent/20 text-x-accent border border-x-accent/20 rounded transition-colors">
                              <Play size={10} /> {selected.status === 'failed' ? 'retry' : 'run'}
                            </button>
                          )}
                          <button onClick={() => handleDelete(selected.id)} className="p-1 text-x-faint hover:text-x-accent-ink rounded">
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
                              className="flex items-center gap-1.5 text-[11px] text-x-faint font-medium uppercase tracking-wider mb-1 hover:text-x-ink-secondary">
                              {showProgress ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                              Progress {lines?.length ? `(${lines.length})` : ''}
                              {selected.status === 'in_progress' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-x-accent-ink animate-pulse ml-1" />}
                            </button>
                            {(() => {
                              const last = [...(lines || [])].reverse().find((l) => l.phase)
                              if (!last) return null
                              return (
                                <div className="flex items-center gap-2 mb-1">
                                  <div className={`w-1.5 h-1.5 rounded-full ${PHASE_COLOR[last.phase] || 'bg-x-faint'} ${selected.status === 'in_progress' ? 'animate-pulse' : ''}`} />
                                  <span className="text-[11px] font-medium text-x-ink-secondary">{PHASE_LABEL[last.phase] || last.phase}</span>
                                  {last.round && <span className="text-[11px] text-x-faint">Round {last.round}{last.total_rounds ? `/${last.total_rounds}` : ''}</span>}
                                  {last.findings_count != null && <span className="text-[11px] text-x-faint">{last.findings_count} findings</span>}
                                  {last.elapsed != null && <span className="text-[11px] text-x-faint">{last.elapsed}s</span>}
                                  {last.confidence != null && (
                                    <span className={`text-[11px] font-mono ${last.confidence >= 0.8 ? 'text-x-good' : last.confidence >= 0.5 ? 'text-x-accent-ink' : 'text-x-faint'}`}>
                                      {Math.round(last.confidence * 100)}%
                                    </span>
                                  )}
                                </div>
                              )
                            })()}
                            {showProgress && (
                              <div className="bg-x-bg border border-x-line-subtle rounded-md p-2 max-h-36 overflow-y-auto font-mono text-[11px] leading-relaxed">
                                {lines?.length ? lines.map((l, i) => (
                                  <div key={i} className={`flex gap-2 ${l.done ? 'text-x-good' : l.start ? 'text-x-accent' : 'text-x-muted'}`}>
                                    <span className="text-x-faint shrink-0">{l.ts}</span>
                                    {l.phase && <span className="text-x-faint shrink-0 w-3 text-center">{PHASE_ICON[l.phase] || '·'}</span>}
                                    <span className={l.failed ? 'text-x-accent-ink' : l.line.startsWith('Tool:') ? 'text-x-accent-ink/80' : l.phase === 'steer' ? 'text-x-accent' : ''}>{l.line}</span>
                                  </div>
                                )) : <div className="text-x-faint">Waiting for progress events...</div>}
                                <div ref={progressEndRef} />
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Findings */}
                      {selected.findings_summary && (
                        <div>
                          <h4 className="text-[11px] text-x-faint font-medium uppercase tracking-wider mb-1">Findings</h4>
                          <div
                            className="text-xs text-x-ink-secondary bg-x-surface-2 rounded-md p-3 leading-relaxed max-h-[50vh] overflow-y-auto prose prose-xs max-w-none [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:text-x-ink [&_h2]:text-x-ink [&_h3]:text-x-ink-secondary [&_p]:text-x-ink-secondary [&_li]:text-x-ink-secondary [&_a]:text-x-accent [&_code]:text-x-accent-ink [&_code]:bg-x-bg [&_code]:px-1 [&_code]:rounded [&_pre]:bg-x-bg [&_pre]:border [&_pre]:border-x-line-subtle [&_pre]:rounded-md [&_table]:text-[11px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_th]:bg-x-surface [&_th]:text-x-ink [&_tr]:border-b [&_tr]:border-x-line-subtle [&_blockquote]:border-l-2 [&_blockquote]:border-x-accent/30 [&_blockquote]:pl-3 [&_blockquote]:text-x-muted"
                            style={{
                              // index.css already re-anchors most .prose colors (code, links,
                              // headings, strong, lists, blockquote, hr, table) to theme tokens —
                              // list marker color is the one thing it doesn't cover, and
                              // `dark:prose-invert` isn't safe here since this app's dark/light
                              // state is a data-theme attribute, not prefers-color-scheme.
                              '--tw-prose-counters': 'var(--x-muted)',
                              '--tw-prose-bullets': 'var(--x-muted)',
                            }}
                          >
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
                          <h4 className="text-[11px] text-x-faint font-medium uppercase tracking-wider mb-2">Sources ({selected.sources.length})</h4>
                          <div className="space-y-1.5">
                            {selected.sources.map((src, i) => (
                              <details key={i} className="border border-x-line-subtle rounded-md overflow-hidden group">
                                <summary className="flex items-center gap-2 px-3 py-1.5 bg-x-surface hover:bg-x-hover cursor-pointer text-xs">
                                  <ChevronRight size={10} className="text-x-faint group-open:rotate-90 transition-transform" />
                                  <span className="text-x-ink flex-1 truncate">{src.title || src.url}</span>
                                  {src.url && <a href={src.url} target="_blank" rel="noopener" className="text-x-faint hover:text-x-accent" onClick={(e) => e.stopPropagation()}><ExternalLink size={10} /></a>}
                                </summary>
                                <div className="px-3 py-2 text-[11px] text-x-muted font-mono whitespace-pre-wrap leading-relaxed border-t border-x-line-subtle max-h-40 overflow-y-auto">
                                  {src.content_summary || 'No summary available'}
                                </div>
                              </details>
                            ))}
                          </div>
                        </div>
                      )}

                      {!selected.findings_summary && (!selected.sources || selected.sources.length === 0) && (
                        <p className="text-xs text-x-faint">
                          {selected.status === 'in_progress' ? 'Research is running — watch the Progress log above.'
                            : selected.status === 'failed' ? 'Last run failed. Click retry above.'
                            : 'No findings yet. Click run above to start research.'}
                        </p>
                      )}

                      {/* Dig deeper */}
                      {(selected.status === 'complete' || selected.status === 'completed') && (
                        <button onClick={(e) => handleRun(selected, e, { depth: 'deep', dig_deeper: true })}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/20 rounded transition-colors">
                          <ZoomIn size={11} /> Dig Deeper
                        </button>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2 border-t border-x-line-subtle">
                        <Button type="submit" onClick={handleCopy}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-x-accent/10 hover:bg-x-accent/20 text-x-accent border border-x-accent/20 transition-colors">
                          <Copy size={10} /> Copy
                        </Button>
                        <ResearchActions entry={selected} workspaceId={activeWorkspaceId} onClose={onClose} />
                        {(selected.status === 'complete' || selected.status === 'completed') && (
                          <Button type="submit" onClick={handlePromoteToBoard}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-x-accent/10 hover:bg-x-accent/20 text-x-accent border border-x-accent/20 transition-colors">
                            <ArrowUpRight size={10} /> Promote to Board
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-x-faint text-xs">
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
