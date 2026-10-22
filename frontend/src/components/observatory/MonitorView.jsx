import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw, Sparkles, Plus, Trash2,
  Loader2, Check, Pencil, Timer, ExternalLink, ArrowUpRight, Info,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

// Module-level so an in-flight profile build survives panel close/reopen.
// The backend regenerate endpoint awaits the LLM (~30s+); local useState
// would be torn down on unmount and the spinner would vanish. Keyed by
// workspace_id; cleared when the request resolves or when the backend
// emits a build-completed/failed bus event.
const inFlightProfileBuilds = new Set()
const profileBuildSubscribers = new Set()
function notifyProfileBuild() {
  profileBuildSubscribers.forEach((fn) => { try { fn() } catch {} })
}

// Same pattern for smart scans — full pipeline can run several minutes.
// Map workspace_id → source ('all'|'github'|...). Set on SCAN_STARTED bus
// event, cleared on SCAN_COMPLETED. The local runSmartScan also seeds it
// optimistically so the spinner appears immediately.
const inFlightScans = new Map()
const scanSubscribers = new Set()
function notifyScan() {
  scanSubscribers.forEach((fn) => { try { fn() } catch {} })
}

const SOURCES = ['github', 'reddit', 'hackernews', 'producthunt', 'x']
const TARGET_TYPES_BY_SOURCE = {
  github: ['topic', 'search_query'],
  reddit: ['subreddit', 'search_query'],
  hackernews: ['search_query'],
  producthunt: ['category', 'topic', 'search_query'],
  x: ['hashtag', 'user', 'search_query'],
}
const INSIGHT_TYPES = ['competitor', 'pain_point', 'feature_gap', 'integration_done']

const SECTION_LABEL = {
  identity: 'Identity',
  interests: 'Interests',
  current_stack: 'Current Stack',
  competitors: 'Known Competitors',
  audience: 'Audience',
  tone: 'Tone',
  dismissal_patterns: 'Dismissal Patterns',
}

function StatusDot({ score }) {
  if (!(score > 0)) {
    return <span className="inline-block w-1.5 h-1.5 rounded-full border-[1.5px] border-x-faint bg-transparent" />
  }
  const cls =
    score >= 0.7 ? 'bg-x-good'
    : score >= 0.4 ? 'bg-x-accent-ink'
    : 'bg-x-accent-ink/70'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
}

