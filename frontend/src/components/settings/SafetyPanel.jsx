import HelpDetails from '../ui/HelpDetails'
import { useState, useEffect, useCallback } from 'react'
import {
  Shield, X, Plus, Trash2, Check, AlertTriangle, Ban,
  HelpCircle, ChevronDown, ChevronRight, Pencil,
  Sparkles, RefreshCw, ShieldCheck,
  Terminal, Package, Globe, Search, Lock, Brain, Cpu,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { Button, IconButton } from '../ui'

const SEVERITY_COLORS = {
  critical: 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30',
  high: 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30',
  medium: 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30',
  low: 'text-x-ink-secondary bg-x-hover border-x-line',
}

const CATEGORY_COLORS = {
  dangerous_command: 'text-x-accent-ink',
  protected_path: 'text-x-accent-ink',
  credential: 'text-x-accent-ink',
  destructive_git: 'text-x-accent',
  sql_destructive: 'text-x-accent-ink',
  network: 'text-x-accent',
  custom: 'text-x-good',
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

// Empty string is the explicit no-LLM mode; unset uses the backend default.
const CLASSIFIER_MODEL_DEFAULT = 'gemini_api:gemini-3.1-flash-lite'
const CLASSIFIER_LATENCY_BUDGET_MS = 7000

const PRECEDENT_MODES = [
  {
    id: 'off',
    label: 'Off',
    sentence: 'Past approvals are ignored.',
  },
  {
    id: 'propose',
    label: 'Propose',
    sentence: 'Past approvals only suggest permanent rules; the gate stays predictable.',
  },
  {
    id: 'verdict',
    label: 'Verdict',
    sentence: 'Past approvals can also auto-allow similar low-risk actions.',
  },
]

function extractHost(summary) {
  const m = (summary || '').match(/https?:\/\/([^\s/:]+(?::\d+)?)/)
  return m ? m[1] : null
}

function policyUsage(policy) {
  if (!policy.last_used_at) return { label: 'Never used', stale: true }
  const usedAt = new Date(policy.last_used_at)
  if (Number.isNaN(usedAt.getTime())) return { label: 'Usage date unavailable', stale: true }
  const ageDays = Math.floor((Date.now() - usedAt.getTime()) / 86400000)
  return {
    label: `${ageDays > 90 ? 'Stale · ' : ''}Last used ${usedAt.toLocaleDateString()}`,
    stale: ageDays > 90,
  }
}

export default function SafetyPanel() {
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
  const [gateSaving, setGateSaving] = useState(false)
  // Safety-classifier model + fail-mode (global app_settings keys). Seeded
  // from getAppSettings on mount; persisted on change via setAppSetting.
  const [classifierModel, setClassifierModel] = useState(CLASSIFIER_MODEL_DEFAULT)
  const [classifierFailMode, setClassifierFailMode] = useState('ask')
  const [classifierModelMessage, setClassifierModelMessage] = useState(null)
  const [providerData, setProviderData] = useState({ providers: [], health: [] })
  const [classifierPrompt, setClassifierPrompt] = useState('')
  const [savedClassifierPrompt, setSavedClassifierPrompt] = useState('')
  const [defaultClassifierPrompt, setDefaultClassifierPrompt] = useState('')
  const [requiredPromptPlaceholders, setRequiredPromptPlaceholders] = useState([])
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptMessage, setPromptMessage] = useState(null)
  const [operatorPolicies, setOperatorPolicies] = useState([])
  const [newOperatorPolicy, setNewOperatorPolicy] = useState('')
  const [policiesSaving, setPoliciesSaving] = useState(false)
  const [policiesMessage, setPoliciesMessage] = useState(null)
  const [newPolicyWorkspaceId, setNewPolicyWorkspaceId] = useState('')
  const [precedentMode, setPrecedentMode] = useState('propose')
  const [precedentWindowDays, setPrecedentWindowDays] = useState('30')
  // Script behavior allowlist settings
  const [allowlistEnabled, setAllowlistEnabled] = useState(false)
  const [scriptApprovals, setScriptApprovals] = useState([])
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

  const fetchRules = useCallback(async () => {
    const wsParam = scopeFilter !== 'all' && scopeFilter !== 'global' ? scopeFilter : undefined
    const r = await api.getSafetyRules(wsParam)
    // Client-side filter for "global only" view
    return scopeFilter === 'global' ? r.filter(rule => !rule.workspace_id) : r
  }, [scopeFilter])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [r, s, appSettings, promptInfo, providers] = await Promise.all([
        fetchRules(),
        api.getSafetyStatus(),
        api.getAppSettings(),
        api.getSafetyClassifierPrompt(activeWorkspaceId).catch(() => null),
        api.getModelProviders().catch(() => ({ providers: [], health: [] })),
      ])
      setRules(r)
      setStatus(s)
      // Seed classifier controls. Unset model key → default; empty string is a
      // valid stored value meaning "deny-list only" (server reads `or None`).
      const rawModel = appSettings?.safety_classifier_model
      setClassifierModel(rawModel === undefined ? CLASSIFIER_MODEL_DEFAULT : rawModel)
      setClassifierFailMode(appSettings?.safety_classifier_fail_mode || 'ask')
      setProviderData(providers)
      const rawPrecedentMode = appSettings?.safety_precedent_mode
      setPrecedentMode(PRECEDENT_MODES.some(option => option.id === rawPrecedentMode)
        ? rawPrecedentMode
        : 'propose')
      setPrecedentWindowDays(appSettings?.safety_precedent_window_days || '30')
      setAllowlistEnabled(appSettings?.safety_script_allowlist_enabled === 'on')
      if (promptInfo?.prompt) {
        setClassifierPrompt(promptInfo.prompt)
        setSavedClassifierPrompt(promptInfo.prompt)
        setDefaultClassifierPrompt(promptInfo.default_prompt || promptInfo.prompt)
        setRequiredPromptPlaceholders(promptInfo.required_placeholders || [])
        setOperatorPolicies(promptInfo.operator_policies || [])
      }
    } catch (e) {
      console.error('Failed to load safety data:', e)
    }
    setLoading(false)
  }, [fetchRules, activeWorkspaceId])

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
  // A rule applied elsewhere (QuickActions safety suggestion) shows up here at
  // once. Only the rule list reloads, so unsaved classifier edits survive.
  useEffect(() => {
    const onRulesChanged = () => {
      fetchRules().then(setRules).catch((e) => console.error('Failed to reload safety rules:', e))
    }
    window.addEventListener('cc-safety-rules-changed', onRulesChanged)
    return () => window.removeEventListener('cc-safety-rules-changed', onRulesChanged)
  }, [fetchRules])
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

  const loadScriptApprovals = useCallback(async () => {
    try {
      const data = await api.getScriptApprovals()
      setScriptApprovals(data)
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { if (tab === 'rules') loadScriptApprovals() }, [tab, loadScriptApprovals])
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

  // Persist provider:model. Empty string is stored verbatim and disables the
  // gray-zone classifier while mandatory/explicit rules remain active.
  const toggleClassifier = async () => {
    setGateSaving(true)
    setClassifierModelMessage(null)
    try {
      await api.setAppSetting('experimental_safety_gate', status?.enabled ? 'off' : 'on')
      await loadData()
    } catch (e) {
      setClassifierModelMessage({ type: 'error', text: e.message || 'Could not update AI check.' })
    } finally {
      setGateSaving(false)
    }
  }

  const changeClassifierModel = async (value) => {
    const prev = classifierModel
    setClassifierModelMessage(null)
    setClassifierModel(value) // optimistic
    try {
      await api.setAppSetting('safety_classifier_model', value)
      setStatus(await api.getSafetyStatus())
    } catch (e) {
      console.error('Failed to set safety_classifier_model:', e)
      setClassifierModel(prev)
      setClassifierModelMessage({
        type: 'error',
        text: e?.body?.code ? `${e.body.code}: ${e.message}` : (e.message || 'Could not save classifier model.'),
      })
    }
  }

  const changeClassifierFailMode = async (value) => {
    const prev = classifierFailMode
    setClassifierFailMode(value) // optimistic
    try {
      await api.setAppSetting('safety_classifier_fail_mode', value)
    } catch (e) {
      console.error('Failed to set safety_classifier_fail_mode:', e)
      setClassifierFailMode(prev)
    }
  }

  const saveClassifierPrompt = async () => {
    const missing = requiredPromptPlaceholders.filter(token => !classifierPrompt.includes(token))
    if (!classifierPrompt.trim() || missing.length) {
      setPromptMessage({
        type: 'error',
        text: !classifierPrompt.trim()
          ? 'The prompt cannot be empty.'
          : `Required placeholder missing: ${missing.join(', ')}`,
      })
      return
    }
    setPromptSaving(true)
    setPromptMessage(null)
    try {
      // A byte-for-byte default is represented by no override, preserving the
      // backend constant as the single source of truth.
      await api.setAppSetting(
        'safety_classifier_prompt',
        classifierPrompt === defaultClassifierPrompt ? null : classifierPrompt,
      )
      const info = await api.getSafetyClassifierPrompt(activeWorkspaceId)
      setClassifierPrompt(info.prompt)
      setSavedClassifierPrompt(info.prompt)
      setDefaultClassifierPrompt(info.default_prompt)
      setRequiredPromptPlaceholders(info.required_placeholders || [])
      setPromptMessage({ type: 'success', text: 'Classifier prompt saved.' })
    } catch (e) {
      setPromptMessage({ type: 'error', text: e.message || 'Could not save the classifier prompt.' })
    } finally {
      setPromptSaving(false)
    }
  }

  const resetClassifierPrompt = async () => {
    setPromptSaving(true)
    setPromptMessage(null)
    try {
      await api.setAppSetting('safety_classifier_prompt', null)
      const info = await api.getSafetyClassifierPrompt(activeWorkspaceId)
      setClassifierPrompt(info.prompt)
      setSavedClassifierPrompt(info.prompt)
      setDefaultClassifierPrompt(info.default_prompt)
      setRequiredPromptPlaceholders(info.required_placeholders || [])
      setPromptMessage({ type: 'success', text: 'Using the built-in default.' })
    } catch (e) {
      setPromptMessage({ type: 'error', text: e.message || 'Could not reset the classifier prompt.' })
    } finally {
      setPromptSaving(false)
    }
  }

  const persistOperatorPolicies = async (next, successText) => {
    const previous = operatorPolicies
    setOperatorPolicies(next)
    setPoliciesSaving(true)
    setPoliciesMessage(null)
    try {
      await api.setAppSetting('safety_operator_policies', next)
      const info = await api.getSafetyClassifierPrompt(activeWorkspaceId)
      setOperatorPolicies(info.operator_policies || [])
      setPoliciesMessage({ type: 'success', text: successText })
      return true
    } catch (e) {
      setOperatorPolicies(previous)
      setPoliciesMessage({ type: 'error', text: e.message || 'Could not save operator policies.' })
      return false
    } finally {
      setPoliciesSaving(false)
    }
  }

  const addOperatorPolicy = async () => {
    const text = newOperatorPolicy.replace(/\s+/g, ' ').trim()
    if (!text || policiesSaving) return
    const id = globalThis.crypto?.randomUUID?.()
      ? `policy-${globalThis.crypto.randomUUID()}`
      : `policy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const added = await persistOperatorPolicies([
      ...operatorPolicies,
      {
        id,
        text,
        created_at: new Date().toISOString(),
        enabled: true,
        workspace_id: newPolicyWorkspaceId || null,
        last_used_at: null,
      },
    ], 'Policy added.')
    if (added) {
      setNewOperatorPolicy('')
      setNewPolicyWorkspaceId('')
    }
  }

  const updateOperatorPolicyText = async (policy) => {
    const text = policy.text.replace(/\s+/g, ' ').trim()
    if (!text) {
      setPoliciesMessage({ type: 'error', text: 'A policy sentence cannot be empty.' })
      return
    }
    await persistOperatorPolicies(
      operatorPolicies.map(item => item.id === policy.id ? { ...item, text } : item),
      'Policy updated.',
    )
  }

  const toggleOperatorPolicy = async (policy) => {
    await persistOperatorPolicies(
      operatorPolicies.map(item => item.id === policy.id ? { ...item, enabled: !item.enabled } : item),
      policy.enabled ? 'Policy disabled.' : 'Policy enabled.',
    )
  }

  const removeOperatorPolicy = async (policy) => {
    await persistOperatorPolicies(
      operatorPolicies.filter(item => item.id !== policy.id),
      'Policy removed.',
    )
  }

  const changePrecedentWindow = async (value) => {
    const previous = precedentWindowDays
    setPrecedentWindowDays(value)
    try {
      await api.setAppSetting('safety_precedent_window_days', value)
    } catch (e) {
      console.error('Failed to set safety_precedent_window_days:', e)
      setPrecedentWindowDays(previous)
    }
  }

  const changePrecedentMode = async (value) => {
    const previous = precedentMode
    setPrecedentMode(value)
    try {
      await api.setAppSetting('safety_precedent_mode', value)
    } catch (e) {
      console.error('Failed to set safety_precedent_mode:', e)
      setPrecedentMode(previous)
    }
  }

  const changeAllowlistEnabled = async (value) => {
    const prev = allowlistEnabled
    setAllowlistEnabled(value)
    try {
      await api.setAppSetting('safety_script_allowlist_enabled', value ? 'on' : 'off')
    } catch (e) {
      console.error('Failed to set safety_script_allowlist_enabled:', e)
      setAllowlistEnabled(prev)
    }
  }

  const removeScriptApproval = async (id) => {
    if (!confirm('Remove this script from the allowlist?')) return
    try {
      await api.deleteScriptApproval(id)
      setScriptApprovals(prev => prev.filter(a => a.id !== id))
    } catch (e) { console.error(e) }
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
  const providerHealth = new Map((providerData.health || []).map(item => [item.id, item]))
  const registryModelIds = new Set(
    (providerData.providers || []).flatMap(provider =>
      provider.models.map(model => `${provider.id}:${model}`)
    )
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-x-line px-4 py-2">
          {status?.enabled && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-x-accent" /> AI check on
            </span>
          )}
          {status && !status.enabled && (
            <span className="px-1.5 py-0.5 text-[11px] font-medium bg-x-hover text-x-muted border border-x-line rounded-md">
              AI check off
            </span>
          )}
          <select
            value={scopeFilter}
            onChange={e => setScopeFilter(e.target.value)}
            className="text-[11px] px-1.5 py-1 bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary outline-none cursor-pointer focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
          >
            <option value="all">All scopes</option>
            <option value="global">Global only</option>
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
          <span className="text-[11px] text-x-muted ml-auto">
            {status ? `${status.rule_count} rules, ${status.decision_count} evaluations` : ''}
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-x-line px-4 py-2 shrink-0">
          {[
            ['rules', 'Rules', rules.length],
            ['decisions', 'Decision Log', decisions.length],
            ['proposals', 'Proposed', proposals.length],
            ['compliance', 'Compliance', accessLog.entries.length + commandLog.length + packageScans.length],
          ].map(([key, label, count]) => (
            <Button
              key={key}
              size="sm"
              selected={tab === key}
              onClick={() => { setTab(key); setMode('list') }}
            >
              {label}
              {count > 0 && <span className="ml-1 text-x-faint">({count})</span>}
            </Button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4">
          {!status?.enabled && (
            <div className="p-3 mb-4 rounded-md border border-x-line bg-x-surface-2 text-[11px] text-x-ink-secondary">
              Agent permissions and IVE deny rules are active. The optional AI check is off.
            </div>
          )}

          {/* ── Rules tab ── */}
          {tab === 'rules' && mode === 'list' && (
            <div className="space-y-2">
              {/* ── Gray-zone Classifier ── */}
              {(() => {
                const gateOn = !!status?.enabled
                const isDenyListOnly = classifierModel === ''
                const selectedProviderId = classifierModel.split(':', 1)[0]
                const selectedProvider = providerData.providers.find(
                  provider => provider.id === selectedProviderId
                )
                const selectedHealth = providerHealth.get(selectedProviderId)
                return (
                  <div className="px-3 py-2.5 rounded-md bg-x-surface border border-x-line space-y-2">
                    <div className="flex items-center gap-2">
                      <Cpu size={12} className="text-x-accent shrink-0" />
                      <span className="text-[11px] font-medium text-x-ink">Optional AI safety check</span>
                      <Button size="sm" onClick={toggleClassifier} disabled={gateSaving}
                        aria-label={gateOn ? 'Turn off optional AI check' : 'Turn on optional AI check'}>
                        {gateOn ? 'Turn off' : 'Turn on'}
                      </Button>
                    </div>
                    <HelpDetails label="How safety checks work"><p className="text-[11px] text-x-ink-secondary leading-relaxed">
                      Your Claude or Codex session works with IVE&apos;s deny rules and the agent&apos;s own
                      permissions. You can optionally add an AI check for other operations.
                      Gemini requires a separate API key; a Gemini chat account alone does not connect it.
                      Off by default. Enabling this can add confirmation prompts even in Auto mode.
                      IVE approvals still pass through your agent&apos;s own permissions.
                    </p></HelpDetails>

                    {status?.classifier_setup?.issue && (
                      <p role="status" className="text-[11px] text-x-ink-secondary">
                        {status.classifier_setup.issue}
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-[11px] font-medium text-x-ink-secondary block mb-1">Model</label>
                        <select
                          aria-label="Safety classifier model"
                          value={classifierModel}
                          onChange={e => changeClassifierModel(e.target.value)}
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink disabled:cursor-not-allowed focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        >
                          <option value="">Deny-list only (no LLM)</option>
                          {classifierModel && !registryModelIds.has(classifierModel) && (
                            <option value={classifierModel} disabled>
                              {classifierModel} — no longer configured
                            </option>
                          )}
                          {(providerData.providers || []).map(provider => {
                            const health = providerHealth.get(provider.id)
                            const suffix = !provider.enabled
                              ? 'disabled'
                              : health?.reachable ? 'reachable' : 'unreachable'
                            return provider.models.length > 0 ? (
                              <optgroup
                                key={provider.id}
                                label={`${provider.id} · ${provider.kind} · ${suffix}`}
                              >
                                {provider.models.map(model => (
                                  <option
                                    key={`${provider.id}:${model}`}
                                    value={`${provider.id}:${model}`}
                                    disabled={!provider.enabled || provider.kind === 'cli' || provider.timeout_ms > CLASSIFIER_LATENCY_BUDGET_MS}
                                  >
                                    {model}
                                    {provider.kind === 'cli'
                                      ? ' — CLI exceeds gate budget'
                                      : provider.timeout_ms > CLASSIFIER_LATENCY_BUDGET_MS
                                        ? ' — exceeds 7s gate budget'
                                      : provider.enabled && !health?.reachable ? ' — unreachable' : ''}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null
                          })}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-x-ink-secondary block mb-1">On error</label>
                        <select
                          value={classifierFailMode}
                          onChange={e => changeClassifierFailMode(e.target.value)}
                          disabled={!gateOn || isDenyListOnly}
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink disabled:cursor-not-allowed focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        >
                          <option value="ask">Ask on error (default)</option>
                          <option value="deny">Deny on error</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-x-ink-secondary block mb-1">Precedent age</label>
                        <select
                          value={precedentWindowDays}
                          onChange={event => changePrecedentWindow(event.target.value)}
                          disabled={!gateOn || precedentMode === 'off'}
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink disabled:cursor-not-allowed focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        >
                          <option value="7">7 days</option>
                          <option value="30">30 days</option>
                          <option value="90">90 days</option>
                          <option value="180">180 days</option>
                          <option value="365">365 days</option>
                        </select>
                      </div>
                    </div>

                    {selectedProvider?.kind === 'cli' && (
                      <p className="flex items-start gap-1.5 rounded-md border border-x-accent-ink/30 bg-x-accent-ink/10 px-2.5 py-2 text-[11px] leading-relaxed text-x-accent-ink">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        CLI subprocess cold-start exceeds the Safety Gate&apos;s 7s latency budget.
                        Saving this classifier is refused; an already-stored CLI selection fails closed.
                      </p>
                    )}
                    {selectedProvider?.kind !== 'cli' && selectedProvider?.timeout_ms > CLASSIFIER_LATENCY_BUDGET_MS && (
                      <p className="flex items-start gap-1.5 rounded-md border border-x-accent-ink/30 bg-x-accent-ink/10 px-2.5 py-2 text-[11px] leading-relaxed text-x-accent-ink">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        This provider declares {selectedProvider.timeout_ms}ms, above the 7s classifier
                        ceiling. Saving it as the classifier is refused.
                      </p>
                    )}
                    {classifierModelMessage && (
                      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-x-accent-ink">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        {classifierModelMessage.text}
                      </p>
                    )}

                    <div
                      className="rounded-lg border border-x-line bg-x-surface-2 p-3"
                      data-testid="safety-precedent-mode-control"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <Brain size={12} className="text-x-accent shrink-0" />
                        <span className="text-[11px] font-medium text-x-ink">Past approval behavior</span>
                      </div>
                      <div className="grid grid-cols-3 items-stretch gap-2" role="radiogroup" aria-label="Past approval behavior">
                        {PRECEDENT_MODES.map(option => {
                          const selected = precedentMode === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              disabled={!gateOn}
                              onClick={() => changePrecedentMode(option.id)}
                              data-testid={`safety-precedent-mode-${option.id}`}
                              className={`flex h-full flex-col items-start rounded-xl border px-3 py-3 text-left transition-colors duration-[80ms] disabled:cursor-not-allowed ${selected
                                ? 'border-x-accent/45 bg-x-tint text-x-ink'
                                : 'border-x-line bg-x-surface text-x-ink-secondary hover:border-x-line-strong hover:bg-x-hover'
                              }`}
                            >
                              <span className="block text-[11px] font-semibold">{option.label}</span>
                              <span className="mt-2 block text-[11px] leading-relaxed text-x-faint">{option.sentence}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div
                      className="rounded-lg border border-x-line bg-x-surface-2 p-3"
                      data-testid="safety-operator-policies-editor"
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <ShieldCheck size={12} className="text-x-good shrink-0" />
                        <span className="text-[11px] font-medium text-x-ink">Operator policies</span>
                        <span className="ml-auto text-[11px] text-x-faint">
                          {operatorPolicies.filter(policy => policy.enabled).length} enabled
                        </span>
                      </div>
                      <HelpDetails label="About policies"><p className="mb-2 text-[11px] text-x-ink-secondary leading-relaxed">
                        Add standing, one-sentence policies without freezing the built-in classifier prompt.
                        Only enabled policies are included when the prompt is built.
                      </p></HelpDetails>

                      {operatorPolicies.length > 0 && (
                        <div className="mb-2 space-y-1.5">
                          {operatorPolicies.map(policy => (
                            <div key={policy.id} className="rounded-md border border-x-line bg-x-surface px-2 py-1.5">
                              <div className="flex items-start gap-2">
                              <Button
                                type="button"
                                onClick={() => toggleOperatorPolicy(policy)}
                                disabled={policiesSaving}
                                aria-label={`${policy.enabled ? 'Disable' : 'Enable'} policy`}
                                toggleState={policy.enabled}
                                shape="card"
                                size="sm"
                                className="min-w-[70px] shrink-0"
                              >
                                {policy.enabled ? 'On' : 'Off'}
                              </Button>
                              <textarea
                                rows={2}
                                value={policy.text}
                                disabled={policiesSaving}
                                onChange={event => {
                                  setOperatorPolicies(current => current.map(item => item.id === policy.id
                                    ? { ...item, text: event.target.value }
                                    : item))
                                  setPoliciesMessage(null)
                                }}
                                onBlur={() => updateOperatorPolicyText(policy)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    event.currentTarget.blur()
                                  }
                                }}
                                aria-label="Operator policy sentence"
                                className={`x-operator-policy-text min-w-0 flex-1 resize-y border-0 bg-transparent px-1 py-1 text-[11px] leading-relaxed outline-none focus:ring-0 ${policy.enabled ? 'text-x-ink' : 'text-x-muted line-through'}`}
                              />
                              <IconButton
                                icon={Trash2}
                                label="Remove policy"
                                variant="destructive"
                                size="sm"
                                onClick={() => removeOperatorPolicy(policy)}
                                disabled={policiesSaving}
                              />
                              </div>
                              <div className="mt-1 flex items-center gap-2 pl-11">
                                <select
                                  value={policy.workspace_id || ''}
                                  disabled={policiesSaving}
                                  onChange={event => persistOperatorPolicies(
                                    operatorPolicies.map(item => item.id === policy.id
                                      ? { ...item, workspace_id: event.target.value || null }
                                      : item),
                                    'Policy scope updated.',
                                  )}
                                  aria-label="Operator policy scope"
                                  className="h-6 max-w-44 rounded border border-x-line bg-x-surface-2 px-1.5 text-[11px] text-x-ink-secondary outline-none focus:border-x-accent disabled:cursor-not-allowed"
                                >
                                  <option value="">Global</option>
                                  {workspaces.map(workspace => (
                                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                                  ))}
                                </select>
                                <span className={`text-[11px] ${policyUsage(policy).stale ? 'text-x-accent-ink' : 'text-x-faint'}`}>
                                  {policyUsage(policy).label}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <select
                          value={newPolicyWorkspaceId}
                          disabled={policiesSaving}
                          onChange={event => setNewPolicyWorkspaceId(event.target.value)}
                          aria-label="New operator policy scope"
                          className="h-8 max-w-44 rounded-md border border-x-line bg-x-surface px-2 text-[11px] text-x-ink-secondary outline-none focus:border-x-accent disabled:cursor-not-allowed"
                        >
                          <option value="">Global</option>
                          {workspaces.map(workspace => (
                            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={newOperatorPolicy}
                          disabled={policiesSaving}
                          onChange={event => {
                            setNewOperatorPolicy(event.target.value)
                            setPoliciesMessage(null)
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Enter') addOperatorPolicy()
                          }}
                          placeholder="Allow benign read-only checks against approved infrastructure."
                          aria-label="New operator policy sentence"
                          className="h-8 min-w-0 flex-1 rounded-md border border-x-line bg-x-surface px-2 text-[11px] text-x-ink outline-none placeholder:text-x-faint focus:border-x-accent focus:ring-[3px] focus:ring-x-focus disabled:cursor-not-allowed"
                        />
                        <Button
                          icon={Plus}
                          onClick={addOperatorPolicy}
                          disabled={policiesSaving || !newOperatorPolicy.trim()}
                          size="sm"
                        >
                          Add
                        </Button>
                      </div>
                      {policiesMessage && (
                        <p className={`mt-2 text-[11px] ${policiesMessage.type === 'error' ? 'text-x-accent-ink' : 'text-x-good'}`}>
                          {policiesMessage.text}
                        </p>
                      )}
                    </div>

                    <div
                      className="rounded-lg border border-x-line bg-x-surface-2 p-3"
                      data-testid="safety-classifier-prompt-editor"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <label htmlFor="safety-classifier-prompt" className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-x-ink-secondary">
                          Advanced full-prompt override
                        </label>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${classifierPrompt === defaultClassifierPrompt
                          ? 'border-x-line bg-x-surface text-x-faint'
                          : 'border-x-accent/35 bg-x-tint text-x-accent'}`}>
                          {classifierPrompt === defaultClassifierPrompt ? 'Matches default' : 'Differs from default'}
                        </span>
                        {classifierPrompt !== savedClassifierPrompt && (
                          <span className="rounded-full border border-x-accent-ink/30 bg-x-accent-ink/10 px-2 py-0.5 font-mono text-[11px] text-x-accent-ink">
                            Unsaved edits
                          </span>
                        )}
                      </div>
                      <textarea
                        id="safety-classifier-prompt"
                        aria-label="Active classifier prompt"
                        value={classifierPrompt}
                        onChange={e => {
                          setClassifierPrompt(e.target.value)
                          setPromptMessage(null)
                        }}
                        spellCheck={false}
                        className="h-64 w-full resize-y rounded-lg border border-x-line bg-x-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-x-ink outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          onClick={saveClassifierPrompt}
                          disabled={promptSaving || classifierPrompt === savedClassifierPrompt}
                          variant="primary"
                          size="sm"
                        >
                          {promptSaving ? 'Saving…' : 'Save'}
                        </Button>
                        <Button
                          onClick={resetClassifierPrompt}
                          disabled={promptSaving || (classifierPrompt === defaultClassifierPrompt && savedClassifierPrompt === defaultClassifierPrompt)}
                          size="sm"
                        >
                          Reset to default
                        </Button>
                        {requiredPromptPlaceholders.length > 0 && (
                          <span className="ml-auto font-mono text-[11px] text-x-faint">
                            required: {requiredPromptPlaceholders.join(', ')}
                          </span>
                        )}
                      </div>
                      {promptMessage && (
                        <p className={`mt-2 text-[11px] ${promptMessage.type === 'error' ? 'text-x-accent-ink' : 'text-x-good'}`}>
                          {promptMessage.text}
                        </p>
                      )}
                      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-x-accent-ink">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        This gates what agent sessions may do — weakening it weakens your safety rails.
                      </p>
                    </div>

                    <p className="text-[11px] text-x-faint leading-relaxed">
                      {isDenyListOnly ? (
                        <>Deny-list only: the gray-zone LLM classifier is inactive — only the Tier-1
                        hardcoded patterns and your explicit DENY/ALLOW rules apply.</>
                      ) : selectedProvider ? (
                        <>{selectedProvider.kind} via {selectedProvider.id}; provider timeout{' '}
                        {selectedProvider.timeout_ms}ms. {selectedHealth?.reason || 'Health not checked'}.
                        Any error or invalid JSON uses the fail-closed action above.</>
                      ) : (
                        <>The selected provider is no longer configured. Calls fail closed until a
                        registry model is selected.</>
                      )}
                    </p>
                  </div>
                )
              })()}

              {/* ── Script Behavior Allowlist ── */}
              {(() => {
                const gateOn = !!status?.enabled
                return (
                  <div className={`px-3 py-2.5 rounded-md bg-x-surface border border-x-line space-y-2 ${gateOn ? '' : 'opacity-50'}`}>
                    <div className="flex items-center gap-2">
                      <Shield size={12} className="text-x-accent-ink shrink-0" />
                      <span className="text-[11px] font-medium text-x-ink">Script Behavior Allowlist</span>
                      <Button
                        type="button"
                        onClick={() => changeAllowlistEnabled(!allowlistEnabled)}
                        disabled={!gateOn}
                        toggleState={allowlistEnabled}
                        shape="card"
                        size="sm"
                        className="ml-auto min-w-[70px] shrink-0"
                        aria-label="Script behavior allowlist"
                      >
                        {allowlistEnabled ? 'On' : 'Off'}
                      </Button>
                    </div>
                    <HelpDetails label="How script approvals work"><p className="text-[11px] text-x-ink-secondary leading-relaxed">
                      When you approve a /tmp/ script execution, IVE stores a description of what
                      it does. For a future script, the classifier receives a bounded pool of approved
                      behavior candidates and decides whether one covers the same benign action.
                    </p></HelpDetails>

                    {allowlistEnabled && (
                      <>
                        {scriptApprovals.length > 0 ? (
                          <div className="space-y-1">
                            <p className="text-[11px] text-x-faint">Stored approvals ({scriptApprovals.length})</p>
                            {scriptApprovals.map(a => (
                              <div key={a.id} className="flex items-start gap-2 px-2 py-1.5 rounded-md bg-x-hover border border-x-line">
                                <div className="flex-1 min-w-0">
                                  <p className="text-[11px] text-x-ink truncate">{a.script_description}</p>
                                  <p className="text-[11px] text-x-faint mt-0.5">
                                    {a.approved_at ? new Date(a.approved_at).toLocaleDateString() : ''}
                                    {a.script_excerpt && (
                                      <code className="ml-1 text-x-faint">{a.script_excerpt.slice(0, 60).replace(/\n/g, ' ')}…</code>
                                    )}
                                  </p>
                                </div>
                                <IconButton
                                  icon={X}
                                  label="Remove script approval"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => removeScriptApproval(a.id)}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[11px] text-x-faint italic">
                            No approvals stored yet — approve a /tmp/ script when the gate asks and it will appear here.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )
              })()}

              {/* Category filters */}
              <div className="flex gap-1 flex-wrap mb-3">
                {categories.map(c => (
                  <Button key={c} onClick={() => setFilter(c)}
                    selected={filter === c}
                    size="sm"
                  >
                    {c === 'all' ? 'All' : CATEGORY_LABELS[c] || c}
                  </Button>
                ))}
                <Button icon={Plus} onClick={() => { setMode('create'); setEditRule(null); setForm({ name: '', description: '', category: 'custom', severity: 'medium', tool_match: 'Bash', pattern: '', pattern_field: '', action: 'ask', workspace_id: scopeFilter !== 'all' && scopeFilter !== 'global' ? scopeFilter : null }) }}
                  size="sm"
                  className="ml-auto"
                >
                  New Rule
                </Button>
              </div>

              {/* Rule list */}
              {filteredRules.map(rule => {
                const ActionIcon = ACTION_ICONS[rule.action] || HelpCircle
                const isExpanded = expanded === rule.id
                return (
                  <div key={rule.id} className={`border rounded-md ${rule.enabled ? 'border-x-line' : 'border-x-line/50 opacity-50'} bg-x-surface`}>
                    <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-x-hover"
                         onClick={() => setExpanded(isExpanded ? null : rule.id)}>
                      {/* Toggle */}
                      <Button
                        type="button"
                        onClick={e => { e.stopPropagation(); toggleRule(rule) }}
                        toggleState={rule.enabled}
                        shape="card"
                        size="sm"
                        className="min-w-[70px] shrink-0"
                        aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                      >
                        {rule.enabled ? 'On' : 'Off'}
                      </Button>

                      {/* Category badge */}
                      <span className={`text-[11px] font-medium uppercase tracking-wider ${CATEGORY_COLORS[rule.category] || 'text-x-faint'}`}>
                        {CATEGORY_LABELS[rule.category] || rule.category}
                      </span>

                      {/* Severity badge */}
                      <span className={`px-1 py-0 text-[11px] rounded-md border ${SEVERITY_COLORS[rule.severity] || ''}`}>
                        {rule.severity}
                      </span>

                      {/* Action icon */}
                      <ActionIcon size={11} className={rule.action === 'deny' ? 'text-x-accent-ink' : rule.action === 'ask' ? 'text-x-accent-ink' : 'text-x-good'} />

                      {/* Name */}
                      <span className="text-[11px] text-x-ink truncate flex-1">{rule.name}</span>

                      {rule.is_builtin ? (
                        <span className="text-[11px] text-x-faint">builtin</span>
                      ) : null}

                      {/* Scope badge */}
                      {rule.workspace_id ? (
                        <span className="text-[11px] text-x-good px-1 py-0 bg-x-good/10 rounded-md border border-x-good/30 shrink-0">
                          {workspaces.find(w => w.id === rule.workspace_id)?.name || 'workspace'}
                        </span>
                      ) : (
                        <span className="text-[11px] text-x-accent px-1 py-0 bg-x-tint rounded-md border border-x-accent/30 shrink-0">global</span>
                      )}

                      {isExpanded ? <ChevronDown size={12} className="text-x-faint" /> : <ChevronRight size={12} className="text-x-faint" />}
                    </div>

                    {isExpanded && (
                      <div className="px-3 pb-2 pt-1 border-t border-x-line/50 space-y-1">
                        {rule.description && <p className="text-[11px] text-x-ink-secondary">{rule.description}</p>}
                        <div className="flex gap-4 text-[11px] text-x-faint">
                          <span>Tool: <code className="text-x-ink-secondary">{rule.tool_match}</code></span>
                          <span>Pattern: <code className="text-x-ink-secondary">{rule.pattern}</code></span>
                          {rule.pattern_field && <span>Field: <code className="text-x-ink-secondary">{rule.pattern_field}</code></span>}
                        </div>
                        <div className="flex gap-1 mt-1">
                          <Button icon={Pencil} onClick={() => startEdit(rule)} size="sm">
                            Edit
                          </Button>
                          {!rule.is_builtin && (
                            <Button icon={Trash2} onClick={() => deleteRule(rule.id)} variant="destructive" size="sm">
                              Delete
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {filteredRules.length === 0 && (
                <div className="text-center py-8 text-[11px] text-x-faint">
                  {rules.length === 0 ? 'No rules yet. Enable Safety Gate in Experimental Features to get started.' : 'No rules match the selected filter.'}
                </div>
              )}
            </div>
          )}

          {/* ── Create/Edit form ── */}
          {tab === 'rules' && (mode === 'create' || mode === 'edit') && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Button onClick={() => { setMode('list'); setEditRule(null) }} size="sm">&larr; Back</Button>
                <span className="text-[13px] font-medium text-x-ink">{mode === 'edit' ? 'Edit Rule' : 'New Rule'}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Name</label>
                  <input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                    className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus" placeholder="Rule name" />
                </div>
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({...f, category: e.target.value}))}
                    className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus">
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Severity</label>
                  <select value={form.severity} onChange={e => setForm(f => ({...f, severity: e.target.value}))}
                    className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus">
                    {['critical', 'high', 'medium', 'low'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Action</label>
                  <select value={form.action} onChange={e => setForm(f => ({...f, action: e.target.value}))}
                    className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus">
                    <option value="deny">Deny (block)</option>
                    <option value="ask">Ask (prompt user)</option>
                    <option value="allow">Allow (auto-approve)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Description</label>
                <input value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))}
                  className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus" placeholder="What this rule catches" />
              </div>

              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Scope</label>
                <select value={form.workspace_id || ''} onChange={e => setForm(f => ({...f, workspace_id: e.target.value || null}))}
                  className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus">
                  <option value="">Global (all workspaces)</option>
                  {workspaces.map(ws => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
                <span className="text-[11px] text-x-faint">Global rules apply everywhere. Workspace rules apply only to sessions in that workspace.</span>
              </div>

              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Tool Match</label>
                <input value={form.tool_match} onChange={e => setForm(f => ({...f, tool_match: e.target.value}))}
                  className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink font-mono placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus" placeholder="Bash, Write|Edit, *, etc." />
                <span className="text-[11px] text-x-faint">Pipe-separated tool names or * for all</span>
              </div>

              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1.5">Pattern (regex)</label>
                <input value={form.pattern} onChange={e => setForm(f => ({...f, pattern: e.target.value}))}
                  className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md text-[13px] px-2 text-x-ink font-mono placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus" placeholder="rm\s+-rf\s+/" />
                <span className="text-[11px] text-x-faint">Regex matched against tool input (case-insensitive)</span>
              </div>

              <div className="flex gap-2 pt-2">
                <Button icon={Check} onClick={saveRule} variant="primary">
                  {mode === 'edit' ? 'Save' : 'Create'}
                </Button>
                <Button onClick={() => { setMode('list'); setEditRule(null) }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* ── Decision Log tab ── */}
          {tab === 'decisions' && (() => {
            const visible = hideAutoAllow
              ? decisions.filter((d) => !(
                d.decision === 'allow'
                && !d.matched_rule_id
                && !(d.precedent_decision_ids?.length)
              ))
              : decisions
            const hiddenCount = decisions.length - visible.length
            return (
            <div className="space-y-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] text-x-faint">
                  {visible.length} of {decisions.length} evaluations
                  {hiddenCount > 0 && (
                    <span className="text-x-faint/60"> · {hiddenCount} auto-allowed hidden</span>
                  )}
                </span>
                <Button
                  onClick={() => setHideAutoAllow(!hideAutoAllow)}
                  selected={!hideAutoAllow}
                  size="sm"
                  title="Auto-allow rows are decisions where no rule matched and the action defaulted to allow — usually routine tool calls."
                >
                  {hideAutoAllow ? 'Show all' : 'Hide auto-allow'}
                </Button>
                <IconButton icon={RefreshCw} label="Refresh decisions" size="sm" onClick={loadDecisions} className="ml-auto" />
              </div>

              {visible.map(d => {
                const host = (d.decision === 'ask' || d.decision === 'deny') ? extractHost(d.tool_input_summary) : null
                return (
                <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-x-surface border border-x-line/50 text-[11px]">
                  <span className={`font-medium ${d.decision === 'deny' ? 'text-x-accent-ink' : d.decision === 'ask' ? 'text-x-accent-ink' : 'text-x-good'}`}>
                    {d.decision}
                  </span>
                  <span className="text-x-faint">{d.tool_name}</span>
                  <span className="text-x-ink-secondary truncate flex-1 font-mono">{d.tool_input_summary}</span>
                  {d.governance === 'precedent' && (
                    <span
                      className="max-w-48 truncate px-1 rounded-md bg-x-accent/10 text-x-accent border border-x-accent/25"
                      title={`${d.precedent_reason || 'Allowed by precedent'} · decisions ${(d.precedent_decision_ids || []).map(id => `#${id}`).join(', ')}`}
                    >
                      precedent: {d.precedent_class || 'same class'}
                    </span>
                  )}
                  {d.governance === 'rule' && (
                    <span className="px-1 rounded-md bg-x-surface-2 text-x-faint border border-x-line">
                      rule: {d.matched_rule_id?.slice(0, 8)}
                    </span>
                  )}
                  {d.user_response && (
                    <span className={`px-1 rounded-md ${d.user_response === 'approved' ? 'bg-x-good/10 text-x-good' : 'bg-x-accent-ink/10 text-x-accent-ink'}`}>
                      {d.user_response}
                    </span>
                  )}
                  {host && (
                    <Button icon={ShieldCheck} onClick={() => trustHost(d)} title={`Always allow ${host}`} size="sm">
                      Trust
                    </Button>
                  )}
                  {!host && (d.decision === 'ask' || d.decision === 'deny') && d.tool_input_summary && (
                    <Button icon={ShieldCheck} onClick={() => allowFromDecision(d)} title={`Create allow rule for this ${d.tool_name} pattern`} size="sm">
                      Allow
                    </Button>
                  )}
                  <span className="text-x-faint shrink-0">{d.latency_ms}ms</span>
                  <span className="text-x-faint shrink-0">{new Date(d.created_at).toLocaleTimeString()}</span>
                </div>
                )
              })}

              {decisions.length === 0 && (
                <div className="text-center py-8 text-[11px] text-x-faint">
                  No decisions recorded yet. Evaluations appear here once the Safety Gate intercepts tool calls.
                </div>
              )}
              {decisions.length > 0 && visible.length === 0 && (
                <div className="text-center py-6 text-[11px] text-x-faint">
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
                <Sparkles size={13} className="text-x-accent-ink" />
                <span className="text-[11px] text-x-ink">Learned Patterns</span>
                <span className="text-[11px] text-x-faint ml-auto">{proposals.length} proposals</span>
              </div>

              {proposals.map(p => (
                <div key={p.id} className="p-3 rounded-md border border-x-line bg-x-surface space-y-2">
                  <p className="text-[11px] text-x-ink">{p.pattern_summary}</p>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-x-faint">
                      Suggested: <span className={p.suggested_action === 'allow' ? 'text-x-good' : 'text-x-accent-ink'}>auto-{p.suggested_action}</span>
                    </span>
                    <span className="text-x-faint">Confidence: {Math.round(p.confidence * 100)}%</span>
                    <span className="text-x-faint">{p.sample_count} samples</span>
                  </div>
                  {/* Confidence bar */}
                  <div className="w-full h-1 bg-x-hover rounded-full overflow-hidden">
                    <div className="h-full bg-x-accent-ink rounded-full transition-all" style={{ width: `${p.confidence * 100}%` }} />
                  </div>
                  <div className="flex gap-2">
                    <Button icon={Check} onClick={() => acceptProposal(p)} variant="primary" size="sm">
                      Accept
                    </Button>
                    <Button onClick={() => dismissProposal(p)} size="sm">
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}

              {proposals.length === 0 && (
                <div className="text-center py-8 text-[11px] text-x-faint">
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
                  <Button key={key} icon={Icon} onClick={() => setComplianceSection(key)}
                    selected={complianceSection === key}
                    size="sm">
                    {label}
                    {count > 0 && <span className="text-x-faint">({count})</span>}
                  </Button>
                ))}
              </div>

              {/* ── Sources section ── */}
              {complianceSection === 'sources' && (<>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-x-faint">{accessLog.entries.length} entries, {accessLog.domains.length} domains</span>
                  <IconButton icon={RefreshCw} label="Refresh access log" size="sm" onClick={loadAccessLog} className="ml-auto" />
                </div>

                {accessLog.domains.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    <Button onClick={() => setAccessFilter(null)} selected={!accessFilter} size="sm">
                      All
                    </Button>
                    {accessLog.domains.map(d => (
                      <Button key={d.domain || 'unknown'} onClick={() => setAccessFilter(d.domain)} selected={accessFilter === d.domain} size="sm">
                        {d.domain || 'search'} <span className="text-x-faint ml-0.5">({d.count})</span>
                      </Button>
                    ))}
                  </div>
                )}

                {accessLog.entries.map(e => (
                  <div key={e.id} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-x-surface border border-x-line/50 text-[11px]">
                    <span className={`font-medium shrink-0 ${
                      e.source_type === 'webfetch' ? 'text-x-accent' :
                      e.source_type === 'websearch' ? 'text-x-accent' :
                      'text-x-accent-ink'
                    }`}>
                      {e.source_type}
                    </span>
                    {e.domain && <span className="text-x-faint shrink-0">{e.domain}</span>}
                    <span className="text-x-ink-secondary truncate flex-1 font-mono">{e.url}</span>
                    <span className="text-x-faint shrink-0">{new Date(e.created_at).toLocaleString()}</span>
                  </div>
                ))}

                {accessLog.entries.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-x-faint">
                    No external access recorded yet. URLs from WebFetch, WebSearch, curl, and wget are logged automatically.
                  </div>
                )}
              </>)}

              {/* ── Commands section ── */}
              {complianceSection === 'commands' && (<>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 flex-1 h-8 px-2 bg-x-surface-2 border border-x-line rounded-md focus-within:border-x-accent focus-within:ring-[3px] focus-within:ring-x-focus">
                    <Search size={11} className="text-x-faint shrink-0" />
                    <input value={commandSearch} onChange={e => setCommandSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') loadCommandLog() }}
                      placeholder="Search commands..."
                      className="bg-transparent text-[13px] text-x-ink placeholder:text-x-muted outline-none w-full" />
                  </div>
                  <IconButton icon={RefreshCw} label="Refresh command log" size="sm" onClick={loadCommandLog} />
                </div>

                {commandLog.map(c => (
                  <div key={c.id} className="px-3 py-1.5 rounded-md bg-x-surface border border-x-line/50 text-[11px]">
                    <div className="flex items-center gap-2">
                      <Terminal size={10} className="text-x-accent-ink shrink-0" />
                      <span className="text-x-ink-secondary truncate flex-1 font-mono">{c.command}</span>
                      <span className="text-x-faint shrink-0">{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}

                {commandLog.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-x-faint">
                    No commands recorded yet. Every Bash command executed by agents is logged here.
                  </div>
                )}
              </>)}

              {/* ── Packages section ── */}
              {complianceSection === 'packages' && (<>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-x-faint">{packageScans.length} package scans</span>
                  <IconButton icon={RefreshCw} label="Refresh package scans" size="sm" onClick={loadPackageScans} className="ml-auto" />
                </div>

                {/* ── Install Script Policy ── */}
                <div className="px-3 py-2.5 rounded-md bg-x-surface-2 border border-x-line space-y-2">
                  <div className="flex items-center gap-2">
                    <Lock size={12} className="text-x-accent-ink shrink-0" />
                    <span className="text-[11px] font-medium text-x-accent-ink">Install Script Policy</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/30">Recommended</span>
                  </div>
                  <p className="text-[11px] text-x-ink-secondary leading-relaxed">
                    Block all packages with install scripts (preinstall, postinstall, build scripts, native extensions) and review case-by-case before adding to the allowlist.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={async () => {
                        const next = !scriptPolicy.block_all
                        await api.setInstallScriptPolicy(next)
                        setScriptPolicy(p => ({ ...p, block_all: next }))
                      }}
                      toggleState={scriptPolicy.block_all}
                      shape="card"
                      size="sm"
                    >
                      <span>
                        {scriptPolicy.block_all ? 'Blocking all install scripts' : 'Not blocking (allow unless flagged)'}
                      </span>
                    </Button>
                  </div>

                  {/* ── Allowlist ── */}
                  {scriptPolicy.allowlist.length > 0 && (
                    <div className="mt-1 space-y-1">
                      <span className="text-[11px] text-x-faint uppercase tracking-wide">Allowlisted packages</span>
                      {scriptPolicy.allowlist.map(a => (
                        <div key={a.id} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded-md bg-x-hover">
                          <Check size={9} className="text-x-good shrink-0" />
                          <span className="text-x-ink">{a.package}</span>
                          <span className="text-x-faint">{a.ecosystem}</span>
                          {a.reason && <span className="text-x-faint truncate max-w-[200px]">{a.reason}</span>}
                          <IconButton
                            icon={Trash2}
                            label={`Remove ${a.package} from the allowlist`}
                            variant="destructive"
                            size="sm"
                            onClick={async () => {
                              await api.removeInstallScriptAllowlist(a.id)
                              setScriptPolicy(p => ({ ...p, allowlist: p.allowlist.filter(x => x.id !== a.id) }))
                            }}
                            className="ml-auto"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {packageScans.map(p => {
                  const isFlagged = p.status === 'flagged'
                  const hasMalware = p.known_malware
                  const hasVulns = p.vuln_count > 0
                  const statusColor = hasMalware ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30'
                    : isFlagged ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30'
                    : hasVulns ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30'
                    : 'text-x-good bg-x-good/10 border-x-good/30'
                  const decisionColor = p.decision === 'block' || p.decision === 'deny' ? 'text-x-accent-ink'
                    : p.decision === 'warn' || p.decision === 'ask' ? 'text-x-accent-ink'
                    : 'text-x-good'

                  let llmVerdict = null
                  try { if (p.llm_verdict) llmVerdict = JSON.parse(p.llm_verdict) } catch {}

                  const isAllowlisted = scriptPolicy.allowlist.some(
                    a => a.package === p.package && a.ecosystem === p.ecosystem
                  )

                  return (
                    <div key={p.id} className="px-3 py-2 rounded-md bg-x-surface border border-x-line/50 text-[11px] space-y-1">
                      <div className="flex items-center gap-2">
                        <Package size={10} className="text-x-accent shrink-0" />
                        <span className="font-medium text-x-ink">{p.package}</span>
                        {p.version && <span className="text-x-faint">v{p.version}</span>}
                        <span className={`px-1 py-0 rounded-md border text-[11px] ${statusColor}`}>
                          {hasMalware ? 'MALWARE' : isFlagged ? 'flagged' : hasVulns ? 'vulns' : 'ok'}
                        </span>
                        <span className="text-x-faint">{p.ecosystem}</span>
                        <span className={`font-medium ml-auto ${decisionColor}`}>{p.decision}</span>
                        <span className="text-x-faint shrink-0">{new Date(p.created_at).toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-3 text-x-faint pl-4">
                        {p.age_days >= 0 && <span>Age: {p.age_days}d</span>}
                        {p.vuln_count > 0 && <span className={p.vuln_critical ? 'text-x-accent-ink' : 'text-x-accent-ink'}>
                          {p.vuln_count} vuln{p.vuln_count !== 1 ? 's' : ''}{p.vuln_critical ? ' (CRITICAL)' : ''}
                        </span>}
                        {p.fallback && <span>Fallback: <span className="text-x-good">{p.fallback}</span></span>}
                        {p.install_scripts && (
                          <span className="text-x-accent-ink flex items-center gap-1">
                            <AlertTriangle size={9} />
                            Install scripts
                            {isAllowlisted && <span className="text-x-good text-[11px]">(allowlisted)</span>}
                          </span>
                        )}
                      </div>

                      {/* LLM verdict */}
                      {llmVerdict && (
                        <div className={`flex items-center gap-2 pl-4 text-[11px] ${
                          llmVerdict.verdict === 'malicious' ? 'text-x-accent-ink'
                            : llmVerdict.verdict === 'suspicious' ? 'text-x-accent-ink'
                            : 'text-x-good'
                        }`}>
                          <Brain size={10} className="shrink-0" />
                          <span className="font-medium uppercase text-[11px]">{llmVerdict.verdict}</span>
                          <span className="text-x-ink-secondary truncate">{llmVerdict.summary}</span>
                        </div>
                      )}

                      {p.reason && (
                        <div className="text-x-faint pl-4 truncate">{p.reason}</div>
                      )}

                      {/* Allowlist button for packages with install scripts */}
                      {p.install_scripts && !isAllowlisted && (
                        <div className="pl-4 pt-0.5">
                          <Button
                            icon={Check}
                            onClick={async () => {
                              await api.addInstallScriptAllowlist(p.package, p.ecosystem, 'Reviewed and approved')
                              loadPackageScans()
                            }}
                            size="sm"
                          >
                            Add to allowlist
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}

                {packageScans.length === 0 && (
                  <div className="text-center py-8 text-[11px] text-x-faint">
                    No package scans recorded yet. AVCP results from npm, pip, cargo, and other installs appear here with security ratings.
                  </div>
                )}
              </>)}
            </div>
          )}
        </div>
    </div>
  )
}
