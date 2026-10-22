import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { X, BookOpenCheck, Camera, Film, FileText, Hammer, Eye, RefreshCw, AlertCircle, CheckCircle2, FolderTree, Play, RotateCcw, Bot, GitBranch, Network } from 'lucide-react'
import { api } from '../../lib/api'
import { appOrigin } from '../../lib/platform'
import { sendTerminalCommand } from '../../lib/terminal'
import useStore from '../../state/store'
import PanelBoundary from '../PanelBoundary'
import { getSessionStatusMeta, hasSessionStarted } from '../../lib/sessionStatus'
import { getCliTypes, getModelsForCli, getRoleDefaultModel, getCliLabel } from '../../lib/constants'
import { Button } from '../ui'

// Opt-in view → opt-in bytes: the canvas drags SystemGraph + CanvasControls in
// behind it, and most visits to this panel never open the graph.
const WorkspaceChangesCanvas = lazy(() => import('./WorkspaceChangesCanvas'))

const KICKOFF_PROMPT = `Begin documenting this project now. Follow this sequence:

1. Call get_knowledge_base() to understand the full product
2. Call get_completed_features() to see what's been built
3. Call scaffold_docs() to create the VitePress site skeleton (use the project name from the knowledge base)
4. Systematically screenshot every major feature and write a documentation page for each
5. Record GIF demos for key multi-step workflows
6. Mark documented task_ids and relevant commit_shas in docs_manifest.json
7. Build the site when done

Start immediately with step 1.`

const UPDATE_PROMPT = `Update the documentation incrementally:

1. Call get_docs_manifest() to see what's already documented
2. Call get_changes_since() with the last build timestamp
3. Call get_completed_features() to find newly completed features
4. Update only the pages affected by changes
5. Re-screenshot any UI that changed
6. Mark covered task_ids and commit_shas in docs_manifest.json
7. Rebuild the site

Start with step 1.`

const screenshotPrompt = (origin) => `Screenshot all major UI features. For each panel/feature visible in the app:

1. Navigate to ${origin}
2. screenshot_page for the main view
3. Open each panel (Command Palette, Feature Board, Sidebar, etc.) and screenshot_page each
4. Use screenshot_element for specific UI components worth highlighting
5. Record record_gif for any multi-step workflows

Start by screenshotting the main dashboard.`

const DOC_MCP_OVERRIDES = {
  'builtin-documentor': { auto_approve_override: 1 },
  'builtin-playwright': { auto_approve_override: 1 },
}

