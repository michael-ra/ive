import { useState, useEffect } from 'react'
import { X, BookOpenCheck, Camera, Film, FileText, Hammer, Eye, RefreshCw, AlertCircle, CheckCircle2, FolderTree, ExternalLink, Play, RotateCcw, Send } from 'lucide-react'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'
import useStore from '../../state/store'

const KICKOFF_PROMPT = `Begin documenting this project now. Follow this sequence:

1. Call get_knowledge_base() to understand the full product
2. Call get_completed_features() to see what's been built
3. Call scaffold_docs() to create the VitePress site skeleton (use the project name from the knowledge base)
4. Systematically screenshot every major feature and write a documentation page for each
5. Record GIF demos for key multi-step workflows
6. Build the site when done

Start immediately with step 1.`

const UPDATE_PROMPT = `Update the documentation incrementally:

1. Call get_docs_manifest() to see what's already documented
2. Call get_changes_since() with the last build timestamp
3. Call get_completed_features() to find newly completed features
4. Update only the pages affected by changes
5. Re-screenshot any UI that changed
6. Rebuild the site

Start with step 1.`

const SCREENSHOT_PROMPT = `Screenshot all major UI features. For each panel/feature visible in the app:

1. Navigate to http://localhost:5173
2. screenshot_page for the main view
3. Open each panel (Command Palette, Feature Board, Sidebar, etc.) and screenshot_page each
4. Use screenshot_element for specific UI components worth highlighting
5. Record record_gif for any multi-step workflows

Start by screenshotting the main dashboard.`

