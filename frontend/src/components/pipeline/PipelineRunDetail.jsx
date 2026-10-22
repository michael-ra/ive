import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X, GitBranch, Terminal, Clock3, Play, Square, ExternalLink,
  FileText, Box, AlertCircle, CheckCircle2, Loader2, PauseCircle,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const STATUS_CLASS = {
  running: 'bg-x-good/10 text-x-good border-x-good/25',
  paused: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/25',
  completed: 'bg-x-good/10 text-x-good border-x-good/25',
  failed: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/25',
  max_iterations: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/25',
  cancelled: 'bg-x-muted/10 text-x-muted border-x-line',
}

function asDate(value) {
  if (!value) return null
  if (typeof value === 'number') return new Date(value * 1000)
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 100000) return new Date(numeric * 1000)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(value) {
  const date = asDate(value)
  if (!date) return ''
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function formatDuration(start, end) {
  const startDate = asDate(start)
  const endDate = asDate(end)
  if (!startDate || !endDate) return ''
  const seconds = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function parsePipelineOutput(output) {
  const text = String(output || '').trim()
  const match = text.match(/^__pipeline_result:(pass|fail):([\s\S]*)$/)
  if (match) return { result: match[1], text: match[2].trim() }
  if (text.startsWith('waiting_for_')) return { result: 'waiting', text }
  return { result: null, text }
}

function textTail(text, limit = 80000) {
  const raw = String(text || '')
  return raw.length > limit ? raw.slice(-limit) : raw
}

function StageDot({ status }) {
  const cls = status === 'running' ? 'bg-x-good animate-subtle-pulse'
    : status === 'completed' ? 'bg-x-good'
      : status === 'failed' ? 'bg-x-accent-ink'
        : 'bg-x-faint'
  return <span className={`h-2 w-2 rounded-full shrink-0 ${cls}`} />
}

function LogBlock({ title, text, tone = 'default' }) {
  if (!text) return null
  const toneClass = tone === 'stderr' ? 'border-x-accent-ink/20 bg-x-accent-ink/10 text-x-accent-ink/90'
    : tone === 'stdout' ? 'border-x-good/20 bg-x-good/10 text-x-good/90'
      : 'border-x-line bg-x-surface-2 text-x-ink-secondary'
  return (
    <section>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-x-faint">
        <FileText size={11} /> {title}
      </div>
      <pre className={`max-h-[44vh] overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-[11px] leading-relaxed font-mono ${toneClass}`}>
        {textTail(text)}
      </pre>
    </section>
  )
}

export default function PipelineRunDetail({ runId, initialRun = null, onClose, onRunUpdate }) {
  const sessions = useStore((s) => s.sessions)
  const pipelines = useStore((s) => s.pipelines)
  const updateRunInStore = useStore((s) => s.handlePipelineRunUpdate)
  const [run, setRun] = useState(initialRun)
  const [definition, setDefinition] = useState(null)
  const [sessionBundles, setSessionBundles] = useState({})
  const [selectedStageId, setSelectedStageId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!runId) return
      setLoading(true)
      try {
        const nextRun = initialRun?.id === runId ? initialRun : await api.getPipelineRun(runId)
        if (cancelled) return
        setRun(nextRun)

        let defn = pipelines.find((p) => p.id === nextRun?.pipeline_id) || null
        if (!defn && nextRun?.pipeline_id) {
          defn = await api.getPipeline(nextRun.pipeline_id).catch(() => null)
        }
        if (!cancelled) setDefinition(defn)

        const history = nextRun?.stage_history || {}
        const sessionIds = [...new Set(Object.values(history).map((sh) => sh?.session_id).filter(Boolean))]
        const bundles = {}
        await Promise.all(sessionIds.map(async (sid) => {
          const [output, captures, transcriptResp] = await Promise.all([
            api.getSessionOutput(sid, 1200).catch(() => null),
            api.getSessionCaptures(sid, 'all', 80).catch(() => []),
            api.exportSession(sid).catch(() => null),
          ])
          let transcript = ''
          try {
            if (transcriptResp?.ok) transcript = await transcriptResp.text()
          } catch {}
          bundles[sid] = {
            output: output?.text || '',
            startup_blocker: output?.startup_blocker || null,
            captures: Array.isArray(captures) ? captures : [],
            transcript,
          }
        }))
        if (!cancelled) setSessionBundles(bundles)
      } catch (error) {
        if (!cancelled) setActionError(error.message || 'Could not load this workflow run. Close and open it to retry.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [initialRun, pipelines, runId])

  const stages = useMemo(() => {
    const history = run?.stage_history || {}
    const ordered = []
    const seen = new Set()
    for (const stage of definition?.stages || []) {
      seen.add(stage.id)
      ordered.push({ stage, history: history[stage.id] || {}, id: stage.id })
    }
    for (const [id, sh] of Object.entries(history)) {
      if (!seen.has(id)) ordered.push({ stage: { id, name: id, type: 'stage' }, history: sh || {}, id })
    }
    return ordered
  }, [definition, run])

  useEffect(() => {
    if (selectedStageId || !stages.length) return
    const active = stages.find((s) => s.history?.status === 'running') || stages.find((s) => s.history?.status !== 'pending') || stages[0]
    setSelectedStageId(active.id)
  }, [selectedStageId, stages])

  const selected = stages.find((s) => s.id === selectedStageId) || stages[0] || null
  const selectedOutput = parsePipelineOutput(selected?.history?.output_summary)
  const selectedLogs = selected?.history?.logs || {}
  const selectedSessionId = selected?.history?.session_id
  const selectedSession = selectedSessionId ? sessions[selectedSessionId] : null
  const selectedBundle = selectedSessionId ? sessionBundles[selectedSessionId] : null

  const handleAction = useCallback(async (action) => {
    if (!run?.id) return
    setActing(true)
    setActionError('')
    try {
      const updated = await api.updatePipelineRun(run.id, action)
      if (updated?.id) {
        setRun(updated)
        updateRunInStore(updated)
        onRunUpdate?.(updated)
      }
    } catch (error) {
      setActionError(error.message || `Could not ${action} this workflow.`)
    } finally {
      setActing(false)
    }
  }, [onRunUpdate, run?.id, updateRunInStore])

  const openSession = useCallback((sessionId) => {
    if (!sessionId) return
    useStore.getState().openSession(sessionId)
    onClose?.()
  }, [onClose])

  const statusClass = STATUS_CLASS[run?.status] || 'bg-x-surface text-x-ink-secondary border-x-line'

  return (
    <div className="fixed inset-0 z-[80] bg-x-scrim backdrop-blur-[4px] flex flex-col" onClick={onClose}>
      <div className="flex-1 m-3 x-panel shadow-x-3 overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-x-line bg-x-surface-2 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch size={15} className="text-x-accent" />
              <h2 className="truncate text-sm font-semibold text-x-ink">Pipeline Run</h2>
              {run && <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${statusClass}`}>{run.status}</span>}
              {loading && <Loader2 size={12} className="animate-spin text-x-faint" />}
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-x-faint">
              <span>{definition?.name || 'Pipeline run'}</span>
              {run?.id && <span className="font-mono">run {run.id.slice(0, 8)}</span>}
              {run?.iteration && <span className="tabular-nums">Cycle {run.iteration} of {run.max_iterations || 20}</span>}
              {run?.started_at && <span>{formatDateTime(run.started_at)}</span>}
              {run?.completed_at && <span><Clock3 size={10} className="inline mr-1" />{formatDuration(run.started_at, run.completed_at)}</span>}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {run?.status === 'paused' && (
              <button
                onClick={() => handleAction('resume')}
                disabled={acting}
                className="inline-flex items-center gap-1 h-[26px] rounded-md bg-x-good/10 px-2.5 text-xs font-medium text-x-good border border-x-good/30 hover:bg-x-good/15 hover:border-x-good/45 disabled:opacity-40 transition-colors duration-[80ms] ease-x"
              >
                <Play size={12} strokeWidth={1.75} /> Resume
              </button>
            )}
            {(run?.status === 'running' || run?.status === 'paused') && (
              <button
                onClick={() => handleAction('cancel')}
                disabled={acting}
                className="inline-flex items-center gap-1 h-[26px] rounded-md bg-x-accent-ink/10 px-2.5 text-xs font-medium text-x-accent-ink border border-x-accent-ink/30 hover:bg-x-accent-ink/15 hover:border-x-accent-ink/45 disabled:opacity-40 transition-colors duration-[80ms] ease-x"
              >
                <Square size={12} strokeWidth={1.75} /> Cancel
              </button>
            )}
            <button onClick={onClose} aria-label="Close workflow run" className="p-1 rounded-md text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]">
              <X size={16} />
            </button>
          </div>
        </header>

        {actionError && <div role="alert" className="border-b border-x-line px-4 py-2 text-sm text-x-accent-ink">{actionError}</div>}
        <div className="flex-1 min-h-0 flex">
          <aside className="w-80 shrink-0 border-r border-x-line bg-x-surface-2 overflow-y-auto">
            <div className="p-3 space-y-2">
              {stages.map(({ id, stage, history }) => {
                const parsed = parsePipelineOutput(history.output_summary)
                const active = id === selected?.id
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedStageId(id)}
                    className={`w-full rounded-md border p-2.5 text-left transition-colors duration-[80ms] ease-x ${
                      active ? 'border-x-accent/45 bg-x-tint' : 'border-x-line bg-transparent hover:bg-x-hover hover:border-x-line-strong'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <StageDot status={history.status} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-x-ink-secondary">{stage.name || id}</span>
                      {parsed.result && (
                        <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                          parsed.result === 'pass' ? 'bg-x-good/10 text-x-good' :
                          parsed.result === 'fail' ? 'bg-x-accent-ink/10 text-x-accent-ink' :
                          'bg-x-accent-ink/10 text-x-accent-ink'
                        }`}>
                          {parsed.result}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-x-faint">
                      <span>{stage.type || 'stage'}</span>
                      <span>{history.status || 'pending'}</span>
                      {history.completed_at && <span>{formatDuration(history.started_at, history.completed_at)}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>

          <main className="flex-1 min-w-0 overflow-y-auto">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-[11px] text-x-faint">
                No stages recorded for this run.
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <section className="rounded-lg border border-x-line bg-x-surface shadow-x-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StageDot status={selected.history?.status} />
                    <h3 className="text-sm font-semibold text-x-ink">{selected.stage?.name || selected.id}</h3>
                    <span className="rounded-md border border-x-line bg-x-hover px-1.5 py-0.5 text-[11px] text-x-faint">
                      {selected.stage?.type || 'stage'}
                    </span>
                    {selectedOutput.result && (
                      <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                        selectedOutput.result === 'pass' ? 'bg-x-good/10 text-x-good' :
                        selectedOutput.result === 'fail' ? 'bg-x-accent-ink/10 text-x-accent-ink' :
                        'bg-x-accent-ink/10 text-x-accent-ink'
                      }`}>
                        {selectedOutput.result}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-x-faint">
                    {selected.history?.started_at && <span>started {formatDateTime(selected.history.started_at)}</span>}
                    {selected.history?.completed_at && <span>duration {formatDuration(selected.history.started_at, selected.history.completed_at)}</span>}
                    {selectedSessionId && (
                      <button onClick={() => openSession(selectedSessionId)} className="inline-flex items-center gap-1 text-x-accent hover:text-x-accent-ink">
                        <ExternalLink size={10} /> {selectedSession?.name || selectedSessionId.slice(0, 8)}
                      </button>
                    )}
                  </div>
                </section>

                <LogBlock title="Stage Summary" text={selectedOutput.text || selected.history?.output_summary} />

                {selectedLogs.kind === 'command' && (
                  <section className="rounded-lg border border-x-good/30 bg-x-good/10 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-[11px] font-medium text-x-good">
                      <Terminal size={12} /> Command
                    </div>
                    <div className="grid gap-2 text-[11px] font-mono text-x-faint md:grid-cols-2">
                      <div><span className="text-x-ink-secondary">Command:</span> {selectedLogs.command}</div>
                      <div><span className="text-x-ink-secondary">CWD:</span> {selectedLogs.cwd || 'workspace'}</div>
                      {selectedLogs.exit_code !== undefined && <div><span className="text-x-ink-secondary">Exit:</span> {selectedLogs.exit_code}</div>}
                      {selectedLogs.duration_s !== undefined && <div><span className="text-x-ink-secondary">Duration:</span> {selectedLogs.duration_s}s</div>}
                    </div>
                    <LogBlock title="stdout" text={selectedLogs.stdout} tone="stdout" />
                    <LogBlock title="stderr" text={selectedLogs.stderr} tone="stderr" />
                    {selectedLogs.error && <LogBlock title="Execution Error" text={selectedLogs.error} tone="stderr" />}
                  </section>
                )}

                {selectedSessionId && (
                  <section className="rounded-lg border border-x-line bg-x-surface shadow-x-1 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[11px] font-medium text-x-ink-secondary">
                        <Terminal size={12} /> Linked Session
                      </div>
                      <button onClick={() => openSession(selectedSessionId)} className="inline-flex items-center gap-1 text-[11px] text-x-accent hover:text-x-accent-ink">
                        <ExternalLink size={10} /> Open session
                      </button>
                    </div>
                    {selectedBundle?.startup_blocker && (
                      <div className="flex items-start gap-2 rounded-md border border-x-accent-ink/25 bg-x-accent-ink/10 p-2 text-[11px] text-x-accent-ink">
                        <AlertCircle size={12} className="mt-0.5 shrink-0" /> {selectedBundle.startup_blocker.message || 'Startup blocker detected'}
                      </div>
                    )}
                    <LogBlock title="Recent Terminal Output" text={selectedBundle?.output} />
                    <LogBlock title="Full Session Transcript" text={selectedBundle?.transcript} />

                    <div>
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-x-faint">
                        <Box size={11} /> Captures / Artifacts
                      </div>
                      {selectedBundle?.captures?.length ? (
                        <div className="space-y-2">
                          {selectedBundle.captures.map((cap) => (
                            <div key={cap.id} className="rounded-lg border border-x-line bg-x-surface-2 p-2">
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-x-faint">
                                <span className="text-x-ink-secondary">{cap.capture_type}</span>
                                {cap.tool_name && <span>{cap.tool_name}</span>}
                                {cap.status && <span>{cap.status}</span>}
                                {cap.created_at && <span className="ml-auto">{formatDateTime(cap.created_at)}</span>}
                              </div>
                              {(cap.content || cap.raw_text || cap.tool_input_summary) && (
                                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] font-mono text-x-ink-secondary">
                                  {cap.content || cap.raw_text || cap.tool_input_summary}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-x-line bg-x-surface-2 p-3 text-[11px] text-x-faint">
                          No captures recorded for this session.
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {!selectedSessionId && selectedLogs.kind !== 'command' && !selectedOutput.text && (
                  <div className="flex items-center gap-2 rounded-lg border border-x-line bg-x-surface-2 p-3 text-[11px] text-x-faint">
                    <CheckCircle2 size={13} /> No additional logs were recorded for this stage.
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