export default function DocsPanel({ onClose }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState(null)
  const [tab, setTab] = useState('overview') // overview | tree | screenshots | undocumented
  const [documentorSession, setDocumentorSession] = useState(null)
  const [sending, setSending] = useState(null) // which action is in-flight
  const [selectedCli, setSelectedCli] = useState('claude')
  const [selectedModel, setSelectedModel] = useState(null)
  // The same coverage numbers, read on the code graph instead of as stats.
  const [showCoverage, setShowCoverage] = useState(false)
  const coverageCanvasRef = useRef(null)

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const cliProfiles = useStore((s) => s.cliProfiles)

  const docSessions = useMemo(() => {
    const hasDocCapability = (session) => {
      let tags = session.tags || []
      if (typeof tags === 'string') {
        try { tags = JSON.parse(tags || '[]') } catch { tags = [] }
      }
      return Array.isArray(tags) && tags.includes('capability_documentation')
    }
    return Object.values(sessions).filter(
      (s) => s.workspace_id === activeWorkspaceId
        && hasDocCapability(s)
    )
  }, [sessions, activeWorkspaceId])

  const cliOptions = useMemo(() => {
    const base = getCliTypes()
    const activeCli = docSessions[0]?.cli_type
    if (activeCli && !base.some((cli) => cli.id === activeCli)) {
      return [...base, { id: activeCli, label: getCliLabel(activeCli) }]
    }
    return base
  }, [cliProfiles, docSessions])

  const modelOptions = useMemo(() => getModelsForCli(selectedCli), [cliProfiles, selectedCli])

  useEffect(() => {
    if (cliOptions.length && !cliOptions.some((cli) => cli.id === selectedCli)) {
      setSelectedCli(cliOptions[0].id)
    }
  }, [cliOptions, selectedCli])

  useEffect(() => {
    setSelectedModel(getRoleDefaultModel(selectedCli, 'documentor') ?? '')
  }, [selectedCli, cliProfiles])

  useEffect(() => {
    const fallback = getRoleDefaultModel(selectedCli, 'documentor')
    if (selectedModel !== null && modelOptions.length && !modelOptions.some((model) => model.id === selectedModel)) {
      setSelectedModel(fallback ?? modelOptions[0]?.id ?? '')
    }
  }, [selectedCli, selectedModel, modelOptions])

  // Find an existing documentation-capable worker for the selected CLI.
  useEffect(() => {
    if (docSessions.length && !docSessions.some((s) => s.cli_type === selectedCli)) {
      setSelectedCli(docSessions[0].cli_type || 'claude')
      setDocumentorSession(docSessions[0])
      return
    }
    setDocumentorSession(docSessions.find((s) => s.cli_type === selectedCli) || null)
  }, [docSessions, selectedCli])

  useEffect(() => {
    if (activeWorkspaceId) {
      loadStatus()
      setBuildResult(null)
      setSending(null)
    }
  }, [activeWorkspaceId])

  const loadStatus = async () => {
    setLoading(true)
    try {
      const data = await api.getDocsStatus(activeWorkspaceId)
      setStatus(data)
    } catch (e) {
      setStatus(null)
    }
    setLoading(false)
  }

  const handleBuild = async () => {
    setBuilding(true)
    setBuildResult(null)
    try {
      const result = await api.triggerDocsBuild(activeWorkspaceId)
      setBuildResult(result)
      loadStatus()
    } catch (e) {
      setBuildResult({ error: e.message || 'Build failed' })
    }
    setBuilding(false)
  }

  const handleStartDocumentor = async (autoPrompt) => {
    if (!activeWorkspaceId) return
    try {
      let s = await api.createSession(activeWorkspaceId, {
        name: 'Documentation Worker',
        purpose: 'Maintain project documentation, screenshots, GIF demos, and docs builds.',
        cli_type: selectedCli,
        model: selectedModel ?? '',
        permission_mode: selectedCli === 'claude' ? 'acceptEdits' : undefined,
        auto_approve_plan: true,
      })
      await api.setSessionMcpServers(
        s.id,
        ['builtin-documentor', 'builtin-playwright'],
        DOC_MCP_OVERRIDES,
      )
      await api.setSessionGuidelines(s.id, ['builtin-documentation-agent'])
      s = await api.updateSession(s.id, { tags: ['capability_documentation'] })
      // focus:false: the DocsPanel stays in front, the new session must not
      // pull the keyboard into its terminal behind it.
      useStore.getState().addSession(s, { focus: false })
      setDocumentorSession(s)
      await useStore.getState().ensureSessionRunning(s.id)
      // Auto-send kickoff prompt after PTY boots (give it time to start)
      if (autoPrompt) {
        setSending('kickoff')
        // Wait for PTY to be ready, then send
        const waitAndSend = (retries = 0) => {
          setTimeout(() => {
            const ws = useStore.getState().ws
            if (ws?.readyState === WebSocket.OPEN && retries < 20) {
              sendTerminalCommand(s.id, autoPrompt)
              setSending(null)
            } else if (retries < 20) {
              waitAndSend(retries + 1)
            } else {
              setSending(null)
            }
          }, 1500)
        }
        waitAndSend()
      }
    } catch (e) {
      console.error(e)
      setSending(null)
    }
  }

  const handleSendPrompt = async (prompt, actionName) => {
    if (!documentorSession?.id) return
    setSending(actionName)
    // Wake the documentation worker PTY if it was stopped — otherwise the input
    // would be sent into a dead session and silently dropped.
    await useStore.getState().ensureSessionRunning(documentorSession.id)
    sendTerminalCommand(documentorSession.id, prompt)
    // Switch to the documentor tab
    useStore.getState().setActiveSession(documentorSession.id)
    setTimeout(() => setSending(null), 1000)
  }

  const handlePreview = () => {
    const port = status?.dev_port || 5174
    window.open(`${window.location.protocol}//${window.location.hostname}:${port}`, '_blank')
  }

  const docsContextLines = () => {
    if (!status) return []
    const lines = [
      `Workspace: ${status.workspace?.name || activeWorkspaceId}`,
      `Docs: ${status.pages || 0} pages, ${status.screenshots || 0} screenshots, ${status.gifs || 0} GIFs`,
      `Coverage: ${status.coverage?.pct ?? 0}% (${status.coverage?.documented_completed_features || 0}/${status.coverage?.completed_features || 0} completed features)`,
      `Last build: ${status.last_build || 'never'}`,
    ]
    const undocumented = (status.undocumented_features || []).slice(0, 10)
    if (undocumented.length) {
      lines.push('Undocumented completed/review features:')
      undocumented.forEach((f) => lines.push(`- ${f.id}: ${f.title} (${f.status})`))
    }
    const commits = (status.undocumented_commits || []).slice(0, 10)
    if (commits.length) {
      lines.push('Recent commits not marked documented:')
      commits.forEach((c) => lines.push(`- ${c.short_hash || c.hash?.slice(0, 8)}: ${c.message}`))
    }
    const stale = (status.stale_pages || []).slice(0, 10)
    if (stale.length) {
      lines.push('Tracked pages older than recent feature changes:')
      stale.forEach((p) => lines.push(`- ${p.path}`))
    }
    const missing = (status.missing_pages || []).slice(0, 10)
    if (missing.length) {
      lines.push('Manifest pages missing from disk:')
      missing.forEach((p) => lines.push(`- ${p.path}`))
    }
    const untracked = (status.untracked_pages || []).slice(0, 10)
    if (untracked.length) {
      lines.push('Markdown pages not in manifest:')
      untracked.forEach((p) => lines.push(`- ${p.path}`))
    }
    return lines
  }

  const buildDocPrompt = (mode, feature = null) => {
    const context = docsContextLines().join('\n') || 'No Docs Hub status is loaded yet.'
    if (mode === 'update') {
      return `${UPDATE_PROMPT}\n\nDocs Hub status:\n${context}\n\nPrioritize undocumented features, recent commits not marked documented, stale pages, missing manifest entries, and untracked pages. Update docs_manifest.json when done, including task_ids and relevant commit_shas.`
    }
    if (mode === 'screenshots') {
      return `${screenshotPrompt(appOrigin())}\n\nDocs Hub status:\n${context}\n\nOnly capture missing or stale screenshots unless the existing media is clearly outdated.`
    }
    if (mode === 'feature' && feature) {
      return `Update documentation for this completed feature:\n\n- Task: ${feature.id}\n- Title: ${feature.title}\n- Status: ${feature.status}\n\nDocs Hub status:\n${context}\n\nFind the relevant existing page or create a focused feature page. Inspect recent git commits to identify the relevant changes. Add screenshots if the UI changed. Mark this task ID and relevant commit_shas as documented in docs_manifest.json.`
    }
    return `${KICKOFF_PROMPT}\n\nDocs Hub status:\n${context}\n\nUse the status above to avoid rewriting pages that are already current. Track completed task IDs and relevant commit_shas in docs_manifest.json.`
  }

  const handleDocumentFeature = (feature) => {
    const prompt = buildDocPrompt('feature', feature)
    if (documentorSession?.id) {
      handleSendPrompt(prompt, `feature-${feature.id}`)
    } else {
      handleStartDocumentor(prompt)
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="x-panel w-[800px] max-h-[85vh] flex flex-col overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-x-line">
          <div className="flex items-center gap-2">
            <BookOpenCheck size={16} className="text-x-accent" />
            <span className="font-semibold text-sm text-x-ink">Documentation</span>
            {workspaces.length > 0 && (
              <>
                <span className="text-x-faint text-xs">/</span>
                <select
                  value={activeWorkspaceId || ''}
                  onChange={(e) => setActiveWorkspace(e.target.value)}
                  className="bg-x-bg border border-x-line hover:border-x-line-strong rounded px-2 py-0.5 text-xs text-x-ink-secondary font-medium outline-none focus:border-x-accent cursor-pointer transition-colors max-w-[200px] truncate"
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name || ws.path}
                    </option>
                  ))}
                </select>
              </>
            )}
            {status?.exists && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-x-good/10 text-x-good font-medium">
                {status.pages} pages
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadStatus}
              className="p-1 text-x-faint hover:text-x-ink-secondary rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} className="p-1 text-x-faint hover:text-x-ink rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-x-line px-2">
          {[
            { id: 'overview', label: 'Overview', icon: BookOpenCheck },
            { id: 'tree', label: 'File Tree', icon: FolderTree },
            { id: 'screenshots', label: 'Screenshots', icon: Camera },
            { id: 'undocumented', label: 'Undocumented', icon: AlertCircle },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-[1.5px] transition-colors duration-[80ms] ease-x ${
                tab === t.id
                  ? 'border-x-accent text-x-accent'
                  : 'border-transparent text-x-muted hover:text-x-ink-secondary'
              }`}
            >
              <t.icon size={12} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-center text-x-faint text-sm py-8">Loading docs status...</div>
          ) : !status?.exists ? (
            <div className="text-center py-12 space-y-4">
              <BookOpenCheck size={40} className="mx-auto text-x-faint" />
              <div className="text-x-ink-secondary text-sm font-medium">No documentation yet</div>
              <p className="text-x-faint text-xs max-w-md mx-auto">
                Start a documentation-capable worker to screenshot features, record GIF demos,
                and build a complete VitePress documentation site.
              </p>
              <div className="flex flex-col gap-2 items-center">
                <Button type="submit"
                  onClick={() => handleStartDocumentor(buildDocPrompt('full'))}
                  disabled={sending === 'kickoff'}
                  className="px-4 py-2 bg-x-accent text-x-on-accent text-sm font-medium hover:bg-x-accent-ink active:scale-[.98] transition-colors disabled:opacity-40 flex items-center gap-2"
                >
                  <Play size={14} />
                  {sending === 'kickoff' ? 'Starting...' : 'Generate Full Documentation'}
                </Button>
                <button
                  onClick={() => handleStartDocumentor(buildDocPrompt('screenshots'))}
                  disabled={sending === 'kickoff'}
                  className="px-3 py-1.5 text-x-muted text-xs hover:text-x-ink transition-colors disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Camera size={12} />
                  Screenshots only
                </button>
              </div>
            </div>
          ) : (
            <>
              {tab === 'overview' && (
                <div className="space-y-4">
                  {/* Stats Grid */}
                  <div className="grid grid-cols-5 gap-3">
                    <StatCard icon={FileText} label="Pages" value={status.pages} color="text-x-ink-secondary" />
                    <StatCard icon={Camera} label="Screenshots" value={status.screenshots} color="text-x-ink-secondary" />
                    <StatCard icon={Film} label="GIFs" value={status.gifs} color="text-x-ink-secondary" />
                    <StatCard
                      icon={GitBranch}
                      label="Commits"
                      value={status.undocumented_commits?.length || 0}
                      color={status.undocumented_commits?.length > 0 ? 'text-x-accent-ink' : 'text-x-good'}
                    />
                    <StatCard
                      icon={AlertCircle}
                      label="Undocumented"
                      value={status.undocumented_features?.length || 0}
                      color={status.undocumented_features?.length > 0 ? 'text-x-accent-ink' : 'text-x-good'}
                    />
                  </div>

                  <div className="x-panel p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5 text-x-ink-secondary font-medium">
                        <CheckCircle2 size={12} className="text-x-good" />
                        Coverage
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Same question, different reading: the percentage says
                            HOW MUCH is documented, the graph says WHICH PARTS
                            are not — and lets you act on them. */}
                        <button
                          onClick={() => setShowCoverage(true)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-x-tint text-x-accent hover:bg-x-accent/15 transition-colors duration-[80ms] text-[11px] font-medium"
                          title="Show which parts of this system lack docs, on its code graph"
                        >
                          <Network size={10} />
                          Coverage on graph
                        </button>
                        <span className="text-x-ink">{status.coverage?.pct ?? 0}%</span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded bg-x-surface-2 overflow-hidden">
                      <div
                        className="h-full bg-x-good"
                        style={{ width: `${Math.max(0, Math.min(100, status.coverage?.pct ?? 0))}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] text-x-faint">
                      <span>{status.coverage?.documented_completed_features || 0}/{status.coverage?.completed_features || 0} tasks documented</span>
                      {status.latest_docs_activity && <span>docs changed {formatDate(status.latest_docs_activity)}</span>}
                      {status.latest_feature_change && <span>latest feature {formatDate(status.latest_feature_change)}</span>}
                      <span>{status.built ? 'built' : 'not built'}</span>
                    </div>
                    {!!status.health?.length && (
                      <div className="grid gap-1 pt-1">
                        {status.health.slice(0, 4).map((item, idx) => (
                          <div key={`${item.label}-${idx}`} className="flex items-start gap-2 text-[11px]">
                            <AlertCircle size={12} className={item.level === 'error' ? 'text-x-accent-ink' : item.level === 'warning' ? 'text-x-accent-ink' : 'text-x-accent'} />
                            <span className="text-x-ink-secondary">{item.label}</span>
                            <span className="text-x-faint truncate">{item.detail}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Manifest Info */}
                  <div className="x-panel p-3 space-y-2">
                    <div className="text-xs font-medium text-x-ink-secondary">Manifest</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="text-x-faint">Project:</div>
                      <div className="text-x-ink">{status.manifest?.project_name || 'Not set'}</div>
                      <div className="text-x-faint">Created:</div>
                      <div className="text-x-ink">{formatDate(status.manifest?.created_at)}</div>
                      <div className="text-x-faint">Last Build:</div>
                      <div className="text-x-ink">{formatDate(status.last_build) || 'Never'}</div>
                      <div className="text-x-faint">Documented Pages:</div>
                      <div className="text-x-ink">{Object.keys(status.manifest?.pages || {}).length}</div>
                      <div className="text-x-faint">Documented Tasks:</div>
                      <div className="text-x-ink">{status.manifest?.documented_tasks?.length || 0}</div>
                      <div className="text-x-faint">Documented Commits:</div>
                      <div className="text-x-ink">{status.manifest?.documented_commits?.length || 0}</div>
                    </div>
                  </div>

                  {/* Documentation Actions */}
                  <div className="x-panel p-3 space-y-3">
                    <div className="text-xs font-medium text-x-ink-secondary">Documentation Worker</div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs font-medium text-x-ink-secondary space-y-1">
                        <span>CLI</span>
                        <select
                          value={selectedCli}
                          onChange={(e) => setSelectedCli(e.target.value)}
                          className="w-full bg-x-surface-2 border border-x-line rounded-md px-2 py-1 text-xs text-x-ink focus:outline-none focus:border-x-accent"
                        >
                          {cliOptions.map((cli) => (
                            <option key={cli.id} value={cli.id}>{cli.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs font-medium text-x-ink-secondary space-y-1">
                        <span>Model</span>
                        <select
                          value={selectedModel ?? ''}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          className="w-full bg-x-surface-2 border border-x-line rounded-md px-2 py-1 text-xs text-x-ink focus:outline-none focus:border-x-accent"
                        >
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.id}>{model.label || model.id || 'Default'}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {documentorSession ? (
                      (() => {
                        const statusMeta = getSessionStatusMeta(documentorSession.status, documentorSession.agentState, hasSessionStarted(documentorSession, sessionStarted))
                        return (
                      <>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`w-2 h-2 rounded-full ${statusMeta.dotClass}`} title={statusMeta.label} />
                          <span className="text-x-faint">{documentorSession.name}</span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-x-hover text-x-faint">{getCliLabel(documentorSession.cli_type)}</span>
                          <span className={`text-[11px] px-1.5 py-0.5 rounded bg-x-hover ${statusMeta.textClass}`}>{statusMeta.label}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ActionBtn
                            icon={Play} label="Full Docs" color="emerald"
                            disabled={sending === 'full'}
                            onClick={() => handleSendPrompt(buildDocPrompt('full'), 'full')}
                          />
                          <ActionBtn
                            icon={RotateCcw} label="Update Docs" color="blue"
                            disabled={sending === 'update'}
                            onClick={() => handleSendPrompt(buildDocPrompt('update'), 'update')}
                          />
                          <ActionBtn
                            icon={Camera} label="Screenshots" color="purple"
                            disabled={sending === 'screenshots'}
                            onClick={() => handleSendPrompt(buildDocPrompt('screenshots'), 'screenshots')}
                          />
                          <ActionBtn
                            icon={Hammer} label={building ? 'Building...' : 'Build Site'} color="amber"
                            disabled={building}
                            onClick={handleBuild}
                          />
                          <ActionBtn
                            icon={Eye} label="Preview" color="cyan"
                            onClick={handlePreview}
                          />
                        </div>
                      </>
                        )
                      })()
                    ) : (
                      <div className="flex gap-2">
                        <Button type="submit"
                          onClick={() => handleStartDocumentor(buildDocPrompt('full'))}
                          disabled={sending === 'kickoff'}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-x-accent text-x-on-accent hover:bg-x-accent-ink active:scale-[.98] transition-colors disabled:opacity-40"
                        >
                          <Play size={12} />
                          {sending === 'kickoff' ? 'Starting...' : 'New Worker & Generate Docs'}
                        </Button>
                        <Button type="submit"
                          onClick={handleBuild}
                          disabled={building}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-x-ink-secondary border border-x-line hover:bg-x-hover hover:text-x-ink hover:border-x-line-strong transition-colors disabled:opacity-40"
                        >
                          <Hammer size={12} />
                          {building ? 'Building...' : 'Build Site'}
                        </Button>
                        <Button type="submit"
                          onClick={handlePreview}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-x-ink-secondary border border-x-line hover:bg-x-hover hover:text-x-ink hover:border-x-line-strong transition-colors"
                        >
                          <Eye size={12} />
                          Preview
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Build Result */}
                  {buildResult && (
                    <div className={`x-panel p-3 text-xs ${buildResult.error ? 'border-x-accent-ink/30' : 'border-x-good/30'}`}>
                      {buildResult.error ? (
                        <div className="text-x-accent-ink">{buildResult.error}</div>
                      ) : (
                        <div className="text-x-good">
                          <CheckCircle2 size={12} className="inline mr-1" />
                          Build successful! Output: {buildResult.dist_path}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === 'tree' && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-x-ink-secondary mb-2">Documentation File Tree</div>
                  {!!status.page_list?.length && (
                    <div className="grid gap-1 mb-3">
                      {status.page_list.slice(0, 12).map((page) => (
                        <div key={page.path} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-x-surface border border-x-line">
                          <FileText size={12} className={page.tracked ? 'text-x-accent' : 'text-x-accent-ink'} />
                          <span className="text-x-ink truncate flex-1">{page.title}</span>
                          <span className="text-[11px] text-x-faint">{page.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!!status.missing_pages?.length && (
                    <div className="text-[11px] text-x-accent-ink mb-2">{status.missing_pages.length} manifest page(s) missing from disk</div>
                  )}
                  {!!status.untracked_pages?.length && (
                    <div className="text-[11px] text-x-accent-ink mb-2">{status.untracked_pages.length} markdown page(s) not tracked in the manifest</div>
                  )}
                  <pre className="text-[11px] text-x-faint font-mono bg-x-surface-2 p-3 rounded-md overflow-x-auto max-h-[50vh]">
                    {status.tree?.join('\n') || 'Empty'}
                  </pre>
                </div>
              )}

              {tab === 'screenshots' && (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-x-ink-secondary">
                    Screenshots ({status.screenshot_list?.length || 0}) &amp; GIFs ({status.gif_list?.length || 0})
                  </div>
                  {(!status.screenshot_list?.length && !status.gif_list?.length) ? (
                    <div className="text-center text-x-faint text-xs py-8">
                      No screenshots or GIFs yet. Start a documentation-capable worker to capture them.
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {status.screenshot_list?.map((s) => (
                        <div key={s.path} className="x-panel p-2 space-y-1">
                          <div className="flex items-center gap-1">
                            <Camera size={10} className="text-x-accent" />
                            <span className="text-[11px] text-x-ink-secondary truncate">{s.name}</span>
                          </div>
                          <div className="text-[11px] text-x-faint">{s.size_kb} KB</div>
                          <img
                            src={`/api/workspaces/${activeWorkspaceId}/docs/file/${encodeURIComponent(s.path)}`}
                            alt={s.name}
                            className="w-full rounded border border-x-line"
                            onError={(e) => { e.target.style.display = 'none' }}
                          />
                        </div>
                      ))}
                      {status.gif_list?.map((g) => (
                        <div key={g.path} className="x-panel p-2 space-y-1">
                          <div className="flex items-center gap-1">
                            <Film size={10} className="text-x-accent" />
                            <span className="text-[11px] text-x-ink-secondary truncate">{g.name}</span>
                          </div>
                          <div className="text-[11px] text-x-faint">{g.size_kb} KB</div>
                          <img
                            src={`/api/workspaces/${activeWorkspaceId}/docs/file/${encodeURIComponent(g.path)}`}
                            alt={g.name}
                            className="w-full rounded border border-x-line"
                            onError={(e) => { e.target.style.display = 'none' }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'undocumented' && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-x-ink-secondary">
                    Undocumented Completed Features ({status.undocumented_features?.length || 0})
                  </div>
                  {!status.undocumented_features?.length ? (
                    <div className="flex items-center gap-2 text-x-good text-xs py-4">
                      <CheckCircle2 size={14} />
                      All completed features are documented!
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {status.undocumented_features.map((f) => (
                        <div key={f.id} className="flex items-center gap-2 px-3 py-2 x-panel text-xs">
                          <AlertCircle size={12} className="text-x-accent-ink shrink-0" />
                          <span className="text-x-ink flex-1">{f.title}</span>
                          <span className="text-[11px] text-x-faint px-1.5 py-0.5 bg-x-hover rounded">
                            {f.status}
                          </span>
                          <button
                            onClick={() => handleDocumentFeature(f)}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-x-tint text-x-accent hover:bg-x-accent/15 transition-colors"
                          >
                            <Bot size={10} />
                            Update
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-xs font-medium text-x-ink-secondary pt-3">
                    Recent Commits Not Marked Documented ({status.undocumented_commits?.length || 0})
                  </div>
                  {!status.undocumented_commits?.length ? (
                    <div className="flex items-center gap-2 text-x-good text-xs py-3">
                      <CheckCircle2 size={14} />
                      Recent commits are marked in the docs manifest.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {status.undocumented_commits.slice(0, 20).map((c) => (
                        <div key={c.hash} className="flex items-center gap-2 px-3 py-2 x-panel text-xs">
                          <GitBranch size={12} className="text-x-accent-ink shrink-0" />
                          <span className="text-[11px] font-mono text-x-faint">{c.short_hash || c.hash?.slice(0, 8)}</span>
                          <span className="text-x-ink flex-1 truncate">{c.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>

    {/* Layered ABOVE the panel, not instead of it: closing the graph returns to
        the docs panel exactly as it was left (tab, scroll, in-flight build). The
        graph needs real width, so this one is wide and centred rather than the
        800px column the stats use. */}
    {showCoverage && activeWorkspaceId && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-4"
        onClick={() => {
          if (coverageCanvasRef.current) coverageCanvasRef.current.requestClose(() => setShowCoverage(false))
          else setShowCoverage(false)
        }}
      >
        <div
          className="x-panel w-full max-w-6xl h-[86vh] flex flex-col scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-x-line px-3 py-2">
            <Button type="submit"
              onClick={() => {
                if (coverageCanvasRef.current) coverageCanvasRef.current.requestClose(() => setShowCoverage(false))
                else setShowCoverage(false)
              }}
              className=" border border-x-line px-2 py-0.5 text-xs font-medium text-x-ink-secondary transition-colors duration-[80ms] hover:border-x-line-strong hover:bg-x-hover hover:text-x-ink"
            >
              ← Documentation
            </Button>
            <span className="truncate text-xs text-x-faint">
              Docs coverage projected onto this workspace&apos;s code graph
            </span>
          </div>
          {/* Suspense covers the lazy chunk LOADING; the boundary covers it
              throwing (chunk fetch failure, a render error in the graph) — the
              docs panel behind it survives either way. */}
          <PanelBoundary onClose={() => setShowCoverage(false)}>
            <Suspense fallback={<div className="flex-1 p-4 text-xs text-x-faint">Loading graph…</div>}>
              <WorkspaceChangesCanvas
                ref={coverageCanvasRef}
                workspaceId={activeWorkspaceId}
                mode="coverage"
                onClose={() => setShowCoverage(false)}
              />
            </Suspense>
          </PanelBoundary>
        </div>
      </div>
    )}
    </>
  )
}

const COLOR_MAP = {
  emerald: 'bg-x-good/10 text-x-good hover:bg-x-good/15',
  blue: 'bg-x-tint text-x-accent hover:bg-x-accent/15',
  purple: 'bg-x-tint text-x-accent hover:bg-x-accent/15',
  amber: 'bg-x-accent-ink/10 text-x-accent-ink hover:bg-x-accent-ink/15',
  cyan: 'bg-x-tint text-x-accent hover:bg-x-accent/15',
}

function ActionBtn({ icon: Icon, label, color, onClick, disabled }) {
  return (
    <Button type="submit"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors duration-[80ms] ease-x disabled:opacity-40 ${COLOR_MAP[color] || COLOR_MAP.blue}`}
    >
      <Icon size={12} />
      {label}
    </Button>
  )
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="x-panel p-3 text-center">
      <Icon size={16} className={`mx-auto mb-1 ${color}`} />
      <div className="text-lg font-semibold text-x-ink tabular-nums">{value}</div>
      <div className="text-[11px] text-x-faint">{label}</div>
    </div>
  )
}

function formatDate(iso) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}
