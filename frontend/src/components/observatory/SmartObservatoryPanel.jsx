import { useState, useEffect, useCallback } from 'react'
import {
  X, RefreshCw, Sparkles, Plus, Trash2, Telescope,
  Loader2, Check, Pencil,
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
  const cls =
    score >= 0.7 ? 'bg-emerald-400'
    : score >= 0.4 ? 'bg-amber-400'
    : score > 0 ? 'bg-red-400/70'
    : 'bg-zinc-700'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
}

function StatusPill({ score }) {
  const tone =
    score >= 0.7 ? 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20'
    : score >= 0.4 ? 'text-amber-300 bg-amber-400/10 border-amber-400/20'
    : score > 0 ? 'text-red-300 bg-red-400/10 border-red-400/20'
    : 'text-text-faint bg-zinc-700/20 border-zinc-700/40'
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] tabular-nums ${tone}`}>
      <StatusDot score={score} />
      {(score || 0).toFixed(2)}
    </span>
  )
}

function Eyebrow({ children, action, className = '' }) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="text-[10px] font-medium text-text-faint uppercase tracking-[0.12em]">{children}</div>
      {action}
    </div>
  )
}

const PRIMARY_BTN = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 rounded transition-colors'
const GHOST_BTN = 'inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs text-text-faint hover:text-text-base hover:bg-bg-deep/60 rounded transition-colors'
const INPUT_BASE = 'bg-bg-deep border border-border-base focus:border-cyan-500/40 focus:outline-none rounded px-2 py-1.5 text-xs'

export default function SmartObservatoryPanel({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const [tab, setTab] = useState('profile')
  const [profile, setProfile] = useState(null)
  const [profileDraft, setProfileDraft] = useState({})
  const [editingSection, setEditingSection] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [, setBuildTick] = useState(0)
  const profileBuilding = activeWorkspaceId
    ? inFlightProfileBuilds.has(activeWorkspaceId)
    : false

  // Subscribe to module-level build state so this panel re-renders when
  // another mount of the panel (or the backend bus event below) toggles it.
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

  const [scanRunning, setScanRunning] = useState(null)
  const [scanResults, setScanResults] = useState([])

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

  useEffect(() => { loadProfile() }, [loadProfile])
  useEffect(() => { loadTargets() }, [loadTargets])
  useEffect(() => { loadInsights() }, [loadInsights])

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
    setScanRunning(source)
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
    setScanRunning(null)
  }

  const deleteInsight = async (i) => {
    if (!confirm(`Remove insight "${i.key}"?`)) return
    try { await api.deleteObservatoryInsight(i.id); loadInsights() }
    catch (err) { alert('Delete failed: ' + err.message) }
  }

  if (!activeWorkspaceId) {
    return (
      <div className="fixed inset-0 z-50 bg-bg-deep/80 backdrop-blur-sm flex items-center justify-center">
        <div className="text-text-faint">Select a workspace first.</div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg-deep/80 backdrop-blur-sm flex" onClick={onClose}>
      <div
        className="flex-1 max-w-4xl mx-auto my-10 bg-bg-base border border-border-base rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-border-base">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-md bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
              <Telescope className="w-4 h-4 text-cyan-300" />
            </div>
            <div>
              <div className="text-sm font-medium leading-tight">Smart Observatory</div>
              <div className="text-[11px] text-text-faint mt-0.5">Profile-aware competitive scanning across web sources</div>
            </div>
          </div>
          <button onClick={onClose} className="text-text-faint hover:text-text-base p-1 -m-1 rounded hover:bg-bg-deep/60 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-4 pt-2 border-b border-border-base">
          {[
            ['profile', 'Profile'],
            ['targets', 'Curated Targets'],
            ['insights', 'Insights'],
            ['scan', 'Smart Scan'],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`relative px-3 py-2 text-xs transition-colors ${
                tab === k ? 'text-text-base' : 'text-text-faint hover:text-text-base'
              }`}
            >
              {label}
              {tab === k && (
                <span className="absolute left-2 right-2 -bottom-px h-px bg-cyan-400" />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 text-sm">
          {tab === 'profile' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4 p-3 rounded-md bg-bg-deep/40 border border-border-base/60">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${profile?.last_built_at ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="text-text-base">
                    {profile?.last_built_at ? 'Profile ready' : 'No profile yet'}
                  </span>
                  <span className="text-text-faint">
                    {profile?.last_built_at
                      ? `· built ${new Date(profile.last_built_at).toLocaleString()}`
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

              <div className="divide-y divide-border-base/60 border border-border-base/60 rounded-md overflow-hidden">
                {Object.keys(SECTION_LABEL).map((section) => {
                  const text = profileDraft[section] || ''
                  const editing = editingSection === section
                  return (
                    <div key={section} className="px-4 py-3 hover:bg-bg-deep/30 transition-colors group">
                      <Eyebrow
                        className="mb-1.5"
                        action={
                          editing ? (
                            <button onClick={() => saveProfileSection(section)} className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                              <Check className="w-3 h-3" /> Save
                            </button>
                          ) : (
                            <button
                              onClick={() => setEditingSection(section)}
                              className="inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-base opacity-0 group-hover:opacity-100 transition-opacity"
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
                          className="w-full bg-bg-deep border border-border-base focus:border-cyan-500/40 focus:outline-none rounded p-2 text-xs min-h-[90px] font-mono leading-relaxed"
                        />
                      ) : (
                        <div className="text-xs text-text-base whitespace-pre-wrap leading-relaxed">
                          {text || <span className="text-text-faint italic">empty — click Edit to fill in</span>}
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
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-text-faint">Source</span>
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
                  <span className="text-[11px] text-text-faint tabular-nums">{targets.length} target{targets.length === 1 ? '' : 's'}</span>
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
                <div className="border-l-2 border-cyan-500/50 bg-cyan-500/5 rounded-r px-3 py-2 text-[11px]">
                  <div className="font-medium text-cyan-300 mb-1">
                    Plan for {planResult.source}: +{(planResult.added || []).length} added · {(planResult.retired || []).length} retired
                  </div>
                  {(planResult.added || []).map((t, i) => (
                    <div key={i} className="text-text-faint leading-relaxed">
                      <span className="text-emerald-400">+</span> <span className="text-text-faint">{t.target_type}:</span>{' '}
                      <span className="text-text-base">{t.value}</span>
                      {t.rationale && <span className="text-text-faint"> — {t.rationale}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-md border border-border-base/60 overflow-hidden">
                <div className="grid grid-cols-[80px_100px_1fr_56px_56px_84px_36px] text-[10px] uppercase tracking-[0.12em] text-text-faint bg-bg-deep/40 border-b border-border-base/60 px-3 py-2">
                  <div>Source</div><div>Type</div><div>Value</div>
                  <div className="text-right">Hits</div><div className="text-right">Yields</div>
                  <div className="text-right">Signal</div><div></div>
                </div>
                {targets.length === 0 ? (
                  <div className="text-center text-text-faint text-xs py-10">
                    No targets yet. Use <span className="text-cyan-300">Plan with LLM</span> or add one below.
                  </div>
                ) : targets.map((t, idx) => (
                  <div
                    key={t.id}
                    className={`grid grid-cols-[80px_100px_1fr_56px_56px_84px_36px] items-center px-3 py-2 text-xs hover:bg-bg-deep/30 transition-colors ${idx > 0 ? 'border-t border-border-base/40' : ''}`}
                  >
                    <div className="text-text-faint">{t.source}</div>
                    <div className="text-text-faint">{t.target_type}</div>
                    <div className="truncate flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => toggleTarget(t)}
                        title={t.status === 'active' ? 'Active — click to pause' : 'Paused — click to activate'}
                        className={`shrink-0 w-1.5 h-1.5 rounded-full ${t.status === 'active' ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                      />
                      <span className="truncate text-text-base">{t.value}</span>
                      {t.rationale && <span className="text-text-faint truncate">— {t.rationale}</span>}
                    </div>
                    <div className="text-right tabular-nums text-text-faint">{t.hit_count || 0}</div>
                    <div className="text-right tabular-nums text-text-faint">{t.yield_count || 0}</div>
                    <div className="flex justify-end"><StatusPill score={t.signal_score || 0} /></div>
                    <div className="text-right">
                      <button onClick={() => deleteTarget(t)} className="text-text-faint hover:text-red-400 p-1 -m-1 rounded">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-md border border-border-base/60 p-3 space-y-2">
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
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[10px] uppercase tracking-[0.12em] text-text-faint">Type</span>
                <select
                  value={insightTypeFilter}
                  onChange={(e) => setInsightTypeFilter(e.target.value)}
                  className={INPUT_BASE}
                >
                  <option value="all">All types</option>
                  {INSIGHT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
                <span className="ml-auto text-[11px] text-text-faint tabular-nums">{insights.length} insight{insights.length === 1 ? '' : 's'}</span>
              </div>

              {insights.length === 0 ? (
                <div className="text-center text-text-faint text-xs py-12 border border-dashed border-border-base/60 rounded-md">
                  No insights yet. Run a smart scan to populate.
                </div>
              ) : (
                <div className="space-y-2">
                  {insights.map((i) => {
                    let evidenceCount = 0
                    if (Array.isArray(i.evidence)) evidenceCount = i.evidence.length
                    else if (typeof i.evidence === 'string') {
                      try { const arr = JSON.parse(i.evidence); evidenceCount = Array.isArray(arr) ? arr.length : 0 } catch {}
                    }
                    return (
                      <div key={i.id} className="rounded-md border border-border-base/60 hover:border-border-base transition-colors p-3 text-xs group">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-medium text-text-base">{i.name}</span>
                          <span className="text-[10px] text-text-faint uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-deep/60">
                            {(i.insight_type || '').replace('_', ' ')}
                          </span>
                          <StatusPill score={i.strength || 0} />
                          <button
                            onClick={() => deleteInsight(i)}
                            className="ml-auto text-text-faint hover:text-red-400 p-1 -m-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="whitespace-pre-wrap text-text-base leading-relaxed">{i.summary}</div>
                        {evidenceCount > 0 && (
                          <div className="text-[10px] text-text-faint mt-2 flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-text-faint/60" />
                            {evidenceCount} evidence finding{evidenceCount === 1 ? '' : 's'}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'scan' && (
            <div className="space-y-4">
              <div className="text-[11px] text-text-faint leading-relaxed p-3 rounded-md bg-bg-deep/40 border border-border-base/60">
                <div className="text-text-base text-xs font-medium mb-1">How it works</div>
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
                        className="border border-border-base/60 hover:border-cyan-500/40 hover:bg-bg-deep/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-md px-3 py-2.5 text-left flex items-center justify-between transition-colors"
                      >
                        <span className="text-sm capitalize">{s}</span>
                        {running ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5 text-text-faint" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {scanResults.length > 0 && (
                <div className="rounded-md border border-border-base/60 overflow-hidden">
                  <div className="px-3 py-2 bg-bg-deep/40 border-b border-border-base/60">
                    <Eyebrow>Last results</Eyebrow>
                  </div>
                  <div className="divide-y divide-border-base/40">
                    {scanResults.map((r, i) => (
                      <div key={i} className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium capitalize">{r.source}</span>
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                            r.status === 'completed'
                              ? 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10'
                              : 'text-amber-300 border-amber-400/30 bg-amber-400/10'
                          }`}>
                            {r.status}
                          </span>
                        </div>
                        <div className="text-text-faint text-[11px] mt-1 tabular-nums">
                          {r.targets_scanned || 0} targets · {r.items_scraped || 0} scraped · {r.findings_created || 0} findings · {r.insights_touched || 0} insights touched
                        </div>
                        {r.error && <div className="text-red-400 text-[11px] mt-1">{r.error}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