export default function DocsPanel({ onClose }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [buildResult, setBuildResult] = useState(null)
  const [tab, setTab] = useState('overview') // overview | tree | screenshots | undocumented
  const [documentorSession, setDocumentorSession] = useState(null)
  const [sending, setSending] = useState(null) // which action is in-flight

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sessions = useStore((s) => s.sessions)

  // Find existing documentor session
  useEffect(() => {
    const docSession = Object.values(sessions).find(
      (s) => s.session_type === 'documentor' && s.workspace_id === activeWorkspaceId
    )
    setDocumentorSession(docSession || null)
  }, [sessions, activeWorkspaceId])

  useEffect(() => {
    if (activeWorkspaceId) loadStatus()
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
      const s = await api.startDocumentor(activeWorkspaceId)
      useStore.getState().addSession(s)
      setDocumentorSession(s)
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

  const handleSendPrompt = (prompt, actionName) => {
    if (!documentorSession?.id) return
    setSending(actionName)
    sendTerminalCommand(documentorSession.id, prompt)
    // Switch to the documentor tab
    useStore.getState().setActiveSession(documentorSession.id)
    setTimeout(() => setSending(null), 1000)
  }

  const handlePreview = () => {
    const port = status?.dev_port || 5174
    window.open(`http://localhost:${port}`, '_blank')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh]" onClick={onClose}>
      <div
        className="ide-panel w-[800px] max-h-[85vh] flex flex-col overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <BookOpenCheck size={16} className="text-emerald-400" />
            <span className="font-semibold text-sm text-text-primary">Documentation</span>
            {status?.exists && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
                {status.pages} pages
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadStatus}
              className="p-1 text-text-faint hover:text-text-secondary rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} className="p-1 text-text-faint hover:text-text-primary rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-primary px-2">
          {[
            { id: 'overview', label: 'Overview', icon: BookOpenCheck },
            { id: 'tree', label: 'File Tree', icon: FolderTree },
            { id: 'screenshots', label: 'Screenshots', icon: Camera },
            { id: 'undocumented', label: 'Undocumented', icon: AlertCircle },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-emerald-400 text-emerald-400'
                  : 'border-transparent text-text-faint hover:text-text-secondary'
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
            <div className="text-center text-text-faint text-sm py-8">Loading docs status...</div>
          ) : !status?.exists ? (
            <div className="text-center py-12 space-y-4">
              <BookOpenCheck size={40} className="mx-auto text-text-faint/40" />
              <div className="text-text-secondary text-sm font-medium">No documentation yet</div>
              <p className="text-text-faint text-xs max-w-md mx-auto">
                Start the Documentor agent to automatically screenshot features, record GIF demos,
                and build a complete VitePress documentation site.
              </p>
              <div className="flex flex-col gap-2 items-center">
                <button
                  onClick={() => handleStartDocumentor(KICKOFF_PROMPT)}
                  disabled={sending === 'kickoff'}
                  className="px-4 py-2 bg-emerald-500/20 text-emerald-400 text-sm font-medium rounded-md hover:bg-emerald-500/30 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  <Play size={14} />
                  {sending === 'kickoff' ? 'Starting...' : 'Generate Full Documentation'}
                </button>
                <button
                  onClick={() => handleStartDocumentor(SCREENSHOT_PROMPT)}
                  disabled={sending === 'kickoff'}
                  className="px-3 py-1.5 text-text-faint text-xs hover:text-text-secondary transition-colors flex items-center gap-1.5"
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
                  <div className="grid grid-cols-4 gap-3">
                    <StatCard icon={FileText} label="Pages" value={status.pages} color="text-blue-400" />
                    <StatCard icon={Camera} label="Screenshots" value={status.screenshots} color="text-purple-400" />
                    <StatCard icon={Film} label="GIFs" value={status.gifs} color="text-amber-400" />
                    <StatCard
                      icon={AlertCircle}
                      label="Undocumented"
                      value={status.undocumented_features?.length || 0}
                      color={status.undocumented_features?.length > 0 ? 'text-red-400' : 'text-green-400'}
                    />
                  </div>

                  {/* Manifest Info */}
                  <div className="ide-panel p-3 space-y-2">
                    <div className="text-xs font-medium text-text-secondary">Manifest</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="text-text-faint">Project:</div>
                      <div className="text-text-primary">{status.manifest?.project_name || 'Not set'}</div>
                      <div className="text-text-faint">Created:</div>
                      <div className="text-text-primary">{formatDate(status.manifest?.created_at)}</div>
                      <div className="text-text-faint">Last Build:</div>
                      <div className="text-text-primary">{formatDate(status.last_build) || 'Never'}</div>
                      <div className="text-text-faint">Documented Pages:</div>
                      <div className="text-text-primary">{Object.keys(status.manifest?.pages || {}).length}</div>
                      <div className="text-text-faint">Documented Tasks:</div>
                      <div className="text-text-primary">{status.manifest?.documented_tasks?.length || 0}</div>
                    </div>
                  </div>

                  {/* Documentor Actions */}
                  <div className="ide-panel p-3 space-y-3">
                    <div className="text-xs font-medium text-text-secondary">Documentor Agent</div>
                    {documentorSession ? (
                      <>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`w-2 h-2 rounded-full ${documentorSession.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
                          <span className="text-text-faint">{documentorSession.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-faint">{documentorSession.status || 'idle'}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ActionBtn
                            icon={Play} label="Full Docs" color="emerald"
                            disabled={sending === 'full'}
                            onClick={() => handleSendPrompt(KICKOFF_PROMPT, 'full')}
                          />
                          <ActionBtn
                            icon={RotateCcw} label="Update Docs" color="blue"
                            disabled={sending === 'update'}
                            onClick={() => handleSendPrompt(UPDATE_PROMPT, 'update')}
                          />
                          <ActionBtn
                            icon={Camera} label="Screenshots" color="purple"
                            disabled={sending === 'screenshots'}
                            onClick={() => handleSendPrompt(SCREENSHOT_PROMPT, 'screenshots')}
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
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleStartDocumentor(KICKOFF_PROMPT)}
                          disabled={sending === 'kickoff'}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-500/15 text-emerald-400 rounded-md hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
                        >
                          <Play size={12} />
                          {sending === 'kickoff' ? 'Starting...' : 'Start & Generate Docs'}
                        </button>
                        <button
                          onClick={handleBuild}
                          disabled={building}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-500/15 text-blue-400 rounded-md hover:bg-blue-500/25 transition-colors disabled:opacity-50"
                        >
                          <Hammer size={12} />
                          {building ? 'Building...' : 'Build Site'}
                        </button>
                        <button
                          onClick={handlePreview}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-500/15 text-purple-400 rounded-md hover:bg-purple-500/25 transition-colors"
                        >
                          <Eye size={12} />
                          Preview
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Build Result */}
                  {buildResult && (
                    <div className={`ide-panel p-3 text-xs ${buildResult.error ? 'border-red-500/30' : 'border-green-500/30'}`}>
                      {buildResult.error ? (
                        <div className="text-red-400">{buildResult.error}</div>
                      ) : (
                        <div className="text-green-400">
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
                  <div className="text-xs font-medium text-text-secondary mb-2">Documentation File Tree</div>
                  <pre className="text-[11px] text-text-faint font-mono bg-bg-primary p-3 rounded-md overflow-x-auto max-h-[50vh]">
                    {status.tree?.join('\n') || 'Empty'}
                  </pre>
                </div>
              )}

              {tab === 'screenshots' && (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-text-secondary">
                    Screenshots ({status.screenshot_list?.length || 0}) &amp; GIFs ({status.gif_list?.length || 0})
                  </div>
                  {(!status.screenshot_list?.length && !status.gif_list?.length) ? (
                    <div className="text-center text-text-faint text-xs py-8">
                      No screenshots or GIFs yet. Start the Documentor to capture them.
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {status.screenshot_list?.map((s) => (
                        <div key={s.path} className="ide-panel p-2 space-y-1">
                          <div className="flex items-center gap-1">
                            <Camera size={10} className="text-purple-400" />
                            <span className="text-[10px] text-text-secondary truncate">{s.name}</span>
                          </div>
                          <div className="text-[9px] text-text-faint">{s.size_kb} KB</div>
                          <img
                            src={`/api/workspaces/${activeWorkspaceId}/docs/file/${encodeURIComponent(s.path)}`}
                            alt={s.name}
                            className="w-full rounded border border-border-primary"
                            onError={(e) => { e.target.style.display = 'none' }}
                          />
                        </div>
                      ))}
                      {status.gif_list?.map((g) => (
                        <div key={g.path} className="ide-panel p-2 space-y-1">
                          <div className="flex items-center gap-1">
                            <Film size={10} className="text-amber-400" />
                            <span className="text-[10px] text-text-secondary truncate">{g.name}</span>
                          </div>
                          <div className="text-[9px] text-text-faint">{g.size_kb} KB</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'undocumented' && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-text-secondary">
                    Undocumented Completed Features ({status.undocumented_features?.length || 0})
                  </div>
                  {!status.undocumented_features?.length ? (
                    <div className="flex items-center gap-2 text-green-400 text-xs py-4">
                      <CheckCircle2 size={14} />
                      All completed features are documented!
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {status.undocumented_features.map((f) => (
                        <div key={f.id} className="flex items-center gap-2 px-3 py-2 ide-panel text-xs">
                          <AlertCircle size={12} className="text-red-400 shrink-0" />
                          <span className="text-text-primary flex-1">{f.title}</span>
                          <span className="text-[10px] text-text-faint px-1.5 py-0.5 bg-bg-hover rounded">
                            {f.status}
                          </span>
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
  )
}

const COLOR_MAP = {
  emerald: 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
  blue: 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25',
  purple: 'bg-purple-500/15 text-purple-400 hover:bg-purple-500/25',
  amber: 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25',
  cyan: 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25',
}

function ActionBtn({ icon: Icon, label, color, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${COLOR_MAP[color] || COLOR_MAP.blue}`}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="ide-panel p-3 text-center">
      <Icon size={16} className={`mx-auto mb-1 ${color}`} />
      <div className="text-lg font-bold text-text-primary">{value}</div>
      <div className="text-[10px] text-text-faint">{label}</div>
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
