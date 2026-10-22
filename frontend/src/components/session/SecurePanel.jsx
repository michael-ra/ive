// SecurePanel — operator surface for a `secure` (offensive self-test) session.
//
// A Secure session drives a sandboxed Kali box that can only ever reach the
// IP/ports the operator signs into a SCOPE. This panel is that control plane:
//   (a) authorize a scope + provision the clamp  (POST /api/secure/provision)
//   (b) once active: run status + kill switch     (POST /api/secure/kill)
//   (c) live command feed = the scope-aware verdict audit trail (decisions)
//   (d) findings the agent has recorded
// It polls GET /api/secure/run every ~3s while mounted and stops on unmount.
//
// Styling mirrors CodeReviewPanel / CatchUpPanel (x-panel, design tokens).

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Shield, ShieldAlert, X, RefreshCw, Loader2, Plus, Trash2,
  AlertTriangle, Ban, Bug, Terminal, Globe, Lock, Crosshair,
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { Button } from '../ui'

const INTENSITIES = ['light', 'normal', 'aggressive']
const DEFAULT_TTL = 120

// Severity → chip styling. critical/high = red, medium = amber, low/info = neutral.
const SEVERITY_STYLES = {
  critical: 'border-x-accent-ink/50 bg-x-accent-ink/15 text-x-accent-ink',
  high: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  medium: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  low: 'border-x-line bg-x-hover text-x-ink-secondary',
  info: 'border-x-line bg-x-hover text-x-muted',
}

// Sonnet pre-exec verdict → chip styling. allow = green, ask = amber, deny = red.
const VERDICT_STYLES = {
  allow: 'border-x-good/40 bg-x-good/10 text-x-good',
  ask: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  deny: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
}

const STATUS_STYLES = {
  active: 'border-x-good/40 bg-x-good/10 text-x-good',
  provisioning: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  error: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  killed: 'border-x-accent-ink/40 bg-x-accent-ink/10 text-x-accent-ink',
  torndown: 'border-x-line bg-x-hover text-x-muted',
}

function severityClass(sev) {
  return SEVERITY_STYLES[(sev || 'info').toLowerCase()] || SEVERITY_STYLES.info
}
function verdictClass(d) {
  return VERDICT_STYLES[(d || 'ask').toLowerCase()] || VERDICT_STYLES.ask
}
function statusClass(s) {
  return STATUS_STYLES[(s || '').toLowerCase()] || STATUS_STYLES.torndown
}

function targetSummary(scope) {
  const targets = scope?.targets || []
  if (!targets.length) return '—'
  return targets
    .map((t) => `${t.ip}${(t.ports || []).length ? ':' + t.ports.join(',') : ''}`)
    .join('  ·  ')
}

