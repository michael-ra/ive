import { useState, useRef, useCallback, useEffect, Suspense } from 'react'
import { Menu, Plus, Search, CircleHelp, GraduationCap } from 'lucide-react'
import useWebSocket from './hooks/useWebSocket'
import useMediaQuery from './hooks/useMediaQuery'
import useKeyboard from './hooks/useKeyboard'
import useView from './hooks/useView'
import useCostPoll from './hooks/useCostPoll'
import useCatchUp, { touchLastSeen } from './hooks/useCatchUp'
import useTaskAttention from './hooks/useTaskAttention'
import { isShellSession } from './lib/sessionStatus'
import AppShell from './components/shell/AppShell'
import NavSidebar from './components/shell/NavSidebar'
import AttentionBar from './components/session/AttentionBar'
import { Modal } from './components/ui'
import HeaderBar from './components/shell/HeaderBar'
import ConnectionNotice from './components/shell/ConnectionNotice'
import HomeScreen from './screens/HomeScreen'
import BoardScreen from './screens/BoardScreen'
import SessionScreen from './screens/SessionScreen'
import { closeSession, useSessionDelete } from './lib/sessionActions'
import SessionDeleteDialog from './components/session/SessionDeleteDialog'
import SessionRenameDialog from './components/session/SessionRenameDialog'
import { useSessionRename } from './lib/sessionRename'
// Dialogs and overlay panels are loaded on first use so the start-up bundle
// stays smaller. Each one has its own Suspense + chunk-error boundary.
import lazyPanel from './components/LazyPanel'
const MissionControl = lazyPanel(() => import('./components/session/MissionControl'))
import TerminalView from './components/chat/Terminal'
import ChatPanel from './components/chat/ChatPanel'
import SideChat from './components/chat/SideChat'
import QuickStartPopover from './components/session/QuickStartPopover'
import { openQuickStart, openSessionSetup, loadQuickStart } from './lib/quickStart'
import { newTerminal } from './lib/shellSession'
import useSessionAttention from './hooks/useSessionAttention'
import CommandPalette from './components/command/CommandPalette'
import { resolveExtensionPanel, isSurfaceAvailable } from './lib/extensionRegistry'
const SearchPanel = lazyPanel(() => import('./components/command/SearchPanel'))
const PromptPalette = lazyPanel(() => import('./components/prompts/PromptPalette'))
const GuidelinePanel = lazyPanel(() => import('./components/guidelines/GuidelinePanel'))
const MarketplacePanel = lazyPanel(() => import('./components/marketplace/MarketplacePanel'))
const SettingsShell = lazyPanel(() => import('./components/settings/SettingsShell'))
const GlobalLogsPanel = lazyPanel(() => import('./components/logs/GlobalLogsPanel'))
import InteractiveOnboarding from './components/onboarding/InteractiveOnboarding'
import { emitTourEvent } from './lib/guidedTour'
import useOnboarding from './hooks/useOnboarding'
import MobileInstallPrompt from './components/mobile/MobileInstallPrompt'
import { PhoneLockOverlay, PhonePushPrompt } from './components/mobile/PhoneRemote'
import PhoneOverview from './components/mobile/PhoneOverview'
import { PhoneKeyBar, PhoneSessionHeader } from './components/mobile/PhoneSession'
import CatchUpPanel from './components/catchup/CatchUpPanel'
import CostPanel from './components/cost/CostPanel'
import BroadcastBar from './components/chat/BroadcastBar'
const HistoryImport = lazyPanel(() => import('./components/session/HistoryImport'))
const InboxPanel = lazyPanel(() => import('./components/session/Inbox'))
const PlanViewer = lazyPanel(() => import('./components/session/PlanViewer'))
const FeatureBoard = lazyPanel(() => import('./components/board/FeatureBoard'))
const ResearchHub = lazyPanel(() => import('./components/session/ResearchHub'))
const DiscoveryHub = lazyPanel(() => import('./components/discovery/DiscoveryHub'))
const GovernancePanel = resolveExtensionPanel('company', 'GovernancePanel')
const AIControlCenter = resolveExtensionPanel('gi', 'AIControlCenter')
import WorkspaceVisionOnboarding from './components/workspace/WorkspaceVisionOnboarding'
const PipelineEditor = lazyPanel(() => import('./components/pipeline/PipelineEditor'))
const QuickFeatureModal = lazyPanel(() => import('./components/board/QuickFeatureModal'))
const SubagentTree = lazyPanel(() => import('./components/session/SubagentTree'))
const TemplateManager = lazyPanel(() => import('./components/command/TemplateManager'))
const NewSessionDialog = lazyPanel(() => import('./components/session/NewSessionDialog'), { preload: 'idle' })
const CapabilitiesPanel = lazyPanel(() => import('./components/session/CapabilitiesPanel'))
const DocsPanel = lazyPanel(() => import('./components/session/DocsPanel'))
const KnowledgePanel = resolveExtensionPanel('myelin', 'KnowledgePanel')
const CodeCatalogPanel = resolveExtensionPanel('forge', 'CodeCatalogPanel')
const SecurePanel = lazyPanel(() => import('./components/session/SecurePanel'))
const AgentSystemsPanel = resolveExtensionPanel('agentario', 'AgentSystemsPanel')
const PeerMessagesPanel = lazyPanel(() => import('./components/session/PeerMessagesPanel'))
const MemoryWindow = lazyPanel(() => import('./components/session/MemoryWindow'))
import SessionSidebar from './components/session/SessionSidebar'
import CheatSheet from './components/command/CheatSheet'
const TaskFlow = lazyPanel(() => import('./components/home/TaskFlow'))
import { connectProject } from './lib/taskFlow'
import WorkspacePicker from './components/workspace/WorkspacePicker'
import SubagentViewer from './components/session/SubagentViewer'
import Composer from './components/chat/Composer'
const TerminalAnnotator = lazyPanel(() => import('./components/chat/TerminalAnnotator'))
import CodePreview from './components/session/CodePreview'
const DistillPanel = lazyPanel(() => import('./components/session/DistillPanel'))
const PreviewPalette = lazyPanel(() => import('./components/command/PreviewPalette'))
const LivePreview = lazyPanel(() => import('./components/command/LivePreview'))
const ScreenshotAnnotator = lazyPanel(() => import('./components/session/ScreenshotAnnotator'))
const QuickActionPalette = lazyPanel(() => import('./components/command/QuickActionPalette'))
import CascadeBar from './components/chat/CascadeBar'
import CascadeVariableDialog from './components/prompts/CascadeVariableDialog'
import NotificationToast, { ToastBoundary } from './components/layout/NotificationToast'
import PanelBoundary from './components/PanelBoundary'
import { canRestoreTerminalFocus } from './lib/gridFocus'
import { openFindInSession } from './lib/findRouter'
import useStore from './state/store'
import { operatorDeskChanged, persistOperatorDesk, restoreOperatorDesk, runningSessionTabs } from './lib/operatorDesk'
import { toggleTheme } from './lib/theme'
import { loadLanguageSetting } from './lib/i18n'
import { installRouter, viewOf } from './lib/route'
import { api } from './lib/api'
import { typeInTerminal } from './lib/terminal'

const OWNER_ACTORS = ['localhost', 'owner_legacy', 'owner_device']

// No stored desk tabs (fresh browser): open the running sessions once they load.
let seedTabsFromRunning = false
if (typeof window !== 'undefined') {
  try {
    const desk = restoreOperatorDesk(useStore, window.localStorage)
    seedTabsFromRunning = !Array.isArray(desk?.openTabs)
  } catch {}
}

