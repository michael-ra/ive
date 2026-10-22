import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Telescope, Inbox, Lightbulb, Activity, Settings, Search, RefreshCw,
  Loader2, ExternalLink, BookOpen, Kanban, GitBranch, Trash2,
  CheckCircle2, Play, ArrowRight, Rocket, Newspaper, MessageCircle,
  Hash, Wrench, Star, Map, Save, Plus, Pause, Pencil,
} from 'lucide-react'
import { api } from '../../lib/api'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import { publishDiscoveryEvent } from '../../lib/discoveryContributions'
import useStore from '../../state/store'
import Chip from '../ui/Chip'
import ChipInput from '../ui/ChipInput'
import { Button, Modal } from '../ui'
import ResearchModePicker from '../research/ResearchModePicker'
import { buildResearchQuery, researchScopeForModes } from '../../lib/researchModes'
import { createDiscoveryReader } from '../../lib/discoveryReads'

const DiscoveryKnowledgeAction = resolveExtensionPanel('myelin', 'DiscoveryKnowledgeAction')

const SOURCES = ['all', 'github', 'reddit', 'hackernews', 'producthunt', 'x']
const DISCOVERY_SOURCES = ['github', 'reddit', 'hackernews', 'producthunt', 'x']
const PROFILE_SECTIONS = [
  ['identity', 'Identity'],
  ['interests', 'Interests'],
  ['current_stack', 'Current stack'],
  ['competitors', 'Competitors'],
  ['audience', 'Audience'],
  ['tone', 'Tone'],
  ['dismissal_patterns', 'Dismissal patterns'],
]
const TARGET_TYPES_BY_SOURCE = {
  github: ['topic', 'search_query'],
  reddit: ['subreddit', 'search_query'],
  hackernews: ['search_query'],
  producthunt: ['category', 'topic', 'search_query'],
  x: ['hashtag', 'user', 'search_query'],
}
const SETUP_SOURCE_DEFAULTS = {
  github: { enabled: false, interval_hours: 24, mode: 'both', keywords: '' },
  reddit: { enabled: false, interval_hours: 12, mode: 'both', keywords: '' },
  hackernews: { enabled: false, interval_hours: 12, mode: 'both', keywords: '' },
  producthunt: { enabled: false, interval_hours: 24, mode: 'both', keywords: '' },
  x: { enabled: false, interval_hours: 24, mode: 'both', keywords: '' },
}

const SOURCE_META = {
  all: { label: 'All', icon: Telescope, color: 'text-x-accent' },
  github: { label: 'GitHub', icon: GitBranch, color: 'text-x-ink-secondary' },
  reddit: { label: 'Reddit', icon: MessageCircle, color: 'text-x-accent-ink' },
  hackernews: { label: 'HN', icon: Newspaper, color: 'text-x-accent-ink' },
  producthunt: { label: 'Product Hunt', icon: Rocket, color: 'text-x-accent-ink' },
  x: { label: 'X', icon: Hash, color: 'text-x-ink-secondary' },
}

const INTENT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'add_tool', label: 'Add tool' },
  { key: 'adopt_pattern', label: 'Adopt pattern' },
  { key: 'competitor', label: 'Competitor' },
  { key: 'voice', label: 'User signal' },
  { key: 'needs_research', label: 'Needs research' },
]

const BACKEND_STATUS_FILTERS = new Set(['new', 'accepted', 'promoted', 'dismissed', 'reviewed'])

function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeFinding(row) {
  return {
    ...row,
    tags: parseJson(row.tags, []),
    steal_targets: parseJson(row.steal_targets, []),
    metadata: parseJson(row.metadata, {}),
    voice: parseJson(row.voice, {}),
  }
}

function scoreTone(score = 0) {
  if (score >= 0.7) return 'text-x-good bg-x-good/10 border-x-good/25'
  if (score >= 0.4) return 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/25'
  return 'text-x-muted bg-x-hover border-x-line'
}

function intentForFinding(finding) {
  const tags = finding.tags || []
  if (finding.category === 'competitor' || finding.verdict === 'competitor_track') return 'competitor'
  if (finding.verdict === 'voice_only' || tags.includes('voice')) return 'voice'
  if (finding.category === 'steal') return 'adopt_pattern'
  if (finding.category === 'integrate') return 'add_tool'
  return 'needs_research'
}

function intentLabel(intent) {
  return {
    add_tool: 'Add tool',
    adopt_pattern: 'Adopt pattern',
    competitor: 'Track competitor',
    voice: 'User signal',
    needs_research: 'Needs research',
  }[intent] || 'Review'
}

function recommendationFor(finding) {
  const intent = intentForFinding(finding)
  if (intent === 'add_tool') return 'Evaluate as an integration candidate.'
  if (intent === 'adopt_pattern') return 'Decide whether to adopt this product pattern.'
  if (intent === 'competitor') return 'Compare against the current roadmap.'
  if (intent === 'voice') return 'Turn the user signal into a product decision.'
  return 'Research before committing work.'
}

function buildFindingResearchQuery(finding) {
  const parts = [
    `Investigate this discovery for the current workspace: ${finding.title}`,
    finding.source_url ? `Source: ${finding.source_url}` : '',
    finding.description ? `Source description: ${finding.description}` : '',
    finding.proposal ? `Existing recommendation: ${finding.proposal}` : '',
    finding.triage_reason ? `Triage reason: ${finding.triage_reason}` : '',
    'Return a decision-oriented report with evidence, risks, alternatives, and concrete next work for this codebase.',
  ].filter(Boolean)
  return parts.join('\n\n')
}

function formatDate(value) {
  if (!value) return 'never'
  const d = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  return d.toLocaleString()
}

function SourceIcon({ source, className = 'w-3 h-3' }) {
  const meta = SOURCE_META[source] || SOURCE_META.all
  const Icon = meta.icon
  return <Icon className={`${className} ${meta.color}`} />
}

function savedStorageKey(workspaceId) {
  return `ive.discovery.saved.${workspaceId || '__global__'}`
}

function itemKey(type, id) {
  return `${type}:${id}`
}

