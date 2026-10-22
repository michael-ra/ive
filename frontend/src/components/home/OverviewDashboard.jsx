import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock3,
  FlaskConical,
  RotateCcw,
  Search,
  Settings2,
  Terminal,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import useStore from '../../state/store'

const MIN_REFRESH_MS = 10_000
const POLL_INTERVAL_MS = 30_000
const DASHBOARD_PREFERENCES_KEY = 'ive.dashboard.preferences.v1'

const DASHBOARD_SECTIONS = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'test_queue', label: 'Test queue' },
  { id: 'open_tasks', label: 'Open tasks' },
  { id: 'active_research', label: 'Active research' },
]

const OverviewContribution = resolveExtensionPanel('company', 'CompanyOverview')

const STATUS_ORDER = new Map([
  ['running', 0],
  ['working', 1],
  ['executing', 2],
  ['waiting', 3],
  ['prompting', 4],
  ['idle', 5],
  ['ready', 6],
  ['auth_failed', 7],
  ['quota_exceeded', 8],
  ['error', 9],
  ['failed', 10],
  ['exited', 11],
])

const ATTENTION_STATUSES = new Set(['auth_failed', 'quota_exceeded', 'error', 'failed', 'crashed'])
const DETAILED_BLOCKED_STATUSES = new Set(['auth_failed', 'quota_exceeded', 'error'])

const STATUS_TONES = {
  running: 'bg-x-accent',
  working: 'bg-x-accent',
  executing: 'bg-x-accent',
  idle: 'bg-x-line-strong',
  ready: 'bg-x-line-strong',
  auth_failed: 'bg-x-danger',
  quota_exceeded: 'bg-x-danger',
  error: 'bg-x-danger',
  failed: 'bg-x-danger',
}

const UPDATED_TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const ITEM_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function defaultDashboardPreferences() {
  return {
    order: DASHBOARD_SECTIONS.map((section) => section.id),
    shown: Object.fromEntries(DASHBOARD_SECTIONS.map((section) => [section.id, true])),
    density: 'comfortable',
  }
}

function normalizeDashboardPreferences(value) {
  const defaults = defaultDashboardPreferences()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults

  const sectionIds = DASHBOARD_SECTIONS.map((section) => section.id)
  const order = Array.isArray(value.order) ? value.order : []
  const hasExactOrder = order.length === sectionIds.length &&
    new Set(order).size === sectionIds.length &&
    order.every((id) => sectionIds.includes(id))
  const shown = value.shown && typeof value.shown === 'object' && !Array.isArray(value.shown)
    ? Object.fromEntries(sectionIds.map((id) => [id, value.shown[id] !== false]))
    : defaults.shown

  return {
    order: hasExactOrder ? [...order] : defaults.order,
    shown,
    density: value.density === 'compact' ? 'compact' : 'comfortable',
  }
}

function readDashboardPreferences() {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY)
    if (!raw) return defaultDashboardPreferences()
    return normalizeDashboardPreferences(JSON.parse(raw))
  } catch {
    return defaultDashboardPreferences()
  }
}

function writeDashboardPreferences(value) {
  try {
    window.localStorage.setItem(DASHBOARD_PREFERENCES_KEY, JSON.stringify(value))
  } catch {
    // Per-viewer preferences are optional; the in-memory view remains usable.
  }
}

function resetStoredDashboardPreferences() {
  try {
    window.localStorage.removeItem(DASHBOARD_PREFERENCES_KEY)
  } catch {
    // Reset still applies in memory when browser storage is unavailable.
  }
}

