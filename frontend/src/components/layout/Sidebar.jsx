import { useProjectPreferences, setProjectPreference } from '../../lib/projectPreferences'
import { activityTime, relativeActivity } from '../../lib/sessionBrief'
import WorkspaceRenameDialog from '../workspace/WorkspaceRenameDialog'
import ProviderLogo from '../ui/ProviderLogo'
import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import { visibleSessionsOf } from '../../lib/visibleSessions'
import { Plus, FolderOpen, MessageSquare, SquareTerminal, ChevronDown, ChevronRight, Trash2, GripVertical, Check, GitMerge, FlaskConical, BookOpenCheck, FileText, ExternalLink, Archive, Settings, RefreshCw, Flame, Network, MoreHorizontal, Sparkles, Pencil, Pin } from 'lucide-react'
import MergeDialog from '../session/MergeDialog'
import SummaryDialog from '../session/SummaryDialog'
import PanelBoundary from '../PanelBoundary'
import useStore from '../../state/store'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'
import { api } from '../../lib/api'
import { MODELS, getWorkspaceColor, getSessionModelLabel, WORKSPACE_PALETTE } from '../../lib/constants'
import { getSubagentStatusMeta, isShellSession } from '../../lib/sessionStatus'
import { sessionStateOf } from '../../lib/sessionVocabulary'
import { formatElapsed } from '../../lib/sessionRuntime'
import { deleteSessionWithConfirm, deleteWorkspaceWithConfirm } from '../../lib/sessionActions'
import SessionContextMenu from '../shell/SessionContextMenu'
import StatusDot from '../ui/StatusDot'
import VoiceControl from './VoiceControl'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
const AgentarioProjects = resolveExtensionPanel('agentario', 'AgentarioProjects')
const CoordinationSidebarBadge = resolveExtensionPanel('swarmlock', 'CoordinationSidebarBadge')
const IndexWorkspaceAction = resolveExtensionPanel('forge', 'IndexWorkspaceAction')
import { Button } from '../ui'
import { isQuickWorkspace, openQuickStart, shortenHome } from '../../lib/quickStart'

// The project tree inside NavSidebar: one group per project with its
// sessions (status dot, name, word on hover), sub-agents, background tasks,
// the archive and "New session". Helper sessions never appear; session
// colours are not applied here any more. The filter text comes from the
// field in NavSidebar.

// "Review graph" is opt-in and rarely the first thing you click, so its chunk
// (the canvas + SystemGraph + CanvasControls) loads only when it opens.
const WorkspaceChangesCanvas = lazy(() => import('../session/WorkspaceChangesCanvas'))


function SessionBackgroundTaskLine({ session, task, now, onOpen }) {
  if (!task) return null
  const status = String(task.status || 'updated').toLowerCase()
  const isRunning = status === 'running' || status === 'started'
  const isFailed = status === 'failed' || status === 'error'
  const elapsed = isRunning ? formatElapsed(task.updatedAt, now) : ''
  const title = [
    task.summary || 'Background task',
    task.id ? `ID: ${task.id}` : '',
    task.outputText ? `Output:\n${String(task.outputText).slice(0, 500)}` : '',
  ].filter(Boolean).join('\n')

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(session)
      }}
      className="ml-10 mr-3 -mt-1 mb-0.5 flex max-w-[calc(100%-3.25rem)] items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-left font-mono text-[11px] text-x-faint transition-colors duration-[80ms] hover:border-x-line hover:bg-x-hover hover:text-x-ink-secondary"
      title={title}
    >
      <Flame size={8} className={isRunning ? 'text-x-accent-ink/75' : isFailed ? 'text-x-accent-ink/75' : 'text-x-good/70'} />
      <span
        className={`h-1 w-1 rounded-full shrink-0 ${
          isFailed
            ? 'bg-x-accent-ink'
            : isRunning
              ? 'bg-x-accent-ink animate-subtle-pulse'
              : 'bg-x-good'
        }`}
      />
      <span className={`shrink-0 ${isRunning ? 'text-x-accent-ink/80' : isFailed ? 'text-x-accent-ink/80' : 'text-x-good/70'}`}>
        bg
      </span>
      <span className="min-w-0 truncate">{task.id || 'task'}</span>
      <span className="shrink-0 text-x-faint">{isRunning ? (elapsed || 'running') : status}</span>
    </button>
  )
}

function ResearchModelPicker({ ws }) {
  // Detect installed CLIs (cached after first fetch)
  const [cliAvail, setCliAvail] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cc-cli-available') || '{}') } catch { return {} }
  })

  useEffect(() => {
    api.getCliInfo().then((info) => {
      if (info.available_clis) {
        setCliAvail(info.available_clis)
        localStorage.setItem('cc-cli-available', JSON.stringify(info.available_clis))
      }
      if (info.version) {
        localStorage.setItem('cc-version', info.version)
      }
    }).catch(() => {})
  }, [])

  const hasClaude = cliAvail.claude !== false // default true if unknown

  const savedOllama = JSON.parse(localStorage.getItem('cc-ollama-models') || '[]')
  const [showCustom, setShowCustom] = useState(false)
  const [customModel, setCustomModel] = useState('')

  const currentVal = ws.research_model || ''
  const isOllamaCustom = currentVal && !MODELS.some((m) => m.id === currentVal)

  const saveModel = async (v) => {
    await api.updateWorkspace(ws.id, { research_model: v || null })
    useStore.getState().setWorkspaces(
      useStore.getState().workspaces.map((w) => w.id === ws.id ? { ...w, research_model: v || null } : w)
    )
  }

  const addOllamaModel = (model) => {
    if (!model.trim()) return
    const updated = [...new Set([...savedOllama, model.trim()])]
    localStorage.setItem('cc-ollama-models', JSON.stringify(updated))
    saveModel(model.trim())
    setShowCustom(false)
    setCustomModel('')
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 mb-0.5">
      <span className="text-[11px] text-x-faint shrink-0">research:</span>
      {showCustom ? (
        <div className="flex-1 min-w-0 flex gap-1">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addOllamaModel(customModel); if (e.key === 'Escape') setShowCustom(false) }}
            placeholder="ollama model:tag"
            className="flex-1 px-1.5 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary placeholder-x-faint focus:outline-none x-focus-ring"
            autoFocus
          />
          <button onClick={() => addOllamaModel(customModel)} className="text-[11px] text-x-accent">add</button>
          <button onClick={() => setShowCustom(false)} className="text-[11px] text-x-faint">x</button>
        </div>
      ) : (
        <select
          value={isOllamaCustom ? currentVal : currentVal}
          onChange={(e) => {
            if (e.target.value === '__custom__') { setShowCustom(true); return }
            saveModel(e.target.value)
          }}
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary focus:outline-none focus:border-x-accent x-focus-ring transition-colors duration-[80ms]"
        >
          <option value="">default</option>
          {hasClaude && (
            <optgroup label="Claude">
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          )}
          {savedOllama.length > 0 && (
            <optgroup label="Ollama (saved)">
              {savedOllama.map((m) => <option key={m} value={m}>{m}</option>)}
            </optgroup>
          )}
          <option value="__custom__">+ add Ollama model...</option>
        </select>
      )}
    </div>
  )
}

