import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, ExternalLink, Globe, Lock,
  Package, RefreshCw, ScrollText, Search, ShieldAlert, Sparkles, Terminal, X,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'events', label: 'Events', icon: ScrollText },
  { id: 'commands', label: 'Commands', icon: Terminal },
  { id: 'safety', label: 'AVCP', icon: ShieldAlert },
  { id: 'audit', label: 'HTTP Audit', icon: Lock },
  { id: 'external', label: 'External', icon: Globe },
]

const DOMAIN_SEARCH_KEY = '__search__'

function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : ''
}

function parseMaybeJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function pretty(value) {
  const parsed = parseMaybeJson(value)
  if (!parsed) return ''
  if (typeof parsed === 'string') return parsed
  return JSON.stringify(parsed, null, 2)
}

function compact(value, limit = 260) {
  const text = typeof value === 'string' ? value : pretty(value)
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function matchesQuery(value, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return JSON.stringify(value || {}).toLowerCase().includes(q)
}

function statusTone(status) {
  const code = Number(status)
  if (code >= 500) return 'red'
  if (code >= 400) return 'amber'
  if (code >= 200 && code < 300) return 'emerald'
  return 'default'
}

function decisionTone(decision) {
  if (decision === 'deny' || decision === 'block') return 'red'
  if (decision === 'ask' || decision === 'warn') return 'amber'
  if (decision === 'allow') return 'emerald'
  return 'default'
}

function summarizePayload(payload) {
  const p = parseMaybeJson(payload)
  if (!p || typeof p !== 'object') return compact(p)
  const parts = []
  for (const key of ['action', 'status', 'name', 'title', 'task_id', 'session_id', 'pipeline_id', 'run_id', 'count', 'path']) {
    if (p[key] !== undefined && p[key] !== null && p[key] !== '') parts.push(`${key}: ${String(p[key]).slice(0, 80)}`)
  }
  return parts.length ? parts.join(' | ') : compact(p)
}

function summarizeAudit(entry) {
  const summary = parseMaybeJson(entry.summary)
  if (!summary) return ''
  if (typeof summary === 'string') return compact(summary)
  const parts = []
  if (summary.status) parts.push(`status ${summary.status}`)
  if (summary.action) parts.push(summary.action)
  if (summary.params?.id) parts.push(`id ${shortId(summary.params.id)}`)
  if (summary.body?.name) parts.push(summary.body.name)
  return parts.length ? parts.join(' | ') : compact(summary)
}

function Chip({ children, tone = 'default', onClick, title }) {
  const toneClass = {
    default: 'bg-x-surface text-x-faint border-x-line-subtle',
    cyan: 'bg-x-accent/10 text-x-accent border-x-accent/25',
    amber: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/25',
    emerald: 'bg-x-good/10 text-x-good border-x-good/25',
    red: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/25',
    violet: 'bg-x-accent/10 text-x-accent border-x-accent/25',
  }[tone] || 'bg-x-surface text-x-faint border-x-line-subtle'
  const cls = `rounded border px-1.5 py-0.5 text-[11px] font-mono ${toneClass} ${onClick ? 'hover:bg-x-hover hover:text-x-ink' : ''}`
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cls}>
        {children}
      </button>
    )
  }
  return <span title={title} className={cls}>{children}</span>
}