export default function DiscoveryHub({
  onClose,
  initialTab = 'inbox',
  onOpenResearch,
  onOpenBoard,
  onOpenPipelines,
  onOpenKnowledge,
  onOpenApiKeys,
}) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const workspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name || ''

  const [tab, setTab] = useState(initialTab)
  const [findings, setFindings] = useState([])
  const [insights, setInsights] = useState([])
  const [scans, setScans] = useState([])
  const [sourceFilter, setSourceFilter] = useState('all')
  const [intentFilter, setIntentFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('new')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [scanRunning, setScanRunning] = useState(null)
  const [scanLog, setScanLog] = useState([])
  const [manualQuery, setManualQuery] = useState('')
  const [manualModes, setManualModes] = useState(['technical_decision'])
  const [manualDepth, setManualDepth] = useState('standard')
  const [savedState, setSavedState] = useState({ favorites: [], roadmap: [] })
  const [profile, setProfile] = useState(null)
  const [profileDraft, setProfileDraft] = useState({})
  const [companyProfile, setCompanyProfile] = useState(null)
  const [companyProfileDraft, setCompanyProfileDraft] = useState({})
  const [editingProfile, setEditingProfile] = useState(null)
  const [profileBuilding, setProfileBuilding] = useState(false)
  const [targets, setTargets] = useState([])
  const [targetSource, setTargetSource] = useState('github')
  const [targetForm, setTargetForm] = useState({ scope: 'company', source: 'github', target_type: 'topic', values: [], rationale: '' })
  const [planningSource, setPlanningSource] = useState(null)
  const [sourcesConfig, setSourcesConfig] = useState(SETUP_SOURCE_DEFAULTS)
  const [sourcesDirty, setSourcesDirty] = useState(false)
  const [sourcesSaving, setSourcesSaving] = useState(false)
  const [loadState, setLoadState] = useState({})
  const panelRef = useRef(null)
  const reader = useRef(null)
  if (!reader.current) reader.current = createDiscoveryReader((key, state) => setLoadState((previous) => ({ ...previous, [key]: state })))

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const previous = document.activeElement
    panel.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [!!activeWorkspaceId])

  useEffect(() => {
    reader.current.invalidate()
    setLoadState({})
    setFindings([])
    setInsights([])
    setScans([])
    setProfile(null)
    setCompanyProfile(null)
    setTargets([])
    setScanRunning(null)
    setScanLog([])
    return () => reader.current.invalidate()
  }, [activeWorkspaceId])

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    if (!activeWorkspaceId) return
    try {
      const raw = localStorage.getItem(savedStorageKey(activeWorkspaceId))
      const parsed = raw ? JSON.parse(raw) : null
      setSavedState({
        favorites: Array.isArray(parsed?.favorites) ? parsed.favorites : [],
        roadmap: Array.isArray(parsed?.roadmap) ? parsed.roadmap : [],
      })
    } catch {
      setSavedState({ favorites: [], roadmap: [] })
    }
  }, [activeWorkspaceId])

  const notify = (type, message, action) => {
    useStore.getState().addNotification({ type, message, ...(action ? { action } : {}) })
  }

  const renderOutputActions = (type, item) => (
    <DiscoveryKnowledgeAction
      type={type} item={item} workspaceId={activeWorkspaceId}
      recommendation={type === 'finding' ? recommendationFor(item) : ''}
      busyId={busyId} onBusyChange={setBusyId} notify={notify}
      onOpen={onOpenKnowledge} ActionButton={ActionButton}
    />
  )

  const persistSavedState = (updater) => {
    setSavedState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      localStorage.setItem(savedStorageKey(activeWorkspaceId), JSON.stringify(next))
      return next
    })
  }

  const isFavorited = (type, id) => savedState.favorites.includes(itemKey(type, id))
  const isRoadmapped = (type, id) => savedState.roadmap.includes(itemKey(type, id))

  const toggleFavorite = (type, item) => {
    const key = itemKey(type, item.id)
    persistSavedState((prev) => {
      const exists = prev.favorites.includes(key)
      return {
        ...prev,
        favorites: exists ? prev.favorites.filter((x) => x !== key) : [...prev.favorites, key],
      }
    })
  }

  const addSavedRoadmap = async (type, item) => {
    const key = itemKey(type, item.id)
    if (!activeWorkspaceId || isRoadmapped(type, item.id) || item.status === 'roadmap') return
    const busyKey = type === 'insight' ? `insight:${item.id}:roadmap` : `${item.id}:roadmap`
    setBusyId(busyKey)
    persistSavedState((prev) => ({
      ...prev,
      roadmap: prev.roadmap.includes(key) ? prev.roadmap : [...prev.roadmap, key],
    }))
    if (type === 'finding') {
      try {
        await api.updateObservatoryFinding(item.id, { status: 'roadmap' })
        setFindings((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'roadmap' } : f)))
      } catch {}
    }
    try {
      const outputs = await publishDiscoveryEvent('roadmapSaved', {
        type, item, workspaceId: activeWorkspaceId,
        recommendation: type === 'finding' ? recommendationFor(item) : '',
        notify, onOpen: onOpenKnowledge,
      })
      if (!outputs) notify('success', 'Added to local roadmap.')
    } catch (err) {
      notify('warning', `Roadmap flag saved locally; optional output failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusyId(null)
    }
  }

  const loadFindings = useCallback(async () => {
    if (!activeWorkspaceId) return
    return reader.current.run('inbox', async () => {
      const params = { workspace_id: activeWorkspaceId }
      if (sourceFilter !== 'all') params.source = sourceFilter
      if (BACKEND_STATUS_FILTERS.has(statusFilter)) params.status = statusFilter
      const rows = await api.getObservatoryFindings(params)
      const findings = Array.isArray(rows) ? rows : rows?.findings
      if (!Array.isArray(findings)) throw new Error('Discovery returned an invalid findings response.')
      return findings.map(normalizeFinding)
    }, setFindings)
  }, [activeWorkspaceId, sourceFilter, statusFilter])

  const loadInsights = useCallback(async () => {
    if (!activeWorkspaceId) return
    return reader.current.run('insights', async () => {
      const rows = await api.listObservatoryInsights(activeWorkspaceId)
      const insights = Array.isArray(rows) ? rows : rows?.insights
      if (!Array.isArray(insights)) throw new Error('Discovery returned an invalid insights response.')
      return insights
    }, setInsights)
  }, [activeWorkspaceId])

  const loadScans = useCallback(async () => {
    if (!activeWorkspaceId) return
    return reader.current.run('runs', async () => {
      const rows = await api.getObservatoryScans()
      if (!Array.isArray(rows)) throw new Error('Discovery returned an invalid scan history response.')
      return rows.filter((s) => s.workspace_id === activeWorkspaceId).slice(0, 30)
    }, setScans)
  }, [activeWorkspaceId])

  const loadSetup = useCallback(async () => {
    if (!activeWorkspaceId) return
    return reader.current.run('setup', () => Promise.all([
      api.getObservatoryProfile(activeWorkspaceId),
      api.getObservatoryProfile(null, 'company'),
      api.listObservatorySearchTargets({ workspace_id: activeWorkspaceId }),
      api.getObservatorySettings(activeWorkspaceId),
    ]), ([profileRow, companyProfileRow, targetRows, sourceRows]) => {
      const targets = Array.isArray(targetRows) ? targetRows : targetRows?.targets
      if (!Array.isArray(targets) || !sourceRows?.sources || typeof sourceRows.sources !== 'object') throw new Error('Discovery returned incomplete setup data. Retry before editing settings.')
      setProfile(profileRow || null)
      setProfileDraft((profileRow && profileRow.profile) || {})
      setCompanyProfile(companyProfileRow || null)
      setCompanyProfileDraft((companyProfileRow && companyProfileRow.profile) || {})
      setTargets(targets)
      setSourcesConfig({ ...SETUP_SOURCE_DEFAULTS, ...(sourceRows?.sources || {}) })
      setSourcesDirty(false)
    })
  }, [activeWorkspaceId])

  useEffect(() => { loadFindings() }, [loadFindings])
  useEffect(() => { loadInsights(); loadScans() }, [loadInsights, loadScans])
  useEffect(() => { if (tab === 'setup') loadSetup() }, [tab, loadSetup])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const onStarted = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      setScanRunning(d.source || 'all')
      setScanLog((prev) => [{ ts: Date.now(), text: `Started ${d.source || 'scan'}` }, ...prev].slice(0, 20))
      loadScans()
    }
    const onProgress = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      let text = d.phase || 'progress'
      if (d.phase === 'scrape_target') text = `Scraped ${d.target || d.source || 'target'} (${d.items_found || 0})`
      if (d.phase === 'triage') text = `Triaging ${d.new_items || 0} new items`
      if (d.phase === 'analyze') text = `Analyzing ${d.to_analyze || 0} candidates`
      setScanLog((prev) => [{ ts: Date.now(), text }, ...prev].slice(0, 20))
    }
    const onCompleted = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      setScanRunning((current) => (current && current !== 'all' ? null : current))
      setScanLog((prev) => [{
        ts: Date.now(),
        text: `Completed ${d.source || 'scan'} with ${d.findings_count || 0} new items`,
      }, ...prev].slice(0, 20))
      loadFindings()
      loadInsights()
      loadScans()
    }
    const onFinding = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      loadFindings()
      loadInsights()
    }
    window.addEventListener('cc-observatory_scan_started', onStarted)
    window.addEventListener('cc-observatory_scan_progress', onProgress)
    window.addEventListener('cc-observatory_scan_completed', onCompleted)
    window.addEventListener('cc-observatory_finding_created', onFinding)
    return () => {
      window.removeEventListener('cc-observatory_scan_started', onStarted)
      window.removeEventListener('cc-observatory_scan_progress', onProgress)
      window.removeEventListener('cc-observatory_scan_completed', onCompleted)
      window.removeEventListener('cc-observatory_finding_created', onFinding)
    }
  }, [activeWorkspaceId, loadFindings, loadInsights, loadScans])

  const filteredFindings = useMemo(() => {
    const q = search.trim().toLowerCase()
    return findings.filter((finding) => {
      const intent = intentForFinding(finding)
      if (intentFilter !== 'all' && intent !== intentFilter) return false
      if (statusFilter === 'saved' && !isFavorited('finding', finding.id)) return false
      if (statusFilter === 'roadmap' && finding.status !== 'roadmap' && !isRoadmapped('finding', finding.id)) return false
      if (!q) return true
      return [
        finding.title,
        finding.description,
        finding.proposal,
        finding.triage_reason,
        ...(finding.tags || []),
      ].filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [findings, intentFilter, search, statusFilter, savedState])

  const counts = useMemo(() => {
    const all = findings.length
    const high = findings.filter((f) => (f.relevance_score || 0) >= 0.7).length
    const research = findings.filter((f) => intentForFinding(f) === 'needs_research' || f.verdict === 'analyze').length
    return { all, high, research, insights: insights.length }
  }, [findings, insights])

  const runScan = async (source = 'all') => {
    if (!activeWorkspaceId || scanRunning) return
    setScanRunning(source)
    setScanLog([{ ts: Date.now(), text: `Queued ${source === 'all' ? 'all sources' : source}` }])
    try {
      const result = await api.triggerObservatorySmartScan({
        workspace_id: activeWorkspaceId,
        source,
        wait: true,
      })
      const created = (result?.results || []).reduce((sum, r) => sum + (r.findings_created || 0), 0)
      notify('success', `Discovery scan complete: ${created} new item${created === 1 ? '' : 's'}.`)
      loadFindings()
      loadInsights()
      loadScans()
    } catch (err) {
      notify('error', `Discovery scan failed: ${err?.message || 'unknown error'}`)
    } finally {
      setScanRunning(null)
    }
  }

  const updateFindingStatus = async (finding, status) => {
    setBusyId(`${finding.id}:${status}`)
    try {
      await api.updateObservatoryFinding(finding.id, { status })
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status } : f)))
    } catch (err) {
      notify('error', `Update failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusyId(null)
    }
  }

  const researchFinding = async (finding) => {
    if (!activeWorkspaceId) return
    setBusyId(`${finding.id}:research`)
    try {
      const query = buildFindingResearchQuery(finding)
      const created = await api.createResearch({
        workspace_id: activeWorkspaceId,
        topic: finding.title,
        query,
        feature_tag: 'discovery',
      })
      if (created?.id) {
        await api.startResearch({
          query,
          entry_id: created.id,
          workspace_id: activeWorkspaceId,
          depth: 'standard',
          feature_tag: 'discovery',
        })
      }
      await api.updateObservatoryFinding(finding.id, { status: 'accepted' })
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status: 'accepted' } : f)))
      notify('success', 'Research started from discovery.', {
        label: 'Open research',
        onClick: () => onOpenResearch?.('active'),
      })
    } catch (err) {
      notify('error', `Research start failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusyId(null)
    }
  }

  const promoteFinding = async (finding) => {
    if (!activeWorkspaceId) return
    setBusyId(`${finding.id}:task`)
    try {
      await api.promoteObservatoryFinding(finding.id, activeWorkspaceId)
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status: 'promoted' } : f)))
      notify('success', 'Created board task from discovery.', {
        label: 'Open board',
        onClick: () => onOpenBoard?.(),
      })
    } catch (err) {
      notify('error', `Task creation failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusyId(null)
    }
  }

  const createPipelineTask = async (finding, opts = {}) => {
    if (!activeWorkspaceId) return
    setBusyId(`${finding.id}:pipeline`)
    const intent = intentForFinding(finding)
    try {
      await api.createTask({
        workspace_id: activeWorkspaceId,
        title: `[Discovery] ${intentLabel(intent)}: ${finding.title}`.slice(0, 200),
        description: [
          `## Discovery Decision`,
          `Source: ${finding.source}${finding.source_url ? ` - ${finding.source_url}` : ''}`,
          `Intent: ${intentLabel(intent)}`,
          `Score: ${Math.round((finding.relevance_score || 0) * 100)}%`,
          '',
          finding.proposal || recommendationFor(finding),
          finding.description ? `\n## Source Detail\n${finding.description}` : '',
        ].filter(Boolean).join('\n'),
        status: 'backlog',
        labels: ['discovery', 'pipeline', finding.source, intent],
        pipeline: 1,
        plan_first: true,
        deep_research: true,
        force: opts.force,
      })
      await api.updateObservatoryFinding(finding.id, { status: 'promoted' })
      setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, status: 'promoted' } : f)))
      notify('success', 'Created a pipeline-backed board task.', {
        label: 'Open pipelines',
        onClick: () => onOpenPipelines?.(),
      })
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates?.length) {
        notify('warning', 'A similar task already exists.', {
          label: 'Create anyway',
          onClick: () => createPipelineTask(finding, { force: true }),
        })
      } else {
        notify('error', `Pipeline task failed: ${err?.message || 'unknown error'}`)
      }
    } finally {
      setBusyId(null)
    }
  }

  const createInsightTask = async (insight, opts = {}) => {
    setBusyId(`insight:${insight.id}:task`)
    try {
      await api.createTask({
        workspace_id: activeWorkspaceId,
        title: `[Discovery insight] ${insight.name}`.slice(0, 200),
        description: [
          `## Discovery Insight`,
          `Type: ${(insight.insight_type || '').replace('_', ' ')}`,
          '',
          insight.summary,
          Array.isArray(insight.evidence_findings) && insight.evidence_findings.length
            ? `\n## Evidence\n${insight.evidence_findings.slice(0, 5).map((f) => `- ${f.title}${f.source_url ? ` (${f.source_url})` : ''}`).join('\n')}`
            : '',
        ].filter(Boolean).join('\n'),
        status: 'backlog',
        labels: ['discovery', 'insight', insight.insight_type].filter(Boolean),
        force: opts.force,
      })
      notify('success', 'Created board task from insight.', {
        label: 'Open board',
        onClick: () => onOpenBoard?.(),
      })
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates?.length) {
        notify('warning', 'A similar task already exists.', {
          label: 'Create anyway',
          onClick: () => createInsightTask(insight, { force: true }),
        })
      } else {
        notify('error', `Task creation failed: ${err?.message || 'unknown error'}`)
      }
    } finally {
      setBusyId(null)
    }
  }

  const startManualResearch = async () => {
    const queryText = manualQuery.trim()
    if (!activeWorkspaceId || !queryText) return
    setBusyId('manual-research')
    try {
      const query = buildResearchQuery(queryText, manualModes)
      const scope = researchScopeForModes(manualModes)
      const created = await api.createResearch({
        workspace_id: scope === 'workspace' ? activeWorkspaceId : undefined,
        scope,
        topic: queryText,
        query,
        feature_tag: manualModes[0],
        modes: manualModes,
      })
      if (created?.id) {
        await api.startResearch({
          query,
          entry_id: created.id,
          workspace_id: activeWorkspaceId,
          depth: manualDepth,
          scope,
          modes: manualModes,
        })
      }
      setManualQuery('')
      notify('success', 'Research started.', {
        label: 'Open research',
        onClick: () => onOpenResearch?.('active'),
      })
    } catch (err) {
      notify('error', `Research start failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusyId(null)
    }
  }

  const buildProfile = async () => {
    if (!activeWorkspaceId || profileBuilding) return
    setProfileBuilding(true)
    try {
      const row = await api.regenerateObservatoryProfile(activeWorkspaceId)
      setProfile(row || null)
      setProfileDraft((row && row.profile) || {})
      notify('success', 'Discovery profile rebuilt.')
    } catch (err) {
      notify('error', `Profile build failed: ${err?.message || 'unknown error'}`)
    } finally {
      setProfileBuilding(false)
    }
  }

  const saveProfileSection = async (scope, section) => {
    try {
      const isCompany = scope === 'company'
      const draft = isCompany ? companyProfileDraft : profileDraft
      const next = { ...draft, [section]: draft[section] || '' }
      const row = await api.updateObservatoryProfile(activeWorkspaceId, next, scope)
      if (isCompany) {
        setCompanyProfile(row || null)
        setCompanyProfileDraft((row && row.profile) || next)
      } else {
        setProfile(row || null)
        setProfileDraft((row && row.profile) || next)
      }
      setEditingProfile(null)
      notify('success', 'Discovery profile updated.')
    } catch (err) {
      notify('error', `Profile save failed: ${err?.message || 'unknown error'}`)
    }
  }

  const saveSources = async () => {
    setSourcesSaving(true)
    try {
      await api.updateObservatorySettings({ workspace_id: activeWorkspaceId, sources: sourcesConfig })
      setSourcesDirty(false)
      notify('success', 'Discovery schedule saved.')
    } catch (err) {
      notify('error', `Schedule save failed: ${err?.message || 'unknown error'}`)
    } finally {
      setSourcesSaving(false)
    }
  }

  const updateSourceConfig = (source, key, value) => {
    setSourcesConfig((prev) => ({
      ...prev,
      [source]: { ...(prev[source] || SETUP_SOURCE_DEFAULTS[source]), [key]: value },
    }))
    setSourcesDirty(true)
  }

  const planTargets = async (source) => {
    setPlanningSource(source)
    try {
      await api.planObservatorySearchTargets(activeWorkspaceId, source, targetForm.scope)
      const rows = await api.listObservatorySearchTargets({ workspace_id: activeWorkspaceId })
      setTargets(Array.isArray(rows) ? rows : rows?.targets || [])
      notify('success', `Planned ${SOURCE_META[source]?.label || source} targets.`)
    } catch (err) {
      notify('error', `Target planning failed: ${err?.message || 'unknown error'}`)
    } finally {
      setPlanningSource(null)
    }
  }

  const addTarget = async () => {
    if (!targetForm.values.length) return
    try {
      await Promise.all(targetForm.values.map((value) => api.addObservatorySearchTarget({
        workspace_id: activeWorkspaceId,
        scope: targetForm.scope,
        source: targetForm.source,
        target_type: targetForm.target_type,
        value,
        rationale: targetForm.rationale,
      })))
      setTargetForm((prev) => ({ ...prev, values: [], rationale: '' }))
      const rows = await api.listObservatorySearchTargets({ workspace_id: activeWorkspaceId })
      setTargets(Array.isArray(rows) ? rows : rows?.targets || [])
    } catch (err) {
      notify('error', `Target add failed: ${err?.message || 'unknown error'}`)
    }
  }

  const toggleTarget = async (target) => {
    try {
      const status = target.status === 'active' ? 'paused' : 'active'
      await api.updateObservatorySearchTarget(target.id, { status })
      setTargets((prev) => prev.map((t) => (t.id === target.id ? { ...t, status } : t)))
    } catch (err) {
      notify('error', `Target update failed: ${err?.message || 'unknown error'}`)
    }
  }

  if (!activeWorkspaceId) {
    return (
      <Modal title="Choose a project for Discovery" subtitle="Discovery collects useful external sources for one project." icon={Telescope} onClose={onClose} size="sm">
        <div className="space-y-4 p-5 text-sm text-x-ink-secondary">
          <p>Select a project in the sidebar or connect a local project folder. Then set up the topics and sources to watch.</p>
          <Button onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('open-add-workspace')) }}>Find a project</Button>
        </div>
      </Modal>
    )
  }

  const currentRead = loadState[tab]
  const retryRead = { inbox: loadFindings, insights: loadInsights, runs: loadScans, setup: loadSetup }[tab]
  const readLabel = { inbox: 'findings', insights: 'insights', runs: 'scan history', setup: 'settings' }[tab]
  const hasFilters = sourceFilter !== 'all' || intentFilter !== 'all' || statusFilter !== 'all' || !!search.trim()

  return (
    <div className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col" onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="discovery-title" className="flex-1 flex flex-col m-4 md:m-6 xl:m-8 x-panel overflow-hidden outline-none" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
        if (event.key !== 'Tab') return
        const elements = [...panelRef.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((element) => element.getClientRects().length)
        const first = elements[0], last = elements.at(-1)
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first.focus() }
      }}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-3.5 border-b border-x-line/80 bg-x-surface/20 shrink-0">
          <Telescope className="w-4 h-4 text-x-accent" />
          <div className="min-w-0">
            <div id="discovery-title" className="text-xs font-semibold text-x-ink">Discovery</div>
            <div className="text-[11px] text-x-faint truncate font-mono">{workspaceName}</div>
          </div>

          <div className="hidden lg:flex items-center gap-1 ml-4 text-[11px] text-x-faint">
            <span className="px-2 py-0.5 rounded-md bg-x-surface-2 border border-x-line-subtle/60">Discover</span>
            <ArrowRight className="w-3 h-3" />
            <span className="px-2 py-0.5 rounded-md bg-x-surface-2 border border-x-line-subtle/60">Research</span>
            <ArrowRight className="w-3 h-3" />
            <span className="px-2 py-0.5 rounded-md bg-x-surface-2 border border-x-line-subtle/60">Build</span>
          </div>

          <div className="flex max-w-full items-center gap-1.5 overflow-x-auto sm:ml-4" role="group" aria-label="Discovery sections">
            {[
              { key: 'inbox', label: 'Inbox', icon: Inbox, badge: counts.all },
              { key: 'insights', label: 'Insights', icon: Lightbulb, badge: counts.insights },
              { key: 'runs', label: 'Runs', icon: Activity },
              { key: 'setup', label: 'Setup', icon: Settings },
            ].map((item) => {
              const Icon = item.icon
              const isSelected = tab === item.key
              return (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  aria-pressed={isSelected}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded-md border transition-all duration-200 ${
                    isSelected
                      ? 'bg-x-accent/15 text-x-accent border-x-accent/25 shadow-x-1'
                      : 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover/40 border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                  {item.badge > 0 && (
                    <span className={`ml-1 text-[11px] px-1.5 py-px rounded-md font-sans ${
                      isSelected
                        ? 'bg-x-accent/20 text-x-accent border border-x-accent/20'
                        : 'bg-x-surface border border-x-line-subtle text-x-muted'
                    }`}>
                      {item.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex-1" />
          <button
            onClick={() => runScan('all')}
            disabled={!!scanRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-md border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/18 disabled:opacity-50 transition-colors"
          >
            {scanRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {scanRunning ? 'Scanning' : 'Scan'}
          </button>
          <button onClick={onClose} aria-label="Close Discovery" className="p-1 rounded-md hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors ml-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {currentRead?.loading && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-x-line px-5 py-3 text-xs text-x-muted"><Loader2 size={14} className="animate-spin" />Loading {readLabel}…</div>}
        {currentRead?.error && <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-x-line bg-x-surface-2 px-5 py-3 text-sm"><div><strong className="text-x-danger">Could not load {readLabel}.</strong><p className="mt-1 text-xs text-x-muted">{currentRead.error} Any previously loaded results remain below.</p></div><Button size="sm" onClick={retryRead}>Retry</Button></div>}

        {scanRunning && (
          <div className="shrink-0 border-b border-x-accent/20 bg-x-accent/8 px-5 py-2.5">
            <div className="flex items-center gap-2 text-[11px] text-x-accent">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Smart scan running{scanRunning !== 'all' ? `: ${scanRunning}` : ''}</span>
              {scanLog[0] && <span className="text-x-accent/60">- {scanLog[0].text}</span>}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === 'inbox' && (
            <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] h-full min-h-0 bg-x-surface-2/5">
              <aside className="border-r border-x-line-subtle/60 bg-x-surface-2/20 p-5 overflow-y-auto">
                <div className="space-y-4">
                  <div className="rounded-xl border border-x-line-subtle bg-x-surface/20 p-4 shadow-x-1">
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2">Ask research</div>
                    <textarea
                      value={manualQuery}
                      onChange={(e) => setManualQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startManualResearch()
                      }}
                      placeholder="Question, paper topic, repo space, competitor..."
                      className="w-full min-h-[74px] resize-none bg-x-surface-2/40 border border-x-line/80 rounded-lg px-2.5 py-2 text-xs text-x-ink placeholder-x-faint focus:outline-none x-focus-ring focus:border-x-accent/60 transition-colors font-mono"
                    />
                    <div className="mt-2">
                      <ResearchModePicker value={manualModes} onChange={setManualModes} compact />
                      <div className="mt-1 text-[11px] text-x-faint">
                        {researchScopeForModes(manualModes) === 'company' ? 'Company scope' : `${workspaceName} scope`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <select
                        value={manualDepth}
                        onChange={(e) => setManualDepth(e.target.value)}
                        className="flex-1 bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/40 cursor-pointer transition-colors"
                      >
                        <option value="quick">quick</option>
                        <option value="standard">standard</option>
                        <option value="deep">deep</option>
                      </select>
                      <button
                        onClick={startManualResearch}
                        disabled={!manualQuery.trim() || busyId === 'manual-research'}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-x-accent/15 text-x-accent border border-x-accent/25 hover:bg-x-accent/25 disabled:opacity-40 transition-colors"
                      >
                        {busyId === 'manual-research' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Start
                      </button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-x-line-subtle bg-x-surface/15 p-4 shadow-x-1">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Metric label="New" value={counts.all} />
                      <Metric label="High signal" value={counts.high} />
                      <Metric label="Research" value={counts.research} />
                      <Metric label="Insights" value={counts.insights} />
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2">Source</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {SOURCES.map((source) => {
                        const meta = SOURCE_META[source] || SOURCE_META.all
                        const Icon = meta.icon
                        return (
                          <button
                            key={source}
                            onClick={() => setSourceFilter(source)}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-lg border transition-all duration-200 ${
                              sourceFilter === source
                                ? 'border-x-accent/30 text-x-accent bg-x-accent/10 shadow-x-1'
                                : 'border-x-line-subtle text-x-muted hover:text-x-ink-secondary hover:bg-x-hover/30'
                            }`}
                          >
                            <Icon className={`w-3 h-3 ${meta.color}`} />
                            {meta.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2">Decision</div>
                    <div className="space-y-1.5">
                      {INTENT_FILTERS.map((item) => (
                        <button
                          key={item.key}
                          onClick={() => setIntentFilter(item.key)}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] rounded-lg border transition-all duration-200 ${
                            intentFilter === item.key
                              ? 'border-x-accent/30 text-x-accent bg-x-accent/10 shadow-x-1'
                              : 'border-x-line-subtle text-x-muted hover:text-x-ink-secondary hover:bg-x-hover/30'
                          }`}
                        >
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2">State</div>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/45 cursor-pointer transition-colors"
                    >
                      <option value="new">New</option>
                      <option value="saved">Favorites</option>
                      <option value="roadmap">Roadmap</option>
                      <option value="reviewed">Reviewed</option>
                      <option value="accepted">In research</option>
                      <option value="promoted">Promoted</option>
                      <option value="dismissed">Dismissed</option>
                      <option value="all">All states</option>
                    </select>
                  </div>
                </div>
              </aside>

              <main className="flex flex-col min-h-0">
                <div className="shrink-0 flex items-center gap-3 px-5 py-2.5 border-b border-x-line-subtle/60 bg-x-surface/5">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-x-faint" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter discovery inbox..."
                      className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-x-ink placeholder-x-faint focus:outline-none x-focus-ring focus:border-x-accent/40 transition-colors"
                    />
                  </div>
                  <button
                    onClick={() => loadFindings()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg text-x-muted hover:text-x-ink-secondary hover:bg-x-hover border border-x-line-subtle transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5">
                  {filteredFindings.length === 0 ? (!currentRead?.loading && !currentRead?.error && (
                    <div className="h-full flex flex-col items-center justify-center text-xs text-x-faint gap-3 py-12">
                      <Inbox className="w-10 h-10 text-x-faint/30" />
                      <strong className="text-sm text-x-ink-secondary">{hasFilters ? 'No findings match these filters.' : 'Your discovery inbox is ready for its first sources.'}</strong>
                      <p className="max-w-md text-center leading-relaxed">Set up your project profile and sources, then scan for relevant tools, ideas and evidence. Review findings before turning them into work.</p>
                      <div className="mt-2 flex flex-wrap justify-center gap-2">
                        {hasFilters && <Button size="sm" onClick={() => { setSourceFilter('all'); setIntentFilter('all'); setStatusFilter('all'); setSearch('') }}>Clear filters</Button>}
                        <Button size="sm" icon={Settings} onClick={() => setTab('setup')}>Set up sources</Button>
                        <Button size="sm" icon={RefreshCw} onClick={() => runScan('all')} disabled={!!scanRunning}>Scan now</Button>
                      </div>
                    </div>
                  )) : (
                    <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                      {filteredFindings.map((finding) => (
                        <DecisionCard
                          key={finding.id}
                          finding={finding}
                          busyId={busyId}
                          onResearch={researchFinding}
                          onPromote={promoteFinding}
                          onPipeline={createPipelineTask}
                          extraActions={renderOutputActions('finding', finding)}
                          onDismiss={(f) => updateFindingStatus(f, 'dismissed')}
                          onReviewed={(f) => updateFindingStatus(f, 'reviewed')}
                          onFavorite={(f) => toggleFavorite('finding', f)}
                          onRoadmap={(f) => addSavedRoadmap('finding', f)}
                          favorited={isFavorited('finding', finding.id)}
                          roadmapped={isRoadmapped('finding', finding.id) || finding.status === 'roadmap'}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </main>
            </div>
          )}

          {tab === 'insights' && (
            <div className="h-full overflow-y-auto p-5 bg-x-surface-2/5">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-6xl mx-auto">
                {insights.length === 0 ? (!currentRead?.loading && !currentRead?.error && (
                  <div className="col-span-full flex flex-col items-center justify-center py-20 text-xs text-x-faint gap-3 border border-dashed border-x-line-subtle rounded-xl bg-x-surface/10">
                    <Lightbulb className="w-10 h-10 text-x-faint/30" />
                    <div>No durable insights yet.</div>
                    <p className="max-w-md px-4 text-center leading-relaxed">Insights capture conclusions from discovered sources. Start by reviewing findings in the Inbox.</p>
                    <Button size="sm" onClick={() => setTab('inbox')}>Open discovery inbox</Button>
                  </div>
                )) : ['company', 'workspace'].map((scope) => {
                  const scoped = insights.filter((insight) => (insight.scope || 'workspace') === scope)
                  if (!scoped.length) return null
                  return (
                    <section key={scope} className="col-span-full" data-insight-scope={scope}>
                      <div className="flex items-baseline gap-2 mb-2">
                        <h2 className="text-[11px] uppercase tracking-[0.12em] text-x-ink-secondary">{scope === 'company' ? 'Company' : workspaceName}</h2>
                        <span className="text-[11px] text-x-faint">{scope === 'company' ? 'Shared across workspaces' : 'Workspace insights'}</span>
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {scoped.map((insight) => (
                          <InsightCard
                            key={insight.id}
                            insight={insight}
                            busyId={busyId}
                            favorited={isFavorited('insight', insight.id)}
                            roadmapped={isRoadmapped('insight', insight.id)}
                            onFavorite={(i) => toggleFavorite('insight', i)}
                            onRoadmap={(i) => addSavedRoadmap('insight', i)}
                            extraActions={renderOutputActions('insight', insight)}
                            onTask={createInsightTask}
                            onOpenSource={(finding) => {
                              setTab('inbox')
                              setStatusFilter('all')
                              setSearch(finding?.title || insight.name || '')
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <div className="h-full overflow-y-auto p-5 bg-x-surface-2/5">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 max-w-6xl mx-auto">
                <div className="rounded-xl border border-x-line-subtle/65 bg-x-surface/15 overflow-hidden shadow-x-1">
                  <div className="grid grid-cols-[120px_100px_100px_1fr] px-4 py-2.5 bg-x-surface-2/40 text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint border-b border-x-line-subtle/70">
                    <div>Source</div>
                    <div>Status</div>
                    <div>Items</div>
                    <div>Time</div>
                  </div>
                  {scans.length === 0 ? (!currentRead?.loading && !currentRead?.error && (
                    <div className="py-14 text-center text-xs text-x-faint font-mono">No scan history for this workspace.</div>
                  )) : scans.map((scan) => (
                    <div key={scan.id} className="grid grid-cols-[120px_100px_100px_1fr] items-center px-4 py-2.5 text-xs border-b border-x-line-subtle/40 last:border-b-0 hover:bg-x-hover/30 transition-colors duration-150">
                      <div className="flex items-center gap-2 text-x-ink-secondary">
                        <SourceIcon source={scan.source} />
                        <span className="capitalize truncate font-mono">{scan.source}</span>
                      </div>
                      <div>
                        <span className={`px-2 py-0.5 rounded-lg border text-[11px] font-semibold font-mono ${
                          scan.status === 'completed'
                            ? 'text-x-good border-x-good/20 bg-x-good/8'
                            : scan.status === 'failed'
                              ? 'text-x-accent-ink border-x-accent-ink/20 bg-x-accent-ink/8'
                              : 'text-x-accent-ink border-x-accent-ink/20 bg-x-accent-ink/8'
                        }`}>
                          {scan.status}
                        </span>
                      </div>
                      <div className="text-x-faint tabular-nums font-mono">{scan.findings_count || 0}</div>
                      <div className="text-x-faint text-[11px] truncate font-mono">
                        {formatDate(scan.started_at)}
                        {scan.completed_at ? ` -> ${formatDate(scan.completed_at)}` : ''}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border border-x-line-subtle bg-x-surface/20 p-4 shadow-x-1">
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2.5">Run source</div>
                    <div className="grid grid-cols-2 gap-2">
                      {SOURCES.map((source) => (
                        <button
                          key={source}
                          onClick={() => runScan(source)}
                          disabled={!!scanRunning}
                          className="flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-lg border border-x-line-subtle hover:border-x-accent/30 hover:bg-x-hover/30 text-xs text-x-ink-secondary disabled:opacity-50 transition-all duration-200"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            <SourceIcon source={source} />
                            <span className="truncate text-[11px]">{SOURCE_META[source]?.label || source}</span>
                          </span>
                          <RefreshCw className="w-3 h-3 text-x-faint" />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-x-line-subtle bg-x-surface/20 p-4 shadow-x-1">
                    <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2.5">Live log</div>
                    {scanLog.length === 0 ? (
                      <div className="text-xs text-x-faint py-6 text-center font-mono">No live scan events.</div>
                    ) : (
                      <div className="space-y-1.5 max-h-72 overflow-y-auto font-mono">
                        {scanLog.map((item, idx) => (
                          <div key={`${item.ts}-${idx}`} className="flex items-start gap-2 text-[11px]">
                            <span className="text-x-faint tabular-nums shrink-0">
                              {new Date(item.ts).toLocaleTimeString().slice(0, 8)}
                            </span>
                            <span className="text-x-ink-secondary/90 leading-normal">{item.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'setup' && currentRead && !currentRead.loading && !currentRead.error && (
            <DiscoverySetup
              profile={profile}
              profileDraft={profileDraft}
              companyProfile={companyProfile}
              companyProfileDraft={companyProfileDraft}
              editingProfile={editingProfile}
              profileBuilding={profileBuilding}
              sourcesConfig={sourcesConfig}
              sourcesDirty={sourcesDirty}
              sourcesSaving={sourcesSaving}
              targets={targets}
              targetSource={targetSource}
              targetForm={targetForm}
              planningSource={planningSource}
              onBuildProfile={buildProfile}
              onEditProfile={setEditingProfile}
              onProfileDraftChange={setProfileDraft}
              onCompanyProfileDraftChange={setCompanyProfileDraft}
              onSaveProfileSection={saveProfileSection}
              onUpdateSource={updateSourceConfig}
              onSaveSources={saveSources}
              onOpenApiKeys={onOpenApiKeys}
              onPlanTargets={planTargets}
              onTargetSourceChange={setTargetSource}
              onTargetFormChange={setTargetForm}
              onAddTarget={addTarget}
              onToggleTarget={toggleTarget}
              onRunScan={runScan}
              scanRunning={scanRunning}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function DiscoverySetup({
  profile,
  profileDraft,
  companyProfile,
  companyProfileDraft,
  editingProfile,
  profileBuilding,
  sourcesConfig,
  sourcesDirty,
  sourcesSaving,
  targets,
  targetSource,
  targetForm,
  planningSource,
  onBuildProfile,
  onEditProfile,
  onProfileDraftChange,
  onCompanyProfileDraftChange,
  onSaveProfileSection,
  onUpdateSource,
  onSaveSources,
  onOpenApiKeys,
  onPlanTargets,
  onTargetSourceChange,
  onTargetFormChange,
  onAddTarget,
  onToggleTarget,
  onRunScan,
  scanRunning,
}) {
  const activeTargets = targets.filter((t) => t.status === 'active').length
  const enabledSources = DISCOVERY_SOURCES.filter((source) => sourcesConfig[source]?.enabled).length
  const targetTypes = TARGET_TYPES_BY_SOURCE[targetForm.source] || ['search_query']
  const visibleTargets = targets.filter((target) => targetSource === 'all' || target.source === targetSource)

  return (
    <div className="h-full overflow-y-auto p-5 bg-x-surface-2/5">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SetupMetric label="Profile" value={profile?.generated_at ? 'Ready' : 'Missing'} detail={profile?.generated_at ? formatDate(profile.generated_at) : 'Build before serious scans'} />
          <SetupMetric label="Sources" value={`${enabledSources}/${DISCOVERY_SOURCES.length}`} detail="enabled for recurring scans" />
          <SetupMetric label="Targets" value={activeTargets} detail={`${targets.length} configured total`} />
        </div>

        <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden shadow-x-1">
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-x-line-subtle">
            <div>
              <div className="text-sm font-semibold text-x-ink">Profile</div>
              <div className="text-[11px] text-x-faint">The brief used to rank signals, plan targets, and avoid stale recommendations.</div>
            </div>
            <div className="flex-1" />
            <button
              onClick={onBuildProfile}
              disabled={profileBuilding}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors"
            >
              {profileBuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {profile?.generated_at ? 'Rebuild' : 'Build profile'}
            </button>
          </div>
          {[
            { scope: 'company', label: 'Company', detail: 'Shared context for every workspace', draft: companyProfileDraft, setDraft: onCompanyProfileDraftChange },
            { scope: 'workspace', label: 'Workspace', detail: 'Context specific to this codebase', draft: profileDraft, setDraft: onProfileDraftChange },
          ].map(({ scope, label, detail, draft, setDraft }) => (
            <div key={scope} data-profile-scope={scope} className="border-b border-x-line-subtle last:border-b-0">
              <div className="flex items-baseline gap-2 px-4 py-2 bg-x-surface-2/30 border-b border-x-line-subtle/60">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-x-ink-secondary">{label}</span>
                <span className="text-[11px] text-x-faint">{detail}</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
                {PROFILE_SECTIONS.map(([section, sectionLabel]) => {
                  const editKey = `${scope}:${section}`
                  const editing = editingProfile === editKey
                  const text = draft[section] || ''
                  return (
                    <div key={section} className="border-b border-r border-x-line-subtle/50 p-4 min-h-[130px] hover:bg-x-hover/10 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint">{sectionLabel}</div>
                        <div className="flex-1" />
                        {editing ? (
                          <button onClick={() => onSaveProfileSection(scope, section)} className="flex items-center gap-1 text-[11px] font-mono text-x-accent hover:text-x-accent/80 transition-colors">
                            <Save className="w-3 h-3" /> Save
                          </button>
                        ) : (
                          <button onClick={() => onEditProfile(editKey)} className="flex items-center gap-1 text-[11px] font-mono text-x-faint hover:text-x-ink-secondary transition-colors">
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                        )}
                      </div>
                      {editing ? (
                        <textarea
                          value={text}
                          onChange={(e) => setDraft({ ...draft, [section]: e.target.value })}
                          className="w-full min-h-[90px] bg-x-surface-2 border border-x-line-subtle rounded-lg px-2.5 py-2 text-xs text-x-ink focus:outline-none x-focus-ring resize-none font-mono"
                          autoFocus
                        />
                      ) : (
                        <div className="text-xs text-x-ink-secondary leading-relaxed whitespace-pre-wrap">
                          {text || <span className="text-x-faint italic font-mono text-[11px]">Empty</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden shadow-x-1">
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-x-line-subtle">
            <div>
              <div className="text-sm font-semibold text-x-ink">Sources and cadence</div>
              <div className="text-[11px] text-x-faint">Choose where Discovery watches automatically. Manual scans still run from the Inbox/Runs tabs.</div>
            </div>
            <div className="flex-1" />
            <button onClick={onOpenApiKeys} className="px-3 py-1.5 text-xs font-semibold rounded-lg text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors">
              API keys
            </button>
            {sourcesDirty && (
              <button
                onClick={onSaveSources}
                disabled={sourcesSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors"
              >
                {sourcesSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 p-4">
            {DISCOVERY_SOURCES.map((source) => {
              const cfg = sourcesConfig[source] || SETUP_SOURCE_DEFAULTS[source]
              const meta = SOURCE_META[source]
              const Icon = meta.icon
              return (
                <div key={source} className={`rounded-xl border p-4 transition-all duration-200 ${cfg.enabled ? 'border-x-accent/20 bg-x-accent/5 shadow-x-1' : 'border-x-line-subtle bg-x-surface-2/20'}`}>
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${meta.color}`} />
                    <div className="text-xs text-x-ink font-semibold">{meta.label}</div>
                    <button
                      onClick={() => onUpdateSource(source, 'enabled', !cfg.enabled)}
                      className={`ml-auto w-8 h-4.5 rounded-full border transition-colors cursor-pointer ${cfg.enabled ? 'bg-x-good/20 border-x-good/30' : 'bg-x-bg border-x-line-subtle'}`}
                      title={cfg.enabled ? 'Enabled' : 'Disabled'}
                    >
                      <span className={`block w-3 h-3 rounded-full bg-current transition-transform ${cfg.enabled ? 'translate-x-4 text-x-good' : 'translate-x-0.5 text-x-faint'}`} />
                    </button>
                  </div>
                  <div className="mt-3.5 flex items-center gap-1.5">
                    <span className="text-[11px] text-x-faint font-mono font-semibold uppercase">every</span>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={cfg.interval_hours}
                      onChange={(e) => onUpdateSource(source, 'interval_hours', parseInt(e.target.value) || 24)}
                      className="w-14 bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2 py-0.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/30 font-mono text-center"
                    />
                    <span className="text-[11px] text-x-faint font-mono font-semibold uppercase">hrs</span>
                  </div>
                  <button
                    onClick={() => onRunScan(source)}
                    disabled={!!scanRunning}
                    className="mt-3 w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-lg border border-x-line-subtle text-x-ink-secondary hover:bg-x-hover hover:text-x-ink disabled:opacity-50 transition-all font-semibold"
                  >
                    <RefreshCw className="w-3 h-3" /> Scan
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden shadow-x-1">
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-x-line-subtle">
            <div>
              <div className="text-sm font-semibold text-x-ink">Targets</div>
              <div className="text-[11px] text-x-faint">Targets are the subreddits, topics, categories, and queries Discovery actually scans.</div>
            </div>
            <div className="flex-1" />
            <select
              value={targetSource}
              onChange={(e) => onTargetSourceChange(e.target.value)}
              className="bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/30 cursor-pointer transition-colors"
            >
              <option value="all">All sources</option>
              {DISCOVERY_SOURCES.map((source) => <option key={source} value={source}>{SOURCE_META[source]?.label || source}</option>)}
            </select>
            {targetSource !== 'all' && (
              <button
                onClick={() => onPlanTargets(targetSource)}
                disabled={planningSource === targetSource}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors"
              >
                {planningSource === targetSource ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Plan targets
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] min-h-[260px]">
            <div className="overflow-x-auto">
              <div className="grid grid-cols-[84px_92px_100px_1fr_64px_64px_60px] px-4 py-2.5 bg-x-surface-2/40 text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint border-b border-x-line-subtle min-w-[800px]">
                <div>Scope</div><div>Source</div><div>Type</div><div>Target</div><div className="text-right">Hits</div><div className="text-right">Yield</div><div></div>
              </div>
              {visibleTargets.length === 0 ? (
                <div className="py-14 text-center text-xs text-x-faint font-mono">No targets yet.</div>
              ) : ['company', 'workspace'].map((scope) => {
                const scopedTargets = visibleTargets.filter((target) => (target.scope || 'workspace') === scope)
                if (!scopedTargets.length) return null
                return (
                  <div key={scope} className="contents">
                    <div className="px-4 py-2 text-[11px] uppercase tracking-[0.12em] text-x-ink-secondary bg-x-surface-2/25 border-b border-x-line-subtle min-w-[800px]">
                      {scope === 'company' ? 'Company' : 'Workspace'}
                      <span className="normal-case tracking-normal text-x-faint ml-2">{scope === 'company' ? 'visible everywhere' : 'this workspace only'}</span>
                    </div>
                    {scopedTargets.map((target) => (
                      <div key={target.id} data-target-scope={scope} className="grid grid-cols-[84px_92px_100px_1fr_64px_64px_60px] items-center px-4 py-2.5 text-xs border-b border-x-line-subtle/40 min-w-[800px] hover:bg-x-hover/20 transition-colors">
                        <div><Chip color={scope === 'company' ? 'amber' : 'neutral'} className="rounded-full">{scope === 'company' ? 'Company' : 'Workspace'}</Chip></div>
                        <div className="flex items-center gap-1.5 text-x-faint"><SourceIcon source={target.source} /> <span className="font-mono">{target.source}</span></div>
                        <div className="text-x-faint font-mono">{target.target_type}</div>
                        <div className="min-w-0 pr-3">
                          <div className="truncate text-x-ink font-medium">{target.value}</div>
                          {target.rationale && <div className="truncate text-[11px] text-x-faint italic">{target.rationale}</div>}
                        </div>
                        <div className="text-right text-x-faint tabular-nums font-mono">{target.hit_count || 0}</div>
                        <div className="text-right text-x-faint tabular-nums font-mono">{target.yield_count || 0}</div>
                        <div className="text-right">
                          <button
                            onClick={() => onToggleTarget(target)}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold font-mono border transition-all duration-150 ${target.status === 'active' ? 'text-x-good border-x-good/20 bg-x-good/8' : 'text-x-muted border-x-line-subtle bg-x-surface-2/40'}`}
                          >
                            {target.status === 'active' ? <CheckCircle2 className="w-3 h-3 text-x-good" /> : <Pause className="w-3 h-3" />}
                            {target.status}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>

            <div className="border-t lg:border-t-0 lg:border-l border-x-line-subtle/60 p-4 bg-x-surface/5">
              <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-2">Add target</div>
              <div className="space-y-2">
                <div className="flex gap-1.5" aria-label="Target scope">
                  {['company', 'workspace'].map((scope) => (
                    <button key={scope} type="button" aria-pressed={targetForm.scope === scope} onClick={() => onTargetFormChange({ ...targetForm, scope })}>
                      <Chip color={targetForm.scope === scope ? (scope === 'company' ? 'amber' : 'accent') : 'neutral'} className="rounded-full capitalize">{scope}</Chip>
                    </button>
                  ))}
                </div>
                <select
                  value={targetForm.source}
                  onChange={(e) => {
                    const source = e.target.value
                    const types = TARGET_TYPES_BY_SOURCE[source] || ['search_query']
                    onTargetFormChange({ ...targetForm, source, target_type: types[0] })
                  }}
                  className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/30 cursor-pointer"
                >
                  {DISCOVERY_SOURCES.map((source) => <option key={source} value={source}>{SOURCE_META[source]?.label || source}</option>)}
                </select>
                <select
                  value={targetForm.target_type}
                  onChange={(e) => onTargetFormChange({ ...targetForm, target_type: e.target.value })}
                  className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/30 cursor-pointer"
                >
                  {targetTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <ChipInput
                  values={targetForm.values}
                  onChange={(values) => onTargetFormChange({ ...targetForm, values })}
                  placeholder="Add targets with Enter or comma…"
                />
                <input
                  value={targetForm.rationale}
                  onChange={(e) => onTargetFormChange({ ...targetForm, rationale: e.target.value })}
                  placeholder="why this target matters"
                  className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink placeholder-x-faint focus:outline-none focus:border-x-accent/30 transition-all"
                />
                <button
                  onClick={onAddTarget}
                  disabled={!targetForm.values.length}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> Add {targetForm.values.length || ''} target{targetForm.values.length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function SetupMetric({ label, value, detail }) {
  return (
    <div className="rounded-xl border border-x-line-subtle bg-x-surface p-4 shadow-x-1">
      <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint">{label}</div>
      <div className="mt-1 text-lg font-bold text-x-ink font-mono tracking-tight">{value}</div>
      <div className="text-[11px] text-x-faint leading-snug mt-0.5">{detail}</div>
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-x-line-subtle/60 bg-x-surface-2/20 px-3 py-2">
      <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.08em] text-x-faint">{label}</div>
      <div className="text-base text-x-ink font-bold font-mono tabular-nums leading-tight mt-0.5">{value}</div>
    </div>
  )
}

function DecisionCard({
  finding,
  busyId,
  onResearch,
  onPromote,
  onPipeline,
  extraActions,
  onDismiss,
  onReviewed,
  onFavorite,
  onRoadmap,
  favorited,
  roadmapped,
}) {
  const [expanded, setExpanded] = useState(false)
  const intent = intentForFinding(finding)
  const source = SOURCE_META[finding.source] || { label: finding.source, icon: Telescope, color: 'text-x-faint' }
  const Source = source.icon
  const score = finding.relevance_score || 0
  const isBusy = (suffix) => busyId === `${finding.id}:${suffix}`

  return (
    <article className="rounded-xl border border-x-line-subtle bg-x-surface/20 hover:bg-x-surface/30 hover:border-x-line/80 transition-all duration-200 overflow-hidden shadow-x-1 flex flex-col justify-between">
      <div className="p-4">
        <div className="flex items-start gap-2.5">
          <Source className={`w-4 h-4 mt-0.5 shrink-0 ${source.color}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-xs font-semibold text-x-ink leading-snug truncate" title={finding.title}>{finding.title}</h3>
              {finding.source_url && (
                <a
                  href={finding.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-x-faint hover:text-x-accent shrink-0 transition-colors"
                  title="Open source"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap mt-1">
              <span className={`text-[11px] font-semibold font-mono px-1.5 py-0.5 rounded-lg border ${scoreTone(score)}`}>
                {Math.round(score * 100)}%
              </span>
              <span className="text-[11px] font-semibold font-mono px-1.5 py-0.5 rounded-lg border border-x-accent/25 bg-x-accent/8 text-x-accent/95">
                {intentLabel(intent)}
              </span>
              <span className="text-[11px] text-x-faint font-mono">{source.label}</span>
              {finding.verdict && <span className="text-[11px] text-x-faint font-mono">({finding.verdict.replace('_', ' ')})</span>}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-x-line-subtle/50 bg-x-surface-2/40 p-3">
          <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-1">Decision</div>
          <p className="text-xs text-x-ink-secondary leading-relaxed">
            {finding.proposal || recommendationFor(finding)}
          </p>
        </div>

        {(finding.triage_reason || finding.description || (finding.steal_targets || []).length > 0) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 text-[11px] font-mono text-x-faint hover:text-x-ink-secondary transition-colors"
          >
            {expanded ? '[-/ Hide evidence]' : '[+/ Show evidence]'}
          </button>
        )}

        {expanded && (
          <div className="mt-3 space-y-2.5 text-xs text-x-ink-secondary border-t border-x-line-subtle/40 pt-2.5">
            {finding.triage_reason && (
              <EvidenceBlock label="Triage" text={finding.triage_reason} />
            )}
            {finding.description && (
              <EvidenceBlock label="Source detail" text={finding.description} />
            )}
            {(finding.steal_targets || []).length > 0 && (
              <div>
                <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-1">Patterns</div>
                <div className="flex flex-wrap gap-1">
                  {finding.steal_targets.map((target) => (
                    <span key={target} className="px-1.5 py-0.5 text-[11px] font-mono rounded-lg border border-x-accent/20 bg-x-accent/8 text-x-accent">
                      {target}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-x-line-subtle/60 bg-x-surface-2/20 px-4 py-2.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <ActionButton busy={isBusy('research')} onClick={() => onResearch(finding)} icon={BookOpen} label="Research" tone="cyan" />
          <ActionButton busy={isBusy('task')} onClick={() => onPromote(finding)} icon={Kanban} label="Task" tone="emerald" />
          <ActionButton busy={isBusy('pipeline')} onClick={() => onPipeline(finding)} icon={Wrench} label="Pipeline" tone="amber" />
          {extraActions}
          <ActionButton busy={isBusy('roadmap')} onClick={() => onRoadmap(finding)} icon={Map} label={roadmapped ? 'On Roadmap' : 'Roadmap'} tone={roadmapped ? 'purple' : 'zinc'} />
          <div className="flex-1" />
          <button
            onClick={() => onFavorite(finding)}
            className={`p-1.5 rounded-lg transition-colors ${
              favorited
                ? 'text-x-accent-ink bg-x-accent-ink/10 hover:bg-x-accent-ink/18'
                : 'text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10'
            }`}
            title={favorited ? 'Remove favorite' : 'Favorite'}
          >
            <Star className={`w-3.5 h-3.5 ${favorited ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={() => onReviewed(finding)}
            disabled={isBusy('reviewed')}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-x-line-subtle text-x-ink-secondary bg-x-hover/30 hover:bg-x-hover disabled:opacity-50 transition-colors"
            title="Mark reviewed"
          >
            {isBusy('reviewed') ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Reviewed
          </button>
          <button
            onClick={() => onDismiss(finding)}
            className="p-1.5 rounded-lg text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors"
            title="Dismiss"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </article>
  )
}

function ActionButton({ busy, onClick, icon: Icon, label, tone }) {
  const toneCls = {
    cyan: 'text-x-accent bg-x-accent/10 border-x-accent/20 hover:bg-x-accent/20',
    emerald: 'text-x-good bg-x-good/10 border-x-good/20 hover:bg-x-good/20',
    amber: 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/20 hover:bg-x-accent-ink/20',
    purple: 'text-x-accent bg-x-accent/10 border-x-accent/20 hover:bg-x-accent/20',
    zinc: 'text-x-ink-secondary bg-x-hover/30 border-x-line-subtle hover:bg-x-hover',
  }[tone] || 'text-x-ink-secondary bg-x-hover/30 border-x-line-subtle hover:bg-x-hover'
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border transition-colors disabled:opacity-50 ${toneCls}`}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {label}
    </button>
  )
}

function EvidenceBlock({ label, text }) {
  return (
    <div>
      <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-1">{label}</div>
      <div className="text-xs text-x-ink-secondary leading-relaxed whitespace-pre-wrap font-mono">{text}</div>
    </div>
  )
}

function InsightCard({
  insight,
  busyId,
  favorited,
  roadmapped,
  onFavorite,
  onRoadmap,
  extraActions,
  onTask,
  onOpenSource,
}) {
  const evidence = Array.isArray(insight.evidence_findings) ? insight.evidence_findings : []
  const strength = insight.strength || 0
  const isBusy = (suffix) => busyId === `insight:${insight.id}:${suffix}`
  return (
    <div className="rounded-xl border border-x-line-subtle bg-x-surface/20 hover:bg-x-surface/25 transition-all duration-200 overflow-hidden shadow-x-1 flex flex-col justify-between">
      <div className="p-4">
        <div className="flex items-start gap-2.5">
          <Lightbulb className="w-4 h-4 text-x-accent-ink mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-xs font-semibold text-x-ink min-w-0 flex-1 truncate" title={insight.name}>{insight.name}</h3>
              <span className="text-[11px] font-semibold font-mono px-1.5 py-0.5 rounded-lg bg-x-surface-2/40 border border-x-line-subtle/60 text-x-faint">
                {(insight.insight_type || '').replace('_', ' ')}
              </span>
              <span className={`text-[11px] font-semibold font-mono px-1.5 py-0.5 rounded-lg border ${scoreTone(strength)}`}>
                {strength.toFixed(2)}
              </span>
            </div>
            <p className="mt-2 text-xs text-x-ink-secondary leading-relaxed whitespace-pre-wrap">{insight.summary}</p>
          </div>
        </div>

        {evidence.length > 0 && (
          <div className="mt-4 pt-3 border-t border-x-line-subtle/50">
            <div className="text-[11px] font-semibold font-mono uppercase tracking-[0.12em] text-x-faint mb-1.5">
              Evidence
            </div>
            <div className="space-y-1.5">
              {evidence.slice(0, 5).map((finding) => (
                <button
                  key={finding.id}
                  onClick={() => onOpenSource(finding)}
                  className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg hover:bg-x-hover/40 text-[11px] transition-all group"
                >
                  <SourceIcon source={finding.source} />
                  <span className="truncate text-x-ink-secondary flex-1 group-hover:text-x-ink transition-colors">{finding.title}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-x-faint group-hover:translate-x-0.5 transition-transform" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-x-line-subtle/60 bg-x-surface-2/20 px-4 py-2.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => onFavorite(insight)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-colors ${
              favorited
                ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/20 hover:bg-x-accent-ink/20'
                : 'text-x-ink-secondary bg-x-hover/30 border-x-line-subtle hover:bg-x-hover'
            }`}
          >
            <Star className={`w-3 h-3 ${favorited ? 'fill-current' : ''}`} />
            {favorited ? 'Favorited' : 'Favorite'}
          </button>
          <ActionButton busy={isBusy('roadmap')} onClick={() => onRoadmap(insight)} icon={Map} label={roadmapped ? 'On Roadmap' : 'Roadmap'} tone={roadmapped ? 'purple' : 'zinc'} />
          {extraActions}
          <ActionButton busy={isBusy('task')} onClick={() => onTask(insight)} icon={Kanban} label="Task" tone="emerald" />
        </div>
      </div>
    </div>
  )
}
