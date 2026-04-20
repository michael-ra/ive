import { useState, useRef, useCallback, useEffect } from 'react'
import { X } from 'lucide-react'
import useWebSocket from './hooks/useWebSocket'
import useKeyboard from './hooks/useKeyboard'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import StatusBar from './components/layout/StatusBar'
import SessionTabs from './components/session/SessionTabs'
import MissionControl from './components/session/MissionControl'
import TerminalView from './components/chat/Terminal'
import QuickActions from './components/command/QuickActions'
import CommandPalette from './components/command/CommandPalette'
import { ACTIONS as CMD_ACTIONS } from './lib/commandActions'
import SearchPanel from './components/command/SearchPanel'
import PromptPalette from './components/prompts/PromptPalette'
import GuidelinePanel from './components/guidelines/GuidelinePanel'
import McpPanel from './components/mcp/McpPanel'
import MarketplacePanel from './components/marketplace/MarketplacePanel'
import ExperimentalPanel from './components/settings/ExperimentalPanel'
import SafetyPanel from './components/settings/SafetyPanel'
import SoundSettingsPanel from './components/settings/SoundSettingsPanel'
import GeneralSettingsPanel from './components/settings/GeneralSettingsPanel'
import WorkspaceSettingsPanel from './components/settings/WorkspaceSettingsPanel'
import BroadcastBar from './components/chat/BroadcastBar'
import HistoryImport from './components/session/HistoryImport'
import InboxPanel from './components/session/Inbox'
import PlanViewer from './components/session/PlanViewer'
import FeatureBoard from './components/board/FeatureBoard'
import PipelineEditor from './components/pipeline/PipelineEditor'
import QuickFeatureModal from './components/board/QuickFeatureModal'
import SubagentTree from './components/session/SubagentTree'
import TemplateManager from './components/command/TemplateManager'
import AccountManager from './components/command/AccountManager'
import ConfigViewer from './components/session/ConfigViewer'
import ResearchPanel from './components/session/ResearchPanel'
import DocsPanel from './components/session/DocsPanel'
import KnowledgePanel from './components/session/KnowledgePanel'
import PeerMessagesPanel from './components/session/PeerMessagesPanel'
import MemoryWindow from './components/session/MemoryWindow'
import ShortcutsPanel from './components/command/ShortcutsPanel'
import GridTemplateEditor from './components/command/GridTemplateEditor'
import Scratchpad from './components/session/Scratchpad'
import SubagentViewer from './components/session/SubagentViewer'
import Composer from './components/chat/Composer'
import TerminalAnnotator from './components/chat/TerminalAnnotator'
import CodePreview from './components/session/CodePreview'
import CodeReviewPanel from './components/session/CodeReviewPanel'
import DistillPanel from './components/session/DistillPanel'
import PreviewPalette from './components/command/PreviewPalette'
import LivePreview from './components/command/LivePreview'
import ScreenshotAnnotator from './components/session/ScreenshotAnnotator'
import QuickActionPalette from './components/command/QuickActionPalette'
import CascadeBar from './components/chat/CascadeBar'
import CascadeVariableDialog from './components/prompts/CascadeVariableDialog'
import NotificationToast from './components/layout/NotificationToast'
import useStore from './state/store'
import { api } from './lib/api'
import { typeInTerminal, sendTerminalCommand } from './lib/terminal'
import { getWorkspaceColor } from './lib/constants'