function RowShell({ icon: Icon, iconClass = 'text-x-faint', title, meta, subtitle, chips, children }) {
  return (
    <div className="rounded border border-x-line-subtle/70 bg-x-surface/70 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        {Icon && <Icon size={13} className={`mt-0.5 shrink-0 ${iconClass}`} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-x-ink">{title}</div>
            {meta && <div className="shrink-0 text-[11px] font-mono text-x-faint">{meta}</div>}
          </div>
          {subtitle && <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-x-ink-secondary">{subtitle}</div>}
          {chips?.length ? <div className="mt-1.5 flex flex-wrap gap-1">{chips}</div> : null}
        </div>
      </div>
      {children && <div className="mt-1.5 pl-5">{children}</div>}
    </div>
  )
}

function DetailBlock({ label = 'details', value }) {
  const text = pretty(value)
  if (!text) return null
  return (
    <details className="group">
      <summary className="cursor-pointer text-[11px] font-mono text-x-faint hover:text-x-ink-secondary">
        {label}
      </summary>
      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded border border-x-line-subtle bg-x-surface-2 p-2 text-[11px] leading-relaxed text-x-ink-secondary">
        {text}
      </pre>
    </details>
  )
}

function WorkspacePill({ workspaceId, workspaces }) {
  if (!workspaceId) return null
  const workspace = workspaces.find((w) => w.id === workspaceId)
  return <Chip title={workspaceId}>{workspace?.name || shortId(workspaceId)}</Chip>
}

function SessionPill({ sessionId, sessions }) {
  if (!sessionId) return null
  const session = sessions[sessionId]
  const label = session?.name || session?.title || shortId(sessionId)
  return (
    <Chip
      tone="violet"
      title={sessionId}
      onClick={() => {
        const store = useStore.getState()
        store.openSession(sessionId)
        store.setActiveSession?.(sessionId)
        useStore.setState({ showHome: false })
      }}
    >
      session {label}
    </Chip>
  )
}

function EmptyState({ children }) {
  return (
    <div className="rounded border border-dashed border-x-line-subtle bg-x-surface-2 px-4 py-10 text-center text-[11px] text-x-faint">
      {children}
    </div>
  )
}

function ErrorNotice({ children }) {
  if (!children) return null
  return (
    <div className="mb-3 flex items-center gap-2 rounded border border-x-accent-ink/25 bg-x-accent-ink/10 px-3 py-2 text-[11px] text-x-accent-ink">
      <AlertTriangle size={13} className="shrink-0" />
      {children}
    </div>
  )
}

async function loadOrError(fn) {
  try {
    return { data: await fn(), error: null }
  } catch (error) {
    return { data: null, error }
  }
}

export default function GlobalLogsPanel({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(false)
  const [workspaceOnly, setWorkspaceOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [eventType, setEventType] = useState('')
  const [decisionFilter, setDecisionFilter] = useState('all')
  const [externalDomain, setExternalDomain] = useState('')
  const [data, setData] = useState({
    events: [],
    commands: [],
    decisions: [],
    audit: [],
    access: { entries: [], domains: [] },
    packages: [],
  })
  const [errors, setErrors] = useState({})
  const [allowSuggestions, setAllowSuggestions] = useState(null)
  const [suggestionEmptyMessage, setSuggestionEmptyMessage] = useState(null)
  const [suggestionError, setSuggestionError] = useState(null)
  const [suggestingAllows, setSuggestingAllows] = useState(false)
  const [applyingSuggestionId, setApplyingSuggestionId] = useState(null)
  const [appliedAllowRules, setAppliedAllowRules] = useState([])

  const workspaceId = workspaceOnly ? activeWorkspaceId : ''

  const load = useCallback(async () => {
    setLoading(true)
    const common = { limit: 300 }
    const scoped = workspaceId ? { ...common, workspace_id: workspaceId } : common
    const eventParams = workspaceId ? { limit: 300, workspace: workspaceId } : { limit: 300 }

    const [events, commands, decisions, audit, access, packages] = await Promise.all([
      loadOrError(() => api.getEvents(eventParams)),
      loadOrError(() => api.getCommandLog(scoped)),
      loadOrError(() => api.getSafetyDecisions(scoped)),
      loadOrError(() => api.listAuditLog({ limit: 300 })),
      loadOrError(() => api.getExternalAccessLog(scoped)),
      loadOrError(() => api.getPackageScans(scoped)),
    ])

    setData({
      events: Array.isArray(events.data?.events) ? events.data.events : [],
      commands: Array.isArray(commands.data) ? commands.data : [],
      decisions: Array.isArray(decisions.data) ? decisions.data : [],
      audit: Array.isArray(audit.data?.entries) ? audit.data.entries : [],
      access: {
        entries: Array.isArray(access.data?.entries) ? access.data.entries : [],
        domains: Array.isArray(access.data?.domains) ? access.data.domains : [],
      },
      packages: Array.isArray(packages.data) ? packages.data : [],
    })
    setErrors({
      events: events.error,
      commands: commands.error,
      decisions: decisions.error,
      audit: audit.error,
      access: access.error,
      packages: packages.error,
    })
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  const suggestAllows = useCallback(async () => {
    setSuggestingAllows(true)
    setSuggestionError(null)
    setSuggestionEmptyMessage(null)
    try {
      const result = await api.suggestSafetyAllows(workspaceOnly ? activeWorkspaceId : undefined)
      setAllowSuggestions(Array.isArray(result?.suggestions) ? result.suggestions : [])
      setSuggestionEmptyMessage(result?.empty_message || null)
    } catch (error) {
      setAllowSuggestions([])
      setSuggestionError(error.message || 'Could not generate auto-allow suggestions.')
    } finally {
      setSuggestingAllows(false)
    }
  }, [activeWorkspaceId, workspaceOnly])

  const applyAllowSuggestion = async (suggestion) => {
    setApplyingSuggestionId(suggestion.id)
    setSuggestionError(null)
    try {
      const result = await api.createSafetyRule(suggestion.rule)
      setAppliedAllowRules((current) => [
        ...current,
        { ...suggestion.rule, id: result?.id || suggestion.id },
      ])
      setAllowSuggestions((current) => (current || []).filter((item) => item.id !== suggestion.id))
    } catch (error) {
      setSuggestionError(error.message || 'Could not apply this allow rule.')
    } finally {
      setApplyingSuggestionId(null)
    }
  }

  const dismissAllowSuggestion = (suggestionId) => {
    setAllowSuggestions((current) => (current || []).filter((item) => item.id !== suggestionId))
  }

  const eventTypes = useMemo(() => (
    [...new Set(data.events.map((event) => event.event_type).filter(Boolean))].sort()
  ), [data.events])

  const filtered = useMemo(() => {
    const events = data.events
      .filter((event) => !eventType || event.event_type === eventType)
      .filter((event) => matchesQuery(event, query))
    const commands = data.commands.filter((command) => matchesQuery(command, query))
    const decisions = data.decisions
      .filter((decision) => decisionFilter === 'all' || decision.decision === decisionFilter)
      .filter((decision) => matchesQuery(decision, query))
    const packages = data.packages.filter((scan) => matchesQuery(scan, query))
    const audit = data.audit.filter((entry) => matchesQuery(entry, query))
    const access = (data.access.entries || [])
      .filter((entry) => !externalDomain || (entry.domain || DOMAIN_SEARCH_KEY) === externalDomain)
      .filter((entry) => matchesQuery(entry, query))
    return { events, commands, decisions, packages, audit, access }
  }, [data, decisionFilter, eventType, externalDomain, query])

  const counts = useMemo(() => ({
    overview: data.events.length + data.commands.length + data.decisions.length + data.audit.length + data.access.entries.length + data.packages.length,
    events: data.events.length,
    commands: data.commands.length,
    safety: data.decisions.length + data.packages.length,
    audit: data.audit.length,
    external: data.access.entries.length,
  }), [data])

  const visibleCounts = useMemo(() => ({
    overview: filtered.events.length + filtered.commands.length + filtered.decisions.length + filtered.audit.length + filtered.access.length + filtered.packages.length,
    events: filtered.events.length,
    commands: filtered.commands.length,
    safety: filtered.decisions.length + filtered.packages.length,
    audit: filtered.audit.length,
    external: filtered.access.length,
  }), [filtered])

  const latest = useMemo(() => {
    const rows = [
      ...filtered.events.slice(0, 10).map((event) => ({
        key: `event-${event.id}`,
        kind: 'event',
        time: event.created_at,
        icon: ScrollText,
        iconClass: 'text-x-accent',
        title: event.event_type,
        subtitle: summarizePayload(event.payload) || event.source,
        chips: [
          event.source && <Chip key="source" tone="cyan">{event.source}</Chip>,
          event.actor && <Chip key="actor">{event.actor}</Chip>,
          <WorkspacePill key="ws" workspaceId={event.workspace_id} workspaces={workspaces} />,
          <SessionPill key="session" sessionId={event.session_id} sessions={sessions} />,
          event.task_id && <Chip key="task">task {shortId(event.task_id)}</Chip>,
        ].filter(Boolean),
      })),
      ...filtered.commands.slice(0, 10).map((command) => ({
        key: `command-${command.id}`,
        kind: 'command',
        time: command.created_at,
        icon: Terminal,
        iconClass: 'text-x-accent-ink',
        title: command.command,
        subtitle: command.workspace_id || command.session_id ? 'Recorded Bash command from an agent session.' : 'Recorded Bash command.',
        chips: [
          <WorkspacePill key="ws" workspaceId={command.workspace_id} workspaces={workspaces} />,
          <SessionPill key="session" sessionId={command.session_id} sessions={sessions} />,
        ].filter(Boolean),
      })),
      ...filtered.decisions.slice(0, 10).map((decision) => ({
        key: `decision-${decision.id}`,
        kind: 'decision',
        time: decision.created_at,
        icon: decisionTone(decision.decision) === 'red' ? AlertTriangle : ShieldAlert,
        iconClass: decisionTone(decision.decision) === 'red' ? 'text-x-accent-ink' : decisionTone(decision.decision) === 'amber' ? 'text-x-accent-ink' : 'text-x-good',
        title: `${decision.tool_name} ${decision.decision}`,
        subtitle: compact(decision.tool_input_summary) || decision.reason || 'No tool input summary recorded.',
        chips: [
          <Chip key="decision" tone={decisionTone(decision.decision)}>{decision.decision}</Chip>,
          decision.reason && <Chip key="reason">{decision.reason}</Chip>,
          decision.governance === 'precedent' && (
            <Chip key="governance" tone="violet">
              precedent: {decision.precedent_class || 'same-class history'}
            </Chip>
          ),
          decision.governance === 'rule' && <Chip key="governance">governed by rule</Chip>,
          <WorkspacePill key="ws" workspaceId={decision.workspace_id} workspaces={workspaces} />,
          <SessionPill key="session" sessionId={decision.session_id} sessions={sessions} />,
        ].filter(Boolean),
      })),
      ...filtered.audit.slice(0, 10).map((entry) => ({
        key: `audit-${entry.id}`,
        kind: 'audit',
        time: entry.ts,
        icon: Lock,
        iconClass: 'text-x-accent',
        title: `${entry.method} ${entry.path}`,
        subtitle: summarizeAudit(entry) || entry.user_agent || entry.actor_label || entry.actor_kind,
        chips: [
          <Chip key="status" tone={statusTone(entry.status)}>{entry.status || 'pending'}</Chip>,
          <Chip key="actor">{entry.actor_label || entry.actor_kind}</Chip>,
          entry.mode && <Chip key="mode">{entry.mode}</Chip>,
          entry.ip && <Chip key="ip">{entry.ip}</Chip>,
        ].filter(Boolean),
      })),
    ]
    return rows
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 24)
  }, [filtered, sessions, workspaces])

  const activeTotal = counts[tab] || counts.overview
  const activeVisible = visibleCounts[tab] || visibleCounts.overview

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim p-3 backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="x-panel flex h-[min(840px,calc(100dvh-1.5rem))] w-[min(1180px,calc(100vw-1.5rem))] flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-x-line bg-x-surface-2 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-x-accent" />
                <h2 className="truncate text-sm font-semibold text-x-ink">Activity / Audit Logs</h2>
                {loading && <RefreshCw size={12} className="animate-spin text-x-faint" />}
              </div>
              <p className="mt-1 text-[11px] text-x-faint">
                Events, agent commands, AVCP decisions, package scans, external access, and owner HTTP audit.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={suggestAllows}
                disabled={suggestingAllows}
                data-testid="suggest-auto-allows"
                className="flex items-center gap-1.5 rounded-full bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-x-on-accent transition-colors hover:bg-x-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {suggestingAllows
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <Sparkles size={12} />}
                Suggest auto-allows
              </button>
              <button
                onClick={() => setWorkspaceOnly((v) => !v)}
                disabled={!activeWorkspaceId}
                className={`rounded border px-2 py-1 text-[11px] font-mono ${workspaceOnly
                  ? 'border-x-accent/35 bg-x-accent/15 text-x-accent'
                  : 'border-x-line-subtle bg-x-surface text-x-ink-secondary hover:bg-x-hover'} disabled:opacity-40`}
              >
                {workspaceOnly ? 'Active workspace' : 'All workspaces'}
              </button>
              <button onClick={load} className="rounded border border-x-line-subtle bg-x-surface p-1.5 text-x-faint hover:bg-x-hover hover:text-x-ink-secondary">
                <RefreshCw size={14} />
              </button>
              <button onClick={onClose} className="rounded p-1.5 text-x-faint hover:bg-x-hover hover:text-x-ink-secondary">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex min-w-[260px] flex-1 items-center gap-2 rounded border border-x-line-subtle bg-x-surface px-2 py-1.5">
              <Search size={13} className="shrink-0 text-x-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search command, event, URL, actor, session, task, reason..."
                className="min-w-0 flex-1 bg-transparent text-[11px] text-x-ink outline-none placeholder:text-x-faint"
              />
              {query && (
                <button onClick={() => setQuery('')} className="rounded px-1 text-[11px] text-x-faint hover:bg-x-hover hover:text-x-ink-secondary">
                  clear
                </button>
              )}
            </div>

            {tab === 'events' && (
              <select
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                className="rounded border border-x-line-subtle bg-x-surface px-2 py-1.5 text-[11px] text-x-ink-secondary outline-none"
              >
                <option value="">All event types</option>
                {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            )}

            {tab === 'safety' && (
              <select
                value={decisionFilter}
                onChange={(e) => setDecisionFilter(e.target.value)}
                className="rounded border border-x-line-subtle bg-x-surface px-2 py-1.5 text-[11px] text-x-ink-secondary outline-none"
              >
                <option value="all">All decisions</option>
                <option value="allow">allow</option>
                <option value="ask">ask</option>
                <option value="warn">warn</option>
                <option value="deny">deny</option>
                <option value="block">block</option>
              </select>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-48 shrink-0 border-r border-x-line bg-x-surface/40 p-2">
            <div className="space-y-1">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[11px] transition-colors ${tab === id
                    ? 'bg-x-accent/15 text-x-accent'
                    : 'text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'}`}
                >
                  <Icon size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="font-mono text-[11px] text-x-faint">
                    {visibleCounts[id] ?? counts[id] ?? 0}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto p-4">
            {(allowSuggestions !== null || appliedAllowRules.length > 0 || suggestionError) && (
              <section
                className="mb-4 rounded-xl border border-x-line bg-x-surface p-3"
                data-testid="auto-allow-suggestions"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-x-ink">
                      <Sparkles size={12} className="text-x-accent" /> Suggested auto-allows
                    </h3>
                    <p className="mt-1 text-[11px] text-x-faint">
                      The cheap safety model reviewed recent prompts; nothing is applied without your click.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Hide auto-allow suggestions"
                    onClick={() => {
                      setAllowSuggestions(null)
                      setSuggestionEmptyMessage(null)
                      setSuggestionError(null)
                    }}
                    className="rounded-lg p-1 text-x-faint hover:bg-x-hover hover:text-x-ink"
                  >
                    <X size={13} />
                  </button>
                </div>

                {suggestionError && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-x-accent-ink/25 bg-x-accent-ink/10 px-3 py-2 text-[11px] text-x-accent-ink">
                    <AlertTriangle size={12} /> {suggestionError}
                  </div>
                )}

                {appliedAllowRules.length > 0 && (
                  <div className="mt-3 rounded-lg border border-x-good/25 bg-x-good/10 px-3 py-2">
                    <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-x-good">
                      Applied this session
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {appliedAllowRules.map((rule) => (
                        <span key={rule.id} className="rounded-full border border-x-good/25 bg-x-surface px-2 py-1 text-[11px] text-x-ink">
                          {rule.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {allowSuggestions?.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {allowSuggestions.map((suggestion) => (
                      <article key={suggestion.id} className="rounded-xl border border-x-line-subtle bg-x-surface/60 p-3">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="text-[12px] font-semibold text-x-ink">{suggestion.rule?.name}</h4>
                              <span className="rounded-full border border-x-line bg-x-surface px-2 py-0.5 font-mono text-[11px] text-x-faint">
                                {suggestion.evidence_count} events
                              </span>
                              <span className="rounded-full border border-x-line bg-x-surface px-2 py-0.5 font-mono text-[11px] text-x-faint">
                                {suggestion.rule?.workspace_id ? 'workspace' : 'global'}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-x-ink-secondary">{suggestion.rationale}</p>
                            <pre className="mt-2 overflow-x-auto rounded-lg border border-x-line bg-x-surface-2 px-2 py-1.5 font-mono text-[11px] text-x-ink">
                              {suggestion.pattern}
                            </pre>
                            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-x-accent-ink">
                              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                              {suggestion.risk_note}
                            </p>
                            {suggestion.sample_commands?.length > 0 && (
                              <details className="mt-2">
                                <summary className="cursor-pointer font-mono text-[11px] text-x-faint hover:text-x-ink-secondary">
                                  sample commands ({suggestion.sample_commands.length})
                                </summary>
                                <div className="mt-1.5 space-y-1">
                                  {suggestion.sample_commands.map((command, index) => (
                                    <code key={`${suggestion.id}-${index}`} className="block overflow-x-auto rounded-lg bg-x-surface-2 px-2 py-1 font-mono text-[11px] text-x-ink-secondary">
                                      {command}
                                    </code>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => applyAllowSuggestion(suggestion)}
                              disabled={applyingSuggestionId === suggestion.id}
                              className="rounded-full bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-x-on-accent hover:bg-x-accent-ink disabled:opacity-50"
                            >
                              {applyingSuggestionId === suggestion.id ? 'Applying…' : 'Apply'}
                            </button>
                            <button
                              type="button"
                              onClick={() => dismissAllowSuggestion(suggestion.id)}
                              className="rounded-full border border-x-line bg-x-surface px-3 py-1.5 text-[11px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : allowSuggestions !== null && !suggestionError ? (
                  <div className="mt-3 rounded-lg border border-dashed border-x-line-subtle bg-x-surface-2 px-4 py-7 text-center text-[11px] text-x-faint">
                    {suggestionEmptyMessage || 'No safe repeated auto-allows were suggested.'}
                  </div>
                ) : null}
              </section>
            )}

            {tab === 'overview' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                  {[
                    ['Events', filtered.events.length, data.events.length, ScrollText, 'events'],
                    ['Commands', filtered.commands.length, data.commands.length, Terminal, 'commands'],
                    ['AVCP decisions', filtered.decisions.length, data.decisions.length, ShieldAlert, 'safety'],
                    ['Package scans', filtered.packages.length, data.packages.length, Package, 'safety'],
                    ['External sources', filtered.access.length, data.access.entries.length, Globe, 'external'],
                  ].map(([label, visible, total, Icon, target]) => (
                    <button
                      key={label}
                      onClick={() => setTab(target)}
                      className="rounded border border-x-line-subtle bg-x-surface px-3 py-2 text-left transition-colors hover:bg-x-hover"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-x-faint">
                        <Icon size={12} /> {label}
                      </div>
                      <div className="mt-1 text-lg font-semibold text-x-ink">
                        {visible}{visible !== total && <span className="ml-1 text-[11px] font-normal text-x-faint">of {total}</span>}
                      </div>
                    </button>
                  ))}
                </div>
                <ErrorNotice>{Object.values(errors).filter(Boolean).length ? 'Some log sources could not be loaded. Open the relevant tab for details.' : null}</ErrorNotice>
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-x-faint">Latest Matching Activity</h3>
                  <div className="space-y-2">
                    {latest.map((row) => (
                      <RowShell
                        key={row.key}
                        icon={row.icon}
                        iconClass={row.iconClass}
                        title={row.title}
                        meta={formatDateTime(row.time)}
                        subtitle={row.subtitle}
                        chips={row.chips}
                      />
                    ))}
                    {!latest.length && <EmptyState>No activity matches the current filters.</EmptyState>}
                  </div>
                </section>
              </div>
            )}

            {tab === 'events' && (
              <div className="space-y-2">
                <ErrorNotice>{errors.events?.message}</ErrorNotice>
                {filtered.events.map((event) => (
                  <RowShell
                    key={event.id}
                    icon={ScrollText}
                    iconClass="text-x-accent"
                    title={event.event_type}
                    meta={formatDateTime(event.created_at)}
                    subtitle={summarizePayload(event.payload)}
                    chips={[
                      event.source && <Chip key="source" tone="cyan">{event.source}</Chip>,
                      event.actor && <Chip key="actor">{event.actor}</Chip>,
                      <WorkspacePill key="ws" workspaceId={event.workspace_id} workspaces={workspaces} />,
                      <SessionPill key="session" sessionId={event.session_id} sessions={sessions} />,
                      event.task_id && <Chip key="task">task {shortId(event.task_id)}</Chip>,
                    ].filter(Boolean)}
                  >
                    <DetailBlock label="payload" value={event.payload} />
                  </RowShell>
                ))}
                {!filtered.events.length && !errors.events && <EmptyState>No commander events match the current filters.</EmptyState>}
              </div>
            )}

            {tab === 'commands' && (
              <div className="space-y-2">
                <ErrorNotice>{errors.commands?.message}</ErrorNotice>
                {filtered.commands.map((command) => (
                  <RowShell
                    key={command.id}
                    icon={Terminal}
                    iconClass="text-x-accent-ink"
                    title={command.command}
                    meta={formatDateTime(command.created_at)}
                    subtitle={command.command}
                    chips={[
                      <WorkspacePill key="ws" workspaceId={command.workspace_id} workspaces={workspaces} />,
                      <SessionPill key="session" sessionId={command.session_id} sessions={sessions} />,
                    ].filter(Boolean)}
                  />
                ))}
                {!filtered.commands.length && !errors.commands && <EmptyState>No agent commands match the current filters.</EmptyState>}
              </div>
            )}

            {tab === 'safety' && (
              <div className="space-y-4">
                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-x-faint">
                    <ShieldAlert size={12} /> Safety Decisions
                  </h3>
                  <ErrorNotice>{errors.decisions?.message}</ErrorNotice>
                  <div className="space-y-2">
                    {filtered.decisions.map((decision) => {
                      const tone = decisionTone(decision.decision)
                      return (
                        <RowShell
                          key={decision.id}
                          icon={tone === 'red' ? AlertTriangle : CheckCircle2}
                          iconClass={tone === 'red' ? 'text-x-accent-ink' : tone === 'amber' ? 'text-x-accent-ink' : 'text-x-good'}
                          title={`${decision.tool_name} -> ${decision.decision}`}
                          meta={formatDateTime(decision.created_at)}
                          subtitle={compact(decision.tool_input_summary) || decision.reason || 'No tool input summary recorded.'}
                          chips={[
                            <Chip key="decision" tone={tone}>{decision.decision}</Chip>,
                            decision.reason && <Chip key="reason">{decision.reason}</Chip>,
                            <WorkspacePill key="ws" workspaceId={decision.workspace_id} workspaces={workspaces} />,
                            <SessionPill key="session" sessionId={decision.session_id} sessions={sessions} />,
                            decision.matched_rule_id && <Chip key="rule">rule {shortId(decision.matched_rule_id)}</Chip>,
                            decision.governance === 'precedent' && (
                              <Chip key="governance" tone="violet">
                                riding precedent: {decision.precedent_class || 'same-class history'}
                              </Chip>
                            ),
                            decision.governance === 'rule' && <Chip key="governance">governed by rule</Chip>,
                            decision.latency_ms !== undefined && decision.latency_ms !== null && <Chip key="latency">{decision.latency_ms}ms</Chip>,
                          ].filter(Boolean)}
                        >
                          <DetailBlock label="tool input" value={decision.tool_input_summary} />
                          <DetailBlock label="precedent why" value={decision.precedent_reason} />
                          <DetailBlock label="influencing decision ids" value={decision.precedent_decision_ids} />
                        </RowShell>
                      )
                    })}
                    {!filtered.decisions.length && !errors.decisions && <EmptyState>No AVCP decisions match the current filters.</EmptyState>}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-x-faint">
                    <Package size={12} /> Package Scans
                  </h3>
                  <ErrorNotice>{errors.packages?.message}</ErrorNotice>
                  <div className="space-y-2">
                    {filtered.packages.map((scan) => {
                      const risky = scan.status === 'flagged' || scan.known_malware || scan.vuln_count > 0
                      return (
                        <RowShell
                          key={scan.id}
                          icon={Package}
                          iconClass={risky ? 'text-x-accent-ink' : 'text-x-good'}
                          title={`${scan.package}${scan.version ? `@${scan.version}` : ''}`}
                          meta={formatDateTime(scan.created_at)}
                          subtitle={scan.reason || scan.install_scripts || scan.fallback}
                          chips={[
                            <Chip key="ecosystem">{scan.ecosystem}</Chip>,
                            <Chip key="status" tone={risky ? 'amber' : 'emerald'}>{scan.status}</Chip>,
                            <Chip key="decision" tone={decisionTone(scan.decision)}>{scan.decision}</Chip>,
                            Number(scan.vuln_count) > 0 && <Chip key="vulns" tone="amber">{scan.vuln_count} vulns</Chip>,
                            scan.known_malware ? <Chip key="malware" tone="red">malware</Chip> : null,
                            <WorkspacePill key="ws" workspaceId={scan.workspace_id} workspaces={workspaces} />,
                            <SessionPill key="session" sessionId={scan.session_id} sessions={sessions} />,
                          ].filter(Boolean)}
                        >
                          <DetailBlock label="advisories" value={scan.advisories} />
                          <DetailBlock label="llm verdict" value={scan.llm_verdict} />
                        </RowShell>
                      )
                    })}
                    {!filtered.packages.length && !errors.packages && <EmptyState>No package scans match the current filters.</EmptyState>}
                  </div>
                </section>
              </div>
            )}

            {tab === 'audit' && (
              <div className="space-y-2">
                <ErrorNotice>{errors.audit?.status === 403 ? 'HTTP audit is owner-only in multiplayer mode.' : errors.audit?.message}</ErrorNotice>
                {filtered.audit.map((entry) => (
                  <RowShell
                    key={entry.id}
                    icon={Lock}
                    iconClass="text-x-accent"
                    title={`${entry.method} ${entry.path}`}
                    meta={formatDateTime(entry.ts)}
                    subtitle={summarizeAudit(entry) || entry.user_agent}
                    chips={[
                      <Chip key="status" tone={statusTone(entry.status)}>{entry.status || 'pending'}</Chip>,
                      <Chip key="actor">{entry.actor_label || entry.actor_kind}</Chip>,
                      entry.mode && <Chip key="mode">{entry.mode}</Chip>,
                      entry.ip && <Chip key="ip">{entry.ip}</Chip>,
                    ].filter(Boolean)}
                  >
                    <DetailBlock label="summary" value={entry.summary} />
                    <DetailBlock label="user agent" value={entry.user_agent} />
                  </RowShell>
                ))}
                {!filtered.audit.length && !errors.audit && <EmptyState>No HTTP audit entries match the current filters.</EmptyState>}
              </div>
            )}

            {tab === 'external' && (
              <div className="space-y-4">
                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-x-faint">
                    <Globe size={12} /> External Sources
                  </h3>
                  <ErrorNotice>{errors.access?.message}</ErrorNotice>
                  {data.access.domains?.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1">
                      <Chip tone={!externalDomain ? 'cyan' : 'default'} onClick={() => setExternalDomain('')}>
                        all ({data.access.entries.length})
                      </Chip>
                      {data.access.domains.slice(0, 40).map((domain) => {
                        const key = domain.domain || DOMAIN_SEARCH_KEY
                        const active = externalDomain === key
                        return (
                          <Chip key={key} tone={active ? 'cyan' : 'default'} onClick={() => setExternalDomain(key)}>
                            {domain.domain || 'search'} ({domain.count})
                          </Chip>
                        )
                      })}
                    </div>
                  )}
                  <div className="space-y-2">
                    {filtered.access.map((entry) => (
                      <RowShell
                        key={entry.id}
                        icon={Globe}
                        iconClass="text-x-accent"
                        title={(
                          <a href={entry.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-x-accent hover:text-x-accent">
                            <span className="truncate">{entry.url}</span>
                            <ExternalLink size={10} className="shrink-0" />
                          </a>
                        )}
                        meta={formatDateTime(entry.created_at)}
                        subtitle={entry.tool_name ? `Tool: ${entry.tool_name}` : ''}
                        chips={[
                          <Chip key="source" tone="cyan">{entry.source_type}</Chip>,
                          entry.domain && (
                            <Chip key="domain" onClick={() => setExternalDomain(entry.domain)}>
                              {entry.domain}
                            </Chip>
                          ),
                          !entry.domain && (
                            <Chip key="domain-search" onClick={() => setExternalDomain(DOMAIN_SEARCH_KEY)}>
                              search
                            </Chip>
                          ),
                          <WorkspacePill key="ws" workspaceId={entry.workspace_id} workspaces={workspaces} />,
                          <SessionPill key="session" sessionId={entry.session_id} sessions={sessions} />,
                        ].filter(Boolean)}
                      />
                    ))}
                    {!filtered.access.length && !errors.access && <EmptyState>No external source access matches the current filters.</EmptyState>}
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>

        <footer className="flex items-center justify-between border-t border-x-line bg-x-surface-2 px-4 py-2 text-[11px] text-x-faint">
          <span className="flex items-center gap-1"><Clock3 size={11} /> Newest entries first, last 300 per source</span>
          <span>{activeVisible} of {activeTotal} shown · {workspaceOnly ? 'active workspace' : 'global activity'}</span>
        </footer>
      </div>
    </div>
  )
}