function PreviewUrlInput({ ws }) {
  const [val, setVal] = useState(ws.preview_url || '')
  const [saving, setSaving] = useState(false)

  // Sync local state if the workspace gets updated externally (e.g. by MCP).
  useEffect(() => { setVal(ws.preview_url || '') }, [ws.preview_url])

  const save = async () => {
    const next = val.trim()
    if (next === (ws.preview_url || '')) return
    setSaving(true)
    try {
      await api.updateWorkspace(ws.id, { preview_url: next || null })
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) =>
          w.id === ws.id ? { ...w, preview_url: next || null } : w
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const open = () => {
    const url = (ws.preview_url || val || '').trim()
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 mb-0.5">
      <span className="text-[11px] text-x-faint shrink-0">preview:</span>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        placeholder="http://localhost:3000"
        className="flex-1 min-w-0 px-1.5 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line-subtle rounded-md text-x-ink-secondary placeholder-x-faint focus:outline-none focus:border-x-accent x-focus-ring transition-colors duration-[80ms]"
      />
      <button
        onClick={open}
        disabled={!ws.preview_url && !val.trim()}
        title="Open in new tab (⌘P)"
        className="text-[11px] text-x-accent hover:text-x-accent-ink disabled:text-x-faint disabled:cursor-not-allowed font-mono"
      >
        {saving ? '…' : '↗'}
      </button>
    </div>
  )
}


function FileTreeNode({ item, depth, workspaceId, expandedPaths, treeData, loadingPaths, onToggleFolder, onOpenFile }) {
  const isExpanded = !!expandedPaths[item.path]
  const isLoading = !!loadingPaths[item.path]
  const children = treeData[item.path] || []

  const getFileIcon = (name) => {
    const ext = name.split('.').pop().toLowerCase()
    switch(ext) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        return <FileText size={12} className="text-amber-400" />
      case 'css':
        return <FileText size={12} className="text-cyan-400" />
      case 'html':
        return <FileText size={12} className="text-orange-400" />
      case 'md':
        return <FileText size={12} className="text-sky-400" />
      case 'py':
        return <FileText size={12} className="text-blue-400" />
      case 'json':
        return <FileText size={12} className="text-yellow-500" />
      default:
        return <FileText size={12} className="text-x-faint" />
    }
  }

  if (item.is_dir) {
    return (
      <div className="flex flex-col">
        <button
          onClick={() => onToggleFolder(item.path)}
          className="flex items-center gap-1.5 py-1 px-2 hover:bg-x-hover text-left text-[11px] font-mono text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms] select-none w-full"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="shrink-0 transition-transform duration-150" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }}>
            <ChevronRight size={10} className="text-x-faint" />
          </span>
          <FolderOpen size={12} className="text-x-accent shrink-0" />
          <span className="truncate flex-1">{item.name}</span>
          {isLoading && <RefreshCw size={10} className="animate-spin text-x-accent" />}
        </button>

        {isExpanded && children.length > 0 && (
          <div className="flex flex-col">
            {children.map((child) => (
              <FileTreeNode
                key={child.path}
                item={child}
                depth={depth + 1}
                workspaceId={workspaceId}
                expandedPaths={expandedPaths}
                treeData={treeData}
                loadingPaths={loadingPaths}
                onToggleFolder={onToggleFolder}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}
        {isExpanded && children.length === 0 && !isLoading && (
          <div className="py-0.5 text-[11px] font-mono text-x-faint italic" style={{ paddingLeft: `${(depth + 1) * 12 + 24}px` }}>
            Empty directory
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => onOpenFile(item.path)}
      className="group/file flex items-center gap-1.5 py-1 px-2 hover:bg-x-hover text-left text-[11px] font-mono text-x-muted hover:text-x-ink transition-colors duration-[80ms] w-full"
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
      title="Click to open in your IDE"
    >
      {getFileIcon(item.name)}
      <span className="truncate flex-1">{item.name}</span>
      <span className="opacity-0 group-hover/file:opacity-100 flex items-center gap-1 text-[11px] text-x-accent font-semibold font-mono bg-x-accent/10 px-1 rounded transition-opacity duration-[80ms] shrink-0">
        IDE <ExternalLink size={8} />
      </span>
    </button>
  )
}

function WorkspaceFileTree({ workspaceId }) {
  const [isOpen, setIsOpen] = useState(false)
  const [treeData, setTreeData] = useState({})
  const [expandedPaths, setExpandedPaths] = useState({})
  const [loadingPaths, setLoadingPaths] = useState({})
  const [loadingRoot, setLoadingRoot] = useState(false)

  const loadFolder = async (path) => {
    setLoadingPaths(p => ({ ...p, [path]: true }))
    try {
      const res = await api.getWorkspaceFiles(workspaceId, path)
      if (res && res.items) {
        setTreeData(t => ({ ...t, [path]: res.items }))
      }
    } catch (err) {
      console.error("Failed to load folder", path, err)
    } finally {
      setLoadingPaths(p => ({ ...p, [path]: false }))
    }
  }

  const handleToggleFolder = (path) => {
    const nextExpanded = !expandedPaths[path]
    setExpandedPaths(p => ({ ...p, [path]: nextExpanded }))
    if (nextExpanded && !treeData[path]) {
      loadFolder(path)
    }
  }

  const handleToggleTree = async () => {
    const nextOpen = !isOpen
    setIsOpen(nextOpen)
    if (nextOpen && !treeData[""]) {
      setLoadingRoot(true)
      await loadFolder("")
      setLoadingRoot(false)
    }
  }

  const handleOpenFile = async (filePath) => {
    try {
      await api.openInIde(workspaceId, filePath)
      useStore.getState().addNotification({
        type: 'success',
        message: `Opened ${filePath.split('/').pop()} in IDE.`
      })
    } catch (err) {
      useStore.getState().addNotification({
        type: 'error',
        message: `Failed to open in IDE: ${err.message || err}`
      })
    }
  }

  const rootItems = treeData[""] || []

  return (
    <div className="border-t border-x-line mt-1 pt-1">
      <button
        onClick={handleToggleTree}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-x-ink-secondary hover:text-x-ink uppercase tracking-[0.06em] text-left transition-colors duration-[80ms]"
      >
        <FolderOpen size={10} className="text-x-faint shrink-0" />
        <span>Workspace Files</span>
        <span className="ml-auto text-x-faint">
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>

      {isOpen && (
        <div className="flex flex-col mt-0.5 pb-2 max-h-[300px] overflow-y-auto scrollbar-thin select-none">
          {loadingRoot ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-x-faint font-mono">
              <RefreshCw size={10} className="animate-spin text-x-accent shrink-0" />
              <span>Loading workspace root...</span>
            </div>
          ) : rootItems.length > 0 ? (
            rootItems.map((item) => (
              <FileTreeNode
                key={item.path}
                item={item}
                depth={0}
                workspaceId={workspaceId}
                expandedPaths={expandedPaths}
                treeData={treeData}
                loadingPaths={loadingPaths}
                onToggleFolder={handleToggleFolder}
                onOpenFile={handleOpenFile}
              />
            ))
          ) : (
            <div className="px-3 py-2 text-[11px] text-x-faint italic font-mono">
              No files found
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ filter = '' }) {
  const projectPrefs = useProjectPreferences()
  const [renameWorkspace, setRenameWorkspace] = useState(null)
  const t = useT()
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const ptyStartedAt = useStore((s) => s.sessionPtyStartedAt)
  const workStartedAt = useStore((s) => s.sessionWorkStartedAt)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const planWaiting = useStore((s) => s.planWaiting)
  const sessionActivity = useStore((s) => s.sessionActivity)
  const compactionState = useStore((s) => s.compactionState)
  const subagents = useStore((s) => s.subagents)
  const backgroundTasks = useStore((s) => s.backgroundTasks)
  const sidebarExpanded = useStore((s) => s.sidebarExpanded)
  const toggleSessionExpanded = useStore((s) => s.toggleSessionExpanded)
  const selectedSessionIds = useStore((s) => s.selectedSessionIds)
  const selectionWorkspaceId = useStore((s) => s.selectionWorkspaceId)
  const toggleSessionSelect = useStore((s) => s.toggleSessionSelect)
  const clearSessionSelection = useStore((s) => s.clearSessionSelection)
  const peers = useStore((s) => s.peers)
  const myClientId = useStore((s) => s.myClientId)
  const cliProfiles = useStore((s) => s.cliProfiles)
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [summaryDialogSession, setSummaryDialogSession] = useState(null)
  // {id, name} of the workspace opened in the graph editor overlay, or null.
  const [graphEditWs, setGraphEditWs] = useState(null)
  const graphCanvasRef = useRef(null)
  const [now, setNow] = useState(Date.now())
  const [indexingWorkspaces, setIndexingWorkspaces] = useState({})
  // Tick every 2s so "active" dots decay when spinners stop
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const openActiveWorkspaceGraph = () => {
      const activeId = useStore.getState().activeWorkspaceId
      const workspace = workspaces.find((ws) => ws.id === activeId) || workspaces[0]
      if (workspace) setGraphEditWs(workspace)
    }
    window.addEventListener('open-workspace-review-graph', openActiveWorkspaceGraph)
    return () => window.removeEventListener('open-workspace-review-graph', openActiveWorkspaceGraph)
  }, [workspaces])

  const isActive = (id) => sessionActivity[id] && (now - sessionActivity[id]) < 5000

  const [expanded, setExpanded] = useState({})
  const quickStart = useStore((s) => s.quickStart)
  // Workspaces that appear later (e.g. "Quick sessions" on the first quick
  // start) open expanded like the ones loaded at startup.
  useEffect(() => {
    setExpanded((prev) => {
      const missing = workspaces.filter((w) => !(w.id in prev))
      if (!missing.length) return prev
      const next = { ...prev }
      for (const w of missing) next[w.id] = true
      return next
    })
  }, [workspaces])
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, session }
  void cliProfiles

  // Drag-reorder state
  const [wsDragIdx, setWsDragIdx] = useState(null)        // index of dragged workspace
  const [wsDropIdx, setWsDropIdx] = useState(null)        // workspace drop indicator
  const [sessDrag, setSessDrag] = useState(null)          // { wsId, idx }
  const [sessDropKey, setSessDropKey] = useState(null)    // `${wsId}:${idx}`
  const [colorPickerWs, setColorPickerWs] = useState(null) // workspace id whose color picker is open

  useEffect(() => {
    const expandSelectedWorkspace = (event) => {
      if (event.detail?.id) setExpanded((previous) => ({ ...previous, [event.detail.id]: true }))
    }
    window.addEventListener('workspace-selected', expandSelectedWorkspace)
    return () => window.removeEventListener('workspace-selected', expandSelectedWorkspace)
  }, [])

  // Dismiss color picker on outside click
  useEffect(() => {
    if (!colorPickerWs) return
    const h = (e) => {
      if (!e.target.closest('[data-ws-color-popover]') && !e.target.closest('[data-ws-color-trigger]')) {
        setColorPickerWs(null)
      }
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [colorPickerWs])

  const setWorkspaceColor = async (wsId, color) => {
    try {
      const updated = await api.updateWorkspace(wsId, { color })
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) => (w.id === wsId ? { ...w, ...updated } : w))
      )
    } catch (err) {
      console.error('Failed to update workspace color:', err)
    }
    setColorPickerWs(null)
  }


  // The one initial loader: workspaces, their sessions, tasks, templates,
  // tab groups, prompts, cascades and the CLI profiles.
  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const wsList = await api.getWorkspaces()
      useStore.getState().setWorkspaces(wsList)
      // Auto-set activeWorkspaceId if not yet set so that features like
      // skill install have a valid workspace context from the start.
      if (wsList.length > 0 && !useStore.getState().activeWorkspaceId) {
        useStore.getState().setActiveWorkspace(wsList[0].id)
      }
      const sessResults = await Promise.all(
        wsList.map((ws) => api.getSessions(ws.id).catch(() => []))
      )
      for (let i = 0; i < wsList.length; i++) {
        useStore.getState().loadSessions(sessResults[i])
        setExpanded((p) => ({ ...p, [wsList[i].id]: true }))
      }
      // Eagerly load tasks for all workspaces so the auto-oversight
      // nudge gate (useWebSocket session_idle handler) can check whether
      // an idle worker actually has an active task assigned.
      const allTasks = await api.getTasks()
      if (Array.isArray(allTasks)) useStore.getState().loadTasks(allTasks)
      // Grid templates are tiny and used the moment the user opens the layout dropdown.
      useStore.getState().loadGridTemplates()
      // Tab groups for one-click tab set switching.
      useStore.getState().loadTabGroups()
      // Prompt cache backs @prompt:<name> token expansion + the chip preview.
      useStore.getState().loadPrompts()
      useStore.getState().loadCascades()
      // CLI profiles drive model/mode/effort dropdowns from backend data.
      api.getCliFeatures().then((data) => {
        if (data?.profiles) useStore.getState().loadCliProfiles(data.profiles)
      }).catch(() => {})
    } catch (e) {
      console.error('Failed to load data:', e)
    }
  }

  const handleDeleteSession = async (e, sessionId) => {
    e.stopPropagation()
    await deleteSessionWithConfirm(sessionId)
  }

  // A row opens the session full size (Session level); a new tab gets the
  // keyboard through the store's focus request, an open one through goSession.
  const handleClickSession = (session) => {
    const store = useStore.getState()
    store.setActiveWorkspace(session.workspace_id)
    store.goSession(session.id)
  }


  // Sort by server-assigned `order_index` (0 = unset, fall back to natural order from the API).
  // Helper sessions (Commander, Brainstormer) are filtered out before sorting.
  const sortedByOrderIndex = (items) => {
    return [...items].sort((a, b) => {
      const ai = a.order_index || 0
      const bi = b.order_index || 0
      if (ai === 0 && bi === 0) return 0
      if (ai === 0) return 1
      if (bi === 0) return -1
      return ai - bi
    })
  }

  const projectActivity = id => Math.max(activityTime(workspaces.find(w=>w.id===id)),...Object.values(sessions).filter(s=>s.workspace_id===id).map(activityTime))
  const orderedWorkspaces = sortedByOrderIndex(workspaces).sort((a,b) =>
    Number(isQuickWorkspace(a,quickStart))-Number(isQuickWorkspace(b,quickStart)) ||
    Number(projectPrefs.pinned.includes(b.id))-Number(projectPrefs.pinned.includes(a.id)) ||
    (projectPrefs.sort==='recent' ? projectActivity(b.id)-projectActivity(a.id) : 0))

  const workspaceSessions = (wsId) => {
    const q = filter.toLowerCase()
    const list = visibleSessionsOf(sessions, wsId, { includeReadOnly: true }).filter((s) =>
      (!filter || s.name.toLowerCase().includes(q) || getSessionModelLabel(s).toLowerCase().includes(q))
    )
    return projectPrefs.sort === 'recent' ? [...list].sort((a,b)=>activityTime(b)-activityTime(a)) : sortedByOrderIndex(list)
  }

  const archivedSessions = (wsId) => {
    const q = filter.toLowerCase()
    const list = visibleSessionsOf(sessions, wsId, { includeArchived: true, includeReadOnly: true }).filter((s) =>
      s.archived &&
      (!filter || s.name.toLowerCase().includes(q) || getSessionModelLabel(s).toLowerCase().includes(q))
    )
    return sortedByOrderIndex(list)
  }

  const [archiveExpanded, setArchiveExpanded] = useState({})

  return (
    <div className="ive-project-tree" data-project-tree="">
      <div className="ive-project-sort"><label>Sort <select aria-label="Project and session order" value={projectPrefs.sort} onChange={e=>setProjectPreference({sort:e.target.value})}><option value="recent">Recent activity</option><option value="manual">Manual order</option></select></label></div>
      {renameWorkspace && <WorkspaceRenameDialog key={renameWorkspace.id} workspace={renameWorkspace} onClose={() => setRenameWorkspace(null)} />}
      <div className="ive-project-tree-list" data-ia-session-spine>
        {!workspaces.some((workspace) => !isQuickWorkspace(workspace, quickStart)) && (
          <div className="ive-sidebar-empty">
            <FolderOpen size={24} />
            <strong>No projects yet</strong>
            <p>Choose a project folder.</p>
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('open-add-workspace'))}><Plus size={14} /> Add a project</button>
          </div>
        )}

        {orderedWorkspaces.map((ws, wsIdx) => {
          const wsColor = getWorkspaceColor(ws)
          const wsIsDragOver = wsDropIdx === wsIdx && wsDragIdx !== wsIdx
          // "Quick sessions": sessions started without picking a project. It
          // lives in the quick start root, so project-only actions are hidden.
          const isQuick = isQuickWorkspace(ws, quickStart)
          return (
          <div
            key={ws.id}
            data-workspace-id={ws.id}
            data-expanded={expanded[ws.id] ? 'true' : undefined}
            data-drag-over={wsIsDragOver ? 'true' : undefined}
            onDragOver={(e) => {
              // Only react to workspace-id drags here, not session drags
              if (e.dataTransfer.types.includes('workspace-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setWsDropIdx(wsIdx)
              }
            }}
            onDragLeave={(e) => {
              if (e.dataTransfer.types.includes('workspace-id')) setWsDropIdx(null)
            }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes('workspace-id')) {
                e.preventDefault()
                const fromId = e.dataTransfer.getData('workspace-id')
                const currentIds = orderedWorkspaces.map((w) => w.id)
                const fromIdx = currentIds.indexOf(fromId)
                if (fromIdx !== -1 && fromIdx !== wsIdx) {
                  // Compute the new full order and ship it to the store/server
                  const next = [...currentIds]
                  const [moved] = next.splice(fromIdx, 1)
                  next.splice(wsIdx, 0, moved)
                  setProjectPreference({sort:'manual'})
                  useStore.getState().reorderWorkspaces(next)
                }
                setWsDragIdx(null)
                setWsDropIdx(null)
              }
            }}
            className="x-workspace-group relative transition-colors duration-[80ms]"
          >
            <div
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('workspace-id', ws.id)
                e.dataTransfer.effectAllowed = 'move'
                setWsDragIdx(wsIdx)
              }}
              onDragEnd={() => { setWsDragIdx(null); setWsDropIdx(null) }}
              onClick={() => {
                setExpanded((p) => ({ ...p, [ws.id]: !p[ws.id] }))
                useStore.getState().setActiveWorkspace(ws.id)
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setExpanded((p) => ({ ...p, [ws.id]: !p[ws.id] }))
                  useStore.getState().setActiveWorkspace(ws.id)
                }
              }}
              className="group w-full flex items-center gap-1.5 px-3 py-2 text-xs hover:bg-x-hover text-left transition-colors cursor-grab active:cursor-grabbing"
              title="Drag to reorder workspace"
            >
              <GripVertical size={11} className="shrink-0 text-x-faint/40 opacity-0 group-hover:opacity-100 transition-opacity" />
              {expanded[ws.id] ? <ChevronDown size={12} className="shrink-0 text-x-faint" /> : <ChevronRight size={12} className="shrink-0 text-x-faint" />}
              <FolderOpen size={12} className="shrink-0" style={{ color: wsColor }} />
              {isQuick ? (
                <span className="flex-1 min-w-0" data-quick-workspace>
                  <span className="block truncate text-x-ink font-medium">{t('nav.withoutProject')}</span>
                  <span className="block truncate font-mono text-[11px] font-normal normal-case tracking-normal text-x-faint" title={ws.path}>{shortenHome(quickStart?.root || ws.path)}</span>
                </span>
              ) : (
                <span className="truncate text-x-ink font-medium flex-1 min-w-0">{ws.name}</span>
              )}
              {!isQuick && <button type="button" draggable={false} aria-label={`${projectPrefs.pinned.includes(ws.id)?'Unpin':'Pin'} project ${ws.name}`} aria-pressed={projectPrefs.pinned.includes(ws.id)} title={projectPrefs.pinned.includes(ws.id)?'Unpin project':'Pin project'} className={`ive-project-pin ${projectPrefs.pinned.includes(ws.id)?'is-pinned':''}`} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();setProjectPreference({pinned:projectPrefs.pinned.includes(ws.id)?projectPrefs.pinned.filter(id=>id!==ws.id):[...projectPrefs.pinned,ws.id]})}}><Pin size={12}/></button>}
              {!isQuick && <button type="button" draggable={false} aria-label={`Rename project ${ws.name}`} title="Rename project"
                className="shrink-0 p-1 text-x-muted hover:text-x-ink hover:bg-x-hover rounded"
                onPointerDown={e => e.stopPropagation()} onDragStart={e => { e.preventDefault(); e.stopPropagation() }}
                onClick={e => { e.stopPropagation(); setRenameWorkspace(ws) }}><Pencil size={12} /></button>}
              {/* Color picker swatch (uses span so it can live inside the button) */}
              <span
                data-ws-color-trigger
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  setColorPickerWs(colorPickerWs === ws.id ? null : ws.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setColorPickerWs(colorPickerWs === ws.id ? null : ws.id)
                  }
                }}
                className="shrink-0 w-3 h-3 rounded-full cursor-pointer hover:ring-2 hover:ring-x-line-strong transition-colors duration-[80ms]"
                style={{ backgroundColor: wsColor, border: '1px solid var(--x-line-strong)' }}
                title="Change project color"
              />
              {!isQuick && <Button
                type="button"
                aria-label="Delete workspace"
                title="Remove project from IVE"
                className="shrink-0 box-content p-1 -mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10 transition-all"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteWorkspaceWithConfirm(ws.id)
                }}
              >
                <Trash2 size={13} />
              </Button>}
            </div>

            {colorPickerWs === ws.id && (
              <div
                data-ws-color-popover
                className="absolute right-2 top-9 z-50 x-panel p-2 scale-in"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-[11px] text-x-faint font-medium uppercase tracking-[0.06em] mb-1.5 px-0.5">Project color</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {WORKSPACE_PALETTE.map((c) => (
                    <button
                      key={c}
                      onClick={() => setWorkspaceColor(ws.id, c)}
                      className={`w-5 h-5 rounded-full transition-colors duration-[80ms] ${ws.color === c ? 'ring-2 ring-offset-2 ring-offset-bg-elevated ring-x-accent' : 'hover:ring-2 hover:ring-offset-2 hover:ring-offset-bg-elevated hover:ring-x-line-strong'}`}
                      style={{ backgroundColor: c, border: '1px solid var(--x-line-strong)' }}
                      title={c}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setWorkspaceColor(ws.id, null)}
                  className="mt-2 w-full text-[11px] text-x-faint hover:text-x-ink-secondary py-1 rounded hover:bg-x-hover transition-colors duration-[80ms]"
                >
                  auto (hash)
                </button>
              </div>
            )}

            {expanded[ws.id] && (
              <div className="relative px-1.5 pb-1.5">
                  <button
                    // Same prompt as ⌘N and every other "New session", with this
                    // project (or, for Quick sessions, no project) preselected.
                    onClick={() => openQuickStart({ workspaceId: isQuick ? null : ws.id })}
                    title={isQuick ? 'Set up a session or start a quick chat without a project' : `New session in ${ws.name || 'this project'}`}
                    data-sidebar-new-session={ws.id}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-x-faint hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms] border-l-2 border-l-transparent"
                  >
                    <Plus size={11} />
                    {t('nav.newSession')}
                  </button>
                {workspaceSessions(ws.id).map((session, sIdx) => {
                  const dropKey = `${ws.id}:${sIdx}`
                  const isSessDragOver = sessDropKey === dropKey && !(sessDrag?.wsId === ws.id && sessDrag?.idx === sIdx)
	                  const sessAgents = Object.values(subagents[session.id] || {})
	                  const sessBackgroundTasks = Object.values(backgroundTasks[session.id] || {})
	                    .filter((task) => ['running', 'started'].includes(String(task.status || '').toLowerCase()))
	                    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
	                    .slice(0, 3)
                  const hasAgents = sessAgents.length > 0
                  const isExpanded = !!sidebarExpanded[session.id]
                  const runningAgents = sessAgents.filter((a) => a.status === 'running').length
                  const isChecked = selectedSessionIds.includes(session.id)
                  const hasSelection = selectedSessionIds.length > 0
                  const isOtherWs = selectionWorkspaceId && session.workspace_id !== selectionWorkspaceId
                  const statusMeta = sessionStateOf(session, sessionStarted)
                  const sessionModelLabel = getSessionModelLabel(session)
                  const isOpenTab = openTabs.includes(session.id)
                  return (
                  <div key={session.id} data-session-id={session.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleClickSession(session)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleClickSession(session)
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCtxMenu({ x: e.clientX, y: e.clientY, session })
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('session-id', session.id)
                      e.dataTransfer.setData('reorder-from-ws', ws.id)
                      e.dataTransfer.setData('reorder-from-idx', String(sIdx))
                      e.dataTransfer.effectAllowed = 'copyMove'
                      setSessDrag({ wsId: ws.id, idx: sIdx })
                    }}
                    onDragOver={(e) => {
                      // Reorder hint only when dragging another session within same ws
                      if (e.dataTransfer.types.includes('reorder-from-ws')) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setSessDropKey(dropKey)
                      }
                    }}
                    onDragLeave={(e) => {
                      if (e.dataTransfer.types.includes('reorder-from-ws')) setSessDropKey(null)
                    }}
                    onDrop={(e) => {
                      if (e.dataTransfer.types.includes('reorder-from-ws')) {
                        e.preventDefault()
                        e.stopPropagation() // don't bubble up to terminal split-handler
                        const fromWs = e.dataTransfer.getData('reorder-from-ws')
                        const fromIdxRaw = e.dataTransfer.getData('reorder-from-idx')
                        const fromIdx = parseInt(fromIdxRaw, 10)
                        if (fromWs === ws.id && !Number.isNaN(fromIdx) && fromIdx !== sIdx) {
                          const currentIds = workspaceSessions(ws.id).map((s) => s.id)
                          const next = [...currentIds]
                          const [moved] = next.splice(fromIdx, 1)
                          next.splice(sIdx, 0, moved)
                          setProjectPreference({sort:'manual'})
                          useStore.getState().reorderSessionsInWorkspace(ws.id, next)
                        }
                        setSessDrag(null)
                        setSessDropKey(null)
                      }
                    }}
                    onDragEnd={() => { setSessDrag(null); setSessDropKey(null) }}
                    data-reorder-session={session.id}
                    className={`x-session-card group${activeSessionId === session.id ? ' is-active' : ''}${isOpenTab ? ' is-open' : ''}${isSessDragOver ? ' is-drop-target' : ''}`}
                    title={`${session.name} · ${statusMeta.label}${statusMeta.detail ? ` · ${statusMeta.detail}` : ''}${sessionModelLabel ? ` · ${sessionModelLabel}` : ''} · drag onto a sibling to reorder`}
                  >
                    {/* Status dot, or the merge checkbox on hover / while selecting */}
                    <div className="shrink-0 w-3.5 h-3.5 flex items-center justify-center relative">
                      {/* Merge checkbox — visible on hover or when any session is selected */}
                      <span
                        role="checkbox"
                        aria-checked={isChecked}
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); if (!isOtherWs) toggleSessionSelect(session.id) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            if (!isOtherWs) toggleSessionSelect(session.id)
                          }
                        }}
                        className={`absolute inset-0 rounded border flex items-center justify-center transition-all cursor-pointer ${
                          isChecked
                            ? 'bg-x-accent border-x-accent opacity-100 z-10'
                            : isOtherWs
                              ? 'hidden'
                              : hasSelection
                                ? 'border-x-tint-line hover:border-x-muted opacity-100 z-10 bg-x-bg'
                                : 'border-x-tint-line hover:border-x-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:z-10 group-hover:z-10 bg-x-bg'
                        }`}
                        title={isOtherWs ? 'Can only select sessions from the same workspace' : 'Select for merge'}
                      >
                        {isChecked && <Check size={8} className="text-x-on-accent" />}
                      </span>
                      {/* Status dot — hidden when the checkbox is visible */}
                      <div className={`flex items-center justify-center transition-opacity duration-150 ${
                        isChecked || (hasSelection && !isOtherWs) ? 'opacity-0 pointer-events-none' : 'opacity-100 group-hover:opacity-0'
                      }`}>
                        <StatusDot state={statusMeta.state} />
                      </div>
                    </div>
                    {hasAgents && (
                      <span
                        onClick={(e) => { e.stopPropagation(); toggleSessionExpanded(session.id) }}
                        className="shrink-0 text-x-faint hover:text-x-ink-secondary p-0.5 -ml-0.5 rounded cursor-pointer"
                        title={`${sessAgents.length} sub-agent${sessAgents.length !== 1 ? 's' : ''} (${runningAgents} running)`}
                      >
                        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </span>
                    )}
                    <div className="flex-1 min-w-0 flex flex-col justify-center py-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate block" title={session.name}>
                          {session.name}
                        </span>
                        {runningAgents > 0 && (
                          <span className="shrink-0 text-[11px] font-mono text-x-good bg-x-good/10 px-1 rounded">
                            {runningAgents}
                          </span>
                        )}
                      </div>
                      {/* Model and agent live in the session header and on the board card;
                          the row title attribute keeps them for a hover. */}
                      {/* The status word: read by screen readers and e2e, shown on hover. */}
                      <div className={`x-session-status ${statusMeta.textClass}`} data-session-state={statusMeta.state} title={statusMeta.detail || undefined}>
                        <span>{statusMeta.state==='waiting'?'Needs your reply':statusMeta.label}</span><span className="ive-session-age">{relativeActivity(session)}</span>
                        {statusMeta.detail && <span className="x-session-status-detail">· {statusMeta.detail}</span>}
                      </div>
                    </div>
                    {(() => {
                      const tags = Array.isArray(session.tags) ? session.tags
                        : typeof session.tags === 'string' ? (() => { try { return JSON.parse(session.tags) } catch { return [] } })()
                        : []
                      const primaryTag = tags.includes('capability_documentation')
                        ? 'docs'
                        : tags.includes('capability_testing')
                          ? 'test'
                          : tags[0]
                      return tags.length > 0 ? (
                        <span className="text-[11px] text-x-accent font-mono truncate max-w-[60px]" title={tags.join(', ')}>
                          {primaryTag}{tags.length > 1 ? `+${tags.length - 1}` : ''}
                        </span>
                      ) : null
                    })()}
                    {session.is_external ? <span className="text-x-accent/70 text-[11px] font-mono">ext</span> : null}
                    {session.branch_label && (
                      <span
                        className="shrink-0 text-[11px] font-mono px-1 rounded border border-x-accent/25 text-x-accent/90 bg-x-accent/10"
                        title={`Branch group ${session.branch_label} — linked session`}
                      >
                        {session.branch_label}
                      </span>
                    )}
                    {/* Multiplayer: peer presence dots */}
                    {(() => {
                      const viewing = Object.entries(peers).filter(([cid, p]) => p.viewing_session === session.id && cid !== myClientId)
                      return viewing.length > 0 ? (
                        <div className="flex items-center -space-x-0.5 shrink-0">
                          {viewing.slice(0, 2).map(([cid, p]) => (
                            <span
                              key={cid}
                              className="w-3 h-3 rounded-full ring-1 ring-x-bg"
                              style={{ background: p.color }}
                              title={p.name}
                            />
                          ))}
                          {viewing.length > 2 && (
                            <span className="text-[11px] text-x-faint ml-0.5">+{viewing.length - 2}</span>
                          )}
                        </div>
                      ) : null
                    })()}
                    {(compactionState[session.id]?.status === 'compacting' || compactionState[session.id]?.status === 'warning') && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0 bg-x-waiting animate-pulse"
                        title={compactionState[session.id]?.status === 'compacting' ? 'Compacting context' : `${compactionState[session.id].percent_left}% context left`}
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`More actions for ${session.name || 'session'}`}
                      title="More actions: rename, clone, copy output, export, summary, archive, stop (or right-click the session)"
                      data-session-more
                      aria-haspopup="menu"
                      className={`shrink-0 h-6 w-6 items-center justify-center rounded-md text-x-faint hover:text-x-ink hover:bg-x-hover transition-all ${activeSessionId === session.id ? 'inline-flex' : 'hidden group-hover:inline-flex group-focus-within:inline-flex'}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        const r = e.currentTarget.getBoundingClientRect()
                        setCtxMenu({ x: r.left, y: r.bottom + 4, session })
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete session"
                      title="Delete session"
                      className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md -mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10 transition-all"
                      onClick={(e) => handleDeleteSession(e, session.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
	                  {sessBackgroundTasks.map((task) => (
	                    <SessionBackgroundTaskLine
	                      key={task.id}
	                      session={session}
	                      task={task}
	                      now={now}
	                      onOpen={handleClickSession}
	                    />
	                  ))}
	                  {isExpanded && hasAgents && (
                    <div className="pl-7 pr-2 pb-1 space-y-0.5 bg-x-bg/30">
                      {sessAgents.map((agent) => {
                        const agentStatusMeta = getSubagentStatusMeta(agent.status)
                        return (
                          <button
                            key={agent.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              useStore.getState().setViewingSubagent(session.id, agent.id)
                            }}
                            className="w-full flex items-center gap-1.5 py-1 text-[11px] font-mono text-left rounded-sm hover:bg-x-hover transition-colors duration-[80ms] cursor-pointer group/agent"
                            title={`View ${agent.type} output · ${agentStatusMeta.label}`}
                          >
                            <span className={`w-1 h-1 rounded-full shrink-0 ${agentStatusMeta.dotClass}`} />
                            <span className="text-x-ink-secondary shrink-0">{agent.type}</span>
                            {agent.tools.length > 0 && (
                              <span className="text-x-faint truncate">
                                · {agent.tools[agent.tools.length - 1].tool}
                              </span>
                            )}
                            {agent.status === 'completed' && agent.result && (
                              <span className="text-x-faint truncate flex-1 min-w-0">
                                → {agent.result}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  </div>
                  )
                })}
                {/* Archive section */}
                {(() => {
                  const archived = archivedSessions(ws.id)
                  if (archived.length === 0) return null
                  const isArchiveOpen = archiveExpanded[ws.id]
                  return (
                    <div className="border-t border-x-line-subtle/50">
                      <button
                        onClick={() => setArchiveExpanded((p) => ({ ...p, [ws.id]: !p[ws.id] }))}
                        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-x-faint hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms]"
                      >
                        {isArchiveOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        <Archive size={10} />
                        <span className="font-medium">Archive</span>
                        <span className="ml-auto text-[11px] font-mono opacity-70">{archived.length}</span>
                      </button>
                      {isArchiveOpen && archived.map((session) => {
                        const sessionModelLabel = getSessionModelLabel(session)
                        return (
                          <button
                            key={session.id}
                            onClick={() => useStore.getState().openSession(session.id)}
                            title="View saved conversation. Restore session from its menu to continue."
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setCtxMenu({ x: e.clientX, y: e.clientY, session })
                            }}
                            className={`group w-full flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-xs text-left transition-colors duration-[80ms] ${
                              activeSessionId === session.id
                                ? 'bg-x-tint text-x-ink border-l-2 font-medium'
                                : 'text-x-faint hover:bg-x-hover border-l-2 border-l-transparent'
                            }`}
                            style={activeSessionId === session.id ? { borderLeftColor: getWorkspaceColor(ws) } : undefined}
                          >
                            <div className="shrink-0 w-3.5 h-3.5 flex items-center justify-center opacity-50">
                              <MessageSquare size={11} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col justify-center py-0.5">
                              <span className="truncate opacity-60 block" title={session.name}>
                                {session.name}
                              </span>
                              {sessionModelLabel && (
                                <div className="flex items-center gap-1 mt-0.5 min-w-0" title={sessionModelLabel}>
                                  <ProviderLogo provider={session.cli_type} className="w-3.5 h-3.5 shrink-0" />
                                  <span className="truncate text-x-faint/60 text-[11px] font-mono block">
                                    {sessionModelLabel}
                                  </span>
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )
                })()}

                  {/* Agentario systems attached to THIS workspace — rendered
                      inside the project group so they live next to the
                      sessions that edit them. Renders nothing when none. */}
                  <AgentarioProjects workspaceId={ws.id} />

                <details className="ive-sidebar-project-tools">
                  <summary>{t('nav.projectTools')}</summary>
                {/* Workspace settings shortcut — shows key info inline */}
                <div className="flex items-center mb-0.5 px-3 gap-1 select-none w-full">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      useStore.setState({ activeWorkspaceId: ws.id })
                      window.dispatchEvent(new CustomEvent('open-workspace-settings', { detail: { workspaceId: ws.id } }))
                    }}
                    className="flex items-center gap-1.5 flex-1 py-1.5 text-[11px] text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms] group/ws-btn text-left min-w-0"
                    title="Open workspace settings (⌘K → Workspace Settings)"
                  >
                    <Settings size={11} className="text-x-faint group-hover/ws-btn:text-x-ink-secondary transition-colors duration-[80ms] shrink-0" />
                    <span className="shrink-0">Settings</span>
                    <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden">
                      <span
                        title={
                          ws.human_oversight === 'full_auto'
                            ? 'Human oversight: full auto — agents act without approval'
                            : ws.human_oversight === 'approve_all'
                              ? 'Human oversight: approve all — every agent action needs your OK'
                              : 'Human oversight: plans only — you approve plans, not each step'
                        }
                        className="rounded border border-x-line bg-x-surface-2 px-1 py-0.5 font-mono text-[11px] text-x-muted">
                        {ws.human_oversight === 'full_auto' ? 'auto' : ws.human_oversight === 'approve_all' ? 'all' : 'plans'}
                      </span>
                      <CoordinationSidebarBadge workspace={ws} />
                      {ws.research_model && (
                        <span
                          className="min-w-0 truncate text-right font-mono text-[11px] text-x-faint"
                          title={`Research model: ${ws.research_model}`}
                        >
                          {ws.research_model}
                        </span>
                      )}
                    </span>
                  </button>
                  <VoiceControl
                    workspaceId={ws.id}
                    activeSessionId={activeSessionId}
                    compact
                  />
                </div>
                {!isQuick && <>
                <div className="ive-project-actions">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); useStore.getState().setActiveWorkspace(ws.id); window.dispatchEvent(new CustomEvent('open-panel', { detail: 'brainstorm' })) }}
                    className="ive-project-action"
                    title="Brainstorm in this project (opens the Brainstormer)"
                  >
                    <Sparkles size={11} aria-hidden="true" /><span className="truncate">Brainstorm</span>
                  </button>
                  <IndexWorkspaceAction
                    workspaceId={ws.id} busy={indexingWorkspaces[ws.id]}
                    onBusyChange={(busy) => setIndexingWorkspaces((prev) => ({ ...prev, [ws.id]: busy }))}
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setGraphEditWs({ id: ws.id, name: ws.name || ws.path }) }}
                    className="ive-project-action"
                    title="Review this workspace's code graph"
                  >
                    <Network size={11} aria-hidden="true" /><span className="truncate">Review graph</span>
                  </button>
                </div>
                <WorkspaceFileTree workspaceId={ws.id} />
                </>}
                </details>

              </div>
            )}
          </div>
          )
        })}



        {/* Pinned agentario agent systems NOT attached to a workspace. Attached
            pins render inside their workspace group above; this global section
            renders nothing when every pin is attached (or none exist). */}
        <AgentarioProjects />
      </div>

      {/* Merge bar — shown when 2+ sessions are selected */}
      {selectedSessionIds.length >= 2 && (
        <div className="px-2 py-2 border-t border-x-line bg-x-surface-2 flex items-center gap-2">
          <GitMerge size={13} className="shrink-0 text-x-accent" />
          <span className="text-xs text-x-ink-secondary flex-1 min-w-0 truncate">
            {selectedSessionIds.length} sessions selected
          </span>
          <button
            onClick={() => clearSessionSelection()}
            className="text-[11px] text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
          >
            clear
          </button>
          <Button type="submit"
            onClick={() => setShowMergeDialog(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors duration-[80ms]"
          >
            <GitMerge size={11} />
            Merge
          </Button>
        </div>
      )}

      {/* Merge dialog */}
      {showMergeDialog && (
        <MergeDialog onClose={() => setShowMergeDialog(false)} />
      )}

      {/* Session context menu */}
      {ctxMenu && (
        <SessionContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          session={ctxMenu.session}
          onClose={() => setCtxMenu(null)}
          onOpenSummary={(session) => setSummaryDialogSession(session)}
        />
      )}

      {/* Summary dialog */}
      {summaryDialogSession && (
        <SummaryDialog
          session={summaryDialogSession}
          onClose={() => setSummaryDialogSession(null)}
        />
      )}
      {/* Review graph — the workspace's code graph as a working surface, in the
          same full overlay grammar the other panels use. Suspense covers the
          lazy chunk loading, the boundary covers it throwing. */}
      {graphEditWs && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-4"
          onClick={() => {
            if (graphCanvasRef.current) graphCanvasRef.current.requestClose(() => setGraphEditWs(null))
            else setGraphEditWs(null)
          }}
        >
          <div
            className="x-panel w-full max-w-6xl h-[88vh] flex flex-col scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <PanelBoundary onClose={() => setGraphEditWs(null)}>
              <Suspense fallback={<div className="flex-1 p-4 text-xs text-x-faint">Loading graph…</div>}>
                <WorkspaceChangesCanvas
                  ref={graphCanvasRef}
                  workspaceId={graphEditWs.id}
                  mode="coverage"
                  title={`${graphEditWs.name} · review graph`}
                  onClose={() => setGraphEditWs(null)}
                />
              </Suspense>
            </PanelBoundary>
          </div>
        </div>
      )}
    </div>
  )
}