export default function App() {
  useWebSocket()

  // Listen for custom events from sidebar buttons and notifications
  useEffect(() => {
    const handler = (e) => {
      const panel = e.detail
      if (panel === 'feature-board') setShowBoard(true)
      if (panel === 'pipeline-editor') setShowPipelineEditor(true)
      if (panel === 'agent-tree') setShowTree(true)
      if (panel === 'scratchpad') setShowScratchpad((s) => !s)
      if (panel === 'research') setShowResearch(true)
      if (panel === 'docs-panel') setShowDocs(true)
      if (panel === 'knowledge') setShowKnowledge(true)
      if (panel === 'peer-messages') setShowPeerMessages(true)
      if (panel === 'memory') setShowMemory(true)
      if (panel === 'code-review') setShowCodeReview(true)
      if (panel === 'annotate') setShowAnnotator(true)
      if (panel === 'grid-templates') setShowGridEditor(true)
      if (panel === 'command-palette') setShowCommand(true)
      if (panel === 'guidelines') setShowGuidelines(true)
      if (panel === 'mcp-servers') setShowMcpServers(true)
      if (panel === 'inbox') setShowInbox(true)
      if (panel === 'mission-control') setShowMission(true)
      if (panel === 'marketplace') setShowMarketplace(true)
      if (panel === 'accounts') setShowAccounts(true)
      if (panel === 'config-viewer') setShowConfig(true)
      if (panel === 'shortcuts') setShowShortcuts(true)
      if (panel === 'general-settings') setShowGeneralSettings(true)
      if (panel === 'sound-settings') setShowSoundSettings(true)
      if (panel === 'experimental') setShowExperimental(true)
      if (panel === 'prompts') setShowPrompts(true)
      if (panel === 'search') setShowSearch(true)
    }
    const wsSettingsHandler = (e) => {
      setWsSettingsInitialId(e.detail?.workspaceId || null)
      setShowWorkspaceSettings(true)
    }
    const planHandler = () => setShowPlan(true)
    const quickFeatureHandler = (e) => {
      setQuickFeaturePrefill(e.detail?.text || '')
      setQuickFeatureVoice(false)
      setShowQuickFeature(true)
    }
    window.addEventListener('open-panel', handler)
    window.addEventListener('open-plan-viewer', planHandler)
    window.addEventListener('open-quick-feature', quickFeatureHandler)
    window.addEventListener('open-workspace-settings', wsSettingsHandler)
    return () => {
      window.removeEventListener('open-panel', handler)
      window.removeEventListener('open-plan-viewer', planHandler)
      window.removeEventListener('open-quick-feature', quickFeatureHandler)
      window.removeEventListener('open-workspace-settings', wsSettingsHandler)
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
    window.addEventListener('cc-distill_done', handleDistillDone)
    window.addEventListener('cc-distill_error', handleDistillError)
    window.addEventListener('cc-mcp_parse_done', handleMcpParseDone)
    window.addEventListener('cc-mcp_parse_error', handleMcpParseError)
    window.addEventListener('cc-guideline_recommendation', handleGuidelineRec)
    return () => {
      window.removeEventListener('cc-distill_done', handleDistillDone)
      window.removeEventListener('cc-distill_error', handleDistillError)
      window.removeEventListener('cc-mcp_parse_done', handleMcpParseDone)
      window.removeEventListener('cc-mcp_parse_error', handleMcpParseError)
      window.removeEventListener('cc-guideline_recommendation', handleGuidelineRec)
    }
  }, [])

  // Open result panels from notification action buttons
  useEffect(() => {
    const handleOpenDistillResult = (e) => {
      setDistillInitial({ result: e.detail.result, artifactType: e.detail.artifactType })
      setShowDistill(true)
    }
    const handleOpenMcpResult = (e) => {
      // Open MCP panel — the result is in backgroundResults for the panel to consume
      setShowMcpServers(true)
    }
    const handleOpenGuidelines = () => setShowGuidelines(true)
    window.addEventListener('open-distill-result', handleOpenDistillResult)
    window.addEventListener('open-mcp-parse-result', handleOpenMcpResult)
    window.addEventListener('open-guidelines', handleOpenGuidelines)
    return () => {
      window.removeEventListener('open-distill-result', handleOpenDistillResult)
      window.removeEventListener('open-mcp-parse-result', handleOpenMcpResult)
      window.removeEventListener('open-guidelines', handleOpenGuidelines)
    }
  }, [])

  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const showHome = useStore((s) => s.showHome)
  const homeColumns = useStore((s) => s.homeColumns)
  const gridMinRowHeight = useStore((s) => s.gridMinRowHeight)
  const terminalAutoFit = useStore((s) => s.terminalAutoFit)
  const sessions = useStore((s) => s.sessions)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const splitMode = useStore((s) => s.splitMode)
  const viewMode = useStore((s) => s.viewMode)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const workspaces = useStore((s) => s.workspaces)
  const splitSessionId = useStore((s) => s.splitSessionId)
  const tabScope = useStore((s) => s.tabScope)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const viewingSubagent = useStore((s) => s.viewingSubagent)

  // Tabs filtered by the project/workspace scope toggle in SessionTabs.
  // Used everywhere the grid view enumerates tabs so the same filter applies to
  // built-in layouts and to custom template cell assignments.
  const visibleTabs = tabScope === 'workspace' && activeWorkspaceId
    ? openTabs.filter((id) => sessions[id]?.workspace_id === activeWorkspaceId)
    : openTabs

  // Split is visually active when the split session differs from the active tab
  const hasSplit = splitMode && splitSessionId && splitSessionId !== activeSessionId && !!sessions[splitSessionId]

  // Auto-close split if split session was removed
  useEffect(() => {
    if (splitMode && splitSessionId && !sessions[splitSessionId]) {
      useStore.setState({ splitMode: false, splitSessionId: null })
    }
  }, [splitMode, splitSessionId, sessions])

  // Refit all terminals when the view or layout changes — covers workspace
  // switches (different visibleTabs), tab open/close (cell count change),
  // layout mode changes, view mode switches, and split mode toggles.
  // Fires twice: once at 80ms for layout-only changes (grid layout switch),
  // and again at 350ms as a safety net for view switches that remount
  // terminals (tabs↔grid) — the remount path needs ~300ms to settle.
  const visibleTabCount = visibleTabs.length
  useEffect(() => {
    let cancelled = false
    const refit = () => window.dispatchEvent(new Event('cc-terminal-refit'))
    requestAnimationFrame(() => {
      if (cancelled) return
      setTimeout(() => { if (!cancelled) refit() }, 80)
      setTimeout(() => { if (!cancelled) refit() }, 350)
    })
    return () => { cancelled = true }
  }, [viewMode, visibleTabCount, activeWorkspaceId, gridLayout, activeGridTemplateId, splitMode, splitSessionId])

  const [showCommand, setShowCommand] = useState(false)
  const [showPrompts, setShowPrompts] = useState(false)
  const [promptsStartCreate, setPromptsStartCreate] = useState(false)
  const [showGuidelines, setShowGuidelines] = useState(false)
  const [showMcpServers, setShowMcpServers] = useState(false)
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showMission, setShowMission] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showInbox, setShowInbox] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [showBoard, setShowBoard] = useState(false)
  const [showPipelineEditor, setShowPipelineEditor] = useState(false)
  const [showTree, setShowTree] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showResearch, setShowResearch] = useState(false)
  const [showDocs, setShowDocs] = useState(false)
  const [showKnowledge, setShowKnowledge] = useState(false)
  const [showPeerMessages, setShowPeerMessages] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showScratchpad, setShowScratchpad] = useState(false)
  const [showComposer, setShowComposer] = useState(false)
  const [showGridEditor, setShowGridEditor] = useState(false)
  const [showPreviewPalette, setShowPreviewPalette] = useState(false)
  const [livePreviewUrl, setLivePreviewUrl] = useState(null)
  const [livePreviewTaskId, setLivePreviewTaskId] = useState(null)
  const [showMarketplace, setShowMarketplace] = useState(false)
  const [marketplaceTab, setMarketplaceTab] = useState(null)
  const [showQuickActionPalette, setShowQuickActionPalette] = useState(false)
  const [showExperimental, setShowExperimental] = useState(false)
  const [showSafety, setShowSafety] = useState(false)
  const [promptsStartTab, setPromptsStartTab] = useState('prompts')
  const [showSoundSettings, setShowSoundSettings] = useState(false)
  const [showGeneralSettings, setShowGeneralSettings] = useState(false)
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false)
  const [wsSettingsInitialId, setWsSettingsInitialId] = useState(null)
  const [showCodeReview, setShowCodeReview] = useState(false)
  const [showAnnotator, setShowAnnotator] = useState(false)
  const [showDistill, setShowDistill] = useState(false)
  const [distillInitial, setDistillInitial] = useState(null) // { result, artifactType }
  const [showQuickFeature, setShowQuickFeature] = useState(false)
  const [quickFeaturePrefill, setQuickFeaturePrefill] = useState('')
  const [quickFeatureVoice, setQuickFeatureVoice] = useState(false)
  const [composerDraft, setComposerDraft] = useState('') // pre-filled from annotator
  const [screenshotData, setScreenshotData] = useState(null) // { imageUrl, sourceUrl }

  // Global Escape to close any open panel.
  // Uses capture phase so the event fires before xterm.js or other element
  // handlers can swallow it. stopPropagation prevents the Escape from also
  // reaching the terminal after closing a panel.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        // Close panels in priority order (topmost first)
        if (showDistill) { e.stopPropagation(); setShowDistill(false); return }
        if (showQuickFeature) { e.stopPropagation(); setShowQuickFeature(false); setQuickFeaturePrefill(''); setQuickFeatureVoice(false); return }
        if (showAnnotator) { e.stopPropagation(); setShowAnnotator(false); return }
        if (screenshotData) { e.stopPropagation(); setScreenshotData(null); return }
        if (livePreviewUrl) { e.stopPropagation(); setLivePreviewUrl(null); return }
        if (showPreviewPalette) { e.stopPropagation(); setShowPreviewPalette(false); return }
        if (showCommand) { e.stopPropagation(); setShowCommand(false); return }
        if (showPrompts) { e.stopPropagation(); setShowPrompts(false); return }
        if (showGuidelines) { e.stopPropagation(); setShowGuidelines(false); return }
        if (showMcpServers) { e.stopPropagation(); setShowMcpServers(false); return }
        if (showBroadcast) { e.stopPropagation(); setShowBroadcast(false); return }
        if (showSearch) { e.stopPropagation(); setShowSearch(false); return }
        if (showMission) { e.stopPropagation(); setShowMission(false); return }
        if (showHistory) { e.stopPropagation(); setShowHistory(false); return }
        if (showInbox) { e.stopPropagation(); setShowInbox(false); return }
        if (showPlan) { e.stopPropagation(); setShowPlan(false); return }
        if (showBoard) { e.stopPropagation(); setShowBoard(false); return }
        if (showPipelineEditor) { e.stopPropagation(); setShowPipelineEditor(false); return }
        if (showTree) { e.stopPropagation(); setShowTree(false); return }
        if (showTemplates) { e.stopPropagation(); setShowTemplates(false); return }
        if (showShortcuts) { e.stopPropagation(); setShowShortcuts(false); return }
        if (showAccounts) { e.stopPropagation(); setShowAccounts(false); return }
        if (showResearch) { e.stopPropagation(); setShowResearch(false); return }
        if (showDocs) { e.stopPropagation(); setShowDocs(false); return }
        if (showKnowledge) { e.stopPropagation(); setShowKnowledge(false); return }
        if (showPeerMessages) { e.stopPropagation(); setShowPeerMessages(false); return }
        if (showMemory) { e.stopPropagation(); setShowMemory(false); return }
        if (showScratchpad) { e.stopPropagation(); setShowScratchpad(false); return }
        if (showMarketplace) { e.stopPropagation(); setShowMarketplace(false); return }
        if (showQuickActionPalette) { e.stopPropagation(); setShowQuickActionPalette(false); return }
        if (showExperimental) { e.stopPropagation(); setShowExperimental(false); return }
        if (showSoundSettings) { e.stopPropagation(); setShowSoundSettings(false); return }
        if (showGeneralSettings) { e.stopPropagation(); setShowGeneralSettings(false); return }
        if (showWorkspaceSettings) { e.stopPropagation(); setShowWorkspaceSettings(false); return }
        if (showCodeReview) { e.stopPropagation(); setShowCodeReview(false); return }
        if (splitMode) { e.stopPropagation(); useStore.setState({ splitMode: false, splitSessionId: null }); return }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showDistill, showQuickFeature, showAnnotator, screenshotData, livePreviewUrl, showPreviewPalette, showCommand, showPrompts, showGuidelines, showMcpServers, showBroadcast, showSearch, showMission, showHistory, showInbox, showPlan, showBoard, showPipelineEditor, showTree, showTemplates, showScratchpad, showAccounts, showShortcuts, showResearch, showCodeReview, showMarketplace, showQuickActionPalette, showExperimental, showSoundSettings, showGeneralSettings, showWorkspaceSettings, splitMode])

  // When a modal overlay opens, pull focus away from the terminal so that
  // keyboard events (arrows, Enter, etc.) reach panel handlers instead of
  // being consumed by xterm.js.
  const anyModalOpen = showDistill || showQuickFeature || showAnnotator || showCommand || showPrompts || showGuidelines || showMcpServers || showBroadcast || showSearch || showMission || showHistory || showInbox || showPlan || showBoard || showTree || showTemplates || showShortcuts || showAccounts || showResearch || showCodeReview || showGridEditor || showPreviewPalette || !!livePreviewUrl || showMarketplace || showQuickActionPalette || showExperimental || showSoundSettings || showGeneralSettings || !!screenshotData
  useEffect(() => {
    if (anyModalOpen) {
      const active = document.activeElement
      if (active && active.closest('.xterm')) {
        active.blur()
      }
    }
  }, [anyModalOpen])
  const activePlan = useStore((s) => s.activePlan)
  const planFilePaths = useStore((s) => s.planFilePaths)
  const planWaiting = useStore((s) => s.planWaiting)
  const [splitRatio, setSplitRatio] = useState(50)
  const splitDragging = useRef(false)

  const handleSplitDragStart = useCallback((e) => {
    e.preventDefault()
    splitDragging.current = true
    const container = e.target.parentElement
    const onMove = (me) => {
      if (!splitDragging.current) return
      const rect = container.getBoundingClientRect()
      const pct = ((me.clientX - rect.left) / rect.width) * 100
      setSplitRatio(Math.max(20, Math.min(80, pct)))
    }
    const onUp = () => {
      splitDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Toggle split view: pair the active tab with its right neighbor (or left as fallback).
  // Single source of truth — used by both the ⌘D shortcut and the command palette.
  const toggleSplitView = useCallback(() => {
    const store = useStore.getState()
    if (store.splitMode) {
      useStore.setState({ splitMode: false, splitSessionId: null })
      return
    }
    const idx = store.openTabs.indexOf(store.activeSessionId)
    const nextId = store.openTabs[idx + 1] || store.openTabs[idx - 1]
    if (nextId) useStore.setState({ splitMode: true, splitSessionId: nextId })
  }, [])

  useKeyboard({
    onCommandPalette: () => setShowCommand(true),
    onPromptPalette: () => setShowPrompts(true),
    onGuidelinePanel: () => setShowGuidelines(true),
    onMcpServers: () => setShowMcpServers(true),
    onSplitView: toggleSplitView,
    onBroadcast: () => setShowBroadcast(true),
    onSearch: () => setShowSearch(true),
    onMissionControl: () => setShowMission(true),
    onInbox: () => setShowInbox(true),
    onFeatureBoard: () => setShowBoard(true),
    onPipelineEditor: () => setShowPipelineEditor(true),
    onAgentTree: () => setShowTree(true),
    onResearch: () => { if (!livePreviewUrl) setShowResearch(true) },
    onScratchpad: () => setShowScratchpad((s) => !s),
    onComposer: () => setShowComposer((s) => !s),
    onShortcuts: () => setShowShortcuts(true),
    onPreview: () => setShowPreviewPalette(true),
    onMarketplace: () => setShowMarketplace(true),
    onQuickActionPalette: () => setShowQuickActionPalette(true),
    onSkillsLibrary: () => { setShowMarketplace(true); setMarketplaceTab('skills') },
    onCodeReview: () => setShowCodeReview(true),
    onAnnotate: () => setShowAnnotator(true),
    onQuickFeature: () => { setQuickFeaturePrefill(''); setQuickFeatureVoice(false); setShowQuickFeature(true) },
  })

  const handleCommandAction = (action) => {
    if (action === 'prompt-library') { setPromptsStartCreate(false); setShowPrompts(true) }
    if (action === 'new-prompt') { setPromptsStartCreate(true); setShowPrompts(true) }
    if (action === 'guidelines') setShowGuidelines(true)
    if (action === 'mcp-servers') setShowMcpServers(true)
    if (action === 'broadcast') setShowBroadcast(true)
    if (action === 'search') setShowSearch(true)
    if (action === 'mission-control') setShowMission(true)
    if (action === 'import-history') setShowHistory(true)
    if (action === 'inbox') setShowInbox(true)
    if (action === 'plan-viewer') setShowPlan(true)
    if (action === 'feature-board') setShowBoard(true)
    if (action === 'pipeline-editor') setShowPipelineEditor(true)
    if (action === 'agent-tree') setShowTree(true)
    if (action === 'manage-templates') setShowTemplates(true)
    if (action === 'accounts') setShowAccounts(true)
    if (action === 'config-viewer') setShowConfig(true)
    if (action === 'research') setShowResearch(true)
    if (action === 'docs-panel') setShowDocs(true)
    if (action === 'knowledge') setShowKnowledge(true)
    if (action === 'peer-messages') setShowPeerMessages(true)
    if (action === 'memory-search') setShowMemory(true)
    if (action === 'shortcuts') setShowShortcuts(true)
    if (action === 'scratchpad') setShowScratchpad((s) => !s)
    if (action === 'split-view') toggleSplitView()
    if (action === 'preview') setShowPreviewPalette(true)
    if (action === 'marketplace') { setMarketplaceTab(null); setShowMarketplace(true) }
    if (action === 'quick-actions') setShowQuickActionPalette(true)
    if (action === 'skills-library') { setMarketplaceTab('skills'); setShowMarketplace(true) }
    if (action === 'experimental') setShowExperimental(true)
    if (action === 'safety') setShowSafety(true)
    if (action === 'cascades') { setPromptsStartTab('cascades'); setShowPrompts(true) }
    if (action === 'general-settings') setShowGeneralSettings(true)
    if (action === 'sound-settings') setShowSoundSettings(true)
    if (action === 'workspace-settings') { setWsSettingsInitialId(useStore.getState().activeWorkspaceId); setShowWorkspaceSettings(true) }
    if (action === 'add-workspace') {
      api.browseFolder().then(({ path }) => {
        if (path) api.createWorkspace(path).then((ws) => {
          const store = useStore.getState()
          store.setWorkspaces([...store.workspaces, ws])
          store.setActiveWorkspace(ws.id)
        })
      }).catch(() => {})
    }
    if (action === 'grid-layout-editor') setShowGridEditor(true)
    if (action === 'code-review') setShowCodeReview(true)
    if (action === 'annotate') setShowAnnotator(true)
    if (action === 'distill-session') setShowDistill(true)
    if (action === 'quick-feature') { setQuickFeaturePrefill(''); setQuickFeatureVoice(false); setShowQuickFeature(true) }
  }

  const executeHomeAction = useCallback((actionId) => {
    // Panel openers
    const panels = {
      'prompt-library': () => { setPromptsStartCreate(false); setShowPrompts(true) },
      'new-prompt': () => { setPromptsStartCreate(true); setShowPrompts(true) },
      'guidelines': () => setShowGuidelines(true),
      'mcp-servers': () => setShowMcpServers(true),
      'broadcast': () => setShowBroadcast(true),
      'search': () => setShowSearch(true),
      'mission-control': () => setShowMission(true),
      'import-history': () => setShowHistory(true),
      'inbox': () => setShowInbox(true),
      'plan-viewer': () => setShowPlan(true),
      'feature-board': () => setShowBoard(true),
      'pipeline-editor': () => setShowPipelineEditor(true),
      'agent-tree': () => setShowTree(true),
      'manage-templates': () => setShowTemplates(true),
      'accounts': () => setShowAccounts(true),
      'config-viewer': () => setShowConfig(true),
      'research': () => setShowResearch(true),
      'docs-panel': () => setShowDocs(true),
      'knowledge': () => setShowKnowledge(true),
      'peer-messages': () => setShowPeerMessages(true),
      'memory-search': () => setShowMemory(true),
      'shortcuts': () => setShowShortcuts(true),
      'scratchpad': () => setShowScratchpad((s) => !s),
      'split-view': () => toggleSplitView(),
      'preview': () => setShowPreviewPalette(true),
      'marketplace': () => { setMarketplaceTab(null); setShowMarketplace(true) },
      'skills-library': () => { setMarketplaceTab('skills'); setShowMarketplace(true) },
      'quick-actions': () => setShowQuickActionPalette(true),
      'experimental': () => setShowExperimental(true),
      'safety': () => setShowSafety(true),
      'cascades': () => { setPromptsStartTab('cascades'); setShowPrompts(true) },
      'general-settings': () => setShowGeneralSettings(true),
      'sound-settings': () => setShowSoundSettings(true),
      'workspace-settings': () => { setWsSettingsInitialId(useStore.getState().activeWorkspaceId); setShowWorkspaceSettings(true) },
      'add-workspace': () => {
        api.browseFolder().then(({ path }) => {
          if (path) api.createWorkspace(path).then((ws) => {
            const store = useStore.getState()
            store.setWorkspaces([...store.workspaces, ws])
            store.setActiveWorkspace(ws.id)
          })
        }).catch(() => {})
      },
      'code-review': () => setShowCodeReview(true),
      'annotate': () => setShowAnnotator(true),
      'quick-feature': () => { setQuickFeaturePrefill(''); setQuickFeatureVoice(false); setShowQuickFeature(true) },
      'toggle-sidebar': () => useStore.setState((s) => ({ sidebarVisible: !s.sidebarVisible })),
    }
    if (panels[actionId]) { panels[actionId](); return }

    const store = useStore.getState()
    switch (actionId) {
      case 'new-session': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) api.createSession(wsId).then((s) => { store.addSession(s); useStore.setState({ showHome: false }) })
        break
      }
      case 'close-tab':
        if (store.activeSessionId) store.closeTab(store.activeSessionId)
        break
      case 'stop-session':
        if (store.activeSessionId) store.stopSession(store.activeSessionId)
        break
      case 'restart-session':
        if (store.activeSessionId && store.sessions[store.activeSessionId]?.status === 'exited')
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
      case 'start-commander': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) api.startCommander(wsId).then((s) => { store.addSession(s); useStore.setState({ showHome: false }) })
        break
      }
      case 'start-documentor': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) api.startDocumentor(wsId).then((s) => {
          store.addSession(s); useStore.setState({ showHome: false })
          setTimeout(() => {
            sendTerminalCommand(s.id, 'Begin documenting this project now. Start with get_knowledge_base() to understand the product, then scaffold_docs() and systematically document each feature with screenshots and GIF demos. Build the site when done.')
          }, 3000)
        })
        break
      }
      case 'save-template': {
        const sess = store.sessions[store.activeSessionId]
        if (sess) {
          const tname = prompt('Template name:', `${sess.model} ${sess.permission_mode} ${sess.effort}`)
          if (tname?.trim()) {
            Promise.all([
              api.getSessionGuidelines(sess.id),
              fetch(`/api/sessions/${sess.id}/turns`).then((r) => r.json()),
            ]).then(([guidelines, turns]) => {
              api.createTemplate({
                name: tname.trim(), model: sess.model, permission_mode: sess.permission_mode,
                effort: sess.effort, budget_usd: sess.budget_usd, system_prompt: sess.system_prompt,
                allowed_tools: sess.allowed_tools, guideline_ids: guidelines.map((g) => g.id),
                conversation_turns: turns || [],
              })
            })
          }
        }
        break
      }
    }
  }, [toggleSplitView])

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary">
      {sidebarVisible && <Sidebar />}
      <main className="flex-1 flex flex-col min-w-0">
        <SessionTabs />
        {activeSessionId && !showHome && <TopBar />}
        {activeSessionId && !showHome && (
          <div className="flex items-center">
            <div className="flex-1"><QuickActions /></div>
            {/* Plan button — always shown for non-commander sessions */}
            {activeSessionId && sessions[activeSessionId]?.session_type !== 'commander' && (
              <button
                onClick={() => setShowPlan(true)}
                className={`flex items-center gap-1.5 px-2.5 py-1 mr-1 text-[11px] font-medium border rounded-md transition-colors ${
                  planFilePaths[activeSessionId] || (activePlan && activePlan.sessionId === activeSessionId)
                    ? 'bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 border-indigo-500/20'
                    : 'bg-bg-elevated hover:bg-bg-hover text-zinc-500 hover:text-zinc-400 border-border-primary'
                }`}
              >
                {activePlan && activePlan.sessionId === activeSessionId ? `Plan (${activePlan.items.length})` : 'Plan'}
              </button>
            )}
            {/* Input needed indicator — separate from plan */}
            {activeSessionId && planWaiting[activeSessionId] && (
              <span className="px-2.5 py-1 mr-2 text-[11px] font-medium bg-orange-500/15 text-orange-400 border border-orange-500/25 rounded-md animate-subtle-pulse">
                Input needed
              </span>
            )}
          </div>
        )}

        {openTabs.length > 0 && !showHome ? (
          <div className="flex-1 flex min-h-0">
          {viewMode === 'grid' && activeGridTemplateId && (() => {
            /* ─── Custom Grid Template ─── */
            const activeTpl = gridTemplates.find((t) => t.id === activeGridTemplateId)
            if (!activeTpl) return null
            const totalRows = Math.max(1, ...activeTpl.cells.map((c) => (c.row || 1) + (c.rowSpan || 1) - 1))
            const tplAssignments = activeTpl.cell_assignments || {}
            return (
              <div
                className="flex-1 grid min-h-0 gap-1 p-1 overflow-y-auto"
                style={{
                  gridTemplateColumns: `repeat(${activeTpl.cols}, 1fr)`,
                  gridTemplateRows: `repeat(${totalRows}, minmax(${gridMinRowHeight}px, 1fr))`,
                }}
              >
                {activeTpl.cells.map((cell, i) => {
                  let sessionId = tplAssignments[cell.id]
                  if (
                    sessionId &&
                    tabScope === 'workspace' &&
                    activeWorkspaceId &&
                    sessions[sessionId]?.workspace_id !== activeWorkspaceId
                  ) {
                    sessionId = null
                  }
                  const s = sessionId ? sessions[sessionId] : null
                  const ws = s ? workspaces.find((w) => w.id === s.workspace_id) : null
                  const wsColor = getWorkspaceColor(ws)
                  const isFocused = sessionId && activeSessionId === sessionId
                  return (
                    <div
                      key={cell.id}
                      className="relative flex flex-col min-h-0 rounded overflow-hidden transition-all group/grid-cell"
                      style={{
                        gridColumn: `${cell.col} / span ${cell.colSpan}`,
                        gridRow: `${cell.row} / span ${cell.rowSpan}`,
                        border: `${isFocused ? '2px' : '1px'} ${s ? 'solid' : 'dashed'} ${s ? (isFocused ? wsColor : wsColor + '55') : 'var(--color-border-secondary)'}`,
                        boxShadow: isFocused ? `0 0 8px ${wsColor}30` : 'none',
                      }}
                      onMouseDownCapture={() => {
                        if (sessionId) {
                          useStore.getState().setActiveSession(sessionId)
                          requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
                        }
                      }}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes('session-id')) {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                        }
                      }}
                      onDrop={(e) => {
                        const sid = e.dataTransfer.getData('session-id')
                        if (!sid) return
                        e.preventDefault()
                        e.stopPropagation()
                        const store = useStore.getState()
                        if (!store.openTabs.includes(sid)) store.openSession(sid)
                        store.assignSessionToCell(activeTpl.id, cell.id, sid)
                      }}
                    >
                      {s ? (
                        <>
                          <div
                            className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-inset border-b text-[10px] shrink-0"
                            style={{ borderBottomColor: wsColor + (isFocused ? '60' : '25') }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.status === 'running' ? '#4ade80' : '#52525b' }} />
                            <span className="text-text-secondary truncate flex-1 font-medium">{s.name}</span>
                            <span className="text-text-faint font-mono">{s.model}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                useStore.getState().assignSessionToCell(activeTpl.id, cell.id, null)
                              }}
                              className="opacity-0 group-hover/grid-cell:opacity-100 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded p-0.5 -mr-1 transition-all"
                              title="Unassign session from this cell"
                            >
                              <X size={10} />
                            </button>
                          </div>
                          <div className="flex-1 min-h-0">
                            <TerminalView sessionId={sessionId} />
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-center px-3">
                          <div>
                            <div className="text-[10px] font-mono text-text-faint/70">cell {i + 1}</div>
                            <div className="text-[10px] text-text-faint mt-1">drag a session here</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
          {/* ─── Unified Terminal Layer ───────────────────────────────────
              Terminals are rendered in a SINGLE stable container for both
              built-in grid and tab views. When switching viewMode, only CSS
              changes — TerminalView components stay mounted, preserving
              scrollback, renderer state, and avoiding remount/refit races.
              Custom grid templates (above) are separate because they iterate
              cells rather than sessions. */}
          {!(viewMode === 'grid' && activeGridTemplateId) && (() => {
            const isGrid = viewMode === 'grid'
            // Compute built-in grid layout styles
            let gridStyle = {}
            let gridNonFocusCounter = 0
            if (isGrid) {
              const n = visibleTabs.length
              const others = Math.max(1, n - 1)
              const rowMinmax = `minmax(${gridMinRowHeight}px, 1fr)`
              if (n > 1 && gridLayout === 'focusRight') {
                gridStyle = {
                  gridTemplateColumns: '2fr 1fr',
                  gridTemplateRows: `repeat(${others}, ${rowMinmax})`,
                }
              } else if (n > 1 && gridLayout === 'focusBottom') {
                gridStyle = {
                  gridTemplateColumns: `repeat(${others}, 1fr)`,
                  gridTemplateRows: `${gridMinRowHeight * 2}px ${gridMinRowHeight}px`,
                }
              } else {
                gridStyle = {
                  gridTemplateColumns: `repeat(${n <= 2 ? n : n <= 4 ? 2 : 3}, 1fr)`,
                  gridAutoRows: rowMinmax,
                }
              }
            }
            const getGridPlacement = (id, isFocused) => {
              if (!isGrid) return undefined
              const n = visibleTabs.length
              const others = Math.max(1, n - 1)
              if (n <= 1 || gridLayout === 'equal') return undefined
              if (gridLayout === 'focusRight') {
                if (isFocused) return { gridColumn: 1, gridRow: `1 / span ${others}` }
                const row = ++gridNonFocusCounter
                return { gridColumn: 2, gridRow: row }
              }
              if (gridLayout === 'focusBottom') {
                if (isFocused) return { gridColumn: `1 / span ${others}`, gridRow: 1 }
                const col = ++gridNonFocusCounter
                return { gridColumn: col, gridRow: 2 }
              }
              return undefined
            }

            return (
            <div
              className={`flex-1 min-h-0 ${isGrid ? 'grid gap-1 p-1 overflow-y-auto' : 'relative min-w-0'}`}
              style={isGrid ? gridStyle : {}}
              onDragOver={!isGrid ? (e) => {
                if (e.dataTransfer.types.includes('session-id')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }
              } : undefined}
              onDrop={!isGrid ? (e) => {
                const sid = e.dataTransfer.getData('session-id')
                if (sid && sid !== activeSessionId) {
                  const store = useStore.getState()
                  if (!store.openTabs.includes(sid)) store.openSession(sid)
                  useStore.setState({ splitMode: true, splitSessionId: sid })
                }
              } : undefined}
            >
              {openTabs.map((id) => {
                const s = sessions[id]
                const isActiveTab = activeSessionId === id
                const ws = workspaces.find((w) => w.id === s?.workspace_id)
                const wsColor = getWorkspaceColor(ws)
                const gridVisible = isGrid && visibleTabs.includes(id)
                const isSplit = !isGrid && hasSplit && splitSessionId === id
                const tabVisible = !isGrid && (isActiveTab || isSplit)

                // Grid mode: non-visible tabs stay mounted but hidden
                if (isGrid && !gridVisible) {
                  return (
                    <div key={id} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }}>
                      <div key="terminal" className="flex-1 min-h-0">
                        <TerminalView sessionId={id} />
                      </div>
                    </div>
                  )
                }

                const placement = getGridPlacement(id, isActiveTab)

                return (
                  <div
                    key={id}
                    className={isGrid
                      ? 'relative flex flex-col min-h-0 rounded overflow-hidden transition-all group/grid-cell'
                      : 'absolute top-0 bottom-0 flex flex-col'
                    }
                    style={isGrid ? {
                      border: `${isActiveTab ? '2px' : '1px'} solid ${isActiveTab ? wsColor : wsColor + '55'}`,
                      boxShadow: isActiveTab ? `0 0 8px ${wsColor}30` : 'none',
                      ...(placement || {}),
                    } : {
                      left: isSplit ? `${splitRatio}%` : 0,
                      right: (hasSplit && isActiveTab) ? `${100 - splitRatio}%` : 0,
                      opacity: tabVisible ? 1 : 0,
                      pointerEvents: tabVisible ? 'auto' : 'none',
                      zIndex: tabVisible ? 1 : 0,
                    }}
                    onMouseDownCapture={isGrid ? () => {
                      useStore.getState().setActiveSession(id)
                      requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
                    } : undefined}
                  >
                    {/* Grid cell header — only in grid mode */}
                    {isGrid && (
                      <div key="header" className="flex items-center gap-1.5 px-2 py-0.5 bg-bg-inset border-b text-[10px] shrink-0" style={{ borderBottomColor: wsColor + (isActiveTab ? '60' : '25') }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s?.status === 'running' ? '#4ade80' : '#52525b' }} />
                        <span className="text-text-secondary truncate flex-1 font-medium">{s?.name}</span>
                        <span className="text-text-faint font-mono">{s?.model}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            useStore.getState().closeTab(id)
                          }}
                          className="opacity-0 group-hover/grid-cell:opacity-100 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded p-0.5 -mr-1 transition-all"
                          title="Close (⌘W)"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    )}
                    <div key="terminal" className="flex-1 min-h-0">
                      <TerminalView sessionId={id} />
                    </div>
                  </div>
                )
              })}

              {/* Split divider overlay — tab mode only */}
              {!isGrid && hasSplit && (
                <div
                  className="absolute top-0 bottom-0 z-10 flex flex-col items-center group/split"
                  style={{ left: `${splitRatio}%`, transform: 'translateX(-50%)' }}
                >
                  <div
                    className="flex-1 w-[3px] bg-border-primary hover:bg-accent-primary/60 cursor-col-resize transition-colors"
                    onMouseDown={handleSplitDragStart}
                  />
                  <button
                    onClick={() => useStore.setState({ splitMode: false, splitSessionId: null })}
                    className="absolute top-2 bg-bg-tertiary border border-border-primary hover:bg-red-500/20 hover:border-red-500/30 text-text-faint hover:text-red-400 rounded-full w-5 h-5 flex items-center justify-center text-xs z-10 transition-all opacity-0 group-hover/split:opacity-100"
                    title="Close split (⌘D)"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
            )
          })()}

            {showScratchpad && activeSessionId && (
              <Scratchpad sessionId={activeSessionId} onClose={() => setShowScratchpad(false)} />
            )}
            {viewingSubagent && (
              <SubagentViewer
                sessionId={viewingSubagent.sessionId}
                agentId={viewingSubagent.agentId}
                onClose={() => useStore.getState().clearViewingSubagent()}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 bg-bg-primary overflow-y-auto">
            <div className="w-full px-8 pt-3 pb-6">
              {/* Header row: logo + preferences */}
              <div className="flex items-start justify-between gap-6 mb-6">
                <div className="flex items-center gap-4 select-none shrink-0">
                  <svg className="opacity-40" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="56" height="56">
                    <g transform="translate(100,95)"><g transform="translate(-60,-55)">
                      <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#00f0ff" opacity="0.78" transform="translate(-8.4,0) rotate(-7,60,120)"/>
                      <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#8b5cf6" opacity="0.78"/>
                      <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#d946ef" opacity="0.78" transform="translate(8.4,0) rotate(7,60,120)"/>
                      <circle cx="60" cy="120" r="2.5" fill="#fff" opacity="0.9"/>
                    </g></g>
                  </svg>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-text-secondary text-[28px] font-mono font-extrabold tracking-[0.15em] leading-none">IVE</span>
                      <span className="text-text-faint/50 text-[10px] font-mono">v1.0.0</span>
                    </div>
                    <span className="text-text-muted text-[9px] font-mono tracking-[0.2em] uppercase leading-none">Humanity's Last IDE</span>
                    <span className="text-text-faint text-[8px] font-mono tracking-[0.15em] uppercase leading-none mt-0.5">Integrated Vibecoding Environment</span>
                  </div>
                </div>


                {/* Preferences panel */}
                <div className="shrink-0 bg-bg-secondary/40 border border-border-secondary rounded-lg p-3 space-y-2">
                  <div className="text-[9px] text-text-faint uppercase tracking-widest font-semibold mb-1.5">Preferences</div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-24">Home columns</span>
                    <div className="flex gap-1">
                      {[2, 3, 4].map((n) => (
                        <button
                          key={n}
                          onClick={() => useStore.getState().setHomeColumns(n)}
                          className={`w-6 h-6 text-[11px] font-mono rounded transition-colors ${
                            homeColumns === n
                              ? 'bg-accent-primary text-white'
                              : 'bg-bg-tertiary text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-border-secondary'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-24">Grid row height</span>
                    <div className="flex gap-1">
                      {[150, 200, 300, 400].map((px) => (
                        <button
                          key={px}
                          onClick={() => useStore.getState().setGridMinRowHeight(px)}
                          className={`h-6 px-1.5 text-[10px] font-mono rounded transition-colors ${
                            gridMinRowHeight === px
                              ? 'bg-accent-primary text-white'
                              : 'bg-bg-tertiary text-text-faint hover:text-text-secondary hover:bg-bg-hover border border-border-secondary'
                          }`}
                        >
                          {px}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-24">Custom height</span>
                    <input
                      type="number"
                      min={80}
                      max={1200}
                      step={10}
                      value={gridMinRowHeight}
                      onChange={(e) => {
                        const v = parseInt(e.target.value)
                        if (!isNaN(v) && v >= 80) useStore.getState().setGridMinRowHeight(v)
                      }}
                      className="w-16 px-1.5 py-0.5 text-[10px] font-mono bg-bg-inset border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary/50"
                    />
                    <span className="text-[10px] text-text-faint">px</span>
                  </div>

                  <button
                    onClick={() => useStore.getState().setTerminalAutoFit(!terminalAutoFit)}
                    className="flex items-center gap-2 w-full pt-1 mt-1 border-t border-border-secondary/50 group"
                    title="When on, terminal font size scales down so the 80×24 floor fits the cell exactly (no clipping)"
                  >
                    <span className="text-[10px] text-text-secondary w-24 text-left">Auto-fit terminal</span>
                    <span
                      className={`relative inline-block w-7 h-3.5 rounded-full transition-colors ${
                        terminalAutoFit ? 'bg-accent-primary' : 'bg-bg-tertiary border border-border-secondary'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${
                          terminalAutoFit ? 'left-3.5' : 'left-0.5'
                        }`}
                      />
                    </span>
                    <span className="text-[10px] text-text-faint">{terminalAutoFit ? 'on' : 'off'}</span>
                  </button>
                </div>
              </div>

              {/* Sections grid */}
              <div
                className="gap-3"
                style={{ columns: homeColumns, columnGap: '0.75rem' }}
              >
                {(() => {
                  const sections = {}
                  CMD_ACTIONS.forEach((a) => {
                    if (!sections[a.section]) sections[a.section] = []
                    sections[a.section].push(a)
                  })
                  // Sort: alternate large and small sections for balanced columns
                  const entries = Object.entries(sections)
                  entries.sort((a, b) => b[1].length - a[1].length)
                  const balanced = []
                  let lo = 0, hi = entries.length - 1
                  while (lo <= hi) {
                    balanced.push(entries[lo++])
                    if (lo <= hi) balanced.push(entries[hi--])
                  }
                  return balanced.map(([section, actions]) => (
                    <div key={section} className="bg-bg-secondary/30 border border-border-secondary rounded-lg p-3 mb-3 break-inside-avoid">
                      <div className="text-[10px] text-text-faint uppercase tracking-widest font-semibold mb-2">{section}</div>
                      <div className="flex flex-col gap-1">
                        {actions.map((action) => {
                          const Icon = action.icon
                          return (
                            <button
                              key={action.id}
                              onClick={() => executeHomeAction(action.id)}
                              className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium bg-bg-tertiary/60 hover:bg-bg-hover text-text-secondary hover:text-text-primary border border-border-primary/50 hover:border-border-secondary rounded-md transition-all w-full text-left"
                            >
                              <Icon size={12} className="text-text-faint shrink-0" />
                              <span className="flex-1 truncate">{action.label}</span>
                              {action.shortcut && (
                                <kbd className="text-[9px] text-text-faint bg-bg-secondary px-1 py-0.5 rounded border border-border-secondary font-mono shrink-0">{action.shortcut}</kbd>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                })()}
              </div>

            </div>
          </div>
        )}

        {showComposer && activeSessionId && (
          <Composer
            sessionId={activeSessionId}
            initialValue={composerDraft}
            onClose={() => { setShowComposer(false); setComposerDraft('') }}
          />
        )}

        <CascadeBar />
        <CascadeVariableDialog />
        <StatusBar />
      </main>

      {showCommand && <CommandPalette onClose={() => setShowCommand(false)} onAction={handleCommandAction} />}
      {showPrompts && <PromptPalette startInCreate={promptsStartCreate} startTab={promptsStartTab} onClose={() => { setShowPrompts(false); setPromptsStartCreate(false); setPromptsStartTab('prompts') }} />}
      {showGuidelines && <GuidelinePanel onClose={() => setShowGuidelines(false)} />}
      {showMcpServers && <McpPanel onClose={() => setShowMcpServers(false)} />}
      {showBroadcast && <BroadcastBar onClose={() => setShowBroadcast(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      {showMission && <MissionControl onClose={() => setShowMission(false)} />}
      {showHistory && <HistoryImport onClose={() => setShowHistory(false)} />}
      {showInbox && <InboxPanel onClose={() => setShowInbox(false)} />}
      {showPlan && <PlanViewer onClose={() => setShowPlan(false)} />}
      {showBoard && <FeatureBoard onClose={() => setShowBoard(false)} />}
      {showPipelineEditor && <PipelineEditor onClose={() => setShowPipelineEditor(false)} />}
      {showTree && <SubagentTree onClose={() => setShowTree(false)} />}
      {showTemplates && <TemplateManager onClose={() => setShowTemplates(false)} />}
      {showAccounts && <AccountManager onClose={() => setShowAccounts(false)} />}
      {showConfig && <ConfigViewer onClose={() => setShowConfig(false)} />}
      {showResearch && <ResearchPanel onClose={() => setShowResearch(false)} />}
      {showDocs && <DocsPanel onClose={() => setShowDocs(false)} />}
      {showKnowledge && <KnowledgePanel onClose={() => setShowKnowledge(false)} />}
      {showPeerMessages && <PeerMessagesPanel onClose={() => setShowPeerMessages(false)} />}
      {showMemory && <MemoryWindow onClose={() => setShowMemory(false)} />}
      {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
      {showMarketplace && <MarketplacePanel onClose={() => { setShowMarketplace(false); setMarketplaceTab(null) }} initialTab={marketplaceTab} />}
      {showQuickActionPalette && <QuickActionPalette onClose={() => setShowQuickActionPalette(false)} />}
      {showExperimental && <ExperimentalPanel onClose={() => setShowExperimental(false)} />}
      {showSafety && <SafetyPanel onClose={() => setShowSafety(false)} />}
      {showSoundSettings && <SoundSettingsPanel onClose={() => setShowSoundSettings(false)} />}
      {showGeneralSettings && <GeneralSettingsPanel onClose={() => setShowGeneralSettings(false)} />}
      {showWorkspaceSettings && <WorkspaceSettingsPanel onClose={() => setShowWorkspaceSettings(false)} initialWorkspaceId={wsSettingsInitialId} />}
      {showCodeReview && <CodeReviewPanel onClose={() => setShowCodeReview(false)} />}
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
            setComposerDraft(text)
            setShowComposer(true)
          }}
        />
      )}
      {showGridEditor && <GridTemplateEditor onClose={() => setShowGridEditor(false)} />}
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
          autoVoice={quickFeatureVoice}
          onCreated={(task) => useStore.getState().updateTaskInStore(task)}
          onClose={() => { setShowQuickFeature(false); setQuickFeaturePrefill(''); setQuickFeatureVoice(false) }}
        />
      )}

      <CodePreview />

      <NotificationToast />
    </div>
  )
}
