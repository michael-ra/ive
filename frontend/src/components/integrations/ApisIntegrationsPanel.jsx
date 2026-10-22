import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X, Server, Settings, RefreshCw, Loader2, Plus, Wrench, CheckCircle2, Play,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

function formatDate(value) {
  if (!value) return 'never'
  const d = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  return d.toLocaleString()
}

export default function ApisIntegrationsPanel({
  onClose,
  onOpenBoard,
  onOpenWorkspaceSettings,
  embedded = false,
}) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const workspaceName = workspace?.name || ''

  const [servers, setServers] = useState([])
  const [runs, setRuns] = useState([])
  const [tools, setTools] = useState([])
  const [selectedServerId, setSelectedServerId] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [callTool, setCallTool] = useState('')
  const [callArgs, setCallArgs] = useState('{}')
  const [callResult, setCallResult] = useState(null)
  const [ticket, setTicket] = useState({ source: '', language: 'python', target: '' })

  const notify = (type, message, action) => {
    useStore.getState().addNotification({ type, message, ...(action ? { action } : {}) })
  }

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId || server.slug === selectedServerId) || servers[0] || null,
    [servers, selectedServerId],
  )

  const selectedRuns = selectedServer
    ? runs.filter((run) => !run.server_id || run.server_id === selectedServer.id || run.server_id === selectedServer.slug)
    : runs
  const cachedTools = Array.isArray(selectedServer?.tool_cache) ? selectedServer.tool_cache : []
  const displayedTools = tools.length ? tools : cachedTools
  const alloyEnabled = !!workspace?.alloy_enabled

  const loadAlloy = useCallback(async ({ markBusy = false } = {}) => {
    if (!activeWorkspaceId || !workspace?.alloy_enabled) {
      setServers([])
      setRuns([])
      setTools([])
      return
    }
    if (markBusy) setBusy('refresh')
    setError('')
    try {
      const [serverRows, runRows] = await Promise.all([
        api.listAlloyServers(activeWorkspaceId),
        api.listAlloyRuns(activeWorkspaceId, { limit: 50 }).catch(() => []),
      ])
      const nextServers = Array.isArray(serverRows) ? serverRows : []
      setServers(nextServers)
      setRuns(Array.isArray(runRows) ? runRows : [])
      setSelectedServerId((current) => {
        if (current && nextServers.some((server) => server.id === current || server.slug === current)) return current
        return nextServers[0]?.id || ''
      })
    } catch (err) {
      setError(err?.message || 'Alloy load failed')
      setServers([])
      setRuns([])
    } finally {
      if (markBusy) setBusy(null)
    }
  }, [activeWorkspaceId, workspace?.alloy_enabled])

  useEffect(() => { loadAlloy() }, [loadAlloy])

  const refreshTools = async (server = selectedServer) => {
    if (!activeWorkspaceId || !server) return
    setBusy(`tools:${server.id}`)
    setError('')
    try {
      const result = await api.listAlloyTools(activeWorkspaceId, server.id)
      const nextTools = Array.isArray(result?.tools) ? result.tools : []
      setTools(nextTools)
      if (nextTools.length && !callTool) setCallTool(nextTools[0].name)
      await loadAlloy()
    } catch (err) {
      setError(err?.message || 'Tool listing failed')
      setTools([])
    } finally {
      setBusy(null)
    }
  }

  const healthcheck = async (server = selectedServer) => {
    if (!activeWorkspaceId || !server) return
    setBusy(`health:${server.id}`)
    setError('')
    try {
      const result = await api.healthcheckAlloyServer(activeWorkspaceId, server.id)
      const nextTools = Array.isArray(result?.tools) ? result.tools : []
      setTools(nextTools)
      if (nextTools.length && !callTool) setCallTool(nextTools[0].name)
      notify('success', `Alloy healthcheck ${result?.ok ? 'passed' : 'completed'}.`)
      await loadAlloy()
    } catch (err) {
      setError(err?.message || 'Healthcheck failed')
      notify('error', `Alloy healthcheck failed: ${err?.message || 'unknown error'}`)
      await loadAlloy()
    } finally {
      setBusy(null)
    }
  }

  const runToolCall = async () => {
    if (!activeWorkspaceId || !selectedServer || !callTool) return
    let args = {}
    try {
      args = callArgs.trim() ? JSON.parse(callArgs) : {}
    } catch {
      notify('error', 'Tool arguments must be valid JSON.')
      return
    }
    setBusy(`call:${selectedServer.id}`)
    setError('')
    setCallResult(null)
    try {
      const result = await api.callAlloyTool(activeWorkspaceId, selectedServer.id, {
        tool_name: callTool,
        arguments: args,
      })
      setCallResult(result)
      await loadAlloy()
    } catch (err) {
      setError(err?.message || 'Tool call failed')
      setCallResult(err?.body || { error: err?.message || 'Tool call failed' })
    } finally {
      setBusy(null)
    }
  }

  const createAlloyTicket = async () => {
    if (!activeWorkspaceId || !ticket.source.trim()) return
    setBusy('ticket')
    try {
      await api.createTask({
        workspace_id: activeWorkspaceId,
        title: `[Alloy] Generate ${ticket.language || 'SDK'} client and MCP tools`,
        description: [
          `OpenAPI source: ${ticket.source.trim()}`,
          ticket.target.trim() ? `Target/output: ${ticket.target.trim()}` : '',
          `Language: ${ticket.language || 'python'}`,
          '',
          'Generate project-owned SDK/MCP artifacts, register the generated MCP server with Alloy, run alloy_healthcheck/alloy_list_tools, and leave paths plus verification notes in the ticket summary.',
        ].filter(Boolean).join('\n'),
        acceptance_criteria: [
          '- Raw and normalized OpenAPI specs are preserved',
          '- SDK artifacts are generated under the target project or .ive/alloy',
          '- Generated MCP server is registered through Alloy',
          '- alloy_healthcheck and alloy_list_tools pass or failures are documented',
        ].join('\n'),
        labels: ['alloy', 'openapi', 'sdk', 'mcp'],
        pipeline: false,
        test_with_agent: false,
      })
      setTicket({ source: '', language: 'python', target: '' })
      notify('success', 'Created Alloy generation ticket.', {
        label: 'Open board',
        onClick: () => onOpenBoard?.(),
      })
    } catch (err) {
      notify('error', `Alloy ticket failed: ${err?.message || 'unknown error'}`)
    } finally {
      setBusy(null)
    }
  }

  const selectServer = (serverId) => {
    setSelectedServerId(serverId)
    setTools([])
    setCallResult(null)
  }

  if (!activeWorkspaceId) {
    return (
      <div className={embedded ? 'p-6' : 'fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex items-center justify-center'} onClick={embedded ? undefined : onClose}>
        <div className="x-panel px-6 py-5 text-sm text-x-ink-secondary" onClick={(e) => e.stopPropagation()}>
          Select a workspace to manage its custom APIs.
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? 'h-full flex flex-col' : 'fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'flex-1 flex flex-col m-4 md:m-6 xl:m-8 x-panel overflow-hidden'} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-x-line/80 bg-x-surface/20 shrink-0">
          <Server className="w-4 h-4 text-x-accent" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-x-ink">APIs & Integrations</div>
            <div className="text-[11px] text-x-faint truncate font-mono">{workspaceName}</div>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => loadAlloy({ markBusy: true })}
            disabled={busy === 'refresh' || !alloyEnabled}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-x-line-subtle text-x-ink-secondary hover:bg-x-hover disabled:opacity-40 transition-colors duration-[80ms] ease-x"
          >
            {busy === 'refresh' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          {!embedded && <button onClick={onClose} className="p-1.5 rounded-md text-x-faint hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms] ease-x" title="Close">
            <X className="w-4 h-4" />
          </button>}
        </div>

        {!alloyEnabled ? (
          <div className="flex-1 overflow-y-auto p-5 bg-x-surface-2/5">
            <div className="max-w-4xl mx-auto rounded-xl border border-x-line-subtle bg-x-surface/15 p-8 text-center shadow-x-1">
              <Server className="w-10 h-10 mx-auto text-x-faint/40 mb-3" />
              <div className="text-sm font-medium text-x-ink">IVE Alloy is disabled for this workspace.</div>
              <div className="text-xs text-x-faint mt-1">Enable Alloy in Workspace Settings to use workspace-local SDK and MCP generation.</div>
              {onOpenWorkspaceSettings && (
                <button
                  onClick={onOpenWorkspaceSettings}
                  className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 transition-colors"
                >
                  <Settings className="w-3.5 h-3.5" />
                  Workspace Settings
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 bg-x-surface-2/5">
            <div className="max-w-7xl mx-auto space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <SetupMetric label="Servers" value={servers.length} detail="registered Alloy MCP targets" />
                <SetupMetric label="Tools" value={displayedTools.length} detail={selectedServer ? selectedServer.slug || selectedServer.name : 'select a server'} />
                <SetupMetric label="Runs" value={runs.length} detail="recorded generation attempts" />
              </div>

              <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden shadow-x-1">
                <div className="flex items-center gap-3 px-5 py-3.5 border-b border-x-line-subtle">
                  <div>
                    <div className="text-sm font-medium text-x-ink">Workspace API runtime</div>
                    <div className="text-[11px] text-x-faint">Local SDK generation state and generated MCP bridge tools.</div>
                  </div>
                  <div className="flex-1" />
                </div>

                {error && (
                  <div className="px-5 py-2.5 text-xs text-x-accent-ink bg-x-accent-ink/8 border-b border-x-accent-ink/20 font-mono">
                    {error}
                  </div>
                )}

                <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] min-h-[520px]">
                  <aside className="border-b xl:border-b-0 xl:border-r border-x-line-subtle/60 bg-x-surface-2/15 p-4 space-y-4">
                    <div>
                      <div className="text-xs font-medium text-x-ink-secondary mb-2">Generation ticket</div>
                      <div className="rounded-xl border border-x-line-subtle bg-x-surface/15 p-3 space-y-2">
                        <input
                          value={ticket.source}
                          onChange={(e) => setTicket({ ...ticket, source: e.target.value })}
                          placeholder="OpenAPI URL or path"
                          className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent/35 font-mono"
                        />
                        <div className="grid grid-cols-[110px_1fr] gap-2">
                          <select
                            value={ticket.language}
                            onChange={(e) => setTicket({ ...ticket, language: e.target.value })}
                            className="bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/35 cursor-pointer"
                          >
                            <option value="python">python</option>
                            <option value="typescript">typescript</option>
                            <option value="go">go</option>
                            <option value="java">java</option>
                            <option value="rust">rust</option>
                          </select>
                          <input
                            value={ticket.target}
                            onChange={(e) => setTicket({ ...ticket, target: e.target.value })}
                            placeholder="output path"
                            className="bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent/35 font-mono"
                          />
                        </div>
                        <button
                          onClick={createAlloyTicket}
                          disabled={!ticket.source.trim() || busy === 'ticket'}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors"
                        >
                          {busy === 'ticket' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                          Create Alloy ticket
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-x-ink-secondary mb-2">Registered servers</div>
                      {servers.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-x-line-subtle bg-x-surface/10 p-6 text-center text-xs text-x-faint font-mono">
                          No generated MCP servers registered.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-[430px] overflow-y-auto pr-1">
                          {servers.map((server) => {
                            const selected = selectedServer?.id === server.id
                            return (
                              <button
                                key={server.id}
                                onClick={() => selectServer(server.id)}
                                className={`w-full text-left rounded-xl border p-3 transition-colors duration-[80ms] ease-x ${
                                  selected
                                    ? 'border-x-accent/45 bg-x-tint'
                                    : 'border-x-line-subtle bg-x-surface/10 hover:bg-x-hover'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <Server className={`w-4 h-4 ${server.status === 'healthy' ? 'text-x-good' : server.status === 'error' ? 'text-x-accent-ink' : 'text-x-faint'}`} />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-xs font-medium text-x-ink truncate">{server.name || server.slug}</div>
                                    <div className="text-[11px] text-x-faint font-mono truncate">{server.slug || server.id}</div>
                                  </div>
                                  <StatusPill status={server.status || 'registered'} />
                                </div>
                                <div className="mt-2 text-[11px] text-x-faint font-mono truncate">
                                  {server.command} {(server.args || []).join(' ')}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </aside>

                  <main className="min-w-0">
                    {!selectedServer ? (
                      <div className="h-full flex flex-col items-center justify-center text-xs text-x-faint gap-3 py-16">
                        <Wrench className="w-10 h-10 text-x-faint/30" />
                        <div>No Alloy server selected.</div>
                      </div>
                    ) : (
                      <div className="p-5 space-y-5">
                        <div className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3 border-b border-x-line-subtle">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-x-ink truncate">{selectedServer.name}</div>
                              <div className="text-[11px] text-x-faint font-mono truncate">{selectedServer.id}</div>
                            </div>
                            <div className="flex-1" />
                            <button
                              onClick={() => healthcheck(selectedServer)}
                              disabled={busy === `health:${selectedServer.id}`}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-x-good/20 bg-x-good/8 text-x-good hover:bg-x-good/14 disabled:opacity-50 transition-colors"
                            >
                              {busy === `health:${selectedServer.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                              Health
                            </button>
                            <button
                              onClick={() => refreshTools(selectedServer)}
                              disabled={busy === `tools:${selectedServer.id}`}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-x-line-subtle text-x-ink-secondary hover:bg-x-hover disabled:opacity-40 transition-colors duration-[80ms] ease-x"
                            >
                              {busy === `tools:${selectedServer.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                              Tools
                            </button>
                          </div>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
                            <InfoRow label="SDK" value={selectedServer.sdk_path} />
                            <InfoRow label="MCP" value={selectedServer.mcp_path} />
                            <InfoRow label="Manifest" value={selectedServer.manifest_path} />
                            <InfoRow label="CWD" value={selectedServer.cwd} />
                            <InfoRow label="Raw spec" value={selectedServer.raw_spec_path} />
                            <InfoRow label="Normalized spec" value={selectedServer.normalized_spec_path} />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-5">
                          <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden">
                            <div className="px-4 py-3 border-b border-x-line-subtle">
                              <div className="text-sm font-medium text-x-ink">MCP tools</div>
                            </div>
                            {displayedTools.length === 0 ? (
                              <div className="py-12 text-center text-xs text-x-faint font-mono">No tool schema cached yet.</div>
                            ) : (
                              <div className="divide-y divide-x-line-subtle/50">
                                {displayedTools.map((tool) => (
                                  <button
                                    key={tool.name}
                                    onClick={() => {
                                      setCallTool(tool.name)
                                      setCallArgs('{}')
                                    }}
                                    className={`w-full text-left px-4 py-3 hover:bg-x-hover transition-colors duration-[80ms] ease-x ${
                                      callTool === tool.name ? 'bg-x-tint' : ''
                                    }`}
                                  >
                                    <div className="flex items-center gap-2">
                                      <Wrench className="w-3.5 h-3.5 text-x-accent" />
                                      <div className="text-xs font-medium text-x-ink font-mono">{tool.name}</div>
                                    </div>
                                    {tool.description && <div className="mt-1 text-[11px] text-x-faint line-clamp-2">{tool.description}</div>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </section>

                          <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden">
                            <div className="px-4 py-3 border-b border-x-line-subtle">
                              <div className="text-sm font-medium text-x-ink">Call tool</div>
                            </div>
                            <div className="p-4 space-y-3">
                              <select
                                value={callTool}
                                onChange={(e) => setCallTool(e.target.value)}
                                className="w-full bg-x-surface-2/40 border border-x-line-subtle rounded-lg px-2.5 py-1.5 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent/35 cursor-pointer font-mono"
                              >
                                <option value="">Select tool</option>
                                {displayedTools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
                              </select>
                              <textarea
                                value={callArgs}
                                onChange={(e) => setCallArgs(e.target.value)}
                                className="w-full min-h-[120px] bg-x-surface-2/50 border border-x-line-subtle rounded-lg px-2.5 py-2 text-xs text-x-ink focus:outline-none focus:border-x-accent/35 font-mono resize-y"
                                spellCheck={false}
                              />
                              <button
                                onClick={runToolCall}
                                disabled={!callTool || busy === `call:${selectedServer.id}`}
                                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-x-accent/25 bg-x-accent/10 text-x-accent hover:bg-x-accent/20 disabled:opacity-50 transition-colors"
                              >
                                {busy === `call:${selectedServer.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                Call
                              </button>
                              {callResult && (
                                <pre className="max-h-72 overflow-auto rounded-lg border border-x-line-subtle bg-x-surface-2/60 p-3 text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">
                                  {JSON.stringify(callResult, null, 2)}
                                </pre>
                              )}
                            </div>
                          </section>
                        </div>

                        <section className="rounded-xl border border-x-line-subtle bg-x-surface/15 overflow-hidden">
                          <div className="grid grid-cols-[120px_100px_100px_1fr] px-4 py-2.5 bg-x-surface-2/40 text-[11px] font-medium uppercase tracking-[0.06em] text-x-faint border-b border-x-line-subtle/70">
                            <div>Engine</div>
                            <div>Status</div>
                            <div>Lang</div>
                            <div>Output</div>
                          </div>
                          {selectedRuns.length === 0 ? (
                            <div className="py-10 text-center text-xs text-x-faint font-mono">No Alloy runs recorded for this view.</div>
                          ) : selectedRuns.slice(0, 12).map((run) => (
                            <div key={run.id} className="grid grid-cols-[120px_100px_100px_1fr] items-center px-4 py-2.5 text-xs border-b border-x-line-subtle/40 last:border-b-0 hover:bg-x-hover transition-colors duration-[80ms] ease-x">
                              <div className="text-x-ink-secondary font-mono truncate">{run.engine || 'manual'}</div>
                              <div><StatusPill status={run.status || 'recorded'} /></div>
                              <div className="text-x-faint font-mono truncate">{run.language || '-'}</div>
                              <div className="text-x-faint font-mono truncate">{run.output_path || run.manifest_path || formatDate(run.created_at)}</div>
                            </div>
                          ))}
                        </section>
                      </div>
                    )}
                  </main>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SetupMetric({ label, value, detail }) {
  return (
    <div className="rounded-xl border border-x-line-subtle bg-x-surface/15 p-4 shadow-x-1">
      <div className="text-xs font-medium text-x-ink-secondary">{label}</div>
      <div className="mt-2 text-xl font-semibold text-x-ink tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-x-faint">{detail}</div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="border-b border-r border-x-line-subtle/45 px-4 py-3 min-w-0">
      <div className="text-xs font-medium text-x-ink-secondary">{label}</div>
      <div className="mt-1 text-xs text-x-ink-secondary font-mono truncate">{value || '-'}</div>
    </div>
  )
}

function StatusPill({ status }) {
  const tone = status === 'healthy'
    ? 'text-x-good border-x-good/20 bg-x-good/8'
    : status === 'error' || status === 'failed'
      ? 'text-x-accent-ink border-x-accent-ink/20 bg-x-accent-ink/8'
      : 'text-x-accent-ink border-x-accent-ink/20 bg-x-accent-ink/8'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${tone}`}>
      {status || 'unknown'}
    </span>
  )
}