function openProjectSurface(workspaceId, surfaceId) {
  useStore.getState().setActiveWorkspace(workspaceId)
  window.dispatchEvent(new CustomEvent('open-panel', { detail: surfaceId }))
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function isDetailGroup(value) {
  return Boolean(
    value &&
    isCount(value.total) &&
    Array.isArray(value.items) &&
    value.items.length <= value.total
  )
}

function isOverviewPayload(value) {
  if (!value || !isCount(value.workspace_total) || !isCount(value.detail_limit)) return false
  if (!Array.isArray(value.workspaces) || value.workspaces.length !== value.workspace_total) return false

  return value.workspaces.every((workspace) => {
    const statuses = workspace?.sessions?.by_status
    if (!workspace?.id || !isCount(workspace?.sessions?.total) || !statuses || Array.isArray(statuses)) return false
    if (!Object.values(statuses).every(isCount)) return false
    if (Object.values(statuses).reduce((sum, count) => sum + count, 0) !== workspace.sessions.total) return false
    if (!isDetailGroup(workspace.blocked_sessions)) return false
    if (!isDetailGroup(workspace.open_tasks)) return false
    if (!isDetailGroup(workspace.active_research)) return false
    if (!isCount(workspace.test_queue?.depth) || !isCount(workspace.test_queue?.running_total)) return false
    if (workspace.test_queue.running_total === 0 && workspace.test_queue.running) return false
    return true
  })
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function statusLabel(status) {
  return String(status)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatItemTime(value) {
  if (!value) return null
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return null
  return ITEM_TIME.format(timestamp)
}

function hiddenCount(group) {
  return Math.max(0, group.total - group.items.length)
}

function problemSessionCount(workspace) {
  return Object.entries(workspace.sessions.by_status).reduce(
    (total, [status, count]) => total + (ATTENTION_STATUSES.has(status) ? count : 0),
    0,
  )
}

function undetailedProblemStatuses(workspace) {
  return Object.entries(workspace.sessions.by_status)
    .filter(([status, count]) => count > 0 && ATTENTION_STATUSES.has(status) && !DETAILED_BLOCKED_STATUSES.has(status))
}

function activityCount(workspace) {
  const runningSessions = workspace.sessions.by_status.running || 0
  return runningSessions + workspace.test_queue.depth + workspace.test_queue.running_total +
    workspace.open_tasks.total + workspace.active_research.total
}

function compareProjects(left, right) {
  const leftProblems = problemSessionCount(left)
  const rightProblems = problemSessionCount(right)
  const leftNeedsAttention = left.blocked_sessions.total > 0 || leftProblems > 0
  const rightNeedsAttention = right.blocked_sessions.total > 0 || rightProblems > 0

  return Number(rightNeedsAttention) - Number(leftNeedsAttention) ||
    right.blocked_sessions.total - left.blocked_sessions.total ||
    rightProblems - leftProblems ||
    activityCount(right) - activityCount(left) ||
    String(left.name || left.id).localeCompare(String(right.name || right.id))
}

function sortProjects(workspaces, projectOrder) {
  const attentionFirst = [...workspaces].sort(compareProjects)
  if (!projectOrder?.length) return attentionFirst

  const byId = new Map(attentionFirst.map((workspace) => [workspace.id, workspace]))
  const ordered = projectOrder.flatMap((projectId) => {
    const workspace = byId.get(projectId)
    if (!workspace) return []
    byId.delete(projectId)
    return [workspace]
  })
  return [...ordered, ...attentionFirst.filter((workspace) => byId.has(workspace.id))]
}

function Remainder({ count, label }) {
  if (count <= 0) return null
  return <p className="mt-2 text-[10px] font-medium text-x-faint">+{count} more {label}</p>
}

function SurfaceMetric({ total, label, onNavigate, children = total }) {
  if (total <= 0 || !onNavigate) {
    return <span className="font-mono text-xs font-semibold text-x-ink">{children}</span>
  }
  return (
    <button
      type="button"
      onClick={onNavigate}
      className="rounded-md font-mono text-xs font-semibold text-x-accent underline-offset-2 transition-colors hover:text-x-accent-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-accent"
      aria-label={label}
    >
      {children}
    </button>
  )
}

function MetricPanel({ icon: Icon, label, total, onNavigate, navigationLabel, compact, children }) {
  return (
    <section className={`rounded-[10px] border border-x-line bg-x-surface-2/40 ${compact ? 'p-2.5' : 'p-3'}`}>
      <div className={`${compact ? 'mb-1.5' : 'mb-2'} flex items-center justify-between gap-3`}>
        <div className="flex items-center gap-2 text-x-muted">
          <Icon size={13} />
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.07em]">{label}</h4>
        </div>
        <SurfaceMetric total={total} label={navigationLabel} onNavigate={onNavigate} />
      </div>
      {children}
    </section>
  )
}

function BlockedSessions({ group, compact }) {
  if (group.total === 0) return null

  return (
    <section className={`mt-3 rounded-[10px] border border-x-danger/30 bg-x-danger/[0.06] ${compact ? 'p-2.5' : 'p-3'}`} aria-label={plural(group.total, 'blocked session')}>
      <div className="mb-2 flex items-center gap-2 text-x-danger">
        <AlertTriangle size={14} className="shrink-0" />
        <h4 className="text-[11px] font-semibold">{plural(group.total, 'blocked session')}</h4>
      </div>
      <ul className="grid gap-2 lg:grid-cols-2">
        {group.items.map((session) => {
          const lastActive = formatItemTime(session.last_active_at)
          return (
            <li key={session.id}>
              <a
                href={`#session-${encodeURIComponent(session.id)}`}
                className="block rounded-lg border border-x-danger/20 bg-x-surface px-3 py-2 transition-colors hover:border-x-danger/40 hover:bg-x-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-accent"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-x-ink">{session.name || session.id}</span>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-x-danger">
                    {statusLabel(session.status || 'blocked')}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-x-ink-secondary">{session.reason || 'Reason unavailable'}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-x-faint">
                  {session.role && <span>{session.role}</span>}
                  {lastActive && <span>Last active {lastActive}</span>}
                </div>
              </a>
            </li>
          )
        })}
      </ul>
      <Remainder count={hiddenCount(group)} label="blocked sessions" />
    </section>
  )
}

function OtherSessionAttention({ workspace, compact }) {
  const statuses = undetailedProblemStatuses(workspace)
  if (statuses.length === 0) return null
  const total = statuses.reduce((sum, [, count]) => sum + count, 0)
  return (
    <section className={`mt-3 rounded-[10px] border border-x-danger/30 bg-x-danger/[0.06] ${compact ? 'p-2.5' : 'p-3'}`}>
      <div className="flex items-start gap-2 text-x-danger">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div>
          <h4 className="text-[11px] font-semibold">{plural(total, 'session')} need review</h4>
          <p className="mt-1 text-[10px] text-x-ink-secondary">
            {statuses.map(([status, count]) => `${count} ${statusLabel(status)}`).join(' · ')}
          </p>
        </div>
      </div>
    </section>
  )
}

function SessionBreakdown({ sessions }) {
  const statuses = Object.entries(sessions.by_status)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => {
      const leftOrder = STATUS_ORDER.get(left) ?? 99
      const rightOrder = STATUS_ORDER.get(right) ?? 99
      return leftOrder - rightOrder || left.localeCompare(right)
    })

  if (sessions.total === 0) {
    return <p className="text-[11px] text-x-faint">No sessions</p>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {statuses.map(([status, count]) => (
        <span key={status} className="inline-flex items-center gap-1.5 rounded-full border border-x-line bg-x-surface px-2 py-1 text-[10px] text-x-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_TONES[status] || 'bg-x-accent'}`} />
          <span>{statusLabel(status)}</span>
          <strong className="font-mono font-semibold text-x-ink">{count}</strong>
        </span>
      ))}
    </div>
  )
}

function TestQueue({ queue, onNavigate, compact }) {
  const running = queue.running
  const extraRunning = Math.max(0, queue.running_total - (running ? 1 : 0))
  const total = queue.depth + queue.running_total

  return (
    <section className={`rounded-[10px] border border-x-line bg-x-surface-2/40 ${compact ? 'p-2.5' : 'p-3'}`}>
      <div className={`${compact ? 'mb-1.5' : 'mb-2'} flex items-center justify-between gap-3`}>
        <div className="flex items-center gap-2 text-x-muted">
          <FlaskConical size={13} />
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.07em]">Test queue</h4>
        </div>
        <SurfaceMetric total={total} label={`Open ${plural(total, 'test queue item')} for this project`} onNavigate={onNavigate}>
          <span className="flex items-center gap-2 text-[10px]">
            <span className="text-x-muted">{queue.depth} queued</span>
            <span className="text-x-good">{queue.running_total} running</span>
          </span>
        </SurfaceMetric>
      </div>
      {running ? (
        <div className="rounded-lg border border-x-line bg-x-surface px-2.5 py-2">
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-x-good animate-subtle-pulse" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium text-x-ink">{running.title || running.task_id || running.id}</p>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[9px] text-x-faint">
                {running.task_revision != null && <span>revision {running.task_revision}</span>}
                {running.assigned_session_id && (
                  <a className="text-x-accent hover:underline" href={`#session-${encodeURIComponent(running.assigned_session_id)}`}>
                    assigned session
                  </a>
                )}
                {formatItemTime(running.started_at) && <span>started {formatItemTime(running.started_at)}</span>}
              </div>
            </div>
          </div>
          <Remainder count={extraRunning} label="running tests" />
        </div>
      ) : (
        <p className="text-[11px] text-x-faint">{queue.running_total > 0 ? 'Running details unavailable' : 'Nothing running'}</p>
      )}
    </section>
  )
}