export default function SecurePanel({ onClose }) {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const sessionId = activeSessionId
  const session = sessions[sessionId]

  // ── Run state (polled) ──
  const [run, setRun] = useState(null)
  const [findings, setFindings] = useState([])
  const [decisions, setDecisions] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [pollError, setPollError] = useState(null)

  // ── Scope authorizer form ──
  const [targetRows, setTargetRows] = useState([{ ip: '', ports: '' }])
  const [intensity, setIntensity] = useState('normal')
  const [roe, setRoe] = useState('')
  const [allowInternet, setAllowInternet] = useState(false)
  const [ttl, setTtl] = useState(String(DEFAULT_TTL))
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState(null)

  // ── Action state ──
  const [busy, setBusy] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const fetchRun = useCallback(async () => {
    if (!sessionId) { setLoaded(true); return }
    try {
      const res = await api.secureGetRun(sessionId)
      if (!mountedRef.current) return
      setRun(res?.run || null)
      setFindings(res?.findings || [])
      setDecisions(res?.decisions || [])
      setPollError(null)
    } catch (e) {
      if (mountedRef.current) setPollError(e.message)
    } finally {
      if (mountedRef.current) setLoaded(true)
    }
  }, [sessionId])

  // Poll every 3s while the document is visible; clean up on unmount.
  useEffect(() => {
    fetchRun()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchRun()
    }, 3000)
    return () => clearInterval(timer)
  }, [fetchRun])

  const isActive = run && run.status === 'active'

  const addTargetRow = () => setTargetRows((prev) => [...prev, { ip: '', ports: '' }])
  const removeTargetRow = (idx) =>
    setTargetRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
  const updateTargetRow = (idx, key, value) =>
    setTargetRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r)))

  const handleProvision = async () => {
    setProvisionError(null)
    if (!sessionId) { setProvisionError('No active session.'); return }
    const targets = targetRows
      .map((r) => ({
        ip: r.ip.trim(),
        ports: r.ports
          .split(',')
          .map((p) => parseInt(p.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0),
      }))
      .filter((t) => t.ip)
    if (!targets.length) {
      setProvisionError('Add at least one target IP.')
      return
    }
    setProvisioning(true)
    try {
      const scope = {
        targets,
        allow_internet: allowInternet,
        intensity,
        rules_of_engagement: roe.trim(),
      }
      await api.secureProvision(sessionId, scope, parseInt(ttl, 10) || DEFAULT_TTL)
      await fetchRun()
    } catch (e) {
      // Backend returns inline validation/clamp errors (e.g. "invalid scope: …").
      setProvisionError(e.message || 'Provision failed')
    } finally {
      if (mountedRef.current) setProvisioning(false)
    }
  }

  const handleKill = async () => {
    if (!run?.run_id || busy) return
    if (!window.confirm('Kill this Secure run? This immediately tears down the Kali box, its networks, and the egress clamp.')) return
    setBusy(true)
    try {
      await api.secureKill(run.run_id)
      await fetchRun()
    } catch (e) {
      if (mountedRef.current) setPollError(e.message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const handleTeardown = async () => {
    if (!run?.run_id || busy) return
    if (!window.confirm('End this Secure run and tear down the sandbox?')) return
    setBusy(true)
    try {
      await api.secureTeardown(run.run_id)
      await fetchRun()
    } catch (e) {
      if (mountedRef.current) setPollError(e.message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[920px] h-[calc(100vh-80px)] x-panel flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-x-line shrink-0">
          <ShieldAlert size={16} className="text-x-accent-ink" />
          <span className="text-[13px] font-semibold text-x-ink">Secure</span>
          <span className="text-[11px] font-mono text-x-faint">offensive self-test</span>
          {session?.name && (
            <span className="text-[11px] font-mono text-x-faint truncate max-w-[200px]">{session.name}</span>
          )}
          {run?.status && (
            <span className={`px-2 py-0.5 rounded border text-[11px] font-mono uppercase ${statusClass(run.status)}`}>
              {run.status}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={fetchRun}
            className="p-1.5 text-x-faint hover:text-x-ink-secondary rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={provisioning || busy ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1.5 text-x-faint hover:text-x-ink-secondary rounded transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {!sessionId ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <AlertTriangle size={22} className="text-x-accent-ink mb-3" />
              <p className="text-sm text-x-ink-secondary">No active session. Open a Secure session first.</p>
            </div>
          ) : !loaded ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="text-x-faint animate-spin" />
            </div>
          ) : (
            <>
              {pollError && (
                <div className="rounded border border-x-accent-ink/40 bg-x-accent-ink/10 px-3 py-2 text-xs text-x-accent-ink">
                  {pollError}
                </div>
              )}

              {isActive ? (
                <RunStatus
                  run={run}
                  busy={busy}
                  onKill={handleKill}
                  onTeardown={handleTeardown}
                />
              ) : (
                <ScopeAuthorizer
                  targetRows={targetRows}
                  onAddTarget={addTargetRow}
                  onRemoveTarget={removeTargetRow}
                  onUpdateTarget={updateTargetRow}
                  intensity={intensity}
                  setIntensity={setIntensity}
                  roe={roe}
                  setRoe={setRoe}
                  allowInternet={allowInternet}
                  setAllowInternet={setAllowInternet}
                  ttl={ttl}
                  setTtl={setTtl}
                  provisioning={provisioning}
                  error={provisionError}
                  onProvision={handleProvision}
                  lastRun={run}
                />
              )}

              {/* ── Live command feed (verdict audit trail) ── */}
              <CommandFeed decisions={decisions} />

              {/* ── Findings ── */}
              <Findings findings={findings} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Scope authorizer (no active run) ────────────────────────────────────────

function ScopeAuthorizer({
  targetRows, onAddTarget, onRemoveTarget, onUpdateTarget,
  intensity, setIntensity, roe, setRoe, allowInternet, setAllowInternet,
  ttl, setTtl, provisioning, error, onProvision, lastRun,
}) {
  return (
    <div className="rounded-lg border border-x-line bg-x-surface p-4">
      <div className="flex items-center gap-2 mb-3">
        <Crosshair size={14} className="text-x-accent-ink" />
        <span className="text-xs font-semibold uppercase tracking-wide text-x-ink-secondary">Scope authorizer</span>
      </div>

      {lastRun && lastRun.status === 'error' && (
        <div className="mb-3 rounded border border-x-accent-ink/40 bg-x-accent-ink/10 px-3 py-2 text-xs text-x-accent-ink">
          Last provision failed{lastRun.error ? `: ${lastRun.error}` : '.'}
        </div>
      )}
      {lastRun && (lastRun.status === 'killed' || lastRun.status === 'torndown') && (
        <div className="mb-3 rounded border border-x-line bg-x-hover px-3 py-2 text-xs text-x-faint">
          Previous run {lastRun.status}. Authorize a new scope to start again.
        </div>
      )}

      {/* Targets */}
      <label className="text-[11px] font-mono uppercase text-x-faint">Targets</label>
      <div className="mt-1.5 space-y-2">
        {targetRows.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={row.ip}
              onChange={(e) => onUpdateTarget(idx, 'ip', e.target.value)}
              placeholder="Target IP (e.g. 192.168.96.10)"
              className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            />
            <input
              type="text"
              value={row.ports}
              onChange={(e) => onUpdateTarget(idx, 'ports', e.target.value)}
              placeholder="Ports (e.g. 80, 443)"
              className="w-[160px] px-2.5 py-1.5 text-xs font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            />
            <button
              onClick={() => onRemoveTarget(idx)}
              disabled={targetRows.length <= 1}
              className="p-1.5 text-x-faint hover:text-x-accent-ink rounded disabled:opacity-30 disabled:cursor-not-allowed"
              title="Remove target"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <Button type="submit"
          onClick={onAddTarget}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono text-x-ink-secondary hover:text-x-ink border border-x-line hover:bg-x-hover hover:border-x-line-strong transition-colors"
        >
          <Plus size={11} /> Add target
        </Button>
      </div>

      {/* Intensity + TTL */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-mono uppercase text-x-faint">Intensity</label>
          <select
            value={intensity}
            onChange={(e) => setIntensity(e.target.value)}
            className="mt-1.5 w-full px-2.5 py-1.5 text-xs font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
          >
            {INTENSITIES.map((i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] font-mono uppercase text-x-faint">TTL (minutes)</label>
          <input
            type="number"
            min="1"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            className="mt-1.5 w-full px-2.5 py-1.5 text-xs font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
          />
        </div>
      </div>

      {/* Rules of engagement */}
      <div className="mt-4">
        <label className="text-[11px] font-mono uppercase text-x-faint">Rules of engagement</label>
        <textarea
          value={roe}
          onChange={(e) => setRoe(e.target.value)}
          rows={3}
          placeholder="What's in / out of bounds, do-not-touch, stop conditions…"
          className="mt-1.5 w-full px-2.5 py-2 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted resize-y focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
        />
      </div>

      {/* Allow general internet */}
      <label className="mt-4 flex items-start gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={allowInternet}
          onChange={(e) => setAllowInternet(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-x-tint-line bg-x-surface-2 cursor-pointer"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-x-ink">
            {allowInternet ? <Globe size={12} className="text-x-accent-ink" /> : <Lock size={12} className="text-x-good" />}
            Allow general internet (Mode B)
          </div>
          <p className="mt-0.5 text-[11px] text-x-faint leading-relaxed">
            {allowInternet
              ? 'Egress is widened beyond the targets via an allowlisted proxy. Only enable if the run truly needs it.'
              : 'OFF is safest — the box can reach the scoped targets only, with no path to the general internet.'}
          </p>
        </div>
      </label>

      {error && (
        <div className="mt-4 rounded border border-x-accent-ink/40 bg-x-accent-ink/10 px-3 py-2 text-xs text-x-accent-ink">
          {error}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end">
        <Button type="submit"
          onClick={onProvision}
          disabled={provisioning}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold border transition-colors duration-[80ms] ease-x bg-x-accent-ink/10 hover:bg-x-accent-ink/15 text-x-accent-ink border-x-accent-ink/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {provisioning ? <Loader2 size={13} className="animate-spin" /> : <Shield size={13} />}
          {provisioning ? 'Provisioning…' : 'Authorize & Provision'}
        </Button>
      </div>
    </div>
  )
}

// ── Run status + kill switch (active run) ───────────────────────────────────

function RunStatus({ run, busy, onKill, onTeardown }) {
  const scope = run?.scope || {}
  return (
    <div className="rounded-lg border border-x-good/30 bg-x-good/[0.04] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Shield size={14} className="text-x-good" />
        <span className="text-xs font-semibold uppercase tracking-wide text-x-ink-secondary">Run status</span>
        <div className="flex-1" />
        <Button type="submit"
          onClick={onTeardown}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border transition-colors duration-[80ms] ease-x text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border-x-line hover:border-x-line-strong disabled:opacity-40"
          title="Gracefully end the run and tear down the sandbox"
        >
          End run
        </Button>
        <Button type="submit"
          onClick={onKill}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border transition-colors duration-[80ms] ease-x bg-x-accent-ink/15 hover:bg-x-accent-ink/25 text-x-accent-ink border-x-accent-ink/40 disabled:opacity-40"
          title="Kill switch — immediate teardown"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
          Kill switch
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <Field label="Kali IP" value={run.kali_ip} mono />
        <Field label="Inner subnet" value={run.inner_subnet} mono />
        <Field label="Intensity" value={scope.intensity} />
        <Field
          label="Internet"
          value={scope.allow_internet ? 'allowed (Mode B)' : 'targets only (Mode A)'}
        />
        <div className="col-span-2">
          <Field label="Targets" value={targetSummary(scope)} mono />
        </div>
        {scope.rules_of_engagement && (
          <div className="col-span-2">
            <Field label="Rules of engagement" value={scope.rules_of_engagement} />
          </div>
        )}
        {scope.expires_at && (
          <Field label="Scope expires" value={scope.expires_at} mono />
        )}
        {run.scope_hash && (
          <Field label="Scope hash" value={String(run.scope_hash).slice(0, 16)} mono />
        )}
      </div>
    </div>
  )
}

function Field({ label, value, mono }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-mono uppercase text-x-faint">{label}</div>
      <div className={`text-x-ink break-words ${mono ? 'font-mono text-[11px]' : 'text-xs'}`}>
        {value || '—'}
      </div>
    </div>
  )
}

// ── Live command feed ───────────────────────────────────────────────────────

function CommandFeed({ decisions }) {
  return (
    <div className="rounded-lg border border-x-line bg-x-surface p-3">
      <div className="flex items-center gap-2 mb-2">
        <Terminal size={13} className="text-x-ink-secondary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-x-ink-secondary">Command feed</span>
        <span className="text-[11px] font-mono text-x-faint">scope-aware verdicts · audit trail</span>
        {decisions.length > 0 && (
          <span className="ml-auto text-[11px] font-mono text-x-faint">{decisions.length}</span>
        )}
      </div>
      {decisions.length === 0 ? (
        <p className="px-1 py-2 text-xs text-x-faint">
          No commands evaluated yet. The Secure agent's per-command verdicts stream here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {decisions.map((d) => (
            <div
              key={d.id}
              className="rounded-md border border-x-line bg-x-surface-2 px-2.5 py-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_56px]"
            >
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded border text-[11px] font-mono uppercase ${verdictClass(d.decision)}`}>
                  {d.decision}
                </span>
                <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-x-ink" title={d.command}>
                  {d.command}
                </code>
                {Number(d.confidence) > 0 && (
                  <span className="text-[11px] font-mono text-x-faint shrink-0">
                    {Math.round(Number(d.confidence) * 100)}%
                  </span>
                )}
                {d.cached ? (
                  <span className="text-[11px] font-mono text-x-accent/80 shrink-0" title="Served from the verdict cache">cached</span>
                ) : null}
                <span className="text-[11px] font-mono text-x-faint shrink-0">{d.created_at}</span>
              </div>
              {d.reason && (
                <div className="mt-1 text-[11px] text-x-ink-secondary break-words">{d.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Findings ────────────────────────────────────────────────────────────────

function Findings({ findings }) {
  return (
    <div className="rounded-lg border border-x-line bg-x-surface p-3">
      <div className="flex items-center gap-2 mb-2">
        <Bug size={13} className="text-x-ink-secondary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-x-ink-secondary">Findings</span>
        {findings.length > 0 && (
          <span className="ml-auto text-[11px] font-mono text-x-faint">{findings.length}</span>
        )}
      </div>
      {findings.length === 0 ? (
        <p className="px-1 py-2 text-xs text-x-faint">No findings recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {findings.map((f) => (
            <div
              key={f.id}
              className="rounded-md border border-x-line bg-x-surface-2 p-2.5 [content-visibility:auto] [contain-intrinsic-size:auto_88px]"
            >
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded border text-[11px] font-mono uppercase ${severityClass(f.severity)}`}>
                  {f.severity || 'info'}
                </span>
                <span className="flex-1 min-w-0 truncate text-xs font-semibold text-x-ink" title={f.title}>
                  {f.title}
                </span>
                {f.target_ip && (
                  <span className="text-[11px] font-mono text-x-faint shrink-0">{f.target_ip}</span>
                )}
                <span className="text-[11px] font-mono text-x-faint shrink-0">{f.created_at}</span>
              </div>
              {f.detail && (
                <div className="mt-1.5 text-[11px] text-x-ink-secondary whitespace-pre-wrap break-words">{f.detail}</div>
              )}
              {f.reproduction && (
                <pre className="mt-1.5 max-h-40 overflow-y-auto rounded-md bg-x-bg p-2 font-mono text-[11px] text-x-ink-secondary border border-x-line whitespace-pre-wrap">
                  {f.reproduction}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
