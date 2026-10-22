import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Square, RefreshCw, Loader2, X, GitBranch, Terminal as TerminalIcon } from 'lucide-react'
import useStore from '../../state/store'
import { demoApi, localPreviewUrl } from '../../lib/api'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import { Button } from '../ui'

// Per-workspace demo runner control panel. Renders status, branch/command
// inputs, action buttons, and a streaming log tail. Subscribes to global
// `demo_state` / `demo_log` ws events to live-update without polling.
const DemoProductActions = resolveExtensionPanel('agentario', 'ConnectorPublication')

export default function DemoPanel({ workspaceId, onClose, onPreviewUrl }) {
  const [demo, setDemo] = useState(null)
  const [branch, setBranch] = useState('main')
  const [command, setCommand] = useState('npm run dev')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const logRef = useRef(null)

  const globalWs = useStore((s) => s.ws)

  // ── Initial load + light polling fallback ─────────────────────────
  const refresh = useCallback(async () => {
    if (!workspaceId) return
    try {
      const d = await demoApi.status(workspaceId)
      setDemo(d)
      if (d?.branch) setBranch(d.branch)
      if (d?.command) setCommand(d.command)
    } catch (e) {
      setError(e.message)
    }
  }, [workspaceId])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  // ── Live ws updates ────────────────────────────────────────────────
  useEffect(() => {
    if (!globalWs) return
    function onMsg(e) {
      let data
      try { data = JSON.parse(e.data) } catch { return }
      if (data.type === 'demo_state' && data.demo?.workspace_id === workspaceId) {
        setDemo(data.demo)
      } else if (data.type === 'demo_log' && data.workspace_id === workspaceId) {
        setDemo((prev) => {
          if (!prev) return prev
          const merged = [...(prev.build_log_tail || []), ...(data.lines || [])]
          return { ...prev, build_log_tail: merged.slice(-200) }
        })
      }
    }
    globalWs.addEventListener('message', onMsg)
    return () => globalWs.removeEventListener('message', onMsg)
  }, [globalWs, workspaceId])

  // Auto-scroll log tail to bottom on update.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [demo?.build_log_tail])

  // ── Actions ───────────────────────────────────────────────────────
  const guarded = useCallback(async (fn) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }, [])

  const handleStart = () => guarded(async () => {
    const d = await demoApi.start(workspaceId, { branch, command })
    setDemo(d)
    if (d?.port && onPreviewUrl) onPreviewUrl(localPreviewUrl(d.port, '/'))
  })

  const handleStop = () => guarded(async () => {
    setDemo(await demoApi.stop(workspaceId))
  })

  const handlePull = () => guarded(async () => {
    setDemo(await demoApi.pullLatest(workspaceId))
  })

  const status = demo?.status || 'stopped'
  const port = demo?.port
  const sha = demo?.last_commit
  const lines = demo?.build_log_tail || []

  const pillColor = {
    running:  'bg-x-good/10 text-x-good border-x-good/30',
    starting: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30',
    building: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30',
    error:    'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30',
    stopped:  'bg-x-hover text-x-muted border-x-line',
  }[status] || 'bg-x-hover text-x-muted border-x-line'

  const isRunning = status === 'running' || status === 'starting' || status === 'building'

  return (
    <div className="w-[360px] flex flex-col bg-x-surface border-l border-x-line shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-x-line">
        <TerminalIcon size={13} strokeWidth={1.75} className="text-x-good" />
        <span className="text-xs text-x-ink-secondary font-medium">Demo</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${pillColor}`}>
          {status}
        </span>
        <div className="flex-1" />
        {onClose && (
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms] ease-x">
            <X size={13} />
          </Button>
        )}
      </div>

      <div className="px-3 py-2 space-y-2 border-b border-x-line">
        <div className="flex items-center gap-2">
          <GitBranch size={11} strokeWidth={1.75} className="text-x-muted shrink-0" />
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={isRunning}
            placeholder="main"
            className="flex-1 px-2 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus disabled:opacity-50"
          />
          {sha && (
            <span className="text-[11px] font-mono text-x-muted shrink-0" title={sha}>
              @ {sha.slice(0, 7)}
            </span>
          )}
        </div>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={isRunning}
          placeholder="npm run dev"
          className="w-full px-2 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus disabled:opacity-50"
        />
        {port ? (
          <div className="text-[11px] font-mono text-x-muted">
            port: <span className="text-x-ink-secondary">{port}</span>
          </div>
        ) : null}
      </div>

      <div className="px-3 py-2 flex items-center gap-2 border-b border-x-line">
        {!isRunning ? (
          <Button type="submit"
            onClick={handleStart}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-good/10 hover:bg-x-good/15 text-x-good border border-x-good/30 hover:border-x-good/45 transition-colors duration-[80ms] ease-x disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            Start
          </Button>
        ) : (
          <Button type="submit"
            onClick={handleStop}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-accent-ink/10 hover:bg-x-accent-ink/15 text-x-accent-ink border border-x-accent-ink/30 hover:border-x-accent-ink/45 transition-colors duration-[80ms] ease-x disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />}
            Stop
          </Button>
        )}
        <Button type="submit"
          onClick={handlePull}
          disabled={busy || status === 'stopped'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-x-tint hover:bg-x-accent/20 text-x-accent border border-x-accent/30 hover:border-x-accent/45 transition-colors duration-[80ms] ease-x disabled:opacity-40"
          title="git pull origin <branch> + reinstall (if needed) + restart on same port"
        >
          {busy && status === 'building' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Pull Latest
        </Button>
      </div>

      <DemoProductActions workspaceId={workspaceId} runtime={demo?.runtime} status={status} />

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border-b border-x-accent-ink/20">
          {error}
        </div>
      )}
      {demo?.error && status === 'error' && (
        <div className="px-3 py-1.5 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border-b border-x-accent-ink/20 break-all">
          {demo.error}
        </div>
      )}

      <div
        ref={logRef}
        className="flex-1 overflow-y-auto px-3 py-2 bg-x-surface-2 font-mono text-[11px] text-x-muted leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-x-faint">no log output yet…</span>
        ) : (
          lines.slice(-50).map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{l}</div>
          ))
        )}
      </div>

    </div>
  )
}