export default function App() {
  useWebSocket()
  useSessionAttention()
  const onboarding = useOnboarding()

  // Load AuthContext (mode/actor_kind/label) once on boot. The ModeBadge
  // also self-loads if it ever mounts before this fires.
  const loadWhoami = useStore((s) => s.loadWhoami)
  useEffect(() => { loadWhoami() }, [loadWhoami])
  // UI language: the app setting wins over the browser's stored choice.
  useEffect(() => { loadLanguageSetting() }, [])

  // Load the CLI profile matrix once at boot so every surface uses the same
  // active CLI/model/permission source of truth.
  useEffect(() => {
    let cancelled = false
    api.getCliFeatures()
      .then((data) => {
        if (!cancelled && data?.profiles) {
          useStore.getState().loadCliProfiles(data.profiles)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const [catchupOpen, setCatchupOpen] = useState(false)
  const [catchupSeed, setCatchupSeed] = useState(null)
  const [showCost, setShowCost] = useState(false)
  const [quickFeatureInitialImages, setQuickFeatureInitialImages] = useState([])
  // Fresh browser: once the session lists stop arriving (one request per
  // workspace), open the running sessions so Overview and ⌘⇧E work.
  useEffect(() => {
    if (!seedTabsFromRunning) return undefined
    let timer = null
    const giveUp = setTimeout(() => { seedTabsFromRunning = false }, 20000)
    const trySeed = () => {
      if (!seedTabsFromRunning) return
      const state = useStore.getState()
      if (state.openTabs.length) { seedTabsFromRunning = false; return }
      const ids = runningSessionTabs(state.sessions)
      if (!ids.length) return
      seedTabsFromRunning = false
      useStore.setState({
        openTabs: ids,
        activeSessionId: ids.includes(state.activeSessionId) ? state.activeSessionId : ids[0],
        // Stay where the user is (Home); Overview is one click away now.
        showHome: true,
      })
    }
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (!seedTabsFromRunning || state.sessions === previous.sessions) return
      clearTimeout(timer)
      timer = setTimeout(trySeed, 600)
    })
    return () => { unsubscribe(); clearTimeout(timer); clearTimeout(giveUp) }
  }, [])
  // Preserve the operator's open desk and attention queue across reloads.
  useEffect(() => {
    const saveDesk = (state) => {
      try { persistOperatorDesk(state, window.localStorage) } catch {}
    }
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (operatorDeskChanged(state, previous)) saveDesk(state)
    })
    const onUnload = () => {
      try { touchLastSeen() } catch {}
      saveDesk(useStore.getState())
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      unsubscribe()
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])

  // Background LLM job completion (distill, MCP parse)
  useEffect(() => {
    const handleDistillDone = (e) => {
      const { result, session_name, artifact_type, job_id } = e.detail
      useStore.getState().addBackgroundResult({
        jobType: 'distill',
        jobId: job_id,
        artifactType: artifact_type,
        sessionName: session_name,
        result,
      })
      useStore.getState().addNotification({
        type: 'distill_done',
        message: `Distilled "${artifact_type}" from ${session_name}`,
        jobId: job_id,
        artifactType: artifact_type,
        result,
      })
    }
    const handleDistillError = (e) => {
      useStore.getState().addNotification({
        type: 'distill_error',
        message: `Distill failed: ${e.detail.error}`,
      })
    }
    const handleMcpParseDone = (e) => {
      const { result, job_id } = e.detail
      useStore.getState().addBackgroundResult({
        jobType: 'mcp_parse',
        jobId: job_id,
        result,
      })
      useStore.getState().addNotification({
        type: 'mcp_parse_done',
        message: `MCP server parsed: ${result.name || 'Unknown'}`,
        jobId: job_id,
        result,
      })
    }
    const handleMcpParseError = (e) => {
      useStore.getState().addNotification({
        type: 'mcp_parse_error',
        message: `MCP parse failed: ${e.detail.error}`,
      })
    }
    const handleGuidelineRec = (e) => {
      const { session_id, recommendations } = e.detail
      if (recommendations?.length > 0) {
        // Dedup: skip if a guideline_recommendation notification already exists for this session
        const existing = useStore.getState().notifications
        if (existing.some((n) => n.type === 'guideline_recommendation' && n.sessionId === session_id)) return
        useStore.getState().addNotification({
          type: 'guideline_recommendation',
          message: `${recommendations.length} guideline${recommendations.length > 1 ? 's' : ''} recommended`,
          sessionId: session_id,
          recommendations,
        })
      }
    }
    const handleSkillSuggestion = (e) => {
      const { session_id, skills, index_building } = e.detail
      if (skills?.length > 0) {
        const existing = useStore.getState().notifications
        if (existing.some((n) => n.type === 'skill_suggestion' && n.sessionId === session_id)) return
        useStore.getState().addNotification({
          type: 'skill_suggestion',
          message: `${skills.length} skill${skills.length > 1 ? 's' : ''} suggested`,
          sessionId: session_id,
          skills,
          indexBuilding: !!index_building,
        })
      }
    }
    window.addEventListener('cc-distill_done', handleDistillDone)
    window.addEventListener('cc-distill_error', handleDistillError)
    window.addEventListener('cc-mcp_parse_done', handleMcpParseDone)
    window.addEventListener('cc-mcp_parse_error', handleMcpParseError)
    window.addEventListener('cc-guideline_recommendation', handleGuidelineRec)
    window.addEventListener('cc-skill_suggestion', handleSkillSuggestion)
    return () => {
      window.removeEventListener('cc-distill_done', handleDistillDone)
      window.removeEventListener('cc-distill_error', handleDistillError)
      window.removeEventListener('cc-mcp_parse_done', handleMcpParseDone)
      window.removeEventListener('cc-mcp_parse_error', handleMcpParseError)
      window.removeEventListener('cc-guideline_recommendation', handleGuidelineRec)
      window.removeEventListener('cc-skill_suggestion', handleSkillSuggestion)
    }
  }, [])

  // Open result panels from notification action buttons
  useEffect(() => {
    const handleOpenDistillResult = (e) => {
      closeExclusivePanels()
      setDistillInitial({ result: e.detail.result, artifactType: e.detail.artifactType })
      setShowDistill(true)
    }
    const handleOpenMcpResult = (e) => {
      closeExclusivePanels()
      setSettingsSection('mcp-servers')
    }
    const handleOpenGuidelines = () => { closeExclusivePanels(); setShowGuidelines(true) }
    const handleOpenMarketplace = (e) => {
      closeExclusivePanels()
      setMarketplaceTab(e.detail?.tab || null)
      setMarketplaceSuggestedSkills(e.detail?.suggestedSkills || null)
      setShowMarketplace(true)
    }
    window.addEventListener('open-distill-result', handleOpenDistillResult)
    window.addEventListener('open-mcp-parse-result', handleOpenMcpResult)
    window.addEventListener('open-guidelines', handleOpenGuidelines)
    window.addEventListener('open-marketplace', handleOpenMarketplace)
    return () => {
      window.removeEventListener('open-distill-result', handleOpenDistillResult)
      window.removeEventListener('open-mcp-parse-result', handleOpenMcpResult)
      window.removeEventListener('open-guidelines', handleOpenGuidelines)
      window.removeEventListener('open-marketplace', handleOpenMarketplace)
    }
  }, [])

  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const showHome = useStore((s) => s.showHome)
  const terminalBoardMode = useStore((s) => s.terminalBoardMode)
  const sessions = useStore((s) => s.sessions)
  const activeSessionForComposer = activeSessionId ? sessions[activeSessionId] : null
  const composerTargetSessionId = activeSessionForComposer?.read_only && activeSessionForComposer?.annotation_target_session_id
    ? activeSessionForComposer.annotation_target_session_id
    : activeSessionId
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const viewMode = useStore((s) => s.viewMode)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const workspaces = useStore((s) => s.workspaces)
  const tabScope = useStore((s) => s.tabScope)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const currentAuth = useStore((s) => s.currentAuth)
  const viewingSubagent = useStore((s) => s.viewingSubagent)
  const gridAdjustMode = useStore((s) => s.gridAdjustMode)
  const overviewMode = useStore((s) => s.overviewMode)
  const terminalDrawer = useStore((s) => s.terminalDrawer)
  // Board ⇄ Session level lives in the store so the sidebar, breadcrumb and
  // shortcuts share it (see store.goBoard / goSession, lib/route.js).
  const gridFocus = useStore((s) => s.sessionFocus)
  const setGridFocus = useStore((s) => s.setSessionFocus)
  const view = useView()
  // URL hash ⇄ store: #home, #board, #session-<id>; Back/Forward and deep links.
  useEffect(() => installRouter(useStore), [])
  // Mirrors anyModalOpen (computed further down) for callbacks defined here.
  const anyModalOpenRef = useRef(false)
  const focusGridSession = (id) => {
    if (!id) return
    useStore.getState().goSession(id)
    // Give the terminal the keyboard once the session is laid out, but
    // never take it from an open modal (e.g. DocsPanel creating a session).
    setTimeout(() => { if (!anyModalOpenRef.current) window.dispatchEvent(new Event('cc-focus-terminal')) }, 120)
  }
  const leaveGridFocus = () => useStore.getState().goBoard()
  // One place that hands the keyboard back to the selected session's terminal
  // once something took it away: a modal closed, another session was selected
  // (sidebar card, tab shortcut), the level changed. Waits two frames for
  // layout and for a modal's own focus restore, then leaves text fields, open
  // dialogs and menus alone.
  const restoreTerminalFocus = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (anyModalOpenRef.current) return
      const state = useStore.getState()
      if (state.showHome || !state.activeSessionId) return
      if (!canRestoreTerminalFocus(document.activeElement)) return
      window.dispatchEvent(new Event('cc-focus-terminal'))
    }))
  }, [])
  useEffect(() => { restoreTerminalFocus() }, [activeSessionId, gridFocus, showHome])
  // Back to the overview (from any path: button, Escape, ⌘⇧E, breadcrumb):
  // keep the session the user was just working in on screen, it may be the
  // last cell far below the fold.
  const wasGridFocus = useRef(gridFocus)
  useEffect(() => {
    const left = wasGridFocus.current && !gridFocus
    wasGridFocus.current = gridFocus
    if (!left) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const id = useStore.getState().activeSessionId
      if (!id) return
      const cell = document.querySelector(`[data-session-view="${CSS.escape(id)}"], [data-grid-cell-session="${CSS.escape(id)}"]`)
      cell?.scrollIntoView?.({ block: 'nearest' })
    }))
  }, [gridFocus])
  // Opening a session (new or existing, from any entry point) shows it large
  // and focused. Previously it became one more 380px cell at the end of the
  // overview grid, often below the fold, while keyboard focus stayed elsewhere.
  const terminalFocusRequest = useStore((s) => s.terminalFocusRequest)
  useEffect(() => {
    if (!terminalFocusRequest?.id) return
    focusGridSession(terminalFocusRequest.id)
  }, [terminalFocusRequest?.seq])
  useEffect(() => {
    if (!openTabs.includes(activeSessionId)) setGridFocus(false)
  }, [openTabs, activeSessionId])
  const newSessionWorkspaceId = useStore((s) => s.newSessionWorkspaceId)
  const quickStartOpen = useStore((s) => s.quickStartOpen)
  // Which workspace is "Quick sessions" (sidebar label, header actions).
  useEffect(() => { loadQuickStart().catch(() => {}) }, [])
  const aiControlWorkspaceId = activeSessionForComposer?.workspace_id || activeWorkspaceId || workspaces[0]?.id || null

  // Below 768px the layout clamps to a single terminal — grid / split / custom
  // templates are unusable on phone-width screens. Declared here (not in the
  // mobile-state block below) so it can gate `effectiveViewMode`.
  const isMobile = useMediaQuery('(max-width: 767px)')
  // Cost figures for the sidebar foot and the cards, the catch-up badge and
  // the task attention counter (Board badge) live once, here.
  useCostPoll({ enabled: !isMobile })
  const catchUp = useCatchUp()
  const taskAttention = useTaskAttention({ enabled: !isMobile })

  const effectiveViewMode = isMobile ? 'tabs' : 'grid'
  const effectiveGridTemplateId = isMobile ? null : activeGridTemplateId
  // ── Custom template: never lose a new session ──────────────────────────
  // A template only renders its cells, so a session created or opened while
  // one is active used to be invisible. It now takes the first free cell;
  // when every cell is taken it opens at Session level (rendered as an extra
  // full-size layer of the template) with a notice, and the overview toolbar
  // lists it until it is dragged into a cell or closed.
  const [templateOverflow, setTemplateOverflow] = useState([])
  const overflowNotifiedRef = useRef(new Set())
  const activeTemplate = effectiveGridTemplateId ? gridTemplates.find((template) => template.id === effectiveGridTemplateId) : null
  const templateAssigned = new Set(Object.values(activeTemplate?.cell_assignments || {}))
  const inTabScope = (id) => sessions[id] && (tabScope !== 'workspace' || !activeWorkspaceId || sessions[id].workspace_id === activeWorkspaceId)
  const templateOverflowIds = activeTemplate
    ? templateOverflow.filter((id) => openTabs.includes(id) && !templateAssigned.has(id) && inTabScope(id))
    : []
  const placeInTemplate = (ids, { focus = false } = {}) => {
    const store = useStore.getState()
    const tpl = store.gridTemplates.find((t) => t.id === effectiveGridTemplateId)
    if (!tpl) return
    const assignments = { ...(tpl.cell_assignments || {}) }
    const cells = [...(tpl.cells || [])].sort((a, b) => (a.row || 1) - (b.row || 1) || (a.col || 1) - (b.col || 1))
    const overflow = []
    for (const id of ids) {
      if (!store.sessions[id] || Object.values(assignments).includes(id)) continue
      if (overflowNotifiedRef.current.has(id)) {
        if (focus && store.activeSessionId === id) store.goSession(id)
        continue
      }
      const free = cells.find((c) => !assignments[c.id] || !store.sessions[assignments[c.id]] || !store.openTabs.includes(assignments[c.id]))
      if (free) {
        assignments[free.id] = id
        store.assignSessionToCell(tpl.id, free.id, id)
      } else {
        overflow.push(id)
        overflowNotifiedRef.current.add(id)
      }
    }
    if (!overflow.length) return
    setTemplateOverflow((prev) => [...new Set([...prev, ...overflow])])
    const names = overflow.map((id) => store.sessions[id]?.name || 'Session').join(', ')
    store.addNotification({
      type: 'info',
      message: `All ${cells.length} cells of "${tpl.name}" are in use, so ${names} opened full size. Drag it onto a cell to keep it in the overview.`,
    })
    if (focus && overflow.includes(store.activeSessionId)) store.goSession(store.activeSessionId)
  }
  const prevOpenTabsRef = useRef(openTabs)
  useEffect(() => {
    const prev = prevOpenTabsRef.current
    prevOpenTabsRef.current = openTabs
    if (!effectiveGridTemplateId) return
    const added = openTabs.filter((id) => !prev.includes(id))
    // Single opens only: bulk changes (tab groups, restores) keep the layout.
    if (added.length === 1) placeInTemplate(added, { focus: true })
  }, [openTabs, effectiveGridTemplateId])
  // Re-opening a tab that is open but has no cell (e.g. from the sidebar).
  const placeRequest = useStore((s) => s.terminalFocusRequest)
  useEffect(() => {
    const id = placeRequest?.id
    if (!id || !effectiveGridTemplateId || templateAssigned.has(id)) return
    placeInTemplate([id], { focus: true })
  }, [placeRequest?.seq])
  useEffect(() => { setTemplateOverflow([]); overflowNotifiedRef.current = new Set() }, [effectiveGridTemplateId])
  useEffect(() => {
    // Forget sessions that got a cell or were closed, so a later open notifies again.
    for (const id of overflowNotifiedRef.current) {
      if (!openTabs.includes(id) || templateAssigned.has(id)) overflowNotifiedRef.current.delete(id)
    }
  }, [openTabs, activeTemplate?.cell_assignments])

  // Refit all terminals when the level, layout or sidebar changes. Fires at
  // 80 ms for layout-only changes and again at 350/700 ms as a safety net
  // for transitions where layout needs longer to settle.
  useEffect(() => {
    let cancelled = false
    const refit = () => window.dispatchEvent(new Event('cc-terminal-refit'))
    requestAnimationFrame(() => {
      if (cancelled) return
      refit()
      setTimeout(() => { if (!cancelled) refit() }, 80)
      setTimeout(() => { if (!cancelled) refit() }, 350)
      setTimeout(() => { if (!cancelled) refit() }, 700)
    })
    return () => { cancelled = true }
  }, [viewMode, view, openTabs.length, activeWorkspaceId, activeSessionId, gridLayout, activeGridTemplateId, showHome, terminalBoardMode, overviewMode, sidebarVisible])

  const [showCommand, setShowCommand] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [showCheatSheet, setShowCheatSheet] = useState(false)
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false)
  const [showSideChat, setShowSideChat] = useState(false)
  const [sideChatSessionId, setSideChatSessionId] = useState(null)
  const [sideChatRequest, setSideChatRequest] = useState(null)
  useEffect(() => {
    const ask = (event) => {
      if (!OWNER_ACTORS.includes(currentAuth?.actor_kind)) return
      const { sessionId, question = '' } = event.detail || {}
      if (!sessionId || !useStore.getState().sessions[sessionId]) return
      setSideChatSessionId(sessionId)
      setSideChatRequest({ id: crypto.randomUUID(), question })
      setShowSideChat(true)
    }
    window.addEventListener('ask-session-aside', ask)
    return () => window.removeEventListener('ask-session-aside', ask)
  }, [currentAuth?.actor_kind])
  // "Chat with Claude": the plain chat next to the sessions, from the app bar,
  // Home, quick help or ⌘⇧J. Owner-only like the panel itself.
  useEffect(() => {
    const toggle = () => setShowSideChat((value) => !value)
    window.addEventListener('toggle-side-chat', toggle)
    return () => window.removeEventListener('toggle-side-chat', toggle)
  }, [])
  const [taskFlow, setTaskFlow] = useState(null)
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState('')
  const [showPrompts, setShowPrompts] = useState(false)
  const [promptsStartCreate, setPromptsStartCreate] = useState(false)
  const [showGuidelines, setShowGuidelines] = useState(false)
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showMission, setShowMission] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showInbox, setShowInbox] = useState(false)
  const [showAttention, setShowAttention] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [showBoard, setShowBoard] = useState(false)
  const [boardInitialAction, setBoardInitialAction] = useState(null)
  const [showPipelineEditor, setShowPipelineEditor] = useState(false)
  const [showTree, setShowTree] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showCapabilities, setShowCapabilities] = useState(false)
  const [showResearchHub, setShowResearchHub] = useState(false)
  const [researchHubTab, setResearchHubTab] = useState('library')
  const [showDiscoveryHub, setShowDiscoveryHub] = useState(false)
  const [discoveryHubTab, setDiscoveryHubTab] = useState('inbox')
  const [showGovernance, setShowGovernance] = useState(false)
  const [governanceInitialTab, setGovernanceInitialTab] = useState('directory')
  const [visionOnboardingFor, setVisionOnboardingFor] = useState(null)
  const [showDocs, setShowDocs] = useState(false)
  const [showKnowledge, setShowKnowledge] = useState(false)
  const [showCodeCatalog, setShowCodeCatalog] = useState(false)
  const [showSecure, setShowSecure] = useState(false)
  const [showAgentSystems, setShowAgentSystems] = useState(false)
  const [showPeerMessages, setShowPeerMessages] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [memoryInitialTab, setMemoryInitialTab] = useState('entries')
  const [showSessionSidebar, setShowSessionSidebar] = useState(false)
  const [sessionSidebarTab, setSessionSidebarTab] = useState('files')
  const [showComposer, setShowComposer] = useState(false)
  const [showPreviewPalette, setShowPreviewPalette] = useState(false)
  const [livePreviewUrl, setLivePreviewUrl] = useState(null)
  const [livePreviewTaskId, setLivePreviewTaskId] = useState(null)
  const [showMarketplace, setShowMarketplace] = useState(false)
  const [marketplaceTab, setMarketplaceTab] = useState(null)
  const [marketplaceSuggestedSkills, setMarketplaceSuggestedSkills] = useState(null)
  const [showQuickActionPalette, setShowQuickActionPalette] = useState(false)
  const [settingsSection, setSettingsSection] = useState(null)
  const [showGlobalLogs, setShowGlobalLogs] = useState(false)
  // Discovery owns passive Observatory signal; ResearchHub owns user-initiated research.
  const [promptsStartTab, setPromptsStartTab] = useState('prompts')
  const [sharingInitialTab, setSharingInitialTab] = useState('online')
  const [wsSettingsInitialId, setWsSettingsInitialId] = useState(null)
  const [showAnnotator, setShowAnnotator] = useState(false)
  const [showDistill, setShowDistill] = useState(false)
  const [distillInitial, setDistillInitial] = useState(null) // { result, artifactType }
  const [showQuickFeature, setShowQuickFeature] = useState(false)
  const [quickFeaturePrefill, setQuickFeaturePrefill] = useState('')
  const [quickFeatureVoice, setQuickFeatureVoice] = useState(false)
  const [quickFeatureWorkspaceId, setQuickFeatureWorkspaceId] = useState(null)
  // The file the review opened with (openReviewForActiveSession(file)).
  const [reviewInitialFile, setReviewInitialFile] = useState(null)
  const [composerDraft, setComposerDraft] = useState('') // pre-filled from annotator
  const [screenshotData, setScreenshotData] = useState(null) // { imageUrl, sourceUrl }

  // ── Mobile responsive state ───────────────────────────────────
  // `isMobile` itself is declared earlier (it gates layout decisions); only
  // mobile-only UI state lives here. Below 768px the sidebar collapses behind
  // a hamburger button into a slide-in drawer.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  // Phones: the drawer is the session's Terminal view (Chat ⇄ Terminal in
  // the phone header), remembered across visits. Chat is the default.
  const [isTerminalOpen, setIsTerminalOpen] = useState(() => {
    try { return window.matchMedia('(max-width: 767px)').matches && localStorage.getItem('ive-phone-view') === 'terminal' } catch { return false }
  })
  useEffect(() => {
    if (!isMobile) return
    try { localStorage.setItem('ive-phone-view', isTerminalOpen ? 'terminal' : 'chat') } catch { /* private mode */ }
  }, [isMobile, isTerminalOpen])
  useEffect(() => {
    const openTerminal = event => {
      if (isMobile && event.detail?.sessionId === useStore.getState().activeSessionId) setIsTerminalOpen(true)
    }
    window.addEventListener('ive-open-session-terminal', openTerminal)
    return () => window.removeEventListener('ive-open-session-terminal', openTerminal)
  }, [isMobile])
  // Phone home is the session list; "Home" there opens the full Home page.
  const [phoneFullHome, setPhoneFullHome] = useState(false)
  const phoneHomeLevel = isMobile && (showHome || openTabs.length === 0)
  const phoneSession = isMobile && !phoneHomeLevel
  const phoneOverview = phoneHomeLevel && !phoneFullHome
  useEffect(() => { if (phoneSession) setPhoneFullHome(false) }, [phoneSession])

  // Dispatches refit events to xterm.js layout containers when the drawer expands/collapses
  useEffect(() => {
    const refit = () => window.dispatchEvent(new Event('cc-terminal-refit'))
    refit()
    const t = setTimeout(refit, 150)
    const t2 = setTimeout(refit, 350)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
    }
  }, [isTerminalOpen])
  // Auto-close drawer when leaving mobile breakpoint to avoid stuck-open state
  useEffect(() => { if (!isMobile && mobileDrawerOpen) setMobileDrawerOpen(false) }, [isMobile, mobileDrawerOpen])
  // Auto-close drawer on session change (tap a session in drawer → drawer closes)
  useEffect(() => { if (isMobile) setMobileDrawerOpen(false) }, [activeSessionId, isMobile])
  useEffect(() => {
    const openWorkspaceForm = (event) => {
      setWorkspaceSearchQuery(event.detail?.query || '')
      setShowWorkspacePicker(true)
    }
    window.addEventListener('open-add-workspace', openWorkspaceForm)
    return () => window.removeEventListener('open-add-workspace', openWorkspaceForm)
  }, [])

  // Close all exclusive modal/overlay panels. Called before opening a new panel
  // to enforce mutual exclusion — only one overlay at a time. Inline panels
  // and the unified session sidebar are excluded since they coexist with modals.
  const closeExclusivePanels = useCallback(() => {
    setTaskFlow(null)
    setShowWorkspacePicker(false)
    setShowCommand(false); setCommandQuery('')
    setShowCheatSheet(false)
    setShowPrompts(false); setPromptsStartCreate(false); setPromptsStartTab('prompts')
    setShowGuidelines(false)
    setShowBroadcast(false)
    setShowSearch(false)
    setShowMission(false)
    setShowHistory(false)
    setShowInbox(false)
    setShowAttention(false)
    setShowPlan(false)
    setShowBoard(false)
    setShowPipelineEditor(false)
    setShowTree(false)
    setShowTemplates(false)
    setShowCapabilities(false)
    setShowResearchHub(false)
    setShowDiscoveryHub(false)
    setShowGovernance(false)
    setShowDocs(false)
    setShowKnowledge(false)
    setShowCodeCatalog(false)
    setShowSecure(false)
    setShowAgentSystems(false)
    setShowPeerMessages(false)
    setShowMemory(false)
    setShowMarketplace(false); setMarketplaceTab(null); setMarketplaceSuggestedSkills(null)
    setShowQuickActionPalette(false)
    setSettingsSection(null)
    setShowGlobalLogs(false)
    setShowDistill(false); setDistillInitial(null)
    setShowAnnotator(false)
    setShowPreviewPalette(false)
    setShowQuickFeature(false); setQuickFeaturePrefill(''); setQuickFeatureVoice(false)
  }, [])

  const openSessionSidebarTab = useCallback((tab, { toggle = false } = {}) => {
    if (toggle && showSessionSidebar && sessionSidebarTab === tab) {
      setShowSessionSidebar(false)
      return
    }
    setSessionSidebarTab(tab)
    setShowSessionSidebar(true)
  }, [showSessionSidebar, sessionSidebarTab])

  // Review is a session-level surface: from Home or the Board it opens the
  // active session first (D.1). `file` preselects a file in the review tab.
  const openReviewForActiveSession = useCallback((file = null) => {
    const store = useStore.getState()
    const session = store.sessions[store.activeSessionId]
    setReviewInitialFile(typeof file === 'string' ? file : null)
    if (store.activeSessionId && viewOf(store) !== 'session') store.goSession(store.activeSessionId)
    let sessionTags = session?.tags || []
    if (typeof sessionTags === 'string') {
      try { sessionTags = JSON.parse(sessionTags || '[]') } catch { sessionTags = [] }
    }
    if (Array.isArray(sessionTags) && sessionTags.includes('capability_documentation')) {
      closeExclusivePanels()
      setShowDocs(true)
      return
    }
    // Always open the sidebar review tab first. If the user's last preference
    // was 'fullscreen', the sidebar listens for this event and enters its
    // (portaled) fullscreen view automatically.
    openSessionSidebarTab('review')
    const mode = (() => {
      try { return localStorage.getItem('code_review_open_mode') } catch { return null }
    })()
    if (mode === 'fullscreen') {
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('code-review:enter-fullscreen'))
      )
    }
  }, [closeExclusivePanels, openSessionSidebarTab])

  // panelActions is declared further down; the open-panel listener below
  // reaches the current one through this ref instead of a stale closure.
  const panelActionsRef = useRef(null)

  // Listen for custom events from sidebar buttons and notifications. Kept
  // below state declarations so toggles use the current sidebar tab/open state.
  useEffect(() => {
    const showGuide = () => {
      closeExclusivePanels()
      setMobileDrawerOpen(false)
      onboarding.show()
    }
    window.addEventListener('open-onboarding', showGuide)
    return () => window.removeEventListener('open-onboarding', showGuide)
  }, [closeExclusivePanels, onboarding.show])

  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail
      const panel = typeof detail === 'string' ? detail : detail?.panel
      if (!isSurfaceAvailable(panel)) return
      const requestedTab = typeof detail === 'object' ? detail?.tab : null
      if (panel === 'files') {
        openSessionSidebarTab('files', { toggle: true })
        return
      }
      if (panel === 'scratchpad') {
        openSessionSidebarTab('scratchpad', { toggle: true })
        return
      }
      if (panel === 'code-review') {
        openReviewForActiveSession()
        return
      }
      if (panel === 'toggle-terminal' || panel === 'theme-toggle' || panel === 'brainstorm' || panel === 'review') {
        panelActionsRef.current?.(panel)
        return
      }
      closeExclusivePanels()
      if (panel === 'home') useStore.getState().goHome()
      if (panel === 'board') useStore.getState().goBoard()
      if (panel === 'catch-up') { setCatchupSeed(null); setCatchupOpen(true) }
      if (panel === 'sessions') {
        useStore.getState().setActiveNavGroup('work')
        useStore.setState({ showHome: !useStore.getState().activeSessionId })
      }
      if (panel === 'feature-board') {
        setBoardInitialAction(typeof detail === 'object' ? detail?.boardAction || null : null)
        setShowBoard(true)
      }
      if (panel === 'observatory' || panel === 'discovery') { setDiscoveryHubTab('inbox'); setShowDiscoveryHub(true) }
      if (panel === 'apis-integrations' || panel === 'alloy') setSettingsSection('apis-integrations')
      if (panel === 'app-directory') { setGovernanceInitialTab('directory'); setShowGovernance(true) }
      if (panel === 'morning-digest') { setGovernanceInitialTab('digest'); setShowGovernance(true) }
      if (panel === 'smart-observatory' || panel === 'discovery-setup') { setDiscoveryHubTab('setup'); setShowDiscoveryHub(true) }
      if (panel === 'discovery-insights') { setDiscoveryHubTab('insights'); setShowDiscoveryHub(true) }
      if (panel === 'pipeline-editor') setShowPipelineEditor(true)
      if (panel === 'briefing') { setCatchupSeed(null); setCatchupOpen(true) }
      if (panel === 'cost') setShowCost(true)
      if (panel === 'import-history') setShowHistory(true)
      if (panel === 'quick-feature') { setQuickFeaturePrefill(''); setQuickFeatureWorkspaceId(null); setQuickFeatureVoice(false); setShowQuickFeature(true) }
      if (panel === 'activity-audit' || panel === 'global-logs' || panel === 'logs') setShowGlobalLogs(true)
      if (panel === 'agent-tree') setShowTree(true)
      if (panel === 'research') { setResearchHubTab('new'); setShowResearchHub(true) }
      if (panel === 'research-active') { setResearchHubTab('active'); setShowResearchHub(true) }
      if (panel === 'research-library') { setResearchHubTab('library'); setShowResearchHub(true) }
      if (panel === 'docs-panel') setShowDocs(true)
      if (panel === 'knowledge') { setMemoryInitialTab('knowledge'); setShowMemory(true) }
      if (panel === 'code-catalog') setShowCodeCatalog(true)
      if (panel === 'secure') setShowSecure(true)
      if (panel === 'agent-systems') setShowAgentSystems(true)
      if (panel === 'peer-messages') setShowPeerMessages(true)
      if (panel === 'memory') { setMemoryInitialTab('entries'); setShowMemory(true) }
      if (panel === 'memory-search') { setMemoryInitialTab('search'); setShowMemory(true) }
      if (panel === 'annotate') setShowAnnotator(true)
      if (panel === 'grid-templates') setSettingsSection('grid-templates')
      if (panel === 'manage-templates' || panel === 'templates') setShowTemplates(true)
      if (panel === 'command-palette') setShowCommand(true)
      if (panel === 'guidelines') setShowGuidelines(true)
      if (panel === 'mcp-servers') setSettingsSection('mcp-servers')
      if (panel === 'inbox') setShowInbox(true)
      if (panel === 'mission-control') setShowMission(true)
      if (panel === 'marketplace') setShowMarketplace(true)
      if (panel === 'skills-library') { setMarketplaceTab('skills'); setShowMarketplace(true) }
      if (panel === 'connectors') setSettingsSection('connectors')
      if (panel === 'accounts') setSettingsSection('accounts')
      if (panel === 'config-viewer') setSettingsSection('config-viewer')
      if (panel === 'capabilities') setShowCapabilities(true)
      if (panel === 'shortcuts') setSettingsSection('shortcuts')
      if (panel === 'prompt-library') { setPromptsStartCreate(false); setPromptsStartTab('prompts'); setShowPrompts(true) }
      if (panel === 'cascades') { setPromptsStartCreate(false); setPromptsStartTab('cascades'); setShowPrompts(true) }
      if (panel === 'general-settings') setSettingsSection('general-settings')
      if (panel === 'mac-power') setSettingsSection('mac-power')
      if (panel === 'model-providers') setSettingsSection('model-providers')
      if (panel === 'sound-settings') setSettingsSection('sound-settings')
      if (panel === 'workspace-settings') { setWsSettingsInitialId(useStore.getState().activeWorkspaceId); setSettingsSection('workspace-settings') }
      if (panel === 'experimental') setSettingsSection('experimental')
      if (panel === 'safety') setSettingsSection('safety')
      if (panel === 'api-keys') setSettingsSection('api-keys')
      if (panel === 'phone-access') setSettingsSection('phone-access')
      if (panel === 'sharing' || panel === 'multiplayer-share' || panel === 'invites' || panel === 'auth-sessions' || panel === 'runtime-controls') {
        setSharingInitialTab(requestedTab || (panel === 'invites' ? 'invites' : panel === 'auth-sessions' ? 'sessions' : 'online'))
        setSettingsSection('sharing')
      }
      if (panel === 'prompts') setShowPrompts(true)
      if (panel === 'search') setShowSearch(true)
    }
    const wsSettingsHandler = (e) => {
      closeExclusivePanels()
      setWsSettingsInitialId(e.detail?.workspaceId || null)
      setSettingsSection('workspace-settings')
    }
    const planHandler = () => { closeExclusivePanels(); setShowPlan(true) }
    const quickFeatureHandler = (e) => {
      closeExclusivePanels()
      setQuickFeaturePrefill(e.detail?.text || '')
      setQuickFeatureVoice(false)
      setShowQuickFeature(true)
    }
    const livePreviewHandler = (e) => {
      closeExclusivePanels()
      setLivePreviewUrl(e.detail?.url || '')
      setLivePreviewTaskId(e.detail?.taskId || null)
    }
    const memoryConflictHandler = (e) => {
      closeExclusivePanels()
      setWsSettingsInitialId(e.detail?.workspaceId || null)
      setSettingsSection('workspace-settings')
    }
    window.addEventListener('open-panel', handler)
    window.addEventListener('open-plan-viewer', planHandler)
    window.addEventListener('open-quick-feature', quickFeatureHandler)
    window.addEventListener('open-live-preview', livePreviewHandler)
    window.addEventListener('open-workspace-settings', wsSettingsHandler)
    window.addEventListener('open-memory-conflict', memoryConflictHandler)
    return () => {
      window.removeEventListener('open-panel', handler)
      window.removeEventListener('open-plan-viewer', planHandler)
      window.removeEventListener('open-quick-feature', quickFeatureHandler)
      window.removeEventListener('open-live-preview', livePreviewHandler)
      window.removeEventListener('open-workspace-settings', wsSettingsHandler)
      window.removeEventListener('open-memory-conflict', memoryConflictHandler)
    }
  }, [closeExclusivePanels, openReviewForActiveSession, openSessionSidebarTab])

  // Global Escape to close any open panel.
  // Uses capture phase so the event fires before xterm.js or other element
  // handlers can swallow it. stopPropagation prevents the Escape from also
  // reaching the terminal after closing a panel.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (useSessionDelete.getState().request || useSessionRename.getState().request) return
      if (document.querySelector('[data-ive-onboarding][aria-modal="true"], [data-ive-onboarding] [aria-modal="true"]')) return
      // An open menu or popover closes itself on Escape (useEscapeToClose);
      // it must not also close a panel or leave the Session level.
      if (document.querySelector('[data-ive-popover]')) return
      if (taskFlow) return // The active task modal owns Escape and pending writes.
      // Text fields keep their local Escape behavior. A focused terminal in
      // the Session view also uses Escape to return to the Board.
      const typingTarget = e.target?.closest?.('.xterm, input, textarea, select, [contenteditable="true"], [data-ive-popover]')
      // Panels that sit next to the terminal (third entry = true) never take
      // an Escape typed into it: it would close the panel and the agent would
      // miss its interrupt. Real modals pull focus out of the terminal.
      const inTerminal = !!e.target?.closest?.('.xterm')
      // Ordered by priority: layered panels first, then exclusive panels, then inline
      const escapeStack = [
        [showCheatSheet, () => setShowCheatSheet(false)],
        [showWorkspacePicker, () => setShowWorkspacePicker(false)],
        // The start-folder field inside the quick start cancels its own edit.
        [quickStartOpen && !e.target?.closest?.('[data-quick-start-root]'), () => useStore.setState({ quickStartOpen: false })],
        [newSessionWorkspaceId, () => useStore.setState({ newSessionWorkspaceId: null })],
        [gridAdjustMode, () => useStore.getState().setGridAdjustMode(false), true],
        [showDistill, () => { setShowDistill(false); setDistillInitial(null) }],
        [showQuickFeature, () => { setShowQuickFeature(false); setQuickFeaturePrefill(''); setQuickFeatureVoice(false) }],
        [showAnnotator, () => setShowAnnotator(false)],
        [screenshotData, () => setScreenshotData(null)],
        [livePreviewUrl, () => setLivePreviewUrl(null)],
        [showPreviewPalette, () => setShowPreviewPalette(false)],
        [showCommand, () => setShowCommand(false)],
        [showPrompts, () => { setShowPrompts(false); setPromptsStartCreate(false); setPromptsStartTab('prompts') }],
        [showGuidelines, () => setShowGuidelines(false)],
        [showBroadcast, () => setShowBroadcast(false)],
        [showSearch, () => setShowSearch(false)],
        [showMission, () => setShowMission(false)],
        [showHistory, () => setShowHistory(false)],
        [showInbox, () => setShowInbox(false)],
        [showAttention, () => setShowAttention(false)],
        [showPlan, () => setShowPlan(false)],
        // FeatureBoard owns Escape while mounted so inline edit/composer/detail
        // layers can cancel (and protect dirty text) before the board closes.
        [showPipelineEditor, () => setShowPipelineEditor(false)],
        [showTree, () => setShowTree(false)],
        [showSessionSidebar, () => setShowSessionSidebar(false), true],
        [showTemplates, () => setShowTemplates(false)],
        [showCapabilities, () => setShowCapabilities(false)],
        [showResearchHub, () => setShowResearchHub(false)],
        [showDiscoveryHub, () => setShowDiscoveryHub(false)],
        [showGovernance, () => setShowGovernance(false)],
        [showDocs, () => setShowDocs(false)],
        [showKnowledge, () => setShowKnowledge(false)],
        [showCodeCatalog, () => setShowCodeCatalog(false)],
        [showSecure, () => setShowSecure(false)],
        [showAgentSystems, () => setShowAgentSystems(false)],
        [showPeerMessages, () => setShowPeerMessages(false)],
        [showMemory, () => setShowMemory(false)],
        [showMarketplace, () => { setShowMarketplace(false); setMarketplaceTab(null) }],
        [showQuickActionPalette, () => setShowQuickActionPalette(false)],
        [settingsSection, () => setSettingsSection(null)],
        [showGlobalLogs, () => setShowGlobalLogs(false)],
        // With chrome focus, close the drawer first. From inside the terminal,
        // Escape goes straight back to the Board below.
        [view === 'session' && !!terminalDrawer[activeSessionId] && !typingTarget, () => useStore.getState().toggleTerminalDrawer(activeSessionId, false)],
        // Session → Board, including when the enlarged terminal has focus.
        // Consume the key here so it cannot also interrupt the running CLI.
        [gridFocus && !useStore.getState().showHome && (!typingTarget || inTerminal), leaveGridFocus],
      ]
      for (const [isOpen, close, nonModal] of escapeStack) {
        if (isOpen && !(nonModal && inTerminal)) { e.preventDefault(); e.stopPropagation(); close(); return }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showCheatSheet, taskFlow, gridFocus, showHome, view, activeSessionId, terminalDrawer, showWorkspacePicker, quickStartOpen, newSessionWorkspaceId, gridAdjustMode, showDistill, showQuickFeature, showAnnotator, screenshotData, livePreviewUrl, showPreviewPalette, showCommand, showPrompts, showGuidelines, showBroadcast, showSearch, showMission, showHistory, showInbox, showAttention, showPlan, showBoard, showPipelineEditor, showTree, showSessionSidebar, showTemplates, showCapabilities, showResearchHub, showDiscoveryHub, showGovernance, showDocs, showKnowledge, showCodeCatalog, showSecure, showAgentSystems, showPeerMessages, showMemory, showMarketplace, showQuickActionPalette, settingsSection, showGlobalLogs])

  // When a modal overlay opens, pull focus away from the terminal so that
  // keyboard events (arrows, Enter, etc.) reach panel handlers instead of
  // being consumed by xterm.js.
  const deletingSession = useSessionDelete((state) => !!state.request)
  const renamingSession = useSessionRename((state) => !!state.request)
  const anyModalOpen = deletingSession || renamingSession || onboarding.open || showCheatSheet || !!taskFlow || showWorkspacePicker || quickStartOpen || !!newSessionWorkspaceId || showDistill || showQuickFeature || showAnnotator || showCommand || showPrompts || showGuidelines || showBroadcast || showSearch || showMission || showHistory || showInbox || showAttention || showPlan || showBoard || showPipelineEditor || showTree || showTemplates || showCapabilities || showResearchHub || showDiscoveryHub || showGovernance || showDocs || showKnowledge || showCodeCatalog || showSecure || showAgentSystems || showPeerMessages || showMemory || showPreviewPalette || !!livePreviewUrl || showMarketplace || showQuickActionPalette || !!settingsSection || showGlobalLogs || !!screenshotData
  anyModalOpenRef.current = anyModalOpen
  useEffect(() => {
    if (anyModalOpen) {
      const active = document.activeElement
      if (active && active.closest('.xterm')) {
        active.blur()
      }
    } else {
      restoreTerminalFocus()
    }
  }, [anyModalOpen])
  const activePlan = useStore((s) => s.activePlan)
  const planFilePaths = useStore((s) => s.planFilePaths)
  const planWaiting = useStore((s) => s.planWaiting)
  useKeyboard({
    onCommandPalette: () => { closeExclusivePanels(); setShowCommand(true) },
    // The IA launcher is gone; a custom binding opens the palette instead.
    onNavigationLauncher: () => openCommandPalette(''),
    onPromptPalette: () => { closeExclusivePanels(); setShowPrompts(true) },
    onGuidelinePanel: () => { closeExclusivePanels(); setShowGuidelines(true) },
    onMcpServers: () => { closeExclusivePanels(); setSettingsSection('mcp-servers') },
    onBroadcast: () => { closeExclusivePanels(); setShowBroadcast(true) },
    onSearch: () => { closeExclusivePanels(); setShowSearch(true) },
    onMissionControl: () => { closeExclusivePanels(); setShowMission(true) },
    onInbox: () => { closeExclusivePanels(); setShowInbox(true) },
    onFeatureBoard: () => { closeExclusivePanels(); setBoardInitialAction(null); setShowBoard(true) },
    onPipelineEditor: () => { if (!isSurfaceAvailable('pipeline-editor')) return; closeExclusivePanels(); setShowPipelineEditor(true) },
    onAgentTree: () => { closeExclusivePanels(); setShowTree(true) },
    onResearch: () => { if (!livePreviewUrl && isSurfaceAvailable('research')) { closeExclusivePanels(); setResearchHubTab('new'); setShowResearchHub(true) } },
    onScratchpad: () => openSessionSidebarTab('scratchpad', { toggle: true }),
    onComposer: () => setShowComposer((s) => !s),
    onShortcuts: () => { closeExclusivePanels(); setSettingsSection('shortcuts') },
    onPreview: () => { closeExclusivePanels(); setShowPreviewPalette(true) },
    onMarketplace: () => { closeExclusivePanels(); setShowMarketplace(true) },
    onQuickActionPalette: () => { closeExclusivePanels(); setShowQuickActionPalette(true) },
    onSkillsLibrary: () => { closeExclusivePanels(); setShowMarketplace(true); setMarketplaceTab('skills') },
    onCodeReview: openReviewForActiveSession,
    onAnnotate: () => { closeExclusivePanels(); setShowAnnotator(true) },
    onQuickFeature: () => { closeExclusivePanels(); setQuickFeaturePrefill(''); setQuickFeatureWorkspaceId(null); setQuickFeatureVoice(false); setShowQuickFeature(true) },
    onObservatory: () => { if (!isSurfaceAvailable('observatory')) return; closeExclusivePanels(); setDiscoveryHubTab('inbox'); setShowDiscoveryHub(true) },
    // ⌘J: the terminal drawer of the open session. From Board/Home it opens
    // the selected session first; on the phone the drawer stays the old one.
    onToggleTerminal: () => {
      const store = useStore.getState()
      if (isMobile) { setIsTerminalOpen((t) => !t); return }
      if (viewOf(store) === 'session') {
        store.toggleTerminalDrawer(store.activeSessionId)
      } else {
        store.goSession()
        const id = useStore.getState().activeSessionId
        if (id) useStore.getState().toggleTerminalDrawer(id, true)
      }
    },
  })

  // Single source of truth for opening panels — used by command palette,
  // home screen, keyboard shortcuts, and sidebar event handlers.
  const panelActions = useCallback((action) => {
    if (!isSurfaceAvailable(action)) return false
    // Levels and inline toggles (not exclusive overlays)
    if (action === 'home') { closeExclusivePanels(); useStore.getState().goHome(); return true }
    if (action === 'board') { closeExclusivePanels(); useStore.getState().goBoard(); return true }
    if (action === 'review') {
      const store = useStore.getState()
      if (!store.activeSessionId) { store.addNotification?.({ type: 'info', message: 'Open a session first.' }); return true }
      closeExclusivePanels()
      openReviewForActiveSession()
      return true
    }
    if (action === 'knowledge') { closeExclusivePanels(); setMemoryInitialTab('knowledge'); setShowMemory(true); return true }
    if (action === 'toggle-terminal') {
      const store = useStore.getState()
      if (isMobile) { setIsTerminalOpen((t) => !t); return true }
      if (viewOf(store) === 'session') store.toggleTerminalDrawer(store.activeSessionId)
      else { store.goSession(); const id = useStore.getState().activeSessionId; if (id) useStore.getState().toggleTerminalDrawer(id, true) }
      return true
    }
    if (action === 'theme-toggle') { toggleTheme(); return true }
    if (action === 'brainstorm') {
      const store = useStore.getState()
      const wsId = store.activeWorkspaceId
      if (!wsId) { store.addNotification?.({ type: 'info', message: 'Open a project first.' }); return true }
      api.getBrainstormer(wsId)
        .then((session) => { if (session?.id) { store.loadSessions([session]); useStore.getState().goSession(session.id) } })
        .catch((err) => store.addNotification?.({ type: 'error', message: `Brainstormer unavailable: ${err?.message || err}` }))
      return true
    }
    if (action === 'sessions') {
      closeExclusivePanels()
      const store = useStore.getState()
      store.setActiveNavGroup('work')
      if (store.workspaces.length === 0) {
        window.dispatchEvent(new CustomEvent('open-add-workspace'))
        store.addNotification?.({ type: 'info', message: 'Add a workspace before starting a session.' })
      } else {
        useStore.setState({ showHome: !store.activeSessionId })
      }
      return true
    }
    if (action === 'files') {
      openSessionSidebarTab('files', { toggle: true })
      return true
    }
    if (action === 'scratchpad') {
      openSessionSidebarTab('scratchpad', { toggle: true })
      return true
    }
    if (action === 'toggle-sidebar') { useStore.setState((s) => ({ sidebarVisible: !s.sidebarVisible })); return true }
    if (action === 'adjust-grid') {
      const mode = useStore.getState().gridAdjustMode
      useStore.getState().setGridAdjustMode(!mode)
      return true
    }
    // Panel openers — close any open panel first
    const panels = {
      'prompt-library': () => { setPromptsStartCreate(false); setShowPrompts(true) },
      'new-prompt': () => { setPromptsStartCreate(true); setShowPrompts(true) },
      'guidelines': () => setShowGuidelines(true),
      'mcp-servers': () => setSettingsSection('mcp-servers'),
      'broadcast': () => setShowBroadcast(true),
      'search': () => setShowSearch(true),
      // Opens once the palette has closed; nothing on screen → all sessions.
      'find-in-session': () => setTimeout(() => { if (!openFindInSession({ activeSessionId: useStore.getState().activeSessionId, showHome: useStore.getState().showHome })) setShowSearch(true) }, 60),
      'mission-control': () => setShowMission(true),
      'import-history': () => setShowHistory(true),
      'inbox': () => setShowInbox(true),
      'briefing': () => { setCatchupSeed(null); setCatchupOpen(true) },
      'catch-up': () => { setCatchupSeed(null); setCatchupOpen(true) },
      'cost': () => setShowCost(true),
      'plan-viewer': () => setShowPlan(true),
      'feature-board': () => { setBoardInitialAction(null); setShowBoard(true) },
      'board-new-card': () => { setBoardInitialAction('new'); setShowBoard(true) },
      'board-needs-attention': () => { setBoardInitialAction('attention'); setShowBoard(true) },
      'board-filter': () => { setBoardInitialAction('filter'); setShowBoard(true) },
      'board-shortcuts': () => { setBoardInitialAction('shortcuts'); setShowBoard(true) },
      'observatory': () => { setDiscoveryHubTab('inbox'); setShowDiscoveryHub(true) },
      'discovery': () => { setDiscoveryHubTab('inbox'); setShowDiscoveryHub(true) },
      'apis-integrations': () => setSettingsSection('apis-integrations'),
      'alloy': () => setSettingsSection('apis-integrations'),
      'app-directory': () => { setGovernanceInitialTab('directory'); setShowGovernance(true) },
      'morning-digest': () => { setGovernanceInitialTab('digest'); setShowGovernance(true) },
      'smart-observatory': () => { setDiscoveryHubTab('setup'); setShowDiscoveryHub(true) },
      'discovery-setup': () => { setDiscoveryHubTab('setup'); setShowDiscoveryHub(true) },
      'discovery-insights': () => { setDiscoveryHubTab('insights'); setShowDiscoveryHub(true) },
      'pipeline-editor': () => setShowPipelineEditor(true),
      'activity-audit': () => setShowGlobalLogs(true),
      'global-logs': () => setShowGlobalLogs(true),
      'agent-tree': () => setShowTree(true),
      'manage-templates': () => setShowTemplates(true),
      'connectors': () => setSettingsSection('connectors'),
      'accounts': () => setSettingsSection('accounts'),
      'config-viewer': () => setSettingsSection('config-viewer'),
      'capabilities': () => setShowCapabilities(true),
      'research': () => { setResearchHubTab('new'); setShowResearchHub(true) },
      'research-active': () => { setResearchHubTab('active'); setShowResearchHub(true) },
      'research-library': () => { setResearchHubTab('library'); setShowResearchHub(true) },
      'docs-panel': () => setShowDocs(true),
      'knowledge': () => { setMemoryInitialTab('knowledge'); setShowMemory(true) },
      'code-catalog': () => setShowCodeCatalog(true),
      'secure': () => setShowSecure(true),
      'agent-systems': () => setShowAgentSystems(true),
      'peer-messages': () => setShowPeerMessages(true),
      'memory': () => { setMemoryInitialTab('entries'); setShowMemory(true) },
      'memory-search': () => { setMemoryInitialTab('search'); setShowMemory(true) },
      'shortcuts': () => setSettingsSection('shortcuts'),
      'command-palette': () => setShowCommand(true),
      'preview': () => setShowPreviewPalette(true),
      'marketplace': () => { setMarketplaceTab(null); setShowMarketplace(true) },
      'quick-actions': () => setShowQuickActionPalette(true),
      'skills-library': () => { setMarketplaceTab('skills'); setShowMarketplace(true) },
      'experimental': () => setSettingsSection('experimental'),
      'safety': () => setSettingsSection('safety'),
      'cascades': () => { setPromptsStartTab('cascades'); setShowPrompts(true) },
      'general-settings': () => setSettingsSection('general-settings'),
      'mac-power': () => setSettingsSection('mac-power'),
      'model-providers': () => setSettingsSection('model-providers'),
      'sound-settings': () => setSettingsSection('sound-settings'),
      'workspace-settings': () => { setWsSettingsInitialId(useStore.getState().activeWorkspaceId); setSettingsSection('workspace-settings') },
      'api-keys': () => setSettingsSection('api-keys'),
      'phone-access': () => setSettingsSection('phone-access'),
      'sharing': () => { setSharingInitialTab('online'); setSettingsSection('sharing') },
      // Legacy aliases — the three split panels were unified into Multiplayer Share.
      'invites': () => { setSharingInitialTab('invites'); setSettingsSection('sharing') },
      'auth-sessions': () => { setSharingInitialTab('sessions'); setSettingsSection('sharing') },
      'runtime-controls': () => { setSharingInitialTab('online'); setSettingsSection('sharing') },
      'add-workspace': () => {
        window.dispatchEvent(new CustomEvent('open-add-workspace'))
      },
      'grid-layout-editor': () => setSettingsSection('grid-templates'),
      'grid-templates': () => setSettingsSection('grid-templates'),
      'workspace-review-graph': () => window.dispatchEvent(new CustomEvent('open-workspace-review-graph')),
      'code-review': openReviewForActiveSession,
      'annotate': () => setShowAnnotator(true),
      'distill-session': () => setShowDistill(true),
      'quick-feature': () => { setQuickFeaturePrefill(''); setQuickFeatureWorkspaceId(null); setQuickFeatureVoice(false); setShowQuickFeature(true) },
    }
    if (panels[action]) { closeExclusivePanels(); panels[action](); return true }
    return false
  }, [closeExclusivePanels, openSessionSidebarTab, openReviewForActiveSession, isMobile])
  panelActionsRef.current = panelActions

  const handleCommandAction = (action) => {
    if (action === 'start-task') { runCheatSheetAction(action); return }
    panelActions(action)
  }

  const executeHomeAction = useCallback((actionId) => {
    if (!isSurfaceAvailable(actionId)) return
    if (panelActions(actionId)) return

    const store = useStore.getState()
    switch (actionId) {
      case 'new-session':
        // Quick start: no workspace needed, the agent finds the project.
        openQuickStart()
        break
      case 'new-session-setup':
        openSessionSetup()
        break
      case 'new-terminal':
        newTerminal().catch((err) => store.addNotification?.({ type: 'error', message: err?.message || 'The terminal could not be opened.' }))
        break
      case 'close-tab':
        if (store.activeSessionId) closeSession(store.activeSessionId)
        break
      case 'stop-session':
        if (store.activeSessionId) store.stopSession(store.activeSessionId)
        break
      case 'restart-session':
        if (store.activeSessionId && ['exited', 'stopped'].includes(store.sessions[store.activeSessionId]?.status))
          store.restartSession(store.activeSessionId)
        break
      case 'clone-session':
        if (store.activeSessionId)
          api.cloneSession(store.activeSessionId).then((s) => store.addSession(s))
        break
      case 'export-session':
        if (store.activeSessionId)
          window.open(`/api/sessions/${store.activeSessionId}/export`, '_blank')
        break
      case 'save-template': {
        const sess = store.sessions[store.activeSessionId]
        if (sess) {
          const tname = prompt('Template name:', `${sess.model} ${sess.permission_mode} ${sess.effort}`)
          if (tname?.trim()) {
            Promise.all([
              api.getSessionGuidelines(sess.id),
              fetch(`/api/sessions/${sess.id}/turns`).then((r) => r.json()),
            ]).then(([guidelines, turns]) => {
              const attached = Array.isArray(guidelines) ? guidelines : guidelines?.guidelines || []
              return api.createTemplate({
                name: tname.trim(), cli_type: sess.cli_type, model: sess.model, permission_mode: sess.permission_mode,
                effort: sess.effort, budget_usd: sess.budget_usd, system_prompt: sess.system_prompt,
                allowed_tools: sess.allowed_tools, guideline_ids: attached.map((g) => g.id),
                conversation_turns: turns || [],
              })
            }).then(() => {
              store.addNotification({ type: 'success', message: `Template saved: ${tname.trim()}` })
            }).catch((error) => {
              store.addNotification({ type: 'error', message: `Template could not be saved: ${error.message}` })
            })
          }
        }
        break
      }
    }
  }, [panelActions])

  const openCommandPalette = useCallback((query = '') => {
    closeExclusivePanels()
    setCommandQuery(query)
    setShowCommand(true)
  }, [closeExclusivePanels])

  // Quick help actions: the everyday tasks, each mapped to the surface that
  // already does it. Nothing new happens here; this only routes.
  const runCheatSheetAction = useCallback((id) => {
    const store = useStore.getState()
    if (id === 'start-task') {
      closeExclusivePanels()
      useStore.setState({ showHome: true })
      setTimeout(() => document.querySelector('[data-home-composer]')?.focus(), 120)
      return
    }
    if (id === 'side-chat') { setShowSideChat(true); return }
    if (id === 'find-session') { openCommandPalette(''); return }
    if (id === 'switch-project') { openCommandPalette('Switch to '); return }
    if (id === 'command-palette') { openCommandPalette(''); return }
    if (id === 'code-review') {
      if (store.activeSessionId) openReviewForActiveSession()
      else { closeExclusivePanels(); setShowInbox(true) }
      return
    }
    if (id === 'toggle-terminal') { panelActions('toggle-terminal'); return }
    closeExclusivePanels()
    executeHomeAction(id)
  }, [closeExclusivePanels, openCommandPalette, openReviewForActiveSession, executeHomeAction, panelActions])

  // `?` opens Quick help from anywhere except while typing; other components
  // ask for it (or for the palette) through window events.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm')) return
      if (anyModalOpen) return
      e.preventDefault()
      setShowCheatSheet(true)
    }
    const openHelp = () => { closeExclusivePanels(); setShowCheatSheet(true) }
    const openPalette = (e) => openCommandPalette(e.detail?.query || '')
    window.addEventListener('keydown', onKey)
    window.addEventListener('open-cheat-sheet', openHelp)
    window.addEventListener('open-command-palette', openPalette)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('open-cheat-sheet', openHelp)
      window.removeEventListener('open-command-palette', openPalette)
    }
  }, [anyModalOpen, closeExclusivePanels, openCommandPalette])

  // ── Where the user is, and what the shell shows there ─────────────────
  const isOwner = OWNER_ACTORS.includes(currentAuth?.actor_kind)
  const sideChatToggle = isOwner ? () => setShowSideChat((value) => !value) : undefined
  // Review and Knowledge are overlays (D.1): the sidebar entry stays current
  // while they are open; Settings, Connectors and Phone follow the same rule.
  const activeOverlay = settingsSection
    ? (['connectors', 'accounts', 'api-keys', 'mcp-servers', 'apis-integrations'].includes(settingsSection) ? 'connectors'
      : settingsSection === 'phone-access' ? 'phone' : 'settings')
    : showMemory ? 'knowledge'
      : (showSessionSidebar && sessionSidebarTab === 'review' && view === 'session') ? 'review'
        : null

  const homeScreen = (
    <HomeScreen
      onPlan={(goal, wsId) => setTaskFlow({ goal, workspaceId: wsId || '' })}
      onAddProject={(q) => { setWorkspaceSearchQuery(q || ''); setShowWorkspacePicker(true) }}
      onFindProject={(q) => { setWorkspaceSearchQuery(q || ''); setShowWorkspacePicker(true) }}
      onOpenPanel={executeHomeAction}
      onOpenSession={(id) => useStore.getState().goSession(id)}
      onReviewTask={(taskId) => setTaskFlow({ taskId })}
    />
  )

  const desktopScreen = view === 'home' ? homeScreen
    : view === 'board' ? (
      <BoardScreen onOpenSession={(id) => focusGridSession(id)} onOpenPanel={executeHomeAction} />
    ) : (
      <SessionScreen
        sessionId={activeSessionId}
        sidebarTab={showSessionSidebar ? sessionSidebarTab : null}
        sidebarFile={reviewInitialFile}
        onSidebarTabChange={setSessionSidebarTab}
        onCloseSidebar={() => setShowSessionSidebar(false)}
        onOpenPanel={executeHomeAction}
        onOpenReview={(file) => openReviewForActiveSession(file)}
      />
    )

  // Phone (≤ 767 px): unchanged behaviour. Sessions stack in tab mode, the
  // chat in front, the terminal as the phone drawer; Home is the session list.
  const mobileSessionArea = (
    <div className="flex-1 flex min-h-0 min-w-0 relative">
      <div
        className="flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('session-id')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
        }}
        onDrop={(e) => {
          const sid = e.dataTransfer.getData('session-id')
          if (sid && sid !== activeSessionId) {
            const store = useStore.getState()
            if (!store.openTabs.includes(sid)) store.openSession(sid)
          }
        }}
      >
        {openTabs.map((id) => {
          const s = sessions[id]
          if (!s) return null
          const tabVisible = activeSessionId === id
          return (
            <div
              key={id}
              data-session-view={id}
              className="absolute top-0 bottom-0 left-0 right-0 flex flex-col"
              style={{ opacity: tabVisible ? 1 : 0, pointerEvents: tabVisible ? 'auto' : 'none', zIndex: tabVisible ? 1 : 0 }}
            >
              <div className="flex-1 min-h-0 flex flex-col relative">
                {isShellSession(s) ? (
                  // Plain terminal: the shell fills the tab (no chat, no drawer).
                  <>
                    <TerminalView sessionId={id} phone />
                    <PhoneKeyBar sessionId={id} />
                  </>
                ) : (
                  <ChatPanel sessionId={id} onToggleTerminal={() => setIsTerminalOpen(!isTerminalOpen)} isTerminalOpen={false} phone />
                )}
              </div>
            </div>
          )
        })}
        {/* Terminal view of the phone session (switched in the phone header). */}
        {activeSessionId && !isShellSession(sessions[activeSessionId]) && (
          <div
            data-terminal-drawer={isTerminalOpen ? 'open' : 'closed'}
            className={`ive-terminal-drawer absolute bottom-0 left-0 right-0 border-t border-x-line bg-x-surface-2 z-30 transition-all duration-300 ease-in-out flex flex-col overflow-hidden ${isTerminalOpen ? 'h-[360px] translate-y-0' : 'h-0 border-t-0'}`}
          >
            <div className={`flex-1 min-h-0 flex flex-col bg-x-surface-2 relative transition-opacity duration-200 ${isTerminalOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
              <TerminalView sessionId={activeSessionId} inDrawer={true} phone />
            </div>
            {isTerminalOpen && <PhoneKeyBar sessionId={activeSessionId} />}
          </div>
        )}
      </div>
      {showSessionSidebar && activeSessionId && (
        <SessionSidebar sessionId={activeSessionId} initialTab={sessionSidebarTab} onTabChange={setSessionSidebarTab} onClose={() => setShowSessionSidebar(false)} />
      )}
    </div>
  )

  const mobileScreen = phoneSession && activeSessionId ? mobileSessionArea
    : phoneOverview ? (
      <div key="phone-overview" className="flex-1 min-h-0 overflow-y-auto bg-x-bg x-canvas">
        <PhoneOverview onOpenHome={() => setPhoneFullHome(true)} />
      </div>
    ) : homeScreen

  const mobileHeader = phoneSession && activeSessionId ? (
    // Phone, inside a session: back, name + status, Chat/Terminal, Stop.
    <PhoneSessionHeader
      sessionId={activeSessionId}
      view={isTerminalOpen ? 'terminal' : 'chat'}
      onView={(v) => setIsTerminalOpen(v === 'terminal')}
      onBack={() => useStore.getState().goHome()}
      onMenu={() => setMobileDrawerOpen(true)}
    />
  ) : (
    // Mobile-only header: hamburger + active session name, search, help, new.
    <div className="ive-mobile-header flex items-center gap-2 px-2 py-1.5 bg-x-surface border-b border-x-line shrink-0" style={{ minHeight: 44 }}>
      <button
        type="button"
        onClick={() => setMobileDrawerOpen(true)}
        aria-label="Open sidebar"
        className="flex items-center justify-center text-x-ink-secondary hover:text-x-ink hover:bg-x-hover rounded-md touch-manipulation"
        style={{ width: 44, height: 44 }}
      >
        <Menu size={20} />
      </button>
      <span className="flex-1 truncate t-meta font-medium">
        {activeSessionId && sessions[activeSessionId]?.name && !showHome ? sessions[activeSessionId].name : 'IVE'}
      </span>
      {phoneHomeLevel && phoneFullHome && (
        <button type="button" onClick={() => setPhoneFullHome(false)} className="ive-phone-chip" aria-label="Back to sessions">Sessions</button>
      )}
      {/* Phones: search and quick help live here, where they never cover
          the composer or the terminal (the old floating ⌘K button did). */}
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))} aria-label="Search tools, sessions and projects" className="ive-mobile-header-button">
        <Search size={19} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => window.dispatchEvent(new Event('open-cheat-sheet'))} aria-label="Quick help and keyboard shortcuts" className="ive-mobile-header-button">
        <CircleHelp size={19} aria-hidden="true" />
      </button>
      {phoneOverview && (
        // Safari does not focus a tapped button; focus it so the guide
        // returns focus here when it closes.
        <button type="button" onClick={(e) => { e.currentTarget.focus(); window.dispatchEvent(new Event('open-onboarding')) }} aria-label="IVE kennenlernen" className="ive-mobile-header-button">
          <GraduationCap size={19} aria-hidden="true" />
        </button>
      )}
      {phoneOverview && (
        <button type="button" onClick={() => openQuickStart()} aria-label="Create a new session" className="ive-mobile-header-button ive-phone-header-new">
          <Plus size={20} aria-hidden="true" />
        </button>
      )}
    </div>
  )

  return (
    <AppShell
      isMobile={isMobile}
      sidebarVisible={sidebarVisible}
      mobileDrawerOpen={mobileDrawerOpen}
      onMobileDrawerClose={() => setMobileDrawerOpen(false)}
      mobileView={showHome || openTabs.length === 0 ? 'home' : 'session'}
      phoneLevel={phoneSession ? 'session' : phoneOverview ? 'overview' : 'home'}
      sidebar={(
        <NavSidebar
          onOpenPanel={executeHomeAction}
          onNewSession={() => openQuickStart()}
          onGoHome={() => panelActions('home')}
          onGoBoard={() => panelActions('board')}
          onOpenReview={() => panelActions('review')}
          onOpenKnowledge={() => panelActions('knowledge')}
          activeOverlay={activeOverlay}
          onOpenAttention={() => { closeExclusivePanels(); setMobileDrawerOpen(false); setShowAttention(true) }}
          attentionCount={taskAttention.count}
          catchUp={catchUp}
        />
      )}
      header={(
        <HeaderBar
          view={view}
          onGoHome={() => panelActions('home')}
          onGoBoard={() => panelActions('board')}
          onNewSession={() => openQuickStart()}
          onOpenPanel={executeHomeAction}
          onToggleSideChat={sideChatToggle}
          sideChatOpen={showSideChat}
          isOwner={isOwner}
        />
      )}
      mobileHeader={mobileHeader}
      footer={<ConnectionNotice />}
      prelude={(
        <>
          {/* Mobile PWA install prompt (iOS A2HS / Android beforeinstallprompt) */}
          <MobileInstallPrompt />
          <PhonePushPrompt />
          <PhoneLockOverlay />
          {catchupOpen && <CatchUpPanel initialDigest={catchupSeed} onClose={() => setCatchupOpen(false)} />}
          {showCost && <CostPanel onClose={() => setShowCost(false)} />}
        </>
      )}
      sideChat={isOwner ? <SideChat key={sideChatSessionId || 'general'} sessionId={sideChatSessionId} incoming={sideChatRequest}
        onConsumed={() => setSideChatRequest(null)} onGeneral={() => { setSideChatSessionId(null); setSideChatRequest(null) }}
        open={showSideChat} onClose={() => setShowSideChat(false)} onNavigate={executeHomeAction} /> : null}
      overlays={(
        <>
          {/* Lazy-loaded overlay panels — only the modal region suspends (fallback=null), never the shell. */}
          <Suspense fallback={null}>
          {taskFlow && <TaskFlow key={taskFlow.tourKey || taskFlow.taskId || 'task-draft'} initial={taskFlow} onClose={() => setTaskFlow(null)} onCreated={() => {}} onBoard={(workspaceId) => { if (workspaceId) useStore.getState().setActiveWorkspace(workspaceId); setTaskFlow(null); executeHomeAction('feature-board') }} onKnowledge={(workspaceId) => { useStore.getState().setActiveWorkspace(workspaceId); setTaskFlow(null); executeHomeAction('memory') }} />}
          {showCommand && <CommandPalette initialQuery={commandQuery} onClose={() => { setShowCommand(false); setCommandQuery('') }} onAction={handleCommandAction} />}
          {showCheatSheet && <CheatSheet onClose={() => setShowCheatSheet(false)} onRun={runCheatSheetAction} />}
          {showWorkspacePicker && <WorkspacePicker
            initialQuery={workspaceSearchQuery}
            onClose={() => setShowWorkspacePicker(false)}
            onSelect={async (project) => {
              const { workspace, created } = await connectProject(project)
              useStore.getState().setActiveWorkspace(workspace.id) // Home composer shows the active project
              setShowWorkspacePicker(false)
              emitTourEvent('project-connected', { workspaceId: workspace.id })
              if (created && !onboarding.open) setVisionOnboardingFor(workspace)
            }}
          />}
          {showPrompts && <PromptPalette startInCreate={promptsStartCreate} startTab={promptsStartTab} onClose={() => { setShowPrompts(false); setPromptsStartCreate(false); setPromptsStartTab('prompts') }} />}
          {showGuidelines && <GuidelinePanel onClose={() => setShowGuidelines(false)} />}
          {showBroadcast && <BroadcastBar onClose={() => setShowBroadcast(false)} />}
          {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
          {showMission && <MissionControl onClose={() => setShowMission(false)} />}
          {showHistory && <HistoryImport onClose={() => setShowHistory(false)} />}
          {showInbox && <InboxPanel onClose={() => setShowInbox(false)} />}
          {showAttention && (
            <Modal title="Needs your attention" size="md" onClose={() => setShowAttention(false)} bodyClassName="overflow-y-auto p-4">
              <AttentionBar showAll emptyMessage="Nothing needs your attention right now."
                onReviewTask={(taskId) => { closeExclusivePanels(); setTaskFlow({ taskId }) }}
                onReviewSession={(sessionId) => {
                  closeExclusivePanels()
                  const store = useStore.getState()
                  const session = store.sessions[sessionId]
                  if (!session) return
                  store.setActiveWorkspace(session.workspace_id)
                  store.goSession(sessionId)
                  store.toggleTerminalDrawer(sessionId, true)
                }}
                onSafetySettings={() => executeHomeAction('safety')}
              />
            </Modal>
          )}
          {showPlan && <PlanViewer onClose={() => setShowPlan(false)} />}
          {showBoard && (
            <PanelBoundary onClose={() => { setShowBoard(false); setBoardInitialAction(null) }}>
              <FeatureBoard
                initialAction={boardInitialAction}
                onActionConsumed={() => setBoardInitialAction(null)}
                onClose={() => { setShowBoard(false); setBoardInitialAction(null) }}
              />
            </PanelBoundary>
          )}
          {showPipelineEditor && <PanelBoundary onClose={() => setShowPipelineEditor(false)}><PipelineEditor onClose={() => setShowPipelineEditor(false)} /></PanelBoundary>}
          {showTree && <SubagentTree onClose={() => setShowTree(false)} />}
          {showTemplates && <TemplateManager onClose={() => setShowTemplates(false)} />}
          {showCapabilities && <CapabilitiesPanel onClose={() => setShowCapabilities(false)} />}
          {showResearchHub && <PanelBoundary onClose={() => setShowResearchHub(false)}><ResearchHub initialTab={researchHubTab} onClose={() => setShowResearchHub(false)} /></PanelBoundary>}
          {showDiscoveryHub && (
            <PanelBoundary onClose={() => setShowDiscoveryHub(false)}>
              <DiscoveryHub
                initialTab={discoveryHubTab}
                onClose={() => setShowDiscoveryHub(false)}
                onOpenResearch={(tab = 'new') => {
                  if (!isSurfaceAvailable('research')) return
                  setShowDiscoveryHub(false)
                  setResearchHubTab(tab)
                  setShowResearchHub(true)
                }}
                onOpenBoard={() => {
                  setShowDiscoveryHub(false)
                  setShowBoard(true)
                }}
                onOpenPipelines={() => {
                  if (!isSurfaceAvailable('pipeline-editor')) return
                  setShowDiscoveryHub(false)
                  setShowPipelineEditor(true)
                }}
                onOpenKnowledge={() => {
                  setShowDiscoveryHub(false)
                  setMemoryInitialTab('knowledge')
                  setShowMemory(true)
                }}
                onOpenApiKeys={() => {
                  setShowDiscoveryHub(false)
                  setSettingsSection('api-keys')
                }}
              />
            </PanelBoundary>
          )}
          {showGovernance && (
            <PanelBoundary onClose={() => setShowGovernance(false)}>
              <GovernancePanel
                initialTab={governanceInitialTab}
                onClose={() => setShowGovernance(false)}
              />
            </PanelBoundary>
          )}
          {visionOnboardingFor && (
            <PanelBoundary onClose={() => setVisionOnboardingFor(null)}>
              <WorkspaceVisionOnboarding
                workspace={visionOnboardingFor}
                onClose={() => setVisionOnboardingFor(null)}
                onDone={() => setVisionOnboardingFor(null)}
              />
            </PanelBoundary>
          )}
          {quickStartOpen && !newSessionWorkspaceId && (
            <QuickStartPopover onClose={() => useStore.setState({ quickStartOpen: false })} />
          )}
          {newSessionWorkspaceId && (
            <NewSessionDialog
              workspaceId={newSessionWorkspaceId}
              onClose={() => useStore.setState({ newSessionWorkspaceId: null })}
            />
          )}
          {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
          {showKnowledge && <KnowledgePanel onClose={() => setShowKnowledge(false)} />}
          {showCodeCatalog && <CodeCatalogPanel onClose={() => setShowCodeCatalog(false)} />}
          {showSecure && <SecurePanel onClose={() => setShowSecure(false)} />}
          {showAgentSystems && <AgentSystemsPanel onClose={() => setShowAgentSystems(false)} />}
          {showPeerMessages && <PeerMessagesPanel onClose={() => setShowPeerMessages(false)} />}
          {showMemory && <MemoryWindow initialTab={memoryInitialTab} onClose={() => setShowMemory(false)} />}
          {showMarketplace && <MarketplacePanel onClose={() => { setShowMarketplace(false); setMarketplaceTab(null); setMarketplaceSuggestedSkills(null) }} initialTab={marketplaceTab} suggestedSkills={marketplaceSuggestedSkills} />}
          {showQuickActionPalette && <QuickActionPalette onClose={() => setShowQuickActionPalette(false)} />}
          {settingsSection && (
            <SettingsShell
              sectionId={settingsSection}
              onSectionChange={setSettingsSection}
              onClose={() => setSettingsSection(null)}
              workspaceId={wsSettingsInitialId}
              sharingInitialTab={sharingInitialTab}
            />
          )}
          {showGlobalLogs && <PanelBoundary onClose={() => setShowGlobalLogs(false)}><GlobalLogsPanel onClose={() => setShowGlobalLogs(false)} /></PanelBoundary>}
          {onboarding.open && (
            <InteractiveOnboarding profile={onboarding.profile} onFinish={onboarding.finish} onPause={onboarding.pause} onNavigate={(destination, detail = {}) => {
              closeExclusivePanels()
              if (destination === 'project') setShowWorkspacePicker(true)
              if (destination === 'accounts') setSettingsSection('accounts')
              if (destination === 'home') useStore.getState().goHome()
              if (destination === 'session' && detail.workspaceId) {
                useStore.getState().setActiveWorkspace(detail.workspaceId)
                useStore.setState({ newSessionWorkspaceId: detail.workspaceId, newSessionPrefillName: detail.name || 'Mein erster Dialog', newSessionPrefillPurpose: null })
              }
              if (destination === 'overview' && detail.sessionId) {
                // The tour's "overview" is the Board level now.
                useStore.getState().setActiveWorkspace(detail.workspaceId)
                useStore.getState().openSession(detail.sessionId, { focus: false, autoStart: false })
                useStore.getState().goBoard()
              }
              if (destination === 'task') setTaskFlow({ ...detail, guidedTour: true, tourKey: detail.taskId || Date.now() })
              if (destination === 'tools') openCommandPalette('Pipelines')
              if (destination?.startsWith('surface:')) executeHomeAction(destination.slice(8))
            }} />
          )}
          {showDistill && (
            <DistillPanel
              onClose={() => { setShowDistill(false); setDistillInitial(null) }}
              initialResult={distillInitial?.result}
              initialArtifactType={distillInitial?.artifactType}
            />
          )}
          {showAnnotator && activeSessionId && (
            <TerminalAnnotator
              sessionId={activeSessionId}
              onClose={() => setShowAnnotator(false)}
              onSend={(text) => {
                setShowAnnotator(false)
                const activeSession = useStore.getState().sessions[activeSessionId]
                const sourceName = activeSession?.name || 'public Brainstormer'
                setComposerDraft(activeSession?.read_only ? `[Note from read-only Brainstormer: ${sourceName}]\n\n${text}` : text)
                setShowComposer(true)
              }}
            />
          )}
          {showPreviewPalette && (
            <PreviewPalette
              onClose={() => setShowPreviewPalette(false)}
              onScreenshot={(imageUrl, sourceUrl) => setScreenshotData({ imageUrl, sourceUrl })}
              onLivePreview={(url, taskId) => { setLivePreviewUrl(url); setLivePreviewTaskId(taskId || null) }}
            />
          )}
          {livePreviewUrl && (
            <LivePreview
              url={livePreviewUrl}
              taskId={livePreviewTaskId}
              onScreenshot={(imageUrl, sourceUrl) => {
                setLivePreviewUrl(null)
                setLivePreviewTaskId(null)
                setScreenshotData({ imageUrl, sourceUrl })
              }}
              onClose={() => { setLivePreviewUrl(null); setLivePreviewTaskId(null) }}
            />
          )}
          {screenshotData && (
            <ScreenshotAnnotator
              imageUrl={screenshotData.imageUrl}
              sourceUrl={screenshotData.sourceUrl}
              onClose={() => { URL.revokeObjectURL(screenshotData.imageUrl); setScreenshotData(null) }}
              onSendToSession={(filePath) => {
                const sid = useStore.getState().activeSessionId
                if (sid) typeInTerminal(sid, filePath)
              }}
            />
          )}
          {showQuickFeature && (
            <QuickFeatureModal
              prefillText={quickFeaturePrefill}
              initialPastedImages={quickFeatureInitialImages}
              autoVoice={quickFeatureVoice}
              workspaceId={quickFeatureWorkspaceId}
              onCreated={(task) => useStore.getState().updateTaskInStore(task)}
              onClose={() => {
                setShowQuickFeature(false)
                setQuickFeaturePrefill('')
                setQuickFeatureWorkspaceId(null)
                setQuickFeatureVoice(false)
                setQuickFeatureInitialImages([])
              }}
            />
          )}
          </Suspense>

          <CodePreview />

          <AIControlCenter
            workspaceId={aiControlWorkspaceId}
            activeSessionId={activeSessionId}
            disabled={!aiControlWorkspaceId}
            companion
            overlayHidden={anyModalOpen}
          />

          <SessionDeleteDialog />
          <SessionRenameDialog />
          <ToastBoundary><NotificationToast sideChatOpen={showSideChat} /></ToastBoundary>
        </>
      )}
    >
      {isMobile ? mobileScreen : desktopScreen}
      {viewingSubagent && (
        <SubagentViewer
          sessionId={viewingSubagent.sessionId}
          agentId={viewingSubagent.agentId}
          onClose={() => useStore.getState().clearViewingSubagent()}
        />
      )}
      {showComposer && activeSessionId && (
        <Composer
          sessionId={composerTargetSessionId}
          initialValue={composerDraft}
          onClose={() => { setShowComposer(false); setComposerDraft('') }}
        />
      )}
      <CascadeBar />
      <CascadeVariableDialog />
    </AppShell>
  )
}
