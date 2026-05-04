import { useState, useEffect, useCallback } from 'react'
import {
  Shield, X, Plus, Trash2, Check, AlertTriangle, Ban,
  HelpCircle, ChevronDown, ChevronRight, Pencil,
  Sparkles, ToggleLeft, ToggleRight, RefreshCw, ShieldCheck,
  Terminal, Package, Globe, Search, Lock, Brain,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const SEVERITY_COLORS = {
  critical: 'text-red-400 bg-red-500/15 border-red-500/25',
  high: 'text-orange-400 bg-orange-500/15 border-orange-500/25',
  medium: 'text-yellow-400 bg-yellow-500/15 border-yellow-500/25',
  low: 'text-blue-400 bg-blue-500/15 border-blue-500/25',
}

const CATEGORY_COLORS = {
  dangerous_command: 'text-red-400',
  protected_path: 'text-orange-400',
  credential: 'text-amber-400',
  destructive_git: 'text-purple-400',
  sql_destructive: 'text-pink-400',
  network: 'text-cyan-400',
  custom: 'text-emerald-400',
}

const CATEGORY_LABELS = {
  dangerous_command: 'Commands',
  protected_path: 'Paths',
  credential: 'Credentials',
  destructive_git: 'Git',
  sql_destructive: 'SQL',
  network: 'Network',
  custom: 'Custom',
}

const ACTION_ICONS = {
  deny: Ban,
  ask: HelpCircle,
  allow: Check,
}

function extractHost(summary) {
  const m = (summary || '').match(/https?:\/\/([^\s/:]+(?::\d+)?)/)
  return m ? m[1] : null
}

export default function SafetyPanel({ onClose }) {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const [tab, setTab] = useState('rules')
  const [rules, setRules] = useState([])
  const [decisions, setDecisions] = useState([])
  // Auto-allow rows would otherwise drown the audit view in routine
  // tool calls (every Read/Bash/etc. an agent issues). Default on.
  const [hideAutoAllow, setHideAutoAllow] = useState(true)
  const [proposals, setProposals] = useState([])
  const [accessLog, setAccessLog] = useState({ entries: [], domains: [] })
  const [accessFilter, setAccessFilter] = useState(null) // null = all, or domain string
  const [commandLog, setCommandLog] = useState([])
  const [commandSearch, setCommandSearch] = useState('')
  const [packageScans, setPackageScans] = useState([])
  const [scriptPolicy, setScriptPolicy] = useState({ block_all: false, allowlist: [] })
  const [complianceSection, setComplianceSection] = useState('sources') // sources | commands | packages
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [filter, setFilter] = useState('all')
  const [scopeFilter, setScopeFilter] = useState('all') // 'all' | workspace_id | 'global'
  const [mode, setMode] = useState('list') // list | create | edit
  const [editRule, setEditRule] = useState(null)
  const [form, setForm] = useState({
    name: '', description: '', category: 'custom', severity: 'medium',
    tool_match: 'Bash', pattern: '', pattern_field: '', action: 'ask',
    workspace_id: null,
  })

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const wsParam = scopeFilter !== 'all' && scopeFilter !== 'global' ? scopeFilter : undefined
      const [r, s] = await Promise.all([
        api.getSafetyRules(wsParam),
        api.getSafetyStatus(),
      ])
      // Client-side filter for "global only" view
      const filtered = scopeFilter === 'global' ? r.filter(rule => !rule.workspace_id) : r
      setRules(filtered)
      setStatus(s)
    } catch (e) {
      console.error('Failed to load safety data:', e)
    }
    setLoading(false)
  }, [scopeFilter])

  const loadDecisions = useCallback(async () => {
    try {
      const d = await api.getSafetyDecisions({ limit: 100 })
      setDecisions(d)
    } catch (e) { console.error(e) }
  }, [])

  const loadProposals = useCallback(async () => {
    try {
      const p = await api.getSafetyProposals()
      setProposals(p)
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { if (tab === 'decisions') loadDecisions() }, [tab, loadDecisions])
  const loadAccessLog = useCallback(async () => {
    try {
      const params = {}
      if (accessFilter) params.domain = accessFilter
      const data = await api.getExternalAccessLog(params)
      setAccessLog(data)
    } catch (e) { console.error(e) }
  }, [accessFilter])

  const loadCommandLog = useCallback(async () => {
    try {
      const params = {}
      if (commandSearch) params.q = commandSearch
      const data = await api.getCommandLog(params)
      setCommandLog(data)
    } catch (e) { console.error(e) }
  }, [commandSearch])

  const loadPackageScans = useCallback(async () => {
    try {
      const [data, policy] = await Promise.all([
        api.getPackageScans(),
        api.getInstallScriptPolicy(),
      ])
      setPackageScans(data)
      setScriptPolicy(policy)
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { if (tab === 'proposals') loadProposals() }, [tab, loadProposals])
  useEffect(() => {
    if (tab === 'compliance') {
      if (complianceSection === 'sources') loadAccessLog()
      else if (complianceSection === 'commands') loadCommandLog()
      else if (complianceSection === 'packages') loadPackageScans()
    }
  }, [tab, complianceSection, loadAccessLog, loadCommandLog, loadPackageScans])

  const toggleRule = async (rule) => {
    await api.updateSafetyRule(rule.id, { enabled: !rule.enabled })
    loadData()
  }

  const deleteRule = async (id) => {
    if (!confirm('Delete this rule?')) return
    await api.deleteSafetyRule(id)
    loadData()
  }

  const saveRule = async () => {
    if (!form.name.trim() || !form.pattern.trim()) return
    if (editRule) {
      await api.updateSafetyRule(editRule.id, form)
    } else {
      await api.createSafetyRule(form)
    }
    setMode('list')
    setEditRule(null)
    setForm({ name: '', description: '', category: 'custom', severity: 'medium', tool_match: 'Bash', pattern: '', pattern_field: '', action: 'ask', workspace_id: null })
    loadData()
  }

  const startEdit = (rule) => {
    setForm({
      name: rule.name, description: rule.description || '', category: rule.category,
      severity: rule.severity, tool_match: rule.tool_match, pattern: rule.pattern,
      pattern_field: rule.pattern_field || '', action: rule.action,
      workspace_id: rule.workspace_id || null,
    })
    setEditRule(rule)
    setMode('edit')
  }

  const acceptProposal = async (p) => {
    await api.acceptSafetyProposal(p.id, {
      name: `Learned: ${p.tool_name} ${p.suggested_action}`,
      description: p.pattern_summary,
      tool_name: p.tool_name,
      pattern: p.suggested_pattern,
      action: p.suggested_action,
    })
    loadProposals()
    loadData()
  }

  const dismissProposal = async (p) => {
    await api.dismissSafetyProposal(p.id)
    loadProposals()
  }

  const trustHost = async (d) => {
    const host = extractHost(d.tool_input_summary)
    if (!host) return
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await api.createSafetyRule({
      name: `Trusted: ${host}`,
      description: `Auto-trusted from decision log`,
      category: 'network',
      severity: 'low',
      tool_match: 'WebFetch|Bash',
      pattern: `https?://${escaped}`,
      action: 'allow',
      workspace_id: d.workspace_id || activeWorkspaceId || null,
    })
    loadData()
    loadDecisions()
  }

  const allowFromDecision = async (d) => {
    const summary = (d.tool_input_summary || '').trim()
    if (!summary) return
    const toolLower = (d.tool_name || '').toLowerCase()
    let pattern, name, category
    if (['bash', 'execute'].includes(toolLower)) {
      // Extract base command (e.g. "git commit" from "git commit -m 'foo'")
      const parts = summary.split(/\s+/)
      const base = parts[0]
      const compound = ['git', 'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'go']
      const subCmd = compound.includes(base) && parts.length > 1
        ? `${base} ${parts[1]}` : base
      pattern = `^${subCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
      name = `Allowed: ${subCmd}`
      category = 'dangerous_command'
    } else {
      const escaped = summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = escaped
      const short = summary.split('/').pop() || summary
      name = `Allowed: ${d.tool_name} ${short}`
      category = 'custom'
    }
    await api.createSafetyRule({
      name,
      description: 'Auto-allowed from decision log',
      category,
      severity: 'low',
      tool_match: d.tool_name,
      pattern,
      action: 'allow',
      workspace_id: d.workspace_id || activeWorkspaceId || null,
    })
    loadData()
    loadDecisions()
  }

  const filteredRules = filter === 'all' ? rules : rules.filter(r => r.category === filter)
  const categories = ['all', ...new Set(rules.map(r => r.category))]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/50"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-[680px] ide-panel overflow-hidden scale-in max-h-[82vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-primary shrink-0">
          <Shield size={16} className="text-emerald-400" />
          <span className="text-sm font-medium text-text-primary">Safety Gate</span>
          {status?.enabled && (
            <span className="px-1.5 py-0.5 text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 rounded">
              active
            </span>
          )}
          {status && !status.enabled && (
            <span className="px-1.5 py-0.5 text-[10px] bg-zinc-500/15 text-text-faint border border-zinc-500/25 rounded">
              disabled
            </span>
          )}
          <select
            value={scopeFilter}
            onChange={e => setScopeFilter(e.target.value)}
            className="text-[10px] px-1.5 py-0.5 bg-bg-tertiary border border-border-secondary rounded text-text-secondary outline-none cursor-pointer"
          >
            <option value="all">All scopes</option>
            <option value="global">Global only</option>
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
          <span className="text-[10px] text-text-faint ml-auto">
            {status ? `${status.rule_count} rules, ${status.decision_count} evaluations` : ''}
          </span>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded text-text-secondary">
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-2 border-b border-border-secondary shrink-0">
          {[
            ['rules', 'Rules', rules.length],
            ['decisions', 'Decision Log', decisions.length],
            ['proposals', 'Proposed', proposals.length],
            ['compliance', 'Compliance', accessLog.entries.length + commandLog.length + packageScans.length],
          ].map(([key, label, count]) => (
            <button key={key}
              onClick={() => { setTab(key); setMode('list') }}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-t border-b-2 transition-colors ${
                tab === key
                  ? 'text-text-primary border-accent-primary'
                  : 'text-text-secondary border-transparent hover:text-text-primary'
              }`}
            >
              {label}
              {count > 0 && <span className="ml-1 text-text-faint">({count})</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4">
          {!status?.enabled && (
            <div className="flex items-center gap-2 p-3 mb-4 rounded border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-400">
              <AlertTriangle size={14} />
              <span>Safety Gate is disabled. Enable it in Experimental Features to activate protection.</span>
            </div>
          )}

          {/* ── Rules tab ── */}
          {tab === 'rules' && mode === 'list' && (
            <div className="space-y-2">
              {/* Category filters */}
              <div className="flex gap-1 flex-wrap mb-3">
                {categories.map(c => (
                  <button key={c} onClick={() => setFilter(c)}
                    className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                      filter === c
                        ? 'bg-accent-primary/20 text-accent-primary border-accent-primary/40'
                        : 'bg-bg-tertiary text-text-secondary border-border-secondary hover:border-border-primary'
                    }`}
                  >
                    {c === 'all' ? 'All' : CATEGORY_LABELS[c] || c}
                  </button>
                ))}
                <button onClick={() => { setMode('create'); setEditRule(null); setForm({ name: '', description: '', category: 'custom', severity: 'medium', tool_match: 'Bash', pattern: '', pattern_field: '', action: 'ask', workspace_id: scopeFilter !== 'all' && scopeFilter !== 'global' ? scopeFilter : null }) }}
                  className="px-2 py-0.5 text-[10px] rounded border border-dashed border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 ml-auto"
                >
                  <Plus size={10} className="inline mr-0.5" /> New Rule
                </button>
              </div>

              {/* Rule list */}
              {filteredRules.map(rule => {
                const ActionIcon = ACTION_ICONS[rule.action] || HelpCircle
                const isExpanded = expanded === rule.id
                return (
                  <div key={rule.id} className={`border rounded ${rule.enabled ? 'border-border-secondary' : 'border-border-secondary/50 opacity-50'} bg-bg-secondary`}>
                    <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-bg-hover/50"
                         onClick={() => setExpanded(isExpanded ? null : rule.id)}>
                      {/* Toggle */}
                      <button onClick={e => { e.stopPropagation(); toggleRule(rule) }}
                        className={`w-7 h-4 rounded-full relative transition-colors shrink-0 ${rule.enabled ? 'bg-emerald-500' : 'bg-bg-tertiary border border-border-secondary'}`}
                      >
                        <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${rule.enabled ? 'left-[14px]' : 'left-0.5'}`} />
                      </button>

                      {/* Category badge */}
                      <span className={`text-[9px] font-medium uppercase tracking-wider ${CATEGORY_COLORS[rule.category] || 'text-text-faint'}`}>
                        {CATEGORY_LABELS[rule.category] || rule.category}
                      </span>

                      {/* Severity badge */}
                      <span className={`px-1 py-0 text-[9px] rounded border ${SEVERITY_COLORS[rule.severity] || ''}`}>
                        {rule.severity}
                      </span>

                      {/* Action icon */}
                      <ActionIcon size={11} className={rule.action === 'deny' ? 'text-red-400' : rule.action === 'ask' ? 'text-yellow-400' : 'text-emerald-400'} />

                      {/* Name */}
                      <span className="text-[11px] text-text-primary truncate flex-1">{rule.name}</span>

                      {rule.is_builtin ? (
                        <span className="text-[9px] text-text-faint">builtin</span>
                      ) : null}

                      {/* Scope badge */}
                      {rule.workspace_id ? (
                        <span className="text-[9px] text-emerald-400/70 px-1 py-0 bg-emerald-500/8 rounded border border-emerald-500/15 shrink-0">
                          {workspaces.find(w => w.id === rule.workspace_id)?.name || 'workspace'}
                        </span>
                      ) : (
                        <span className="text-[9px] text-blue-400/60 px-1 py-0 bg-blue-500/8 rounded border border-blue-500/15 shrink-0">global</span>
                      )}

                      {isExpanded ? <ChevronDown size={12} className="text-text-faint" /> : <ChevronRight size={12} className="text-text-faint" />}
                    </div>

                    {isExpanded && (
                      <div className="px-3 pb-2 pt-1 border-t border-border-secondary/50 space-y-1">
                        {rule.description && <p className="text-[10px] text-text-secondary">{rule.description}</p>}
                        <div className="flex gap-4 text-[10px] text-text-faint">
                          <span>Tool: <code className="text-text-secondary">{rule.tool_match}</code></span>
                          <span>Pattern: <code className="text-text-secondary">{rule.pattern}</code></span>
                          {rule.pattern_field && <span>Field: <code className="text-text-secondary">{rule.pattern_field}</code></span>}
                        </div>
                        <div className="flex gap-1 mt-1">
                          <button onClick={() => startEdit(rule)}
                            className="px-2 py-0.5 text-[10px] rounded bg-bg-tertiary hover:bg-bg-hover text-text-secondary border border-border-secondary">
                            <Pencil size={9} className="inline mr-0.5" /> Edit
                          </button>
                          {!rule.is_builtin && (
                            <button onClick={() => deleteRule(rule.id)}
                              className="px-2 py-0.5 text-[10px] rounded bg-bg-tertiary hover:bg-red-500/20 text-red-400 border border-border-secondary">
                              <Trash2 size={9} className="inline mr-0.5" /> Delete
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {filteredRules.length === 0 && (
                <div className="text-center py-8 text-[11px] text-text-faint">
                  {rules.length === 0 ? 'No rules yet. Enable Safety Gate in Experimental Features to get started.' : 'No rules match the selected filter.'}
                </div>
              )}
            </div>
          )}

          {/* ── Create/Edit form ── */}
          {tab === 'rules' && (mode === 'create' || mode === 'edit') && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <button onClick={() => { setMode('list'); setEditRule(null) }} className="text-[10px] text-text-secondary hover:text-text-primary">&larr; Back</button>
                <span className="text-[12px] font-medium text-text-primary">{mode === 'edit' ? 'Edit Rule' : 'New Rule'}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">Name</label>
                  <input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                    className="w-full ide-input text-[11px] px-2 py-1.5" placeholder="Rule name" />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({...f, category: e.target.value}))}
                    className="w-full ide-input text-[11px] px-2 py-1.5">
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">Severity</label>
                  <select value={form.severity} onChange={e => setForm(f => ({...f, severity: e.target.value}))}
                    className="w-full ide-input text-[11px] px-2 py-1.5">
                    {['critical', 'high', 'medium', 'low'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">Action</label>
                  <select value={form.action} onChange={e => setForm(f => ({...f, action: e.target.value}))}
                    className="w-full ide-input text-[11px] px-2 py-1.5">
                    <option value="deny">Deny (block)</option>
                    <option value="ask">Ask (prompt user)</option>
                    <option value="allow">Allow (auto-approve)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Description</label>
                <input value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))}
                  className="w-full ide-input text-[11px] px-2 py-1.5" placeholder="What this rule catches" />
              </div>

              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Scope</label>
                <select value={form.workspace_id || ''} onChange={e => setForm(f => ({...f, workspace_id: e.target.value || null}))}
                  className="w-full ide-input text-[11px] px-2 py-1.5">
                  <option value="">Global (all workspaces)</option>
                  {workspaces.map(ws => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
                <span className="text-[9px] text-text-faint">Global rules apply everywhere. Workspace rules apply only to sessions in that workspace.</span>
              </div>

              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Tool Match</label>
                <input value={form.tool_match} onChange={e => setForm(f => ({...f, tool_match: e.target.value}))}
                  className="w-full ide-input text-[11px] px-2 py-1.5 font-mono" placeholder="Bash, Write|Edit, *, etc." />
                <span className="text-[9px] text-text-faint">Pipe-separated tool names or * for all</span>
              </div>

              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Pattern (regex)</label>
                <input value={form.pattern} onChange={e => setForm(f => ({...f, pattern: e.target.value}))}
                  className="w-full ide-input text-[11px] px-2 py-1.5 font-mono" placeholder="rm\s+-rf\s+/" />
                <span className="text-[9px] text-text-faint">Regex matched against tool input (case-insensitive)</span>
              </div>

              <div className="flex gap-2 pt-2">
                <button onClick={saveRule}
                  className="px-3 py-1.5 text-[11px] rounded bg-accent-primary text-white hover:bg-accent-primary/90">
                  <Check size={12} className="inline mr-1" /> {mode === 'edit' ? 'Save' : 'Create'}
                </button>
                <button onClick={() => { setMode('list'); setEditRule(null) }}
                  className="px-3 py-1.5 text-[11px] rounded bg-bg-tertiary text-text-secondary hover:bg-bg-hover border border-border-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── Decision Log tab ── */}
          {tab === 'decisions' && (() => {
            const visible = hideAutoAllow
              ? decisions.filter((d) => !(d.decision === 'allow' && !d.matched_rule_id))
              : decisions
            const hiddenCount = decisions.length - visible.length
            return (
            <div className="space-y-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] text-text-faint">
                  {visible.length} of {decisions.length} evaluations
                  {hiddenCount > 0 && (
                    <span className="text-text-faint/60"> · {hiddenCount} auto-allowed hidden</span>
                  )}
                </span>
                <button
                  onClick={() => setHideAutoAllow(!hideAutoAllow)}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    hideAutoAllow
                      ? 'bg-bg-secondary text-text-faint border-border-secondary hover:text-text-secondary'
                      : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                  }`}
                  title="Auto-allow rows are decisions where no rule matched and the action defaulted to allow — usually routine tool calls."
                >
                  {hideAutoAllow ? 'Show all' : 'Hide auto-allow'}
                </button>
                <button onClick={loadDecisions} className="p-1 hover:bg-bg-hover rounded text-text-faint ml-auto">
                  <RefreshCw size={11} />
                </button>
              </div>

              {visible.map(d => {
                const host = (d.decision === 'ask' || d.decision === 'deny') ? extractHost(d.tool_input_summary) : null
                return (
                <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 rounded bg-bg-secondary border border-border-secondary/50 text-[10px]">
                  <span className={`font-medium ${d.decision === 'deny' ? 'text-red-400' : d.decision === 'ask' ? 'text-yellow-400' : 'text-emerald-400'}`}>
                    {d.decision}
                  </span>
                  <span className="text-text-faint">{d.tool_name}</span>
                  <span className="text-text-secondary truncate flex-1 font-mono">{d.tool_input_summary}</span>
                  {d.user_response && (
                    <span className={`px-1 rounded ${d.user_response === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                      {d.user_response}
                    </span>
                  )}
                  {host && (
                    <button onClick={() => trustHost(d)} title={`Always allow ${host}`}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 shrink-0 flex items-center gap-0.5">
                      <ShieldCheck size={10} /> Trust
                    </button>
                  )}
                  {!host && (d.decision === 'ask' || d.decision === 'deny') && d.tool_input_summary && (
                    <button onClick={() => allowFromDecision(d)} title={`Create allow rule for this ${d.tool_name} pattern`}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 shrink-0 flex items-center gap-0.5">
                      <ShieldCheck size={10} /> Allow
                    </button>
                  )}
                  <span className="text-text-faint shrink-0">{d.latency_ms}ms</span>
                  <span className="text-text-faint shrink-0">{new Date(d.created_at).toLocaleTimeString()}</span>
                </div>
                )
              })}

              {decisions.length === 0 && (
                <div className="text-center py-8 text-[11px] text-text-faint">
                  No decisions recorded yet. Evaluations appear here once the Safety Gate intercepts tool calls.
                </div>
              )}
              {decisions.length > 0 && visible.length === 0 && (
                <div className="text-center py-6 text-[11px] text-text-faint">
                  All {decisions.length} recent decision{decisions.length === 1 ? ' was' : 's were'} auto-allowed.
                  Click "Show all" above to see them.
                </div>
              )}
            </div>
            )
          })()}

          {/* ── Proposals tab ── */}
          {tab === 'proposals' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={13} className="text-amber-400" />
                <span className="text-[11px] text-text-primary">Learned Patterns</span>
                <span className="text-[10px] text-text-faint ml-auto">{proposals.length} proposals</span>
              </div>

              {proposals.map(p => (
                <div key={p.id} className="p-3 rounded border border-border-secondary bg-bg-secondary space-y-2">
                  <p className="text-[11px] text-text-primary">{p.pattern_summary}</p>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="text-text-faint">
                      Suggested: <span className={p.suggested_action === 'allow' ? 'text-emerald-400' : 'text-red-400'}>auto-{p.suggested_action}</span>
                    </span>
                    <span className="text-text-faint">Confidence: {Math.round(p.confidence * 100)}%</span>
                    <span className="text-text-faint">{p.sample_count} samples</span>
                  </div>
                  {/* Confidence bar */}
                  <div className="w-full h-1 bg-bg-tertiary rounded-full overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${p.confidence * 100}%` }} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => acceptProposal(p)}
                      className="px-2 py-1 text-[10px] rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25">
                      <Check size={10} className="inline mr-0.5" /> Accept
                    </button>
                    <button onClick={() => dismissProposal(p)}
                      className="px-2 py-1 text-[10px] rounded bg-bg-tertiary text-text-secondary border border-border-secondary hover:bg-bg-hover">
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}

              {proposals.length === 0 && (
                <div className="text-center py-8 text-[11px] text-text-faint">
                  No patterns detected yet. The learning system proposes rules after observing consistent approve/deny behavior (5+ samples needed).
                </div>
              )}
            </div>
          )}

          {/* ── Compliance tab ── */}
          {tab === 'compliance' && (
            <div className="space-y-3">
              {/* Section switcher */}
              <div className="flex gap-1 mb-1">
                {[
                  ['sources', Globe, 'Sources', accessLog.entries.length],
                  ['commands', Terminal, 'Commands', commandLog.length],
                  ['packages', Package, 'Packages', packageScans.length],
                ].map(([key, Icon, label, count]) => (
                  <button key={key} onClick={() => setComplianceSection(key)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[10px] rounded border transition-colors ${
                      complianceSection === key
                        ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                        : 'bg-bg-tertiary text-text-secondary border-border-secondary hover:border-border-primary'
                    }`}>
                    <Icon size={11} /> {label}
                    {count > 0 && <span className="text-text-faint">({count})</span>}
                  </button>
                ))}
              </div>

              {/* ── Sources section ── */}
              {complianceSection === 'sources' && (<>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-faint">{accessLog.entries.length} entries, {accessLog.domains.length} domains</span>
                  <button onClick={loadAccessLog} className="p-1 hover:bg-bg-hover rounded text-text-faint ml-auto">
                    <RefreshCw size={11} />
                  </button>
                </div>

                {accessLog.domains.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    <button onClick={() => setAccessFilter(null)}
                      className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                        !accessFilter
                          ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                          : 'bg-bg-tertiary text-text-secondary border-border-secondary hover:border-border-primary'
                      }`}>
                      All
                    </button>
                    {accessLog.domains.map(d => (
                      <button key={d.domain || 'unknown'} onClick={() => setAccessFilter(d.domain)}
                        className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                          accessFilter === d.domain
                            ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                            : 'bg-bg-tertiary text-text-secondary border-border-secondary hover:border-border-primary'
                        }`}>
                        {d.domain || 'search'} <span className="text-text-faint ml-0.5">({d.count})</span>
                      </button>
                    ))}
                  </div>
                )}

                {accessLog.entries.map(e => (
                  <div key={e.id} className="flex items-center gap-2 px-3 py-1.5 rounded bg-bg-secondary border border-border-secondary/50 text-[10px]">
                    <span className={`font-medium shrink-0 ${
                      e.source_type === 'webfetch' ? 'text-cyan-400' :
                      e.source_type === 'websearch' ? 'text-violet-400' :
                      'text-amber-400'
                    }`}>
                      {e.source_type}
                    </span>
                    {e.domain && <span className="text-text-faint shrink-0">{e.domain}</span>}
                    <span className="text-text-secondary truncate flex-1 font-mono">{e.url}</span>
                    <span className="text-text-faint shrink-0">{new Date(e.created_at).toLocaleString()}</span>
                  </div>
                ))}

                {accessLog.entries.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-text-faint">
                    No external access recorded yet. URLs from WebFetch, WebSearch, curl, and wget are logged automatically.
                  </div>
                )}
              </>)}

              {/* ── Commands section ── */}
              {complianceSection === 'commands' && (<>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 flex-1 px-2 py-1 bg-bg-tertiary border border-border-secondary rounded">
                    <Search size={11} className="text-text-faint shrink-0" />
                    <input value={commandSearch} onChange={e => setCommandSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') loadCommandLog() }}
                      placeholder="Search commands..."
                      className="bg-transparent text-[10px] text-text-primary outline-none w-full" />
                  </div>
                  <button onClick={loadCommandLog} className="p-1 hover:bg-bg-hover rounded text-text-faint">
                    <RefreshCw size={11} />
                  </button>
                </div>

                {commandLog.map(c => (
                  <div key={c.id} className="px-3 py-1.5 rounded bg-bg-secondary border border-border-secondary/50 text-[10px]">
                    <div className="flex items-center gap-2">
                      <Terminal size={10} className="text-amber-400 shrink-0" />
                      <span className="text-text-secondary truncate flex-1 font-mono">{c.command}</span>
                      <span className="text-text-faint shrink-0">{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}

                {commandLog.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-text-faint">
                    No commands recorded yet. Every Bash command executed by agents is logged here.
                  </div>
                )}
              </>)}

              {/* ── Packages section ── */}
              {complianceSection === 'packages' && (<>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-faint">{packageScans.length} package scans</span>
                  <button onClick={loadPackageScans} className="p-1 hover:bg-bg-hover rounded text-text-faint ml-auto">
                    <RefreshCw size={11} />
                  </button>
                </div>

                {/* ── Install Script Policy ── */}
                <div className="px-3 py-2.5 rounded bg-amber-500/8 border border-amber-500/20 space-y-2">
                  <div className="flex items-center gap-2">
                    <Lock size={12} className="text-amber-400 shrink-0" />
                    <span className="text-[11px] font-medium text-amber-300">Install Script Policy</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">Recommended</span>
                  </div>
                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    Block all packages with install scripts (preinstall, postinstall, build scripts, native extensions) and review case-by-case before adding to the allowlist.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        const next = !scriptPolicy.block_all
                        await api.setInstallScriptPolicy(next)
                        setScriptPolicy(p => ({ ...p, block_all: next }))
                      }}
                      className="flex items-center gap-1.5 text-[10px]"
                    >
                      {scriptPolicy.block_all
                        ? <ToggleRight size={16} className="text-amber-400" />
                        : <ToggleLeft size={16} className="text-text-faint" />}
                      <span className={scriptPolicy.block_all ? 'text-amber-300' : 'text-text-faint'}>
                        {scriptPolicy.block_all ? 'Blocking all install scripts' : 'Not blocking (allow unless flagged)'}
                      </span>
                    </button>
                  </div>

                  {/* ── Allowlist ── */}
                  {scriptPolicy.allowlist.length > 0 && (
                    <div className="mt-1 space-y-1">
                      <span className="text-[9px] text-text-faint uppercase tracking-wide">Allowlisted packages</span>
                      {scriptPolicy.allowlist.map(a => (
                        <div key={a.id} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded bg-bg-primary/50">
                          <Check size={9} className="text-emerald-400 shrink-0" />
                          <span className="text-text-primary">{a.package}</span>
                          <span className="text-text-faint">{a.ecosystem}</span>
                          {a.reason && <span className="text-text-faint truncate max-w-[200px]">{a.reason}</span>}
                          <button
                            onClick={async () => {
                              await api.removeInstallScriptAllowlist(a.id)
                              setScriptPolicy(p => ({ ...p, allowlist: p.allowlist.filter(x => x.id !== a.id) }))
                            }}
                            className="ml-auto p-0.5 hover:bg-red-500/15 rounded text-text-faint hover:text-red-400"
                          >
                            <Trash2 size={9} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {packageScans.map(p => {
                  const isFlagged = p.status === 'flagged'
                  const hasMalware = p.known_malware
                  const hasVulns = p.vuln_count > 0
                  const statusColor = hasMalware ? 'text-red-400 bg-red-500/15 border-red-500/25'
                    : isFlagged ? 'text-orange-400 bg-orange-500/15 border-orange-500/25'
                    : hasVulns ? 'text-yellow-400 bg-yellow-500/15 border-yellow-500/25'
                    : 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25'
                  const decisionColor = p.decision === 'block' || p.decision === 'deny' ? 'text-red-400'
                    : p.decision === 'warn' || p.decision === 'ask' ? 'text-yellow-400'
                    : 'text-emerald-400'

                  let llmVerdict = null
                  try { if (p.llm_verdict) llmVerdict = JSON.parse(p.llm_verdict) } catch {}

                  const isAllowlisted = scriptPolicy.allowlist.some(
                    a => a.package === p.package && a.ecosystem === p.ecosystem
                  )

                  return (
                    <div key={p.id} className="px-3 py-2 rounded bg-bg-secondary border border-border-secondary/50 text-[10px] space-y-1">
                      <div className="flex items-center gap-2">
                        <Package size={10} className="text-cyan-400 shrink-0" />
                        <span className="font-medium text-text-primary">{p.package}</span>
                        {p.version && <span className="text-text-faint">v{p.version}</span>}
                        <span className={`px-1 py-0 rounded border text-[9px] ${statusColor}`}>
                          {hasMalware ? 'MALWARE' : isFlagged ? 'flagged' : hasVulns ? 'vulns' : 'ok'}
                        </span>
                        <span className="text-text-faint">{p.ecosystem}</span>
                        <span className={`font-medium ml-auto ${decisionColor}`}>{p.decision}</span>
                        <span className="text-text-faint shrink-0">{new Date(p.created_at).toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-3 text-text-faint pl-4">
                        {p.age_days >= 0 && <span>Age: {p.age_days}d</span>}
                        {p.vuln_count > 0 && <span className={p.vuln_critical ? 'text-red-400' : 'text-yellow-400'}>
                          {p.vuln_count} vuln{p.vuln_count !== 1 ? 's' : ''}{p.vuln_critical ? ' (CRITICAL)' : ''}
                        </span>}
                        {p.fallback && <span>Fallback: <span className="text-emerald-400">{p.fallback}</span></span>}
                        {p.install_scripts && (
                          <span className="text-amber-400 flex items-center gap-1">
                            <AlertTriangle size={9} />
                            Install scripts
                            {isAllowlisted && <span className="text-emerald-400 text-[9px]">(allowlisted)</span>}
                          </span>
                        )}
                      </div>

                      {/* LLM verdict */}
                      {llmVerdict && (
                        <div className={`flex items-center gap-2 pl-4 text-[10px] ${
                          llmVerdict.verdict === 'malicious' ? 'text-red-400'
                            : llmVerdict.verdict === 'suspicious' ? 'text-amber-400'
                            : 'text-emerald-400'
                        }`}>
                          <Brain size={10} className="shrink-0" />
                          <span className="font-medium uppercase text-[9px]">{llmVerdict.verdict}</span>
                          <span className="text-text-secondary truncate">{llmVerdict.summary}</span>
                        </div>
                      )}

                      {p.reason && (
                        <div className="text-text-faint pl-4 truncate">{p.reason}</div>
                      )}

                      {/* Allowlist button for packages with install scripts */}
                      {p.install_scripts && !isAllowlisted && (
                        <div className="pl-4 pt-0.5">
                          <button
                            onClick={async () => {
                              await api.addInstallScriptAllowlist(p.package, p.ecosystem, 'Reviewed and approved')
                              loadPackageScans()
                            }}
                            className="text-[9px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20"
                          >
                            <Check size={8} className="inline mr-1" />
                            Add to allowlist
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}

                {packageScans.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-text-faint">
                    No package scans recorded yet. AVCP results from npm, pip, cargo, and other installs appear here with security ratings.
                  </div>
                )}
              </>)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