function OpenTasks({ group, onNavigate, compact }) {
  return (
    <MetricPanel
      icon={Clock3}
      label="Open tasks"
      total={group.total}
      onNavigate={onNavigate}
      navigationLabel={`Open ${plural(group.total, 'task')} for this project`}
      compact={compact}
    >
      {group.items.length > 0 ? (
        <ul className="space-y-1.5">
          {group.items.map((task) => (
            <li key={task.id} className="flex min-w-0 items-start justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-x-ink-secondary">{task.title || task.id}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase text-x-faint">
                {[task.priority, task.status].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-x-faint">{group.total === 0 ? 'No open tasks' : 'Task details unavailable'}</p>
      )}
      <Remainder count={hiddenCount(group)} label="open tasks" />
    </MetricPanel>
  )
}

function ActiveResearch({ group, onNavigate, compact }) {
  return (
    <MetricPanel
      icon={Search}
      label="Active research"
      total={group.total}
      onNavigate={onNavigate}
      navigationLabel={`Open ${plural(group.total, 'active research item')} for this project`}
      compact={compact}
    >
      {group.items.length > 0 ? (
        <ul className="space-y-1.5">
          {group.items.map((research) => (
            <li key={research.id} className="flex min-w-0 items-start justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-x-ink-secondary">{research.topic || research.id}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase text-x-faint">{statusLabel(research.status)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-x-faint">{group.total === 0 ? 'No active research' : 'Research details unavailable'}</p>
      )}
      <Remainder count={hiddenCount(group)} label="research items" />
    </MetricPanel>
  )
}

function DashboardPreferences({ preferences, open, onToggleOpen, onChange, onReset }) {
  const move = (id, direction) => {
    const from = preferences.order.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= preferences.order.length) return
    const order = [...preferences.order]
    ;[order[from], order[to]] = [order[to], order[from]]
    onChange({ ...preferences, order })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-x-line bg-x-surface px-3 py-2 text-xs font-semibold text-x-ink-secondary transition-colors hover:border-x-line-strong hover:text-x-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-accent-ink"
        aria-expanded={open}
        aria-controls="dashboard-preferences"
      >
        <Settings2 size={14} /> Customize
      </button>
      {open && (
        <div id="dashboard-preferences" className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-x-line bg-x-surface p-3 shadow-x-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-x-ink">Dashboard view</h3>
            <button type="button" onClick={onReset} className="inline-flex items-center gap-1 text-[10px] font-semibold text-x-accent hover:text-x-accent-ink">
              <RotateCcw size={11} /> Reset to default
            </button>
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-x-faint">Saved only in this browser. Attention signals cannot be hidden.</p>
          <div className="mt-3 space-y-1.5">
            {preferences.order.map((id, index) => {
              const section = DASHBOARD_SECTIONS.find((candidate) => candidate.id === id)
              return (
                <div key={id} className="flex items-center gap-2 rounded-lg border border-x-line bg-x-surface-2/40 px-2 py-1.5">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-[10px] text-x-ink-secondary">
                    <input
                      type="checkbox"
                      checked={preferences.shown[id]}
                      onChange={() => onChange({
                        ...preferences,
                        shown: { ...preferences.shown, [id]: !preferences.shown[id] },
                      })}
                    />
                    <span className="truncate">{section.label}</span>
                  </label>
                  <button type="button" onClick={() => move(id, -1)} disabled={index === 0} className="text-x-muted enabled:hover:text-x-ink disabled:opacity-25" aria-label={`Move ${section.label} up`}>
                    <ChevronUp size={12} />
                  </button>
                  <button type="button" onClick={() => move(id, 1)} disabled={index === preferences.order.length - 1} className="text-x-muted enabled:hover:text-x-ink disabled:opacity-25" aria-label={`Move ${section.label} down`}>
                    <ChevronDown size={12} />
                  </button>
                </div>
              )
            })}
          </div>
          <fieldset className="mt-3">
            <legend className="text-[9px] font-semibold uppercase tracking-wide text-x-faint">Density</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-x-surface-2 p-1">
              {['comfortable', 'compact'].map((density) => (
                <button
                  key={density}
                  type="button"
                  onClick={() => onChange({ ...preferences, density })}
                  className={`rounded-md px-2 py-1.5 text-[10px] font-semibold capitalize ${
                    preferences.density === density ? 'bg-x-surface text-x-ink shadow-x-1' : 'text-x-muted hover:text-x-ink'
                  }`}
                  aria-pressed={preferences.density === density}
                >
                  {density}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  )
}

function ProjectCard({ workspace, preferences, actions = null }) {
  const problems = problemSessionCount(workspace)
  const needsAttention = workspace.blocked_sessions.total > 0 || problems > 0
  const compact = preferences.density === 'compact'
  const visibleSections = preferences.order.filter((id) => preferences.shown[id])
  const quiet = workspace.sessions.total === 0 && workspace.test_queue.depth === 0 &&
    workspace.test_queue.running_total === 0 && workspace.open_tasks.total === 0 &&
    workspace.active_research.total === 0

  return (
    <article className={`ive-project-card rounded-xl border bg-x-surface shadow-x-1 ${compact ? 'p-3' : 'p-4'} ${needsAttention ? 'border-x-accent-ink/30' : 'border-x-line'}`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-x-faint">Project</p>
          <h3 className="truncate text-sm font-semibold text-x-ink">{workspace.name || workspace.id}</h3>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
            needsAttention
              ? 'border-x-accent-ink/30 bg-x-accent-ink/[0.08] text-x-accent-ink'
              : quiet
                ? 'border-x-line bg-x-surface-2 text-x-faint'
                : 'border-x-good/25 bg-x-good/10 text-x-good'
          }`}>
            {needsAttention ? 'Needs attention' : quiet ? 'Quiet' : 'Live'}
          </span>
        </div>
      </header>

      <BlockedSessions group={workspace.blocked_sessions} compact={compact} />
      <OtherSessionAttention workspace={workspace} compact={compact} />

      {visibleSections.length > 0 && (
        <div className={`mt-3 grid md:grid-cols-2 ${compact ? 'gap-2' : 'gap-3'}`}>
          {visibleSections.map((section) => {
            if (section === 'sessions') {
              return (
                <MetricPanel key={section} icon={Terminal} label="Sessions" total={workspace.sessions.total} compact={compact}>
                  <SessionBreakdown sessions={workspace.sessions} />
                </MetricPanel>
              )
            }
            if (section === 'test_queue') {
              return (
                <TestQueue
                  key={section}
                  queue={workspace.test_queue}
                  compact={compact}
                  onNavigate={() => openProjectSurface(workspace.id, 'feature-board')}
                />
              )
            }
            if (section === 'open_tasks') {
              return (
                <OpenTasks
                  key={section}
                  group={workspace.open_tasks}
                  compact={compact}
                  onNavigate={() => openProjectSurface(workspace.id, 'feature-board')}
                />
              )
            }
            return (
              <ActiveResearch
                key={section}
                group={workspace.active_research}
                compact={compact}
                onNavigate={() => openProjectSurface(workspace.id, 'research')}
              />
            )
          })}
        </div>
      )}
    </article>
  )
}

export default function OverviewDashboard() {
  const currentAuth = useStore((state) => state.currentAuth)
  const [snapshot, setSnapshot] = useState({
    kind: 'loading',
    data: null,
    refreshedAt: null,
  })
  const [presentation, setPresentation] = useState(null)
  const [preferences, setPreferences] = useState(readDashboardPreferences)
  const [preferencesOpen, setPreferencesOpen] = useState(false)

  const updatePreferences = (nextPreferences) => {
    const normalized = normalizeDashboardPreferences(nextPreferences)
    setPreferences(normalized)
    writeDashboardPreferences(normalized)
  }

  const resetPreferences = () => {
    const defaults = defaultDashboardPreferences()
    resetStoredDashboardPreferences()
    setPreferences(defaults)
  }

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let refreshAfterFlight = false
    let lastRequestAt = 0
    let refreshTimer = null
    let pendingSnapshot = null

    const commit = (nextSnapshot) => {
      if (cancelled) return
      if (document.activeElement?.matches('[data-home-composer]')) {
        pendingSnapshot = nextSnapshot
        return
      }
      setSnapshot(nextSnapshot)
    }

    const flushPending = () => {
      if (cancelled || !pendingSnapshot) return
      const nextSnapshot = pendingSnapshot
      pendingSnapshot = null
      setSnapshot(nextSnapshot)
    }

    const refresh = () => {
      if (cancelled) return
      const wait = MIN_REFRESH_MS - (Date.now() - lastRequestAt)
      if (wait > 0) {
        if (!refreshTimer) {
          refreshTimer = window.setTimeout(() => {
            refreshTimer = null
            refresh()
          }, wait)
        }
        return
      }
      if (inFlight) {
        refreshAfterFlight = true
        return
      }

      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
        refreshTimer = null
      }
      inFlight = true
      lastRequestAt = Date.now()
      api.getOverview()
        .then((overview) => {
          if (!isOverviewPayload(overview)) {
            commit({ kind: 'unavailable', data: null, refreshedAt: null })
            return
          }
          commit({ kind: 'ready', data: overview, refreshedAt: new Date() })
        })
        .catch(() => commit({ kind: 'unavailable', data: null, refreshedAt: null }))
        .finally(() => {
          inFlight = false
          if (refreshAfterFlight) {
            refreshAfterFlight = false
            refresh()
          }
        })
    }

    refresh()
    const poll = window.setInterval(refresh, POLL_INTERVAL_MS)
    window.addEventListener('test-queue-update', refresh)
    document.addEventListener('focusout', flushPending)

    return () => {
      cancelled = true
      window.clearInterval(poll)
      if (refreshTimer) window.clearTimeout(refreshTimer)
      window.removeEventListener('test-queue-update', refresh)
      document.removeEventListener('focusout', flushPending)
    }
  }, [currentAuth])

  const baseProjects = useMemo(() => snapshot.data ? sortProjects(snapshot.data.workspaces) : [], [snapshot.data])
  const projects = useMemo(() => sortProjects(baseProjects, presentation?.order), [baseProjects, presentation?.order])

  return (
    <section className="ive-project-overview mb-10" aria-labelledby="home-live-state-title">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-x-accent">
            <Activity size={13} />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em]">Live state</span>
          </div>
          <h2 id="home-live-state-title" className="text-lg font-semibold text-x-ink">Every project at a glance</h2>
        </div>
        <div className="flex items-center gap-2">
          {snapshot.kind === 'ready' && snapshot.refreshedAt && (
            <p className="font-mono text-[11px] text-x-muted">
              {plural(snapshot.data.workspace_total, 'project')} · updated {UPDATED_TIME.format(snapshot.refreshedAt)}
            </p>
          )}
          <DashboardPreferences
            preferences={preferences}
            open={preferencesOpen}
            onToggleOpen={() => setPreferencesOpen((open) => !open)}
            onChange={updatePreferences}
            onReset={resetPreferences}
          />
        </div>
      </header>

      <OverviewContribution projects={baseProjects} compact={preferences.density === 'compact'} onContribution={setPresentation} />

      <div aria-live="polite">
        {snapshot.kind === 'loading' && (
          <div className="rounded-xl border border-x-line bg-x-surface px-4 py-5 text-sm text-x-muted shadow-x-1">
            Reading current project activity…
          </div>
        )}

        {snapshot.kind === 'unavailable' && (
          <div className="rounded-xl border border-x-accent-ink/25 bg-x-surface px-4 py-5 shadow-x-1">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-x-accent-ink" />
              <div>
                <h3 className="text-sm font-semibold text-x-ink">Live overview unavailable</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-x-muted">
                  Current project activity is unknown. The composer and navigation remain available.
                </p>
              </div>
            </div>
          </div>
        )}

        {snapshot.kind === 'ready' && snapshot.data.workspace_total === 0 && (
          <div className="ive-activity-empty">
            <Activity size={24} aria-hidden="true" />
            <div>
              <h3>No project activity yet</h3>
              <p>Sessions, tasks, tests, and research will appear here when you connect a project.</p>
            </div>
          </div>
        )}

        {snapshot.kind === 'ready' && projects.length > 0 && (
          <div className={preferences.density === 'compact' ? 'space-y-2' : 'space-y-3'}>
            {projects.map((workspace, index) => (
              <ProjectCard
                key={workspace.id}
                workspace={workspace}
                preferences={preferences}
                actions={presentation?.renderActions?.(workspace, index, projects.length)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
