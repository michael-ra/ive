import { useState, useEffect, useCallback } from 'react'
import {
  X, RefreshCw, Sparkles, Plus, Trash2, Telescope,
  Loader2, Save, Edit3, Eye, MessageSquare,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

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

function SectionHeader({ children, action }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider">{children}</div>
      {action}
    </div>
  )
}

export default function SmartObservatoryPanel({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const [tab, setTab] = useState('profile')
  const [profile, setProfile] = useState(null)
  const [profileDraft, setProfileDraft] = useState({})
  const [editingSection, setEditingSection] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileBuilding, setProfileBuilding] = useState(false)

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
    setProfileBuilding(true)
    try {
      const r = await api.regenerateObservatoryProfile(activeWorkspaceId)
      setProfile(r || null)
      setProfileDraft((r && r.profile) || {})
    } catch (err) { alert('Profile build failed: ' + err.message) }
    setProfileBuilding(false)
  }

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
      <div className="fixed inset-0 z-50 bg-bg-deep/95 flex items-center justify-center">
        <div className="text-text-faint">Select a workspace first.</div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg-deep/95 flex">
      <div className="flex-1 max-w-5xl mx-auto my-8 bg-bg-base border border-border-base rounded-md flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-base">
          <div className="flex items-center gap-2">
            <Telescope className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-medium">Smart Observatory</span>
          </div>
          <button onClick={onClose} className="text-text-faint hover:text-text-base">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex border-b border-border-base text-xs">
          {[
            ['profile', 'Profile'],
            ['targets', 'Curated Targets'],
            ['insights', 'Insights'],
            ['scan', 'Run Smart Scan'],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 ${
                tab === k ? 'text-text-base border-b border-cyan-400' : 'text-text-faint hover:text-text-base'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-sm">
          {tab === 'profile' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-text-faint">
                  {profile?.last_built_at
                    ? `Built ${new Date(profile.last_built_at).toLocaleString()}`
                    : 'No profile yet — build one to enable smart scans.'}
                </div>
                <button
                  onClick={buildProfile}
                  disabled={profileBuilding || profileLoading}
                  className="px-3 py-1 text-xs bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 rounded flex items-center gap-1.5"
                >
                  {profileBuilding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {profile ? 'Rebuild from sources' : 'Build profile'}
                </button>
              </div>

              {Object.keys(SECTION_LABEL).map((section) => {
                const text = profileDraft[section] || ''
                const editing = editingSection === section
                return (
                  <div key={section} className="border border-border-base rounded p-3">
                    <SectionHeader
                      action={
                        editing ? (
                          <button
                            onClick={() => saveProfileSection(section)}
                            className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                          >
                            <Save className="w-3 h-3" /> Save
                          </button>
                        ) : (
                          <button
                            onClick={() => setEditingSection(section)}
                            className="text-xs text-text-faint hover:text-text-base flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" /> Edit
                          </button>
                        )
                      }
                    >
                      {SECTION_LABEL[section]}
                    </SectionHeader>
                    {editing ? (
                      <textarea
                        value={text}
                        onChange={(e) =>
                          setProfileDraft({ ...profileDraft, [section]: e.target.value })
                        }
                        className="w-full bg-bg-deep border border-border-base rounded p-2 text-xs min-h-[80px] font-mono"
                      />
                    ) : (
                      <div className="text-xs text-text-base whitespace-pre-wrap leading-relaxed">
                        {text || <span className="text-text-faint italic">empty</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'targets' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Source:</span>
                <select
                  value={targetSourceFilter}
                  onChange={(e) => setTargetSourceFilter(e.target.value)}
                  className="bg-bg-deep border border-border-base rounded px-2 py-1"
                >
                  <option value="all">All</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {targetSourceFilter !== 'all' && (
                  <button
                    onClick={() => planTargets(targetSourceFilter)}
                    disabled={planning === targetSourceFilter}
                    className="ml-auto px-2 py-1 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 rounded flex items-center gap-1.5"
                  >
                    {planning === targetSourceFilter ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Plan with LLM
                  </button>
                )}
              </div>

              {planResult && (
                <div className="border border-cyan-500/30 bg-cyan-500/5 rounded p-2 text-[11px]">
                  <div className="font-medium text-cyan-300 mb-1">
                    Plan for {planResult.source}: +{(planResult.added || []).length} added, {(planResult.retired || []).length} retired
                  </div>
                  {(planResult.added || []).map((t, i) => (
                    <div key={i} className="text-text-faint">+ {t.target_type}: <span className="text-text-base">{t.value}</span> — {t.rationale}</div>
                  ))}
                </div>
              )}

              <div className="border border-border-base rounded p-3 space-y-2">
                <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider">Add target</div>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  <select
                    value={targetForm.source}
                    onChange={(e) => {
                      const src = e.target.value
                      const types = TARGET_TYPES_BY_SOURCE[src] || ['search_query']
                      setTargetForm({ ...targetForm, source: src, target_type: types[0] })
                    }}
                    className="bg-bg-deep border border-border-base rounded px-2 py-1"
                  >
                    {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select
                    value={targetForm.target_type}
                    onChange={(e) => setTargetForm({ ...targetForm, target_type: e.target.value })}
                    className="bg-bg-deep border border-border-base rounded px-2 py-1"
                  >
                    {(TARGET_TYPES_BY_SOURCE[targetForm.source] || []).map((t) =>
                      <option key={t} value={t}>{t}</option>
                    )}
                  </select>
                  <input
                    placeholder="value (e.g. r/MachineLearning)"
                    value={targetForm.value}
                    onChange={(e) => setTargetForm({ ...targetForm, value: e.target.value })}
                    className="bg-bg-deep border border-border-base rounded px-2 py-1"
                  />
                  <button
                    onClick={addTarget}
                    className="bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 rounded flex items-center justify-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                </div>
                <input
                  placeholder="rationale (why this source matters)"
                  value={targetForm.rationale}
                  onChange={(e) => setTargetForm({ ...targetForm, rationale: e.target.value })}
                  className="w-full bg-bg-deep border border-border-base rounded px-2 py-1 text-xs"
                />
              </div>

              <div className="border border-border-base rounded">
                <div className="grid grid-cols-[80px_90px_1fr_60px_60px_70px_70px] text-[10px] uppercase tracking-wider text-text-faint border-b border-border-base px-2 py-1.5">
                  <div>Source</div><div>Type</div><div>Value</div>
                  <div className="text-right">Hits</div><div className="text-right">Yields</div>
                  <div className="text-right">Signal</div><div></div>
                </div>
                {targets.length === 0 && (
                  <div className="text-center text-text-faint text-xs py-6">
                    No targets yet. Use "Plan with LLM" or add manually.
                  </div>
                )}
                {targets.map((t) => (
                  <div key={t.id} className="grid grid-cols-[80px_90px_1fr_60px_60px_70px_70px] items-center border-b border-border-base/50 px-2 py-1.5 text-xs">
                    <div className="text-text-faint">{t.source}</div>
                    <div className="text-text-faint">{t.target_type}</div>
                    <div className="truncate">
                      <button
                        onClick={() => toggleTarget(t)}
                        className={`mr-1.5 ${t.status === 'active' ? 'text-emerald-400' : 'text-text-faint'}`}
                        title={t.status}
                      >●</button>
                      {t.value}
                      {t.rationale && <span className="text-text-faint ml-1.5 italic">— {t.rationale}</span>}
                    </div>
                    <div className="text-right tabular-nums">{t.hit_count || 0}</div>
                    <div className="text-right tabular-nums">{t.yield_count || 0}</div>
                    <div className="text-right tabular-nums flex items-center justify-end gap-1">
                      <StatusDot score={t.signal_score || 0} />
                      {(t.signal_score || 0).toFixed(2)}
                    </div>
                    <div className="text-right">
                      <button onClick={() => deleteTarget(t)} className="text-text-faint hover:text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'insights' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-faint">Type:</span>
                <select
                  value={insightTypeFilter}
                  onChange={(e) => setInsightTypeFilter(e.target.value)}
                  className="bg-bg-deep border border-border-base rounded px-2 py-1"
                >
                  <option value="all">All</option>
                  {INSIGHT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              {insights.length === 0 && (
                <div className="text-center text-text-faint text-xs py-6">
                  No insights yet. Run a smart scan to populate.
                </div>
              )}

              {insights.map((i) => {
                let evidenceCount = 0
                if (Array.isArray(i.evidence)) evidenceCount = i.evidence.length
                else if (typeof i.evidence === 'string') {
                  try { const arr = JSON.parse(i.evidence); evidenceCount = Array.isArray(arr) ? arr.length : 0 } catch {}
                }
                return (
                  <div key={i.id} className="border border-border-base rounded p-3 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-text-base">{i.name}</span>
                      <span className="text-[10px] text-text-faint uppercase">{i.insight_type}</span>
                      <StatusDot score={i.strength || 0} />
                      <span className="tabular-nums text-text-faint">{(i.strength || 0).toFixed(2)}</span>
                      <button
                        onClick={() => deleteInsight(i)}
                        className="ml-auto text-text-faint hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap text-text-base">{i.summary}</div>
                    {evidenceCount > 0 && (
                      <div className="text-[10px] text-text-faint mt-1">
                        {evidenceCount} evidence finding{evidenceCount === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'scan' && (
            <div className="space-y-3">
              <div className="text-xs text-text-faint">
                Smart scan = profile-aware planner → scrape per target → batched triage → deep analyze + voice extract → insight merge.
                Requires a built profile.
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SOURCES.map((s) => (
                  <button
                    key={s}
                    onClick={() => runSmartScan(s)}
                    disabled={scanRunning != null}
                    className="border border-border-base hover:border-cyan-500/50 rounded p-3 text-left flex items-center justify-between"
                  >
                    <span className="text-sm">{s}</span>
                    {scanRunning === s ? (
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                    ) : (
                      <RefreshCw className="w-3 h-3 text-text-faint" />
                    )}
                  </button>
                ))}
                <button
                  onClick={() => runSmartScan('all')}
                  disabled={scanRunning != null}
                  className="col-span-2 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 rounded p-3 flex items-center justify-center gap-2"
                >
                  {scanRunning === 'all' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  Scan all sources
                </button>
              </div>

              {scanResults.length > 0 && (
                <div className="border border-border-base rounded p-3 space-y-2">
                  <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider">Last results</div>
                  {scanResults.map((r, i) => (
                    <div key={i} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.source}</span>
                        <span className={r.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}>
                          {r.status}
                        </span>
                      </div>
                      <div className="text-text-faint text-[11px]">
                        targets: {r.targets_scanned || 0} · scraped: {r.items_scraped || 0} · findings: {r.findings_created || 0} · insights touched: {r.insights_touched || 0}
                      </div>
                      {r.error && <div className="text-red-400 text-[11px]">{r.error}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
