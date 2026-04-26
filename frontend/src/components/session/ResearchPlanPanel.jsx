import { useState } from 'react'
import { X, Plus, Trash2, Play, Loader2, Send, Lightbulb, Globe, Shuffle, Users, Tag } from 'lucide-react'
import { api } from '../../lib/api'

/**
 * ResearchPlanPanel — collaborative research planning.
 *
 * Two modes:
 * 1. **Plan mode**: Enter a query → decompose into editable plan → review/edit → launch
 * 2. **Steer mode**: Inject sub-queries into a running research job mid-flight
 */
export default function ResearchPlanPanel({ onClose, onLaunch, activeJobId, activeWorkspaceId }) {
  const [query, setQuery] = useState('')
  const [plan, setPlan] = useState(null) // { sub_queries, reformulations, cross_domain_queries, key_entities }
  const [loading, setLoading] = useState(false)
  const [steerInput, setSteerInput] = useState('')
  const [steerSending, setSteerSending] = useState(false)
  const [steerHistory, setSteerHistory] = useState([])

  // ── Plan decomposition ──────────────────────────────────────

  const handleDecompose = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const res = await api.decomposeResearchPlan(query.trim())
      setPlan(res?.plan || { sub_queries: [query], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } catch (err) {
      setPlan({ sub_queries: [query], reformulations: [], cross_domain_queries: [], key_entities: [] })
    } finally {
      setLoading(false)
    }
  }

  // ── Plan editing helpers ────────────────────────────────────

  const updateList = (key, idx, value) => {
    setPlan(p => ({ ...p, [key]: p[key].map((v, i) => i === idx ? value : v) }))
  }
  const removeFromList = (key, idx) => {
    setPlan(p => ({ ...p, [key]: p[key].filter((_, i) => i !== idx) }))
  }
  const addToList = (key, value = '') => {
    setPlan(p => ({ ...p, [key]: [...(p[key] || []), value] }))
  }

  // ── Launch research with edited plan ────────────────────────

  const handleLaunch = () => {
    if (!plan || !query.trim()) return
    onLaunch?.({
      query: query.trim(),
      plan,
      workspace_id: activeWorkspaceId,
    })
  }

  // ── Steer running job ───────────────────────────────────────

  const handleSteer = async () => {
    if (!steerInput.trim() || !activeJobId) return
    const queries = steerInput.split('\n').map(q => q.trim()).filter(Boolean)
    if (!queries.length) return
    setSteerSending(true)
    try {
      await api.steerResearchJob(activeJobId, queries)
      setSteerHistory(prev => [...prev, ...queries])
      setSteerInput('')
    } catch (err) {
      // ignore
    } finally {
      setSteerSending(false)
    }
  }

  // ── Section renderer for plan lists ─────────────────────────

  const PlanSection = ({ title, icon: Icon, iconColor, listKey, placeholder }) => {
    const items = plan?.[listKey] || []
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Icon size={11} className={iconColor} />
          <span className="text-[10px] font-medium text-text-faint uppercase tracking-wider">{title}</span>
          <span className="text-[10px] text-text-faint">({items.length})</span>
          <button onClick={() => addToList(listKey, '')} className="ml-auto p-0.5 text-text-faint hover:text-text-secondary rounded hover:bg-bg-hover transition-colors">
            <Plus size={10} />
          </button>
        </div>
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input
              value={item}
              onChange={(e) => updateList(listKey, idx, e.target.value)}
              placeholder={placeholder}
              className="flex-1 px-2 py-1 text-[11px] bg-bg-inset border border-border-secondary rounded text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
            />
            <button onClick={() => removeFromList(listKey, idx)} className="p-0.5 text-text-faint hover:text-red-400 transition-colors">
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50" onClick={onClose}>
      <div className="w-[620px] max-h-[78vh] ide-panel overflow-hidden flex flex-col scale-in" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Lightbulb size={14} className="text-amber-400" />
          <span className="text-xs text-text-primary font-medium">Research Plan</span>
          <span className="text-[10px] text-text-faint">
            {activeJobId ? 'steer running job' : 'plan before launching'}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Query input + decompose */}
          {!activeJobId && (
            <div className="space-y-2">
              <textarea
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleDecompose() } }}
                placeholder="Enter your research question..."
                rows={2}
                className="w-full px-3 py-2 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDecompose}
                  disabled={loading || !query.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-md transition-colors disabled:opacity-40"
                >
                  {loading ? <Loader2 size={11} className="animate-spin" /> : <Shuffle size={11} />}
                  {loading ? 'Decomposing...' : 'Decompose'}
                </button>
                <span className="text-[10px] text-text-faint">⌘↵ to decompose</span>
              </div>
            </div>
          )}

          {/* Editable plan */}
          {plan && !activeJobId && (
            <div className="space-y-3 border border-border-secondary rounded-md p-3 bg-bg-elevated">
              <PlanSection title="Sub-Queries" icon={Globe} iconColor="text-cyan-400" listKey="sub_queries" placeholder="specific search query..." />
              <PlanSection title="Reformulations" icon={Shuffle} iconColor="text-purple-400" listKey="reformulations" placeholder="different vocabulary for same concept..." />
              <PlanSection title="Cross-Domain" icon={Users} iconColor="text-green-400" listKey="cross_domain_queries" placeholder="analogous concept in another field..." />
              <PlanSection title="Key Entities" icon={Tag} iconColor="text-amber-400" listKey="key_entities" placeholder="person, algorithm, framework..." />

              <div className="pt-2 border-t border-border-secondary">
                <button
                  onClick={handleLaunch}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 border border-cyan-500/25 rounded-md transition-colors"
                >
                  <Play size={11} /> Launch Research with Plan
                </button>
              </div>
            </div>
          )}

          {/* Steer running job */}
          {activeJobId && (
            <div className="space-y-3">
              <div className="text-[10px] text-text-faint">
                Inject additional sub-queries into the running research job. One per line.
              </div>
              <textarea
                value={steerInput}
                onChange={e => setSteerInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSteer() } }}
                placeholder={"e.g. latest 2025 benchmarks for ...\nalternative approaches to ..."}
                rows={3}
                className="w-full px-3 py-2 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSteer}
                  disabled={steerSending || !steerInput.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-md transition-colors disabled:opacity-40"
                >
                  {steerSending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                  Inject Queries
                </button>
                <span className="text-[10px] text-text-faint">⌘↵ to send</span>
              </div>

              {steerHistory.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[10px] text-text-faint font-medium uppercase tracking-wider">Injected</span>
                  {steerHistory.map((q, i) => (
                    <div key={i} className="text-[11px] text-text-muted font-mono px-2 py-1 bg-bg-inset rounded border border-border-secondary">
                      {q}
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