function StatusPill({ score }) {
  const tone =
    score >= 0.7 ? 'text-x-good bg-x-good/10 border-x-good/20'
    : score >= 0.4 ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/20'
    : score > 0 ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/20'
    : 'text-x-faint bg-x-hover border-x-line'
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] tabular-nums ${tone}`}>
      <StatusDot score={score} />
      {(score || 0).toFixed(2)}
    </span>
  )
}

function Eyebrow({ children, action, className = '' }) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="text-[11px] font-medium text-x-faint uppercase tracking-[0.12em]">{children}</div>
      {action}
    </div>
  )
}

const PRIMARY_BTN = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border border-x-accent/30 rounded transition-colors'
const INPUT_BASE = 'bg-x-surface-2 border border-x-line focus:border-x-accent/40 focus:outline-none rounded px-2 py-1.5 text-xs'

// MonitorView is the Smart Observatory setup body without a modal frame.
// It can render the full legacy tab set or a narrower subset when embedded
// inside DiscoveryHub's Setup surface.
export default function MonitorView({ onOpenFeed, initialTab = 'profile', visibleTabs = null }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const [tab, setTab] = useState(initialTab)
  const [profile, setProfile] = useState(null)
  const [profileDraft, setProfileDraft] = useState({})
  const [editingSection, setEditingSection] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [, setBuildTick] = useState(0)
  const profileBuilding = activeWorkspaceId
    ? inFlightProfileBuilds.has(activeWorkspaceId)
    : false

  useEffect(() => {
    const sub = () => setBuildTick((x) => x + 1)
    profileBuildSubscribers.add(sub)
    return () => { profileBuildSubscribers.delete(sub) }
  }, [])

  const [targets, setTargets] = useState([])
  const [targetSourceFilter, setTargetSourceFilter] = useState('all')
  const [targetForm, setTargetForm] = useState({
    source: 'github', target_type: 'topic', value: '', rationale: '',
  })
  const [planning, setPlanning] = useState(null)
  const [planResult, setPlanResult] = useState(null)

  const [insights, setInsights] = useState([])
  const [insightTypeFilter, setInsightTypeFilter] = useState('all')

  const [, setScanTick] = useState(0)
  const scanRunning = activeWorkspaceId ? (inFlightScans.get(activeWorkspaceId) || null) : null
  const [scanResults, setScanResults] = useState([])
  const [progressLog, setProgressLog] = useState([])

  // Schedules: pulled from observatory_sources and shown alongside last_scan_at
  // so the user can see the scheduler is alive without grepping the DB.
  const [obsSources, setObsSources] = useState([])
  const [schedDirty, setSchedDirty] = useState({})
  const [schedSaving, setSchedSaving] = useState(false)

  useEffect(() => {
    const sub = () => setScanTick((x) => x + 1)
    scanSubscribers.add(sub)
    return () => { scanSubscribers.delete(sub) }
  }, [])

  const tabDefs = [
    ['profile', 'Profile'],
    ['targets', 'Targets'],
    ['scan', 'Run'],
    ['schedules', 'Schedule'],
    ['insights', 'Insights'],
  ].filter(([k]) => !visibleTabs || visibleTabs.includes(k))

  useEffect(() => {
    if (!tabDefs.some(([k]) => k === tab)) {
      setTab(tabDefs[0]?.[0] || 'profile')
    }
  }, [tab, tabDefs])

  const loadProfile = useCallback(async () => {
    if (!activeWorkspaceId) return
    setProfileLoading(true)
    try {
      const r = await api.getObservatoryProfile(activeWorkspaceId)
      setProfile(r || null)
      setProfileDraft((r && r.profile) || {})
    } catch { setProfile(null) }
    setProfileLoading(false)
  }, [activeWorkspaceId])

  const loadTargets = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const params = { workspace_id: activeWorkspaceId }
      if (targetSourceFilter !== 'all') params.source = targetSourceFilter
      const r = await api.listObservatorySearchTargets(params)
      setTargets(Array.isArray(r) ? r : (r?.targets || []))
    } catch { setTargets([]) }
  }, [activeWorkspaceId, targetSourceFilter])

  const loadInsights = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const r = await api.listObservatoryInsights(
        activeWorkspaceId,
        insightTypeFilter === 'all' ? null : insightTypeFilter,
      )
      setInsights(Array.isArray(r) ? r : (r?.insights || []))
    } catch { setInsights([]) }
  }, [activeWorkspaceId, insightTypeFilter])

  const loadObsSources = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const res = await api.getObservatorySettings(activeWorkspaceId)
      const map = res?.sources || {}
      // Coerce to a list of {source, enabled, interval_hours, last_scan_at}
      // covering all 5 sources so reddit/x show up even before the row exists.
      const list = SOURCES.map((src) => {
        const cfg = map[src] || {}
        return {
          source: src,
          enabled: !!cfg.enabled,
          interval_hours: cfg.interval_hours ?? (src === 'hackernews' ? 12 : 24),
          last_scan_at: cfg.last_scan_at || null,
        }
      })
      setObsSources(list)
      setSchedDirty({})
    } catch { setObsSources(SOURCES.map((src) => ({ source: src, enabled: false, interval_hours: 24, last_scan_at: null }))) }
  }, [activeWorkspaceId])

  useEffect(() => { loadProfile() }, [loadProfile])
  useEffect(() => { loadTargets() }, [loadTargets])
  useEffect(() => { loadInsights() }, [loadInsights])
  useEffect(() => { if (tab === 'schedules') loadObsSources() }, [tab, loadObsSources])

  const buildProfile = async () => {
    if (!activeWorkspaceId) return
    if (inFlightProfileBuilds.has(activeWorkspaceId)) return
    inFlightProfileBuilds.add(activeWorkspaceId)
    notifyProfileBuild()
    try {
      const r = await api.regenerateObservatoryProfile(activeWorkspaceId)
      setProfile(r || null)
      setProfileDraft((r && r.profile) || {})
    } catch (err) {
      alert('Profile build failed: ' + err.message)
    } finally {
      inFlightProfileBuilds.delete(activeWorkspaceId)
      notifyProfileBuild()
    }
  }

  // Backend bus signal: clears the in-flight flag for ANY workspace_id
  // (handles the case where another tab kicked off the build, or the
  // request landed but the panel was closed before the await resolved).
  useEffect(() => {
    const handler = (e) => {
      const wsId = e?.detail?.workspace_id
      if (!wsId) return
      if (inFlightProfileBuilds.delete(wsId)) notifyProfileBuild()
      if (wsId === activeWorkspaceId) loadProfile()
    }
    const events = [
      'cc-observatory_profile_build_completed',
      'cc-observatory_profile_build_failed',
    ]
    events.forEach((ev) => window.addEventListener(ev, handler))
    return () => events.forEach((ev) => window.removeEventListener(ev, handler))
  }, [activeWorkspaceId, loadProfile])

  // Live scan signals: keep the spinner accurate when a scan was kicked off
  // from another tab/panel and refresh insights+targets as findings stream in
  // so the Insights tab fills up while a scan is running rather than only at
  // completion.
  useEffect(() => {
    const onStarted = (e) => {
      const wsId = e?.detail?.workspace_id
      const source = e?.detail?.source
      if (!wsId || !source) return
      if (!inFlightScans.has(wsId)) {
        inFlightScans.set(wsId, source)
        notifyScan()
      }
      if (wsId === activeWorkspaceId) {
        setProgressLog([{ ts: Date.now(), phase: 'started', text: `Scan started · ${source}` }])
      }
    }
    const onProgress = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      const phase = d.phase || ''
      let text = phase
      if (phase === 'plan') text = 'Planning targets…'
      else if (phase === 'scrape') text = `Scraping ${d.target_count || 0} target${d.target_count === 1 ? '' : 's'}…`
      else if (phase === 'scrape_target') {
        text = `Scraped ${d.target || ''} (${d.items_found ?? 0} items)`
        if (d.total) text += ` — ${d.progress}/${d.total}`
      } else if (phase === 'triage') text = `Triaging ${d.new_items || 0} new item${d.new_items === 1 ? '' : 's'}…`
      else if (phase === 'analyze') text = `Deep-analyzing ${d.to_analyze || 0}…`
      setProgressLog((prev) => [...prev.slice(-30), { ts: Date.now(), phase, text }])
    }
    const onCompleted = (e) => {
      const wsId = e?.detail?.workspace_id
      if (!wsId) return
      if (inFlightScans.delete(wsId)) notifyScan()
      if (wsId === activeWorkspaceId) {
        const fc = e?.detail?.findings_count ?? 0
        setProgressLog((prev) => [...prev.slice(-30), {
          ts: Date.now(), phase: 'completed',
          text: `Scan completed · ${fc} finding${fc === 1 ? '' : 's'}`,
        }])
        loadTargets()
        loadInsights()
        if (tab === 'schedules') loadObsSources()
      }
    }
    const onFinding = (e) => {
      const d = e?.detail || {}
      if (d.workspace_id !== activeWorkspaceId) return
      loadInsights()
      if (d.title) {
        setProgressLog((prev) => [...prev.slice(-30), {
          ts: Date.now(), phase: 'finding',
          text: `Finding: ${d.title.slice(0, 70)}${d.title.length > 70 ? '…' : ''}`,
        }])
      }
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
  }, [activeWorkspaceId, loadTargets, loadInsights, loadObsSources, tab])

  const saveProfileSection = async (section) => {
    try {
      const next = { ...profileDraft, [section]: profileDraft[section] || '' }
      const r = await api.updateObservatoryProfile(activeWorkspaceId, next)
      setProfile(r || null)
      setProfileDraft((r && r.profile) || next)
      setEditingSection(null)
    } catch (err) { alert('Save failed: ' + err.message) }
  }

  const addTarget = async () => {
    if (!targetForm.value.trim()) return
    try {
      await api.addObservatorySearchTarget({
        workspace_id: activeWorkspaceId,
        ...targetForm,
      })
      setTargetForm({ ...targetForm, value: '', rationale: '' })
      loadTargets()
    } catch (err) { alert('Add failed: ' + err.message) }
  }

  const toggleTarget = async (t) => {
    try {
      await api.updateObservatorySearchTarget(t.id, {
        status: t.status === 'active' ? 'paused' : 'active',
      })
      loadTargets()
    } catch (err) { alert('Update failed: ' + err.message) }
  }

  const deleteTarget = async (t) => {
    if (!confirm(`Remove target "${t.value}"?`)) return
    try {
      await api.deleteObservatorySearchTarget(t.id)
      loadTargets()
    } catch (err) { alert('Delete failed: ' + err.message) }
  }

  const planTargets = async (source) => {
    setPlanning(source)
    setPlanResult(null)
    try {
      const r = await api.planObservatorySearchTargets(activeWorkspaceId, source)
      setPlanResult({ source, ...r })
      loadTargets()
    } catch (err) { alert('Plan failed: ' + err.message) }
    setPlanning(null)
  }

  const runSmartScan = async (source) => {
    if (!activeWorkspaceId) return
    if (inFlightScans.has(activeWorkspaceId)) return
    inFlightScans.set(activeWorkspaceId, source)
    notifyScan()
    try {
      const r = await api.triggerObservatorySmartScan({
        workspace_id: activeWorkspaceId,
        source,
        wait: true,
      })
      setScanResults((r && r.results) || [])
      loadTargets()
      loadInsights()
    } catch (err) { alert('Scan failed: ' + err.message) }
    finally {
      inFlightScans.delete(activeWorkspaceId)
      notifyScan()
    }
  }

  const deleteInsight = async (i) => {
    if (!confirm(`Remove insight "${i.key}"?`)) return
    try { await api.deleteObservatoryInsight(i.id); loadInsights() }
    catch (err) { alert('Delete failed: ' + err.message) }
  }

  const updateSched = (source, key, val) => {
    setObsSources((prev) => prev.map((s) => (s.source === source ? { ...s, [key]: val } : s)))
    setSchedDirty((d) => ({ ...d, [source]: true }))
  }

  const saveSchedules = async () => {
    if (!activeWorkspaceId) return
    setSchedSaving(true)
    try {
      const sources = {}
      obsSources.forEach((s) => {
        sources[s.source] = { enabled: s.enabled, interval_hours: s.interval_hours }
      })
      await api.updateObservatorySettings({ workspace_id: activeWorkspaceId, sources })
      setSchedDirty({})
    } catch (err) { alert('Save failed: ' + err.message) }
    finally { setSchedSaving(false) }
  }

  if (!activeWorkspaceId) {
    return <div className="flex items-center justify-center h-full text-x-faint text-xs">Select a workspace first.</div>
  }

  const anyDirty = Object.values(schedDirty).some(Boolean)

  return (
    <div className="flex flex-col h-full">
      {scanRunning && (
        <div className="bg-x-accent/10 border-b border-x-accent/20 shrink-0">
          <div className="flex items-center gap-2 px-4 py-2 text-[11px]">
            <Loader2 className="w-3 h-3 animate-spin text-x-accent" />
            <span className="text-x-accent">
              Smart scan running
              {scanRunning !== 'all' && <span className="text-x-accent/70"> · {scanRunning}</span>}
            </span>
            <span className="text-x-accent/60">· plan → scrape → triage → analyze</span>
          </div>
          {progressLog.length > 0 && (
            <div className="px-4 pb-2 max-h-32 overflow-y-auto space-y-0.5 font-mono text-[11px]">
              {progressLog.slice(-12).map((p, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-x-accent/40 tabular-nums shrink-0">
                    {new Date(p.ts).toLocaleTimeString().slice(0, 8)}
                  </span>
                  <span className={p.phase === 'finding' ? 'text-x-good/90' : 'text-x-accent/80'}>
                    {p.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 px-4 pt-2 border-b border-x-line shrink-0">
        {tabDefs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`relative px-3 py-2 text-xs transition-colors ${
              tab === k ? 'text-x-ink' : 'text-x-faint hover:text-x-ink'
            }`}
          >
            {label}
            {tab === k && (
              <span className="absolute left-2 right-2 -bottom-px h-px bg-x-accent" />
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 text-sm">
        {tab === 'profile' && (
          <div className="space-y-5">
            <div className="text-[11px] text-x-faint leading-relaxed">
              The profile is the planner's brief — it shapes which targets get suggested,
              which findings score high, and which competitor mentions surface. Build it once,
              then refine. Empty profile → planner falls back to generic queries.
            </div>
            <div className="flex items-center justify-between gap-4 p-3 rounded-md bg-x-surface-2/40 border border-x-line/60">
              <div className="flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${profile?.generated_at ? 'bg-x-good' : 'bg-x-accent-ink'}`} />
                <span className="text-x-ink">
                  {profile?.generated_at ? 'Profile ready' : 'No profile yet'}
                </span>
                <span className="text-x-faint">
                  {profile?.generated_at
                    ? `· built ${new Date(profile.generated_at).toLocaleString()}`
                    : '· build one to enable smart scans'}
                </span>
              </div>
              <button
                onClick={buildProfile}
                disabled={profileBuilding || profileLoading}
                className={PRIMARY_BTN}
              >
                {profileBuilding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                {profile ? 'Rebuild from sources' : 'Build profile'}
              </button>
            </div>

            <div className="divide-y divide-x-line/60 border border-x-line/60 rounded-md overflow-hidden">
              {Object.keys(SECTION_LABEL).map((section) => {
                const text = profileDraft[section] || ''
                const editing = editingSection === section
                return (
                  <div key={section} className="px-4 py-3 hover:bg-x-surface-2/30 transition-colors group">
                    <Eyebrow
                      className="mb-1.5"
                      action={
                        editing ? (
                          <button onClick={() => saveProfileSection(section)} className="inline-flex items-center gap-1 text-[11px] text-x-accent hover:text-x-accent">
                            <Check className="w-3 h-3" /> Save
                          </button>
                        ) : (
                          <button
                            onClick={() => setEditingSection(section)}
                            className="inline-flex items-center gap-1 text-[11px] text-x-faint hover:text-x-ink opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                        )
                      }
                    >
                      {SECTION_LABEL[section]}
                    </Eyebrow>
                    {editing ? (
                      <textarea
                        value={text}
                        onChange={(e) => setProfileDraft({ ...profileDraft, [section]: e.target.value })}
                        autoFocus
                        className="w-full bg-x-surface-2 border border-x-line focus:border-x-accent/40 focus:outline-none rounded p-2 text-xs min-h-[90px] font-mono leading-relaxed"
                      />
                    ) : (
                      <div className="text-xs text-x-ink whitespace-pre-wrap leading-relaxed">
                        {text || <span className="text-x-faint italic">empty — click Edit to fill in</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'targets' && (
          <div className="space-y-4">
            <div className="text-[11px] text-x-faint leading-relaxed">
              Targets are <em>where</em> the planner looks: GitHub topics, subreddits, HN queries, PH categories, X hashtags.
              Auto-planned from your profile, or add by hand. Pause noisy ones; signal score and yield reflect how often a target produces useful findings.
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[11px] uppercase tracking-[0.12em] text-x-faint">Source</span>
                <select
                  value={targetSourceFilter}
                  onChange={(e) => setTargetSourceFilter(e.target.value)}
                  className={INPUT_BASE}
                >
                  <option value="all">All sources</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px] text-x-faint tabular-nums">{targets.length} target{targets.length === 1 ? '' : 's'}</span>
                {targetSourceFilter !== 'all' && (
                  <button
                    onClick={() => planTargets(targetSourceFilter)}
                    disabled={planning === targetSourceFilter}
                    className={PRIMARY_BTN}
                  >
                    {planning === targetSourceFilter ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Plan with LLM
                  </button>
                )}
              </div>
            </div>

            {planResult && (
              <div className="border-l-2 border-x-accent/50 bg-x-accent/5 rounded-r px-3 py-2 text-[11px]">
                <div className="font-medium text-x-accent mb-1">
                  Plan for {planResult.source}: +{(planResult.added || []).length} added · {(planResult.retired || []).length} retired
                </div>
                {(planResult.added || []).map((t, i) => (
                  <div key={i} className="text-x-faint leading-relaxed">
                    <span className="text-x-good">+</span> <span className="text-x-faint">{t.target_type}:</span>{' '}
                    <span className="text-x-ink">{t.value}</span>
                    {t.rationale && <span className="text-x-faint"> — {t.rationale}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-md border border-x-line/60 overflow-hidden">
              <div className="grid grid-cols-[80px_100px_1fr_56px_56px_84px_36px] text-[11px] uppercase tracking-[0.12em] text-x-faint bg-x-surface-2/40 border-b border-x-line/60 px-3 py-2">
                <div>Source</div><div>Type</div><div>Value</div>
                <div className="text-right">Hits</div><div className="text-right">Yields</div>
                <div className="text-right">Signal</div><div></div>
              </div>
              {targets.length === 0 ? (
                <div className="text-center text-x-faint text-xs py-10">
                  No targets yet. Use <span className="text-x-accent">Plan with LLM</span> or add one below.
                </div>
              ) : targets.map((t, idx) => (
                <div
                  key={t.id}
                  className={`grid grid-cols-[80px_100px_1fr_56px_56px_84px_36px] items-center px-3 py-2 text-xs hover:bg-x-surface-2/30 transition-colors ${idx > 0 ? 'border-t border-x-line/40' : ''}`}
                >
                  <div className="text-x-faint">{t.source}</div>
                  <div className="text-x-faint">{t.target_type}</div>
                  <div className="truncate flex items-center gap-2 min-w-0">
                    <button
                      onClick={() => toggleTarget(t)}
                      title={t.status === 'active' ? 'Active — click to pause' : 'Paused — click to activate'}
                      className={`shrink-0 w-1.5 h-1.5 rounded-full ${t.status === 'active' ? 'bg-x-good' : 'border-[1.5px] border-x-faint bg-transparent'}`}
                    />
                    <span className="truncate text-x-ink">{t.value}</span>
                    {t.rationale && <span className="text-x-faint truncate">— {t.rationale}</span>}
                  </div>
                  <div className="text-right tabular-nums text-x-faint">{t.hit_count || 0}</div>
                  <div className="text-right tabular-nums text-x-faint">{t.yield_count || 0}</div>
                  <div className="flex justify-end"><StatusPill score={t.signal_score || 0} /></div>
                  <div className="text-right">
                    <button onClick={() => deleteTarget(t)} className="text-x-faint hover:text-x-accent-ink p-1 -m-1 rounded">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-x-line/60 p-3 space-y-2">
              <Eyebrow>Add target manually</Eyebrow>
              <div className="grid grid-cols-[100px_120px_1fr_auto] gap-2">
                <select
                  value={targetForm.source}
                  onChange={(e) => {
                    const src = e.target.value
                    const types = TARGET_TYPES_BY_SOURCE[src] || ['search_query']
                    setTargetForm({ ...targetForm, source: src, target_type: types[0] })
                  }}
                  className={INPUT_BASE}
                >
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select
                  value={targetForm.target_type}
                  onChange={(e) => setTargetForm({ ...targetForm, target_type: e.target.value })}
                  className={INPUT_BASE}
                >
                  {(TARGET_TYPES_BY_SOURCE[targetForm.source] || []).map((t) =>
                    <option key={t} value={t}>{t}</option>
                  )}
                </select>
                <input
                  placeholder="value (e.g. r/MachineLearning)"
                  value={targetForm.value}
                  onChange={(e) => setTargetForm({ ...targetForm, value: e.target.value })}
                  className={INPUT_BASE}
                />
                <button onClick={addTarget} disabled={!targetForm.value.trim()} className={`${PRIMARY_BTN} disabled:opacity-40 disabled:cursor-not-allowed`}>
                  <Plus className="w-3 h-3" /> Add
                </button>
              </div>
              <input
                placeholder="rationale (why this source matters)"
                value={targetForm.rationale}
                onChange={(e) => setTargetForm({ ...targetForm, rationale: e.target.value })}
                className={`${INPUT_BASE} w-full`}
              />
            </div>
          </div>
        )}

        {tab === 'insights' && (
          <div className="space-y-4">
            <div className="rounded-md border border-x-line/60 bg-x-surface-2/30 p-3 space-y-2 text-[11px] leading-relaxed">
              <div className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-x-accent mt-0.5 shrink-0" />
                <div className="text-x-faint">
                  <span className="text-x-ink">Insights ≠ Findings.</span>{' '}
                  An <span className="text-x-ink">insight</span> is a merged conclusion the analyzer drew across one or more <span className="text-x-ink">findings</span> in the Feed.
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pl-5 text-x-faint">
                <div>
                  <div className="text-x-ink text-[11px] uppercase tracking-[0.12em] mb-0.5">Strength score (here)</div>
                  Confidence in the conclusion. Starts ~0.5; +0.1 for each new finding that reinforces it.
                </div>
                <div>
                  <div className="text-x-ink text-[11px] uppercase tracking-[0.12em] mb-0.5">Relevance score (in Feed)</div>
                  How well one raw finding matches your profile. Set during triage.
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[11px] uppercase tracking-[0.12em] text-x-faint">Type</span>
              <select
                value={insightTypeFilter}
                onChange={(e) => setInsightTypeFilter(e.target.value)}
                className={INPUT_BASE}
              >
                <option value="all">All types</option>
                {INSIGHT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
              <span className="ml-auto text-[11px] text-x-faint tabular-nums">{insights.length} insight{insights.length === 1 ? '' : 's'}</span>
            </div>

            {insights.length === 0 ? (
              <div className="text-center text-x-faint text-xs py-12 border border-dashed border-x-line/60 rounded-md">
                No insights yet. Run a smart scan to populate.
              </div>
            ) : (
              <div className="space-y-2">
                {insights.map((i) => {
                  // Backend now hydrates evidence_findings with id/title/source/source_url.
                  // Fall back to the legacy id-only `evidence` list if the backend isn't
                  // updated yet (so the panel still shows a count even pre-deploy).
                  const ev = Array.isArray(i.evidence_findings) ? i.evidence_findings : []
                  const legacyCount = !ev.length && Array.isArray(i.evidence) ? i.evidence.length : 0
                  return (
                    <div key={i.id} className="rounded-md border border-x-line/60 hover:border-x-line transition-colors p-3 text-xs group">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-medium text-x-ink">{i.name}</span>
                        <span className="text-[11px] text-x-faint uppercase tracking-wider px-1.5 py-0.5 rounded bg-x-surface-2/60">
                          {(i.insight_type || '').replace('_', ' ')}
                        </span>
                        <StatusPill score={i.strength || 0} />
                        <button
                          onClick={() => deleteInsight(i)}
                          className="ml-auto text-x-faint hover:text-x-accent-ink p-1 -m-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete insight"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="whitespace-pre-wrap text-x-ink leading-relaxed">{i.summary}</div>

                      {ev.length > 0 ? (
                        <div className="mt-2.5 pt-2 border-t border-x-line/40">
                          <div className="text-[11px] uppercase tracking-[0.12em] text-x-faint mb-1.5">
                            Evidence · {ev.length} finding{ev.length === 1 ? '' : 's'}
                          </div>
                          <div className="space-y-1">
                            {ev.map((f) => (
                              <div key={f.id} className="flex items-center gap-2 text-[11px] hover:bg-x-surface-2/30 rounded px-1.5 py-1 -mx-1.5 transition-colors">
                                <span className="text-[11px] uppercase tracking-wider text-x-faint shrink-0 w-14">{f.source}</span>
                                <span className="truncate text-x-ink flex-1 min-w-0">{f.title}</span>
                                {typeof f.relevance_score === 'number' && f.relevance_score > 0 && (
                                  <span className="text-[11px] text-x-faint tabular-nums shrink-0">{Math.round(f.relevance_score * 100)}%</span>
                                )}
                                {onOpenFeed && (
                                  <button
                                    onClick={() => onOpenFeed(f)}
                                    className="shrink-0 text-x-faint hover:text-x-accent p-0.5 rounded transition-colors"
                                    title="Open in Feed"
                                  >
                                    <ArrowUpRight className="w-3 h-3" />
                                  </button>
                                )}
                                {f.source_url && (
                                  <a
                                    href={f.source_url}
                                    target="_blank"
                                    rel="noopener"
                                    className="shrink-0 text-x-faint hover:text-x-accent p-0.5 rounded transition-colors"
                                    title="Open source"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : legacyCount > 0 ? (
                        <div className="text-[11px] text-x-faint mt-2 flex items-center gap-1">
                          <span className="w-1 h-1 rounded-full bg-x-faint/60" />
                          {legacyCount} evidence finding{legacyCount === 1 ? '' : 's'}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'scan' && (
          <div className="space-y-4">
            <div className="text-[11px] text-x-faint leading-relaxed p-3 rounded-md bg-x-surface-2/40 border border-x-line/60">
              <div className="text-x-ink text-xs font-medium mb-1">How it works</div>
              Profile-aware planner → scrape per target → batched triage → deep analyze + voice extract → insight merge.
              Requires a built profile.
            </div>

            <button
              onClick={() => runSmartScan('all')}
              disabled={scanRunning != null}
              className={`w-full ${PRIMARY_BTN} py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {scanRunning === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Scan all sources
            </button>

            <div>
              <Eyebrow className="mb-2">Or scan a single source</Eyebrow>
              <div className="grid grid-cols-2 gap-2">
                {SOURCES.map((s) => {
                  const running = scanRunning === s
                  return (
                    <button
                      key={s}
                      onClick={() => runSmartScan(s)}
                      disabled={scanRunning != null}
                      className="border border-x-line/60 hover:border-x-accent/40 hover:bg-x-surface-2/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-md px-3 py-2.5 text-left flex items-center justify-between transition-colors"
                    >
                      <span className="text-sm capitalize">{s}</span>
                      {running ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-x-accent" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 text-x-faint" />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {scanResults.length > 0 && (
              <div className="rounded-md border border-x-line/60 overflow-hidden">
                <div className="px-3 py-2 bg-x-surface-2/40 border-b border-x-line/60">
                  <Eyebrow>Last results</Eyebrow>
                </div>
                <div className="divide-y divide-x-line/40">
                  {scanResults.map((r, i) => (
                    <div key={i} className="px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-medium capitalize">{r.source}</span>
                        <span className={`text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          r.status === 'completed'
                            ? 'text-x-good border-x-good/30 bg-x-good/10'
                            : 'text-x-accent-ink border-x-accent-ink/30 bg-x-accent-ink/10'
                        }`}>
                          {r.status}
                        </span>
                      </div>
                      <div className="text-x-faint text-[11px] mt-1 tabular-nums">
                        {r.targets_scanned || 0} targets · {r.items_scraped || 0} scraped · {r.findings_created || 0} findings · {r.insights_touched || 0} insights touched
                      </div>
                      {r.error && <div className="text-x-accent-ink text-[11px] mt-1">{r.error}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'schedules' && (
          <div className="space-y-4">
            <div className="text-[11px] text-x-faint leading-relaxed">
              The scheduler ticks hourly and re-runs each enabled source on its interval.
              Use this to keep monitoring fresh without clicking <span className="text-x-ink">Run</span> by hand.
              <span className="text-x-faint/60"> Last-scan timestamps reflect the most recent successful run.</span>
            </div>

            <div className="flex items-center justify-between">
              <Eyebrow>Per-source cadence</Eyebrow>
              {anyDirty && (
                <button onClick={saveSchedules} disabled={schedSaving} className={PRIMARY_BTN}>
                  {schedSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Save changes
                </button>
              )}
            </div>

            <div className="rounded-md border border-x-line/60 overflow-hidden divide-y divide-x-line/40">
              {obsSources.map((s) => (
                <div key={s.source} className="px-3 py-2.5 flex items-center gap-3 hover:bg-x-surface-2/30 transition-colors">
                  <button
                    onClick={() => updateSched(s.source, 'enabled', !s.enabled)}
                    className={`shrink-0 w-2 h-2 rounded-full ${s.enabled ? 'bg-x-good' : 'border-[1.5px] border-x-faint bg-transparent'}`}
                    title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  />
                  <div className="text-xs text-x-ink capitalize w-24 shrink-0">{s.source}</div>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="text-x-faint">every</span>
                    <input
                      type="number" min={1} max={168}
                      value={s.interval_hours}
                      onChange={(e) => updateSched(s.source, 'interval_hours', parseInt(e.target.value) || 24)}
                      className="w-14 bg-x-surface-2 border border-x-line/60 focus:border-x-accent/40 focus:outline-none rounded px-1.5 py-0.5 text-xs font-mono"
                    />
                    <span className="text-x-faint">hrs</span>
                  </div>
                  <div className="flex-1 text-right text-[11px] text-x-faint tabular-nums">
                    {s.last_scan_at ? (
                      <span><Timer className="w-2.5 h-2.5 inline mr-1 opacity-60" />last: {String(s.last_scan_at).slice(0, 16)}</span>
                    ) : (
                      <span className="opacity-60">never run</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-x-faint">
              Scheduler is global (1 worker, 60-second tick). When multiple sources are due, they run sequentially per workspace.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
