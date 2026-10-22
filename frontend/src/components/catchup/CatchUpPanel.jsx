// CatchUpPanel — modal panel showing the briefing + raw event digest.
//
// When opened from the banner with an `initialDigest`, the panel just
// renders that pre-fetched digest — it does not re-summarize. A rebrief
// only fires when the user explicitly picks a different time window
// (preset button, custom "Brief me", or the manual ↻ button). The model
// used for re-briefing is read from the global `catchup_model` setting.
//
// The digest is bucketed per workspace, so each bucket also offers "Show on
// graph": the same window projected onto that workspace's code graph
// (vision/CONVERGENCE_AND_CANVAS_TODO.md §4.A). It SWAPS the panel body rather
// than opening a second modal — the prose and the graph are two readings of one
// window, not two things to hold on screen at once. Text stays the default.

import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import PanelBoundary from '../PanelBoundary'

// Opt-in view → opt-in bytes. CatchUpPanel is statically imported by App, and
// the canvas drags in SystemGraph + CanvasControls behind it.
const WorkspaceChangesCanvas = lazy(() => import('../session/WorkspaceChangesCanvas'))

const RANGES = [
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '8h', label: 'Last 8 hours', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

// Format Date → "YYYY-MM-DDTHH:MM" for <input type="datetime-local">.
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Friendly one-line rendering for the security-relevant events emitted by
// the permission-mode ceiling + AVCP bridge. Returns null for event types
// we don't have a custom formatter for — caller falls back to the raw
// event_type + JSON dump.
function formatSecurityEvent(e) {
  const p = e.payload || {}
  switch (e.event_type) {
    case 'permission_mode_changed': {
      const who = p.source === 'agent' ? 'Agent' : p.source === 'joiner' ? 'Joiner' : 'You'
      return {
        label: 'Mode changed',
        summary: `${who} changed permission mode: ${p.from} → ${p.to}`,
        tone: 'neutral',
      }
    }
    case 'permission_mode_rejected': {
      const who = p.source === 'agent' ? 'Agent' : p.source || 'caller'
      return {
        label: 'Mode change blocked',
        summary: `${who} tried ${p.from} → ${p.to} — ${p.reason || 'rejected'}`,
        tone: 'warn',
      }
    }
    case 'avcp_decision': {
      const verb = p.decision === 'block' ? 'Blocked' : p.decision === 'warn' ? 'Warned on' : 'Allowed'
      const why = p.forced_by_plan_mode ? ' (plan mode)' : ''
      const cmd = p.command ? ` \`${p.command.slice(0, 80)}\`` : ''
      return {
        label: 'AVCP supply-chain check',
        summary: `${verb}${why}:${cmd}${p.reason ? ' — ' + p.reason : ''}`,
        tone: p.decision === 'block' ? 'bad' : p.decision === 'warn' ? 'warn' : 'good',
      }
    }
    default:
      return null
  }
}

// Which workspaces this digest actually covers.
//
// Events arrive pre-bucketed in `by_workspace`; commits and memory changes carry
// their own workspace_id. We union all three rather than reading only the commits
// buckets, because a workspace can have a busy window with zero commits — and the
// changes canvas projects file activity as well as commits, so it has something to
// show there. Events with no workspace (global/system) are dropped: there is no
// graph to put them on.
function digestWorkspaces(digest, workspaces) {
  if (!digest) return []
  const order = []
  const labels = new Map()
  const add = (id, label) => {
    if (!id) return
    if (!labels.has(id)) {
      order.push(id)
      labels.set(id, label || null)
    } else if (label && !labels.get(id)) {
      labels.set(id, label)
    }
  }
  for (const w of digest.commits || []) add(w.workspace_id, w.workspace_name)
  for (const b of digest.by_workspace || []) add(b.workspace_id, null)
  for (const m of digest.memory_changes || []) add(m.workspace_id, null)
  return order.map((id) => ({
    id,
    // The digest only names workspaces that had commits; the store knows the rest.
    label: labels.get(id) || workspaces.find((w) => w.id === id)?.name || id.slice(0, 8),
  }))
}

const TONE_CLASS = {
  bad:     'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink',
  warn:    'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink',
  good:    'border-x-good/30 bg-x-good/10 text-x-good',
  neutral: 'border-x-line bg-x-surface text-x-ink-secondary',
}

function formatElapsed(value) {
  const seconds = Math.max(0, Number(value) || 0)
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

function RightNowBlock({ rightNow }) {
  if (!rightNow) return null
  const sessions = Array.isArray(rightNow.sessions) ? rightNow.sessions : []
  const jobs = Array.isArray(rightNow.jobs) ? rightNow.jobs : []
  const pipelineRuns = Array.isArray(rightNow.pipeline_runs) ? rightNow.pipeline_runs : []
  const overflow = rightNow.overflow || {}
  const hasLiveRows = sessions.length > 0 || jobs.length > 0 || pipelineRuns.length > 0

  return (
    <section
      aria-label="Right now"
      data-testid="catchup-right-now"
      className="mb-3 rounded-lg border border-x-accent/25 bg-x-tint p-2.5"
    >
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-x-good animate-subtle-pulse" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-x-ink">Right now</h2>
        {rightNow.available && (
          <span className="ml-auto text-[11px] text-x-faint">
            {sessions.length} active · {jobs.length + pipelineRuns.length} in flight
          </span>
        )}
      </div>

      {!rightNow.available ? (
        <div className="text-xs text-x-faint">Live state is temporarily unavailable. The briefing below is complete.</div>
      ) : !hasLiveRows ? (
        <div className="text-xs text-x-faint">Nothing is running right now.</div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(sessions.length > 0 || overflow.sessions > 0) && (
            <div className="rounded-md border border-x-line bg-x-surface/80 p-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-x-muted">Active sessions</div>
              <ul className="space-y-1">
                {sessions.map((session) => {
                  const model = [session.cli_type, session.model].filter(Boolean).join(' / ')
                  return (
                    <li key={session.id} className="min-w-0 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-x-good" />
                        <span className="min-w-0 flex-1 truncate font-medium text-x-ink">{session.title || session.id}</span>
                        <span className="shrink-0 tabular-nums text-x-faint">{formatElapsed(session.elapsed)}</span>
                      </div>
                      <div className="ml-3 truncate text-[11px] text-x-muted">
                        {session.workspace || 'No workspace'} · {session.status || 'running'}{model ? ` · ${model}` : ''}
                      </div>
                    </li>
                  )
                })}
                {overflow.sessions > 0 && (
                  <li className="text-[11px] text-x-faint">+ {overflow.sessions} more active sessions</li>
                )}
              </ul>
            </div>
          )}

          {(jobs.length > 0 || pipelineRuns.length > 0 || overflow.jobs > 0 || overflow.pipeline_runs > 0) && (
            <div className="rounded-md border border-x-line bg-x-surface/80 p-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-x-muted">In flight</div>
              <ul className="space-y-1">
                {[...jobs.map((row) => ({ ...row, kind: 'Job' })), ...pipelineRuns.map((row) => ({ ...row, kind: 'Pipeline' }))].map((row) => (
                  <li key={`${row.kind}-${row.id}`} className="min-w-0 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 rounded border border-x-line px-1 text-[9px] uppercase text-x-muted">{row.kind}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-x-ink">{row.title || row.id}</span>
                      <span className="shrink-0 tabular-nums text-x-faint">{formatElapsed(row.elapsed)}</span>
                    </div>
                    <div className="ml-10 truncate text-[11px] text-x-muted">
                      {row.workspace || row.executor || 'Global'} · {row.status || 'running'}
                    </div>
                  </li>
                ))}
                {(overflow.jobs > 0 || overflow.pipeline_runs > 0) && (
                  <li className="text-[11px] text-x-faint">
                    + {Number(overflow.jobs || 0) + Number(overflow.pipeline_runs || 0)} more in-flight runs
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default function CatchUpPanel({ initialDigest = null, onClose }) {
  const [digest, setDigest] = useState(initialDigest)
  const [range, setRange] = useState('24h')
  const [customOpen, setCustomOpen] = useState(false)
  const [customSince, setCustomSince] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000))
  )
  const [customUntil, setCustomUntil] = useState(() => toLocalInput(new Date()))
  const modelRef = useRef('claude:haiku')
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [expandedCommits, setExpandedCommits] = useState({})
  const [expandedMemory, setExpandedMemory] = useState({})
  // {id, label} of the workspace whose graph is showing, or null for the digest.
  const [graphWs, setGraphWs] = useState(null)
  const graphCanvasRef = useRef(null)

  const workspaces = useStore((s) => s.workspaces)
  const graphTargets = useMemo(() => digestWorkspaces(digest, workspaces), [digest, workspaces])

  // A graph opened for the previous window would silently show the wrong one.
  useEffect(() => {
    setGraphWs(null)
  }, [digest?.since, digest?.until])

  function toggleCommit(hash) {
    setExpandedCommits((prev) => ({ ...prev, [hash]: !prev[hash] }))
  }

  function toggleMemory(idx) {
    setExpandedMemory((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }

  async function loadPreset(rangeId) {
    const r = RANGES.find((x) => x.id === rangeId) || RANGES[2]
    const since = new Date(Date.now() - r.ms).toISOString()
    return loadWindow({ since, until: undefined })
  }

  async function loadCustom() {
    if (!customSince) return
    const sinceIso = new Date(customSince).toISOString()
    const untilIso = customUntil ? new Date(customUntil).toISOString() : undefined
    return loadWindow({ since: sinceIso, until: untilIso })
  }

  async function loadWindow({ since, until }) {
    setLoading(true)
    try {
      const d = await api.getCatchup({
        since,
        until,
        limit: 500,
        model: modelRef.current,
      })
      setDigest(d)
    } catch (e) {
      console.warn('catchup load failed', e)
    } finally {
      setLoading(false)
    }
  }

  // Resolve the briefing model from global settings once on mount.
  // Only auto-load a digest when the panel was opened without a seed
  // (e.g. via a deep link / future entry points) — the banner-driven
  // open path passes `initialDigest` and we render that directly.
  useEffect(() => {
    let cancelled = false
    api
      .getAppSetting('catchup_model')
      .then((res) => {
        if (cancelled) return
        if (res?.value) {
          modelRef.current = res.value
        }
      })
      .catch(() => {})
      .then(() => {
        if (cancelled) return
        if (!initialDigest) loadPreset(range)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const briefing = digest?.summary
  const briefingFromLLM =
    digest?.summary_source && digest.summary_source !== 'deterministic'

  const sendChat = async (e) => {
    e?.preventDefault?.()
    const q = chatInput.trim()
    if (!q || chatLoading || !briefing) return
    const next = [...chatMessages, { role: 'user', content: q }]
    setChatMessages(next)
    setChatInput('')
    setChatLoading(true)
    try {
      // Send the digest so the chat agent can read events/commits/memory-changes (read-only tools).
      const chatDigest = {
        summary: briefing,
        workspace_id: digest?.workspace_id,
        events: (digest?.events || []).slice(0, 100),
        commits: digest?.commits || [],
        memory_changes: (digest?.memory_changes || []).slice(0, 100),
      }
      const res = await api.catchupChat(chatDigest, next)
      setChatMessages([...next, { role: 'assistant', content: res?.answer || '(no response)' }])
    } catch (err) {
      setChatMessages([...next, { role: 'assistant', content: `Error: ${err?.message || 'failed'}` }])
    } finally {
      setChatLoading(false)
    }
  }

  // ── Graph reading of the same window ──────────────────────────────────────
  // A swap, not a second modal: the digest state stays mounted behind this, so
  // "Briefing" is an instant return with the scroll/expansions intact. The graph
  // needs real width, so this variant is wider and centred rather than the
  // 2xl-at-pt-20 the prose uses.
  if (graphWs) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-4"
        onClick={() => {
          if (graphCanvasRef.current) graphCanvasRef.current.requestClose(onClose)
          else onClose()
        }}
      >
        <div
          className="flex h-[86vh] w-full max-w-6xl flex-col x-panel"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-x-line px-3 py-2">
            <button
              onClick={() => {
                if (graphCanvasRef.current) graphCanvasRef.current.requestClose(() => setGraphWs(null))
                else setGraphWs(null)
              }}
              className="rounded-md border border-x-line px-2 py-0.5 text-xs font-medium text-x-ink-secondary transition-colors duration-[80ms] hover:border-x-line-strong hover:bg-x-hover hover:text-x-ink"
            >
              ← Briefing
            </button>
            <span className="truncate text-xs text-x-faint">
              Same window as the briefing, projected onto {graphWs.label}&apos;s code graph
            </span>
            <button
              onClick={() => {
                if (graphCanvasRef.current) graphCanvasRef.current.requestClose(onClose)
                else onClose()
              }}
              className="ml-auto rounded-md px-2 py-0.5 text-x-muted transition-colors duration-[80ms] hover:bg-x-hover hover:text-x-ink"
            >
              ✕
            </button>
          </div>
          {/* Suspense covers the lazy chunk's LOADING; only a boundary covers it
              throwing (chunk fetch failure, a render error in the graph). Dismiss
              drops back to the briefing, which is still mounted behind this. */}
          <PanelBoundary onClose={() => setGraphWs(null)}>
            <Suspense
              fallback={<div className="flex-1 p-4 text-xs text-x-faint">Loading graph…</div>}
            >
              {/* `until` is absent for the preset ranges (they only pin a start),
                  which the canvas reads as "up to now" — same as the digest did. */}
              <WorkspaceChangesCanvas
                ref={graphCanvasRef}
                workspaceId={graphWs.id}
                sinceIso={digest?.since || null}
                untilIso={digest?.until || null}
                title={`${graphWs.label} · what changed`}
                onClose={() => setGraphWs(null)}
              />
            </Suspense>
          </PanelBoundary>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-x-scrim backdrop-blur-[4px] p-4 pt-20"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl x-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-x-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-x-ink">Briefing</div>
            <div className="text-xs text-x-faint">
              {digest ? (
                <>
                  {digest.total_events} event{digest.total_events !== 1 ? 's' : ''}
                  {digest.total_commits > 0 && (
                    <> · {digest.total_commits} commit{digest.total_commits !== 1 ? 's' : ''}</>
                  )}
                  {digest.total_memory_changes > 0 && (
                    <> · {digest.total_memory_changes} memory</>
                  )}
                </>
              ) : 'Loading…'}
              {briefingFromLLM && (
                <span className="ml-2 text-x-faint">· {digest.summary_source}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-x-muted transition-colors duration-[80ms] hover:bg-x-hover hover:text-x-ink"
          >
            ✕
          </button>
        </div>

        {/* Range controls — clicking a preset triggers a fresh briefing. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-x-line px-4 py-2">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setCustomOpen(false)
                setRange(r.id)
                loadPreset(r.id)
              }}
              className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors duration-[80ms] ${
                !customOpen && range === r.id
                  ? 'border-x-accent/45 bg-x-tint text-x-accent'
                  : 'border-x-line text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={() => setCustomOpen((v) => !v)}
            className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors duration-[80ms] ${
              customOpen
                ? 'border-x-accent/45 bg-x-tint text-x-accent'
                : 'border-x-line text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
            }`}
          >
            Custom…
          </button>

          <button
            onClick={() => (customOpen ? loadCustom() : loadPreset(range))}
            disabled={loading}
            className="ml-auto rounded-md border border-x-line px-2 py-0.5 text-xs text-x-ink-secondary transition-colors duration-[80ms] hover:bg-x-hover hover:text-x-ink disabled:opacity-40"
            title="Regenerate briefing"
          >
            ↻
          </button>
        </div>

        {customOpen && (
          <div className="flex flex-wrap items-center gap-2 border-b border-x-line px-4 py-2 text-xs text-x-ink-secondary">
            <label className="flex items-center gap-1">
              From
              <input
                type="datetime-local"
                value={customSince}
                onChange={(e) => setCustomSince(e.target.value)}
                className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-x-ink focus:outline-none focus:border-x-accent"
              />
            </label>
            <label className="flex items-center gap-1">
              To
              <input
                type="datetime-local"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-x-ink focus:outline-none focus:border-x-accent"
              />
            </label>
            <button
              onClick={() => loadCustom()}
              disabled={loading || !customSince}
              className="rounded-md border border-x-accent/30 bg-x-accent/10 px-2 py-0.5 font-medium text-x-accent transition-colors duration-[80ms] hover:bg-x-accent/20 disabled:opacity-40"
            >
              Brief me
            </button>
          </div>
        )}

        {/* Briefing prose + raw event detail */}
        <div className="max-h-[60vh] overflow-y-auto p-4 text-sm text-x-ink-secondary">
          {loading && (
            <div className="text-x-faint">
              {briefingFromLLM ? 'Re-briefing…' : 'Briefing…'}
            </div>
          )}

          {!loading && digest && (
            <>
              <RightNowBlock rightNow={digest.right_now} />
              {digest.total_events === 0 &&
              (digest.total_commits || 0) === 0 &&
              (digest.total_memory_changes || 0) === 0 ? (
                <div className="text-x-faint">No new activity in this window.</div>
              ) : (
                <>
                  <div className="mb-3 whitespace-pre-wrap rounded-lg border border-x-line bg-x-surface p-3 text-sm leading-relaxed text-x-ink">
                    {briefing}
                  </div>
                  {briefingFromLLM && digest.summary_basic && (
                    <div className="mb-3 text-xs text-x-faint">
                      Counts: {digest.summary_basic}
                    </div>
                  )}

                  {/* One per workspace bucket in this digest — the prose stays the
                      default reading; the graph is a click away, never in the way. */}
                  {graphTargets.length > 0 && (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-x-ink-secondary">
                        Show on graph
                      </span>
                      {graphTargets.map((w) => (
                        <button
                          key={w.id}
                          onClick={() => setGraphWs(w)}
                          title={`See this window on ${w.label}'s code graph`}
                          className="max-w-[200px] truncate rounded-md border border-x-line px-2 py-0.5 text-xs text-x-ink-secondary transition-colors duration-[80ms] hover:border-x-accent/45 hover:bg-x-tint hover:text-x-accent"
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {Array.isArray(digest.commits) && digest.commits.length > 0 && (
                    <div className="mb-3 rounded-lg border border-x-line bg-x-surface p-2">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-x-ink-secondary">
                        Commits
                      </div>
                      {digest.commits.map((w) => (
                        <div key={w.workspace_id} className="mb-2 last:mb-0">
                          <div className="text-xs text-x-faint">
                            {w.workspace_name || w.workspace_id}
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {w.commits.slice(0, 12).map((c) => {
                              const isExpanded = !!expandedCommits[c.hash]
                              const hasFiles = Array.isArray(c.files) && c.files.length > 0
                              return (
                                <li
                                  key={c.hash}
                                  className="flex flex-col gap-0.5 border-b border-x-line/20 py-1 last:border-b-0"
                                >
                                  <div className="flex items-baseline gap-2 font-mono text-xs text-x-ink-secondary">
                                    <span className="text-x-accent">{c.short_hash}</span>
                                    <span className="flex-1 truncate font-sans">{c.message}</span>
                                    {(c.files_changed || 0) > 0 && (
                                      <button
                                        onClick={() => hasFiles && toggleCommit(c.hash)}
                                        className={`text-x-muted hover:text-x-ink text-[11px] tabular-nums px-1 py-0.25 rounded-md border border-x-line hover:border-x-line-strong transition-colors duration-[80ms] ${hasFiles ? 'cursor-pointer' : 'cursor-default'}`}
                                      >
                                        {c.files_changed}f +{c.insertions}/-{c.deletions} {hasFiles ? (isExpanded ? '▴' : '▾') : ''}
                                      </button>
                                    )}
                                  </div>
                                  {isExpanded && hasFiles && (
                                    <ul className="mt-1 pl-6 space-y-0.5 text-[11px] text-x-muted font-mono">
                                      {c.files.map((f, fidx) => (
                                        <li key={fidx} className="flex justify-between gap-4">
                                          <span className="truncate">{f.path}</span>
                                          <span className="text-right text-[11px] tabular-nums">
                                            <span className="text-x-good font-medium">+{f.insertions}</span>
                                            <span className="text-x-accent-ink font-medium ml-1">-{f.deletions}</span>
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}

                  {Array.isArray(digest.memory_changes) &&
                    digest.memory_changes.length > 0 && (
                      <div className="mb-3 rounded-lg border border-x-line bg-x-surface p-2">
                        <button
                          onClick={() => setShowMemory((v) => !v)}
                          className="mb-1 text-[11px] font-medium uppercase tracking-wider text-x-ink-secondary hover:text-x-ink cursor-pointer transition-colors duration-[80ms]"
                        >
                          {showMemory ? '▾' : '▸'} Memory ({digest.memory_changes.length})
                        </button>
                        {showMemory && (
                        <ul className="space-y-1 text-xs text-x-ink-secondary mt-1">
                          {digest.memory_changes.map((m, idx) => {
                            const isExpanded = !!expandedMemory[idx]
                            const sizeStat = m.new_len !== undefined ? `${m.old_len}b → ${m.new_len}b` : `${m.content_length || 0}b`
                            const kind = m.kind || 'memory'
                            return (
                              <li key={idx} className="flex flex-col gap-1 border-b border-x-line/20 py-1 last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <span className="text-x-ink-secondary font-semibold">{kind}</span>{' '}
                                    <span className="text-x-faint">{m.scope}</span>{' '}
                                    {m.name && <span className="font-mono text-x-muted">{m.name}</span>}{' '}
                                    {m.stale && <span className="text-x-accent-ink">stale</span>}{' '}
                                    ws=<span className="font-mono">{(m.workspace_id || '').slice(0, 8)}</span>{' '}
                                    · {sizeStat} · updated{' '}
                                    {m.updated_at || m.last_synced_at || 'never'}
                                  </div>
                                  {m.diff && (
                                    <button
                                      onClick={() => toggleMemory(idx)}
                                      className="text-x-muted hover:text-x-ink text-[11px] px-1 py-0.25 rounded-md border border-x-line hover:border-x-line-strong cursor-pointer transition-colors duration-[80ms]"
                                    >
                                      {isExpanded ? 'Hide Diff ▴' : 'Show Diff ▾'}
                                    </button>
                                  )}
                                </div>
                                {isExpanded && m.diff && (
                                  <pre className="mt-1 max-h-40 overflow-y-auto rounded-md bg-x-surface-2 p-2 font-mono text-[11px] text-x-ink-secondary border border-x-line whitespace-pre-wrap">
                                    {m.diff}
                                  </pre>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                        )}
                      </div>
                    )}

                  <button
                    onClick={() => setShowRaw((v) => !v)}
                    className="mb-2 text-xs text-x-faint hover:text-x-ink"
                  >
                    {showRaw ? '▾ Hide event log' : '▸ Show event log'}
                  </button>
                  {showRaw && (
                    <div className="space-y-2">
                      {digest.events?.map((e) => {
                        const fmt = formatSecurityEvent(e)
                        const toneCls = fmt
                          ? TONE_CLASS[fmt.tone] || TONE_CLASS.neutral
                          : 'border-x-line bg-x-surface'
                        return (
                          <div key={e.id} className={`rounded-md border p-2 [content-visibility:auto] [contain-intrinsic-size:auto_72px] ${toneCls}`}>
                            <div className="flex items-center gap-2 text-xs text-x-faint">
                              <span className="font-mono text-x-ink-secondary">
                                {fmt?.label || e.event_type}
                              </span>
                              <span className="ml-auto">{e.created_at}</span>
                            </div>
                            {fmt ? (
                              <div className="mt-1 text-xs">{fmt.summary}</div>
                            ) : (
                              Object.keys(e.payload || {}).length > 0 && (
                                <pre className="mt-1 overflow-x-auto text-xs text-x-ink-secondary">
                                  {JSON.stringify(e.payload, null, 2)}
                                </pre>
                              )
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {briefing && (
          <div className="border-t border-x-line px-4 py-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-x-ink-secondary">
              Ask about this briefing
            </div>
            {chatMessages.length > 0 && (
              <div className="mb-2 max-h-48 space-y-2 overflow-y-auto">
                {chatMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`rounded-md p-2 text-xs whitespace-pre-wrap [content-visibility:auto] [contain-intrinsic-size:auto_44px] ${m.role === 'user' ? 'border border-x-accent/20 bg-x-accent/10 text-x-ink' : 'border border-x-line bg-x-surface text-x-ink-secondary'}`}
                  >
                    <div className="mb-0.5 text-[11px] uppercase tracking-wider text-x-muted">{m.role}</div>
                    {m.content}
                  </div>
                ))}
                {chatLoading && <div className="px-1 text-xs text-x-faint">thinking…</div>}
              </div>
            )}
            <form onSubmit={sendChat} className="flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask about the briefing…"
                className="flex-1 rounded-md border border-x-line bg-x-surface-2 px-2 py-1.5 text-xs text-x-ink placeholder:text-x-muted focus:border-x-accent focus:ring-[3px] focus:ring-x-focus focus:outline-none"
              />
              <button
                type="submit"
                disabled={chatLoading || !chatInput.trim()}
                className="rounded-md bg-x-accent px-3 py-1.5 text-xs font-medium text-x-on-accent transition-colors duration-[80ms] hover:bg-x-accent-ink active:scale-[.98] disabled:opacity-40 cursor-pointer"
              >
                Send
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
