import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  X, Plus, Play, Pause, Square, Save, Trash2,
  Search, Code, GitBranch, CheckCircle, Eye, Zap, Wrench, Shield,
  Map, Clock, Settings, ArrowRight, RotateCcw, Sparkles, Terminal,
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getCliTypes, getModelsForCli, getPermissionModesForCli, getEffortLevelsForCli, getEffortOptionsForCli, getRoleDefaultModel, getDefaultPermissionMode } from '../../lib/constants'
import { ORCHESTRATION_ROLE_OPTIONS, defaultPolicyRoleForSessionType, getPolicyRoleConfig, parseOrchestrationPolicy } from '../../lib/orchestrationPolicy'
import PipelineRunDetail from './PipelineRunDetail'
import { emitTourEvent } from '../../lib/guidedTour'

const STAGE_ICONS = {
  search: Search, code: Code, 'git-branch': GitBranch, 'check-circle': CheckCircle,
  eye: Eye, zap: Zap, wrench: Wrench, shield: Shield, map: Map, clock: Clock,
  settings: Settings, terminal: Terminal, default: ArrowRight,
}

// Stage-type categorical encoding — theme-aware CSS vars, mapped onto the app's four
// sanctioned semantic hues (accent/warn/success + neutral) rather than a bespoke palette.
const STAGE_COLORS = {
  agent: { bg: 'var(--x-tint)', border: 'var(--x-accent)', accent: 'var(--x-accent)' },
  condition: { bg: 'var(--x-tint)', border: 'var(--x-accent-ink)', accent: 'var(--x-accent-ink)' },
  delay: { bg: 'var(--x-hover)', border: 'var(--x-line-strong)', accent: 'var(--x-muted)' },
  command: { bg: 'var(--x-good-tint)', border: 'var(--x-good)', accent: 'var(--x-good)' },
}

const STATUS_COLORS = {
  pending: 'var(--x-faint)',
  running: 'var(--x-good)',
  completed: 'var(--x-good)',
  failed: 'var(--x-accent-ink)',
  skipped: 'var(--x-muted)',
}

const CONDITION_OPTIONS = [
  { id: 'always', label: 'Always' },
  { id: 'on_pass', label: 'On Pass' },
  { id: 'on_fail', label: 'On Fail' },
  { id: 'on_match', label: 'On Match' },
]

const BOARD_COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To Do' },
  { key: 'planning', label: 'Planning' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
]

const NODE_W = 200
const NODE_H = 80

export default function PipelineEditor({ onClose }) {
  useEffect(() => { emitTourEvent('tool-opened', { toolId: 'pipeline-editor' }) }, [])
  const pipelines = useStore((s) => s.pipelines)
  const pipelineRuns = useStore((s) => s.pipelineRuns)
  const loadPipelines = useStore((s) => s.loadPipelines)
  const loadPipelineRuns = useStore((s) => s.loadPipelineRuns)
  const sessionsMap = useStore((s) => s.sessions)
  const cliProfiles = useStore((s) => s.cliProfiles)
  const sessions = useMemo(() => Object.values(sessionsMap || {}), [sessionsMap])
  const workspaces = useStore((s) => s.workspaces)
  const cliTypes = getCliTypes()
  void cliProfiles
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  )
  const workspacePolicy = useMemo(
    () => parseOrchestrationPolicy(activeWorkspace?.orchestration_policy),
    [activeWorkspace?.orchestration_policy]
  )

  const [selectedPipelineId, setSelectedPipelineId] = useState(null)
  const [pipeline, setPipeline] = useState(null)
  const [selectedStageId, setSelectedStageId] = useState(null)
  const [selectedTransitionId, setSelectedTransitionId] = useState(null)
  const [edgeInProgress, setEdgeInProgress] = useState(null)
  const [draggingNode, setDraggingNode] = useState(null)
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [showPresets, setShowPresets] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [actionError, setActionError] = useState('')
  const [acting, setActing] = useState(false)
  const actionRef = useRef(false)
  const [activeRunId, setActiveRunId] = useState(null)
  const [selectedRunDetailId, setSelectedRunDetailId] = useState(null)
  const [showVarDialog, setShowVarDialog] = useState(false)
  const [pendingVars, setPendingVars] = useState({})
  const canvasRef = useRef(null)
  const dragStartRef = useRef(null)
  const panStartRef = useRef(null)

  // Load data
  useEffect(() => {
    loadPipelines(activeWorkspaceId)
    loadPipelineRuns(activeWorkspaceId)
  }, [loadPipelines, loadPipelineRuns, activeWorkspaceId])

  // Select pipeline
  useEffect(() => {
    if (selectedPipelineId) {
      const p = pipelines.find((d) => d.id === selectedPipelineId)
      if (p) setPipeline(JSON.parse(JSON.stringify(p))) // deep clone for editing
    }
  }, [selectedPipelineId, pipelines])

  // Active run tracking
  const activeRun = useMemo(
    () => pipelineRuns.find((r) => r.id === activeRunId),
    [pipelineRuns, activeRunId]
  )

  const stageHistory = useMemo(() => {
    if (!activeRun) return {}
    return typeof activeRun.stage_history === 'string'
      ? JSON.parse(activeRun.stage_history || '{}')
      : activeRun.stage_history || {}
  }, [activeRun])

  // ── Pipeline CRUD ────────────────────────────────────────────

  const handleCreateNew = useCallback(async () => {
    const defn = await api.createPipeline({
      name: 'New Pipeline',
      workspace_id: activeWorkspaceId,
      stages: [],
      transitions: [],
      triggers: [],
      status: 'draft',
    })
    if (defn) {
      useStore.getState().loadPipelines(activeWorkspaceId)
      setSelectedPipelineId(defn.id)
      setShowPresets(false)
    }
  }, [activeWorkspaceId])

  const handleSelectPreset = useCallback(async (preset) => {
    // Clone preset into a new pipeline for this workspace
    const defn = await api.createPipeline({
      name: preset.name,
      description: preset.description,
      workspace_id: activeWorkspaceId,
      stages: preset.stages,
      transitions: preset.transitions,
      triggers: [],
      status: 'draft',
    })
    if (defn) {
      useStore.getState().loadPipelines(activeWorkspaceId)
      setSelectedPipelineId(defn.id)
      setShowPresets(false)
    }
  }, [activeWorkspaceId])

  const handleSave = useCallback(async () => {
    if (!pipeline) return
    setActionError('')
    try {
      const updated = await api.updatePipeline(pipeline.id, {
        name: pipeline.name,
        description: pipeline.description,
        stages: pipeline.stages,
        transitions: pipeline.transitions,
        triggers: pipeline.triggers,
        status: pipeline.status,
      })
      if (updated) {
        useStore.getState().updatePipelineInStore(updated)
        setDirty(false)
      }
      return updated
    } catch (error) {
      setActionError(error.message || 'Could not save this workflow. Your changes are still here.')
      return null
    }
  }, [pipeline])

  const handleDelete = useCallback(async () => {
    if (!pipeline) return
    await api.deletePipeline(pipeline.id)
    useStore.getState().removePipelineFromStore(pipeline.id)
    setPipeline(null)
    setSelectedPipelineId(null)
    setShowPresets(true)
  }, [pipeline])

  const handleActivate = useCallback(async () => {
    if (!pipeline) return
    const newStatus = pipeline.status === 'active' ? 'draft' : 'active'
    const updated = await api.updatePipeline(pipeline.id, { status: newStatus })
    if (updated) {
      setPipeline((p) => ({ ...p, status: newStatus }))
      useStore.getState().updatePipelineInStore(updated)
    }
  }, [pipeline])

  // ── Run Controls ─────────────────────────────────────────────

  // Variables auto-injected from task context — the backend fills these
  const TASK_AUTO_VARS = new Set([
    'task_id', 'task_title', 'task_description', 'task_criteria',
    'task_labels', 'task_priority', 'task_status', 'topic',
  ])

  // Extract {variable} placeholders from all stage prompt templates
  const pipelineVars = useMemo(() => {
    if (!pipeline) return { all: [], manual: [] }
    const vars = new Set()
    for (const stage of pipeline.stages || []) {
      const tpl = stage.prompt_template || ''
      for (const m of tpl.matchAll(/\{([a-zA-Z_]\w*)\}/g)) {
        vars.add(m[1])
      }
    }
    const all = [...vars]
    // Manual = variables the user needs to fill (not auto-injected from tasks)
    const manual = all.filter((v) => !TASK_AUTO_VARS.has(v))
    return { all, manual }
  }, [pipeline])

  const startSavedRun = useCallback(async (variables) => {
    if (!pipeline || actionRef.current) return
    if (!pipeline.stages?.length) {
      setActionError('Add an agent, a command, or a condition before starting your workflow.')
      return
    }
    actionRef.current = true
    setActing(true)
    setActionError('')
    try {
      if (dirty && !(await handleSave())) return
      const run = await api.startPipelineRun({ pipeline_id: pipeline.id, workspace_id: activeWorkspaceId, variables })
      if (run) {
        setActiveRunId(run.id)
        setShowVarDialog(false)
        await useStore.getState().loadPipelineRuns(activeWorkspaceId)
      }
    } catch (error) {
      setActionError(error.message || 'The workflow could not start. Review its steps and try again.')
    } finally {
      actionRef.current = false
      setActing(false)
    }
  }, [pipeline, activeWorkspaceId, dirty, handleSave])

  const handleStartRun = useCallback(async () => {
    if (!pipeline) return
    if (pipelineVars.manual.length > 0) {
      setPendingVars(Object.fromEntries(pipelineVars.manual.map((v) => [v, ''])))
      setShowVarDialog(true)
      return
    }
    await startSavedRun({})
  }, [pipeline, pipelineVars, startSavedRun])

  const handleConfirmRun = useCallback(() => startSavedRun(pendingVars), [startSavedRun, pendingVars])

  const handleRunAction = useCallback(async (action) => {
    if (!activeRunId || actionRef.current) return
    actionRef.current = true
    setActing(true)
    setActionError('')
    try {
      const updated = await api.updatePipelineRun(activeRunId, action)
      if (updated?.id) useStore.getState().handlePipelineRunUpdate(updated)
    } catch (error) {
      setActionError(error.message || `Could not ${action} this workflow.`)
    } finally {
      actionRef.current = false
      setActing(false)
    }
  }, [activeRunId])

  const handlePauseRun = useCallback(() => handleRunAction('pause'), [handleRunAction])
  const handleCancelRun = useCallback(() => handleRunAction('cancel'), [handleRunAction])

  // ── Stage Operations ─────────────────────────────────────────

  const addStage = useCallback((type = 'agent') => {
    if (!pipeline) return
    const id = `stage-${Date.now()}`
    const defaultConfig = type === 'condition'
      ? { mode: 'keyword', icon: 'git-branch', pass_keywords: ['pass', 'success'], fail_keywords: ['fail', 'error'] }
      : type === 'command'
        ? {
            icon: 'terminal',
            command: '',
            cwd: '',
            timeout_seconds: 300,
            policy: { mode: 'safety_checked' },
          }
        : { icon: 'code' }
    const newStage = {
      id,
      name: type === 'condition' ? 'Evaluate' : type === 'command' ? 'Command' : 'New Stage',
      type,
      session_id: null,
      session_type: type === 'agent' ? 'worker' : null,
      prompt_template: '',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 100 },
      config: defaultConfig,
      agent_config: type === 'agent' ? {} : undefined,
    }
    setPipeline((p) => ({ ...p, stages: [...p.stages, newStage] }))
    setSelectedStageId(id)
    setDirty(true)
  }, [pipeline])

  const updateStage = useCallback((stageId, updates) => {
    setPipeline((p) => ({
      ...p,
      stages: p.stages.map((s) => (s.id === stageId ? { ...s, ...updates } : s)),
    }))
    setDirty(true)
  }, [])

  const deleteStage = useCallback((stageId) => {
    setPipeline((p) => ({
      ...p,
      stages: p.stages.filter((s) => s.id !== stageId),
      transitions: p.transitions.filter((t) => t.source !== stageId && t.target !== stageId),
    }))
    if (selectedStageId === stageId) setSelectedStageId(null)
    setDirty(true)
  }, [selectedStageId])

  // ── Transition Operations ────────────────────────────────────

  const addTransition = useCallback((sourceId, targetId) => {
    if (!pipeline || sourceId === targetId) return
    // Don't duplicate
    if (pipeline.transitions.some((t) => t.source === sourceId && t.target === targetId)) return
    const id = `t-${Date.now()}`
    setPipeline((p) => ({
      ...p,
      transitions: [...p.transitions, {
        id, source: sourceId, target: targetId,
        condition: 'always', condition_config: {}, label: '',
      }],
    }))
    setDirty(true)
  }, [pipeline])

  const updateTransition = useCallback((tid, updates) => {
    setPipeline((p) => ({
      ...p,
      transitions: p.transitions.map((t) => (t.id === tid ? { ...t, ...updates } : t)),
    }))
    setDirty(true)
  }, [])

  const deleteTransition = useCallback((tid) => {
    setPipeline((p) => ({
      ...p,
      transitions: p.transitions.filter((t) => t.id !== tid),
    }))
    if (selectedTransitionId === tid) setSelectedTransitionId(null)
    setDirty(true)
  }, [selectedTransitionId])

  // ── Trigger Operations ───────────────────────────────────────

  const addTrigger = useCallback((type = 'manual') => {
    if (!pipeline) return
    setPipeline((p) => ({
      ...p,
      triggers: [...(p.triggers || []), {
        type, config: {}, filters: {}, guards: {}, enabled: true,
      }],
    }))
    setDirty(true)
  }, [pipeline])

  const updateTrigger = useCallback((idx, updates) => {
    setPipeline((p) => ({
      ...p,
      triggers: p.triggers.map((t, i) => (i === idx ? { ...t, ...updates } : t)),
    }))
    setDirty(true)
  }, [])

  const removeTrigger = useCallback((idx) => {
    setPipeline((p) => ({
      ...p,
      triggers: p.triggers.filter((_, i) => i !== idx),
    }))
    setDirty(true)
  }, [])

  // ── Canvas Interactions ──────────────────────────────────────

  const handleCanvasMouseDown = useCallback((e) => {
    if (e.target === canvasRef.current || e.target.tagName === 'svg') {
      setSelectedStageId(null)
      setSelectedTransitionId(null)
      if (edgeInProgress) {
        setEdgeInProgress(null)
        return
      }
      panStartRef.current = { x: e.clientX - canvasOffset.x, y: e.clientY - canvasOffset.y }
      const onMove = (me) => {
        setCanvasOffset({ x: me.clientX - panStartRef.current.x, y: me.clientY - panStartRef.current.y })
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }, [canvasOffset, edgeInProgress])

  const handleNodeMouseDown = useCallback((stageId, e) => {
    e.stopPropagation()
    setSelectedStageId(stageId)
    setSelectedTransitionId(null)
    const stage = pipeline?.stages.find((s) => s.id === stageId)
    if (!stage) return
    const startX = e.clientX
    const startY = e.clientY
    const startPos = { ...stage.position }
    setDraggingNode(stageId)

    const onMove = (me) => {
      const dx = (me.clientX - startX) / zoom
      const dy = (me.clientY - startY) / zoom
      updateStage(stageId, { position: { x: startPos.x + dx, y: startPos.y + dy } })
    }
    const onUp = () => {
      setDraggingNode(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pipeline, zoom, updateStage])

  const handlePortClick = useCallback((stageId, e) => {
    e.stopPropagation()
    if (!edgeInProgress) {
      setEdgeInProgress({ from: stageId })
    } else if (edgeInProgress.from !== stageId) {
      addTransition(edgeInProgress.from, stageId)
      setEdgeInProgress(null)
    }
  }, [edgeInProgress, addTransition])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.05 : 0.05
    setZoom((z) => Math.max(0.3, Math.min(2, z + delta)))
  }, [])

  // ── Keyboard ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (selectedStageId || selectedTransitionId) {
          setSelectedStageId(null)
          setSelectedTransitionId(null)
        } else if (edgeInProgress) {
          setEdgeInProgress(null)
        } else {
          onClose()
        }
        e.stopPropagation()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedStageId && !e.target.closest('input, textarea, select')) {
          deleteStage(selectedStageId)
        }
        if (selectedTransitionId && !e.target.closest('input, textarea, select')) {
          deleteTransition(selectedTransitionId)
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [selectedStageId, selectedTransitionId, edgeInProgress, onClose, handleSave, deleteStage, deleteTransition])

  // ── Render Helpers ───────────────────────────────────────────

  const getStageStatus = (stageId) => {
    if (!activeRun) return null
    return stageHistory[stageId]?.status || 'pending'
  }

  const renderEdge = (transition) => {
    if (!pipeline) return null
    const src = pipeline.stages.find((s) => s.id === transition.source)
    const tgt = pipeline.stages.find((s) => s.id === transition.target)
    if (!src || !tgt) return null

    const x1 = src.position.x + NODE_W
    const y1 = src.position.y + NODE_H / 2
    const x2 = tgt.position.x
    const y2 = tgt.position.y + NODE_H / 2
    const cx1 = x1 + Math.min(80, Math.abs(x2 - x1) * 0.4)
    const cx2 = x2 - Math.min(80, Math.abs(x2 - x1) * 0.4)

    const isSelected = selectedTransitionId === transition.id
    const condColor = transition.condition === 'on_pass' ? 'var(--x-good)'
      : transition.condition === 'on_fail' ? 'var(--x-accent-ink)'
      : transition.condition === 'on_match' ? 'var(--x-accent-ink)'
      : 'var(--x-accent)'

    // Animate if this transition is actively flowing
    const srcStatus = getStageStatus(transition.source)
    const tgtStatus = getStageStatus(transition.target)
    const isFlowing = srcStatus === 'completed' && tgtStatus === 'running'

    return (
      <g key={transition.id} onClick={(e) => { e.stopPropagation(); setSelectedTransitionId(transition.id); setSelectedStageId(null) }}>
        <path
          d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke={isSelected ? 'var(--x-accent-ink)' : condColor}
          strokeWidth={isSelected ? 2.5 : 1.5}
          strokeDasharray={isFlowing ? '8 4' : 'none'}
          style={isFlowing ? { animation: 'dash 0.6s linear infinite' } : {}}
          className="cursor-pointer"
        />
        {/* Arrow head */}
        <polygon
          points={`${x2},${y2} ${x2 - 8},${y2 - 4} ${x2 - 8},${y2 + 4}`}
          fill={isSelected ? 'var(--x-accent-ink)' : condColor}
        />
        {/* Condition label */}
        {transition.condition !== 'always' && (
          <text
            x={(x1 + x2) / 2}
            y={(y1 + y2) / 2 - 8}
            textAnchor="middle"
            fill={condColor}
            fontSize="10"
            fontWeight="500"
            className="pointer-events-none select-none"
          >
            {transition.label || transition.condition.replace('on_', '')}
          </text>
        )}
      </g>
    )
  }

  // ── Render ───────────────────────────────────────────────────

  if (!pipeline && showPresets) {
    return (
      <div className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col" onClick={onClose}>
        <div className="flex-1 flex flex-col m-4 x-panel shadow-x-3 overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-x-line">
            <div className="flex items-center gap-2">
              <GitBranch size={16} className="text-x-accent" />
              <span className="text-sm font-semibold text-x-ink">Pipeline Editor</span>
            </div>
            <button onClick={onClose} className="p-1 rounded-md text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"><X size={16} /></button>
          </div>

          {/* Presets + list */}
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-lg font-semibold text-x-ink mb-1">Choose a Pipeline</h2>
              <p className="text-sm text-x-muted mb-6">A pipeline is a reusable workflow: connect AI work, checks, and decisions. Start with a preset, then adapt its steps.</p>

              {/* Presets grid */}
              <div className="grid grid-cols-2 gap-3 mb-8">
                {pipelines.filter((p) => p.preset).map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => handleSelectPreset(preset)}
                    className="text-left p-4 bg-x-surface border border-x-line rounded-lg hover:border-x-line-strong hover:bg-x-hover transition-colors duration-[80ms] ease-x"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={14} className="text-x-accent" />
                      <span className="text-sm font-medium text-x-ink-secondary">{preset.name}</span>
                    </div>
                    <p className="text-xs text-x-muted leading-relaxed">{preset.description}</p>
                    <div className="mt-2 flex gap-1">
                      {(preset.stages || []).map((s) => {
                        const Icon = STAGE_ICONS[s.config?.icon] || STAGE_ICONS.default
                        const colors = STAGE_COLORS[s.type] || STAGE_COLORS.agent
                        return (
                          <span key={s.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px]"
                            style={{ background: colors.bg, color: colors.accent, border: `1px solid ${colors.border}` }}>
                            <Icon size={10} />{s.name}
                          </span>
                        )
                      })}
                    </div>
                  </button>
                ))}
              </div>

              {/* Custom pipelines */}
              {pipelines.filter((p) => !p.preset).length > 0 && (
                <>
                  <h3 className="text-sm font-medium text-x-ink-secondary mb-3">Your Pipelines</h3>
                  <div className="space-y-2 mb-6">
                    {pipelines.filter((p) => !p.preset).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedPipelineId(p.id); setShowPresets(false) }}
                        className="w-full text-left p-3 bg-x-surface-2 border border-x-line rounded-lg hover:border-x-line-strong hover:bg-x-hover transition-colors duration-[80ms] ease-x flex items-center justify-between"
                      >
                        <div>
                          <span className="text-sm text-x-ink-secondary">{p.name}</span>
                          <span className="ml-2 text-xs text-x-muted">{(p.stages || []).length} stages</span>
                        </div>
                        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md ${p.status === 'active' ? 'bg-x-good/15 text-x-good' : 'bg-x-surface text-x-faint'}`}>
                          {p.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <button
                onClick={handleCreateNew}
                className="flex items-center gap-2 h-[30px] px-4 bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md text-[13px] font-medium active:scale-[0.98] transition-colors duration-[80ms] ease-x"
              >
                <Plus size={14} strokeWidth={1.75} /> Create Blank Pipeline
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!pipeline) return null

  const selectedStage = pipeline.stages.find((s) => s.id === selectedStageId)
  const selectedTransition = pipeline.transitions.find((t) => t.id === selectedTransitionId)

  return (
    <div className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col m-3 x-panel shadow-x-3 overflow-hidden" onClick={(e) => e.stopPropagation()}>

        {actionError && <div role="alert" className="border-b border-x-line px-4 py-2 text-sm text-x-accent-ink">{actionError}</div>}
        <div className="border-b border-x-line px-4 py-2 text-xs text-x-muted">Connect steps with arrows. A condition chooses what happens after a check. Pause waits before the next step; Stop cancels active work. Each loop has a cycle limit.</div>

        {/* ── Toolbar ────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-x-line bg-x-surface-2">
          <div className="flex items-center gap-3">
            <button onClick={() => { setPipeline(null); setSelectedPipelineId(null); setShowPresets(true) }}
              className="p-1 rounded-md text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]" title="Back to list">
              <RotateCcw size={14} />
            </button>
            <input
              value={pipeline.name}
              onChange={(e) => { setPipeline((p) => ({ ...p, name: e.target.value })); setDirty(true) }}
              className="bg-transparent text-sm font-semibold text-x-ink border-none outline-none w-52"
            />
            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md ${pipeline.status === 'active' ? 'bg-x-good/15 text-x-good' : 'bg-x-surface text-x-faint'}`}>
              {pipeline.status}
            </span>
            {dirty && <span className="text-[11px] text-x-accent-ink">unsaved</span>}
          </div>

          <div className="flex items-center gap-1.5">
            {/* Add stage buttons */}
            <button onClick={() => addStage('agent')}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-accent/10 text-x-accent hover:bg-x-accent/15 rounded-md border border-x-accent/30 transition-colors duration-[80ms] ease-x">
              <Plus size={12} /> Agent
            </button>
            <button onClick={() => addStage('condition')}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink hover:bg-x-accent-ink/15 rounded-md border border-x-accent-ink/30 transition-colors duration-[80ms] ease-x">
              <Plus size={12} /> Condition
            </button>
            <button onClick={() => addStage('command')}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-good/10 text-x-good hover:bg-x-good/15 rounded-md border border-x-good/30 transition-colors duration-[80ms] ease-x">
              <Plus size={12} /> Command
            </button>

            <div className="w-px h-4 bg-x-line mx-1" />

            {/* Run controls */}
            {activeRun?.status === 'paused' ? (
              <>
                <button onClick={() => handleRunAction('resume')} disabled={acting} className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-x-good/30 text-x-good disabled:opacity-40"><Play size={12} /> Resume</button>
                <button onClick={handleCancelRun} disabled={acting} className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-x-line text-x-muted disabled:opacity-40"><Square size={12} /> Stop</button>
              </>
            ) : !activeRun || activeRun.status !== 'running' ? (
              <button onClick={handleStartRun} disabled={acting || !pipeline.stages?.length} title={dirty ? 'Save your changes and start this workflow' : 'Start this workflow'}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-x-good/10 text-x-good hover:bg-x-good/15 border border-x-good/30 hover:border-x-good/45 rounded-md transition-colors duration-[80ms] ease-x">
                <Play size={12} /> {acting ? 'Starting…' : dirty ? 'Save & Run' : 'Run'}
              </button>
            ) : (
              <>
                <button onClick={handlePauseRun} disabled={acting} title="Pause progression; the current step may finish"
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink hover:bg-x-accent-ink/15 border border-x-accent-ink/30 hover:border-x-accent-ink/45 rounded-md transition-colors duration-[80ms] ease-x">
                  <Pause size={12} /> Pause
                </button>
                <button onClick={handleCancelRun} disabled={acting} title="Cancel this workflow and interrupt its active work"
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink hover:bg-x-accent-ink/15 border border-x-accent-ink/30 hover:border-x-accent-ink/45 rounded-md transition-colors duration-[80ms] ease-x">
                  <Square size={12} /> Stop
                </button>
              </>
            )}

            {activeRun && (
              <span className="text-[11px] text-x-faint">
                Cycle {activeRun.iteration || 1} of {activeRun.max_iterations || 20} · {activeRun.status}
              </span>
            )}
            {activeRun && (
              <button onClick={() => setSelectedRunDetailId(activeRun.id)}
                className="px-2 py-1 text-[11px] font-medium rounded-md border bg-x-tint text-x-accent border-x-accent/30 hover:bg-x-accent/15 hover:border-x-accent/45 transition-colors duration-[80ms] ease-x">
                Run Detail
              </button>
            )}

            <div className="w-px h-4 bg-x-line mx-1" />

            <button onClick={handleActivate}
              className={`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors duration-[80ms] ease-x ${pipeline.status === 'active'
                ? 'bg-x-good/10 text-x-good border-x-good/30 hover:bg-x-good/15 hover:border-x-good/45'
                : 'bg-transparent text-x-muted border-x-line hover:bg-x-hover hover:text-x-ink-secondary hover:border-x-line-strong'}`}>
              {pipeline.status === 'active' ? 'Deactivate' : 'Activate'}
            </button>
            <button onClick={handleSave} disabled={!dirty}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-40 ${dirty ? 'bg-x-accent text-x-on-accent hover:bg-x-accent-ink' : 'bg-x-surface text-x-faint'}`}>
              <Save size={12} /> Save
            </button>
            <button onClick={handleDelete} className="p-1 rounded-md text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/15 transition-colors duration-[80ms]">
              <Trash2 size={13} />
            </button>
            <button onClick={onClose} className="p-1 rounded-md text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms] ml-1">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Main Area ─────────────────────────── */}
        <div className="flex-1 flex overflow-hidden">

          {/* Canvas */}
          <div
            ref={canvasRef}
            className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
            onMouseDown={handleCanvasMouseDown}
            onWheel={handleWheel}
            style={{ background: 'var(--x-bg)' }}
          >
            {/* Grid dots */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"
                patternTransform={`translate(${canvasOffset.x % 40} ${canvasOffset.y % 40})`}>
                <circle cx="20" cy="20" r="0.8" fill="var(--x-faint)" />
              </pattern>
              <rect width="100%" height="100%" fill="url(#grid)" />
            </svg>

            {/* Zoomable/pannable group */}
            <div
              className="absolute"
              style={{
                transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
              }}
            >
              {/* SVG layer for edges */}
              <svg className="absolute" style={{ width: '4000px', height: '2000px', overflow: 'visible' }}>
                <defs>
                  <style>{`@keyframes dash { to { stroke-dashoffset: -12; } }`}</style>
                </defs>
                {pipeline.transitions.map(renderEdge)}
                {/* In-progress edge */}
                {edgeInProgress && (() => {
                  const src = pipeline.stages.find((s) => s.id === edgeInProgress.from)
                  if (!src) return null
                  return (
                    <line
                      x1={src.position.x + NODE_W}
                      y1={src.position.y + NODE_H / 2}
                      x2={src.position.x + NODE_W + 50}
                      y2={src.position.y + NODE_H / 2}
                      stroke="var(--x-accent)"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                      className="pointer-events-none"
                    />
                  )
                })()}
              </svg>

              {/* Stage nodes */}
              {pipeline.stages.map((stage) => {
                const colors = STAGE_COLORS[stage.type] || STAGE_COLORS.agent
                const Icon = STAGE_ICONS[stage.config?.icon] || STAGE_ICONS.default
                const isSelected = selectedStageId === stage.id
                const status = getStageStatus(stage.id)
                const statusColor = status ? STATUS_COLORS[status] : null
                const session = sessions.find((s) => s.id === stage.session_id)

                return (
                  <div
                    key={stage.id}
                    className="absolute select-none transition-colors duration-[80ms] ease-x"
                    style={{
                      left: stage.position.x,
                      top: stage.position.y,
                      width: NODE_W,
                      height: NODE_H,
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(stage.id, e)}
                  >
                    {/* Node body */}
                    <div
                      className={`w-full h-full rounded-lg border cursor-pointer flex flex-col justify-center px-3 transition-colors duration-[80ms] ease-x ${
                        isSelected
                          ? 'border-x-accent ring-2 ring-x-focus'
                          : status === 'running'
                            ? 'border-x-good/50 ring-1 ring-x-good/25'
                            : 'border-x-line'
                      }`}
                      style={{ background: colors.bg }}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={14} style={{ color: colors.accent }} />
                        <span className="text-xs font-medium text-x-ink truncate">{stage.name}</span>
                        {status && (
                          <span
                            className={`ml-auto w-2 h-2 rounded-full flex-shrink-0 ${status === 'running' ? 'animate-subtle-pulse' : ''}`}
                            style={{ background: statusColor }}
                          />
                        )}
                      </div>
                      <div className="text-[11px] text-x-faint mt-1 truncate flex items-center gap-1">
                        {stage.type === 'condition'
                          ? 'Condition gate'
                          : stage.type === 'command'
                            ? (stage.config?.command || 'Command stage')
                            : (session?.name || stage.session_type || 'No session')}
                        {stage.cli_type && (
                          <span className={`px-1 py-px rounded text-[11px] font-medium ${
                            stage.cli_type === 'codex' ? 'bg-x-good/15 text-x-good' :
                            stage.cli_type === 'antigravity' ? 'bg-x-accent/15 text-x-accent' :
                            'bg-x-accent-ink/15 text-x-accent-ink'
                          }`}>
                            {stage.cli_type === 'codex' ? 'CODEX' : stage.cli_type === 'antigravity' ? 'AGY' : 'CLA'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Input port (left) */}
                    <div
                      className="absolute w-3 h-3 rounded-full border-2 cursor-crosshair transition-colors duration-[80ms]"
                      style={{
                        left: -6, top: NODE_H / 2 - 6,
                        background: 'var(--x-surface-2)', borderColor: colors.accent,
                      }}
                      onMouseDown={(e) => handlePortClick(stage.id, e)}
                    />

                    {/* Output port (right) */}
                    <div
                      className="absolute w-3 h-3 rounded-full border-2 cursor-crosshair transition-colors duration-[80ms]"
                      style={{
                        right: -6, top: NODE_H / 2 - 6,
                        background: 'var(--x-surface-2)', borderColor: colors.accent,
                      }}
                      onMouseDown={(e) => handlePortClick(stage.id, e)}
                    />
                  </div>
                )
              })}
            </div>

            {/* Zoom indicator */}
            <div className="absolute bottom-3 right-3 text-[11px] text-x-faint bg-x-surface-2 border border-x-line px-2 py-0.5 rounded-md">
              {Math.round(zoom * 100)}%
            </div>

            {/* Edge drawing hint */}
            {edgeInProgress && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 text-xs font-medium text-x-accent bg-x-tint px-3 py-1 rounded-full border border-x-accent/30">
                Click a target node to connect, Esc to cancel
              </div>
            )}
          </div>

          {/* ── Properties Panel ────────────────── */}
          <div className="w-72 border-l border-x-line bg-x-surface-2 overflow-y-auto">
            {selectedStage ? (
              <StageProperties
                stage={selectedStage}
                sessions={sessions}
                cliTypes={cliTypes}
                workspacePolicy={workspacePolicy}
                onUpdate={(u) => updateStage(selectedStageId, u)}
                onDelete={() => deleteStage(selectedStageId)}
              />
            ) : selectedTransition ? (
              <TransitionProperties
                transition={selectedTransition}
                stages={pipeline.stages}
                onUpdate={(u) => updateTransition(selectedTransitionId, u)}
                onDelete={() => deleteTransition(selectedTransitionId)}
              />
            ) : (
              <TriggerPanel
                triggers={pipeline.triggers || []}
                onAdd={addTrigger}
                onUpdate={updateTrigger}
                onRemove={removeTrigger}
                runs={pipelineRuns.filter((r) => r.pipeline_id === pipeline.id)}
                onOpenRunDetail={(runId) => setSelectedRunDetailId(runId)}
              />
            )}
          </div>
        </div>

        {/* Variable input dialog */}
        {showVarDialog && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]"
            onClick={() => setShowVarDialog(false)}>
            <div className="w-96 p-4 x-panel shadow-x-3"
              onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-x-ink mb-3">Pipeline Variables</h3>
              <div className="space-y-2.5 mb-4">
                {Object.keys(pendingVars).map((key) => (
                  <div key={key}>
                    <label className="text-xs font-medium text-x-ink-secondary block mb-1">{`{${key}}`}</label>
                    <textarea
                      value={pendingVars[key]}
                      onChange={(e) => setPendingVars((v) => ({ ...v, [key]: e.target.value }))}
                      rows={key === 'topic' || key.includes('description') ? 3 : 1}
                      placeholder={`Enter ${key}...`}
                      className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] resize-none"
                      autoFocus={Object.keys(pendingVars)[0] === key}
                    />
                  </div>
                ))}
              </div>
              {/* Show auto-injected task vars as info when task-derived vars are used */}
              {pipelineVars.all.some((v) => TASK_AUTO_VARS.has(v)) && (
                <div className="mb-3 px-2 py-1.5 bg-x-surface-2 rounded-md border border-x-line">
                  <span className="text-xs font-medium text-x-ink-secondary block mb-1">Auto-filled from task (when triggered by Feature Board):</span>
                  <div className="flex flex-wrap gap-1">
                    {pipelineVars.all.filter((v) => TASK_AUTO_VARS.has(v)).map((v) => (
                      <span key={v} className="text-[11px] px-1.5 py-0.5 bg-x-tint text-x-accent rounded-md border border-x-accent/25">
                        {`{${v}}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowVarDialog(false)}
                  className="px-3 py-1.5 text-xs font-medium text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms]">
                  Cancel
                </button>
                <button onClick={handleConfirmRun}
                  className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md flex items-center gap-1 active:scale-[0.98] transition-colors duration-[80ms] ease-x">
                  <Play size={12} /> Start Run
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {selectedRunDetailId && (
        <PipelineRunDetail
          runId={selectedRunDetailId}
          initialRun={pipelineRuns.find((r) => r.id === selectedRunDetailId)}
          onClose={() => setSelectedRunDetailId(null)}
        />
      )}
    </div>
  )
}


// ── Sub-components ─────────────────────────────────────────────────

function StageProperties({ stage, sessions, cliTypes, workspacePolicy, onUpdate, onDelete }) {
  const workspaceSessions = sessions || []

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-x-ink-secondary">Stage Properties</span>
        <button onClick={onDelete} className="p-1 rounded-md text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/15 transition-colors duration-[80ms]">
          <Trash2 size={12} />
        </button>
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Name</label>
        <input
          value={stage.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Type</label>
        <select
          value={stage.type}
          onChange={(e) => onUpdate({ type: e.target.value })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        >
          <option value="agent">Agent (sends prompt)</option>
          <option value="command">Command (deterministic)</option>
          <option value="condition">Condition (evaluates)</option>
          <option value="delay">Delay (waits)</option>
        </select>
      </div>

      {stage.type === 'agent' && (
        <>
          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">CLI</label>
            <select
              value={stage.cli_type || ''}
              onChange={(e) => onUpdate({
                cli_type: e.target.value || null,
                session_id: null,
                agent_config: {
                  ...(stage.agent_config || {}),
                  model: null,
                  permission_mode: null,
                  effort: null,
                },
              })}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            >
              <option value="">Any</option>
              {cliTypes.map((ct) => (
                <option key={ct.id} value={ct.id}>{ct.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Session</label>
            <select
              value={stage.session_id || ''}
              onChange={(e) => onUpdate({ session_id: e.target.value || null })}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            >
              <option value="">Auto (by type: {stage.session_type || 'worker'})</option>
              {workspaceSessions
                .filter((s) => !stage.cli_type || s.cli_type === stage.cli_type)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.cli_type ? ` (${s.cli_type})` : ''}</option>
                ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Worker Capability</label>
            <select
              value={stage.session_type || 'worker'}
              onChange={(e) => onUpdate({ session_type: e.target.value })}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            >
              <option value="worker">Worker</option>
              <option value="planner">Planner</option>
              <option value="commander">Commander</option>
              <option value="tester">Testing Worker</option>
              <option value="documentor">Documentation Worker</option>
              <option value="secure">Secure Worker</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Prompt Template</label>
            <textarea
              value={stage.prompt_template || ''}
              onChange={(e) => onUpdate({ prompt_template: e.target.value })}
              placeholder="Use {variables} for substitution..."
              rows={4}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] resize-none"
            />
          </div>

          {/* Agent Config — model, permission mode, effort */}
          <div className="border-t border-x-line pt-2 mt-1">
            <span className="text-xs font-medium text-x-ink-secondary block mb-2">Agent Config</span>
            <AgentConfigFields
              agentConfig={stage.agent_config || {}}
              cliType={stage.cli_type}
              sessionType={stage.session_type || 'worker'}
              workspacePolicy={workspacePolicy}
              onUpdate={(ac) => onUpdate({ agent_config: { ...(stage.agent_config || {}), ...ac } })}
            />
          </div>
        </>
      )}

      {stage.type === 'condition' && (
        <>
          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Evaluation Mode</label>
            <select
              value={stage.config?.mode || 'keyword'}
              onChange={(e) => onUpdate({ config: { ...stage.config, mode: e.target.value } })}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            >
              <option value="keyword">Keyword match</option>
              <option value="always_pass">Always pass</option>
              <option value="always_fail">Always fail</option>
            </select>
          </div>
          {stage.config?.mode === 'keyword' && (
            <>
              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1">Pass Keywords</label>
                <input
                  value={(stage.config?.pass_keywords || []).join(', ')}
                  onChange={(e) => onUpdate({ config: { ...stage.config, pass_keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } })}
                  className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
                  placeholder="pass, success, ok"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-x-ink-secondary block mb-1">Fail Keywords</label>
                <input
                  value={(stage.config?.fail_keywords || []).join(', ')}
                  onChange={(e) => onUpdate({ config: { ...stage.config, fail_keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } })}
                  className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
                  placeholder="fail, error, broken"
                />
              </div>
            </>
          )}
        </>
      )}

      {stage.type === 'command' && (
        <>
          <div className="rounded-lg border border-x-good/30 bg-x-good/10 p-2">
            <div className="text-[11px] font-medium text-x-good mb-1">Deterministic backend stage</div>
            <div className="text-[11px] text-x-faint leading-relaxed">
              Runs without an agent. Safety checks run by default; the checkbox below skips them only while this exact command stays unchanged.
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Command</label>
            <textarea
              value={stage.config?.command || stage.prompt_template || ''}
              onChange={(e) => {
                const policy = { ...(stage.config?.policy || {}) }
                if (policy.mode === 'safety_excluded') {
                  policy.mode = 'safety_checked'
                  delete policy.safety_excluded_command
                }
                onUpdate({
                  prompt_template: e.target.value,
                  config: {
                    ...stage.config,
                    command: e.target.value,
                    policy,
                  },
                })
              }}
              placeholder="npm --prefix frontend run build"
              rows={3}
              className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] resize-none font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-x-ink-secondary block mb-1">Working dir</label>
              <input
                value={stage.config?.cwd || ''}
                onChange={(e) => onUpdate({ config: { ...stage.config, cwd: e.target.value } })}
                placeholder="workspace root"
                className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-x-ink-secondary block mb-1">Timeout seconds</label>
              <input
                type="number"
                min={1}
                max={3600}
                value={stage.config?.timeout_seconds || 300}
                onChange={(e) => onUpdate({ config: { ...stage.config, timeout_seconds: parseInt(e.target.value) || 300 } })}
                className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
              />
            </div>
          </div>

          <div className="border-t border-x-line pt-2">
            <label className="flex items-start gap-2 rounded-md border border-x-line bg-x-surface p-2 cursor-pointer">
              <input
                type="checkbox"
                checked={(stage.config?.policy?.mode || 'safety_checked') === 'safety_excluded'}
                onChange={(e) => {
                  const command = stage.config?.command || stage.prompt_template || ''
                  const policy = {
                    ...(stage.config?.policy || {}),
                    mode: e.target.checked ? 'safety_excluded' : 'safety_checked',
                  }
                  if (e.target.checked) {
                    policy.safety_excluded_command = command
                  } else {
                    delete policy.safety_excluded_command
                  }
                  onUpdate({
                    config: {
                      ...stage.config,
                      policy,
                    },
                  })
                }}
                className="mt-0.5 accent-success"
              />
              <span>
                <span className="text-[11px] font-medium text-x-ink block">Skip safety checks for this exact command</span>
                <span className="text-[11px] text-x-faint leading-relaxed block mt-0.5">
                  Editing the command turns this off and the backend verifies the exact command before skipping checks.
                </span>
              </span>
            </label>
          </div>
        </>
      )}

      {stage.type === 'delay' && (
        <div>
          <label className="text-xs font-medium text-x-ink-secondary block mb-1">Delay (seconds)</label>
          <input
            type="number"
            value={stage.config?.delay_seconds || 5}
            onChange={(e) => onUpdate({ config: { ...stage.config, delay_seconds: parseInt(e.target.value) || 5 } })}
            className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
          />
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Icon</label>
        <div className="flex flex-wrap gap-1">
          {Object.entries(STAGE_ICONS).filter(([k]) => k !== 'default').map(([key, Icon]) => (
            <button
              key={key}
              onClick={() => onUpdate({ config: { ...stage.config, icon: key } })}
              className={`p-1.5 rounded-md border transition-colors duration-[80ms] ${stage.config?.icon === key ? 'bg-x-tint border-x-accent/45' : 'bg-x-surface border-transparent hover:bg-x-hover'}`}
            >
              <Icon size={12} className={stage.config?.icon === key ? 'text-x-accent' : 'text-x-faint'} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


function TransitionProperties({ transition, stages, onUpdate, onDelete }) {
  const src = stages.find((s) => s.id === transition.source)
  const tgt = stages.find((s) => s.id === transition.target)

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-x-ink-secondary">Transition</span>
        <button onClick={onDelete} className="p-1 rounded-md text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/15 transition-colors duration-[80ms]">
          <Trash2 size={12} />
        </button>
      </div>

      <div className="text-[11px] text-x-faint">
        {src?.name || '?'} <ArrowRight size={10} className="inline" /> {tgt?.name || '?'}
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Condition</label>
        <select
          value={transition.condition}
          onChange={(e) => onUpdate({ condition: e.target.value })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        >
          {CONDITION_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Label</label>
        <input
          value={transition.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
          placeholder="e.g., 'Retry', 'Next cycle'"
        />
      </div>

      {transition.condition === 'on_match' && (
        <div>
          <label className="text-xs font-medium text-x-ink-secondary block mb-1">Match Pattern</label>
          <input
            value={transition.condition_config?.pattern || ''}
            onChange={(e) => onUpdate({ condition_config: { ...transition.condition_config, pattern: e.target.value } })}
            className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            placeholder="keyword to match in output"
          />
        </div>
      )}
    </div>
  )
}


function TriggerPanel({ triggers, onAdd, onUpdate, onRemove, runs, onOpenRunDetail }) {
  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-x-ink-secondary">Triggers</span>
        <div className="flex gap-1">
          <button onClick={() => onAdd('board_column')}
            className="text-[11px] font-medium px-1.5 py-0.5 bg-x-accent/10 text-x-accent rounded-md hover:bg-x-accent/15 transition-colors duration-[80ms]">
            + Column
          </button>
          <button onClick={() => onAdd('manual')}
            className="text-[11px] font-medium px-1.5 py-0.5 bg-x-surface text-x-ink-secondary rounded-md hover:bg-x-hover transition-colors duration-[80ms]">
            + Manual
          </button>
        </div>
      </div>

      {(triggers || []).length === 0 && (
        <p className="text-[11px] text-x-faint italic">No triggers — pipeline is manual only.</p>
      )}

      {(triggers || []).map((trigger, idx) => (
        <div key={idx} className="bg-x-surface-2 rounded-lg border border-x-line p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-x-ink-secondary uppercase tracking-[0.06em]">{trigger.type.replace('_', ' ')}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onUpdate(idx, { enabled: !trigger.enabled })}
                className={`text-[11px] font-medium px-1 rounded ${trigger.enabled ? 'text-x-good' : 'text-x-faint'}`}
              >
                {trigger.enabled ? 'ON' : 'OFF'}
              </button>
              <button onClick={() => onRemove(idx)} className="p-0.5 rounded-md text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/15 transition-colors duration-[80ms]">
                <X size={10} />
              </button>
            </div>
          </div>

          {trigger.type === 'board_column' && (
            <div>
              <label className="text-xs font-medium text-x-ink-secondary block mb-1">When ticket enters column</label>
              <select
                value={trigger.config?.column || ''}
                onChange={(e) => onUpdate(idx, { config: { ...trigger.config, column: e.target.value } })}
                className="w-full bg-x-surface-2 text-[11px] text-x-ink px-2 py-1 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
              >
                <option value="">Select column...</option>
                {BOARD_COLUMNS.map((col) => (
                  <option key={col.key} value={col.key}>{col.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Guard: max concurrent */}
          <div>
            <label className="text-xs font-medium text-x-ink-secondary block mb-1">Max concurrent runs</label>
            <input
              type="number"
              value={trigger.guards?.max_concurrent || ''}
              onChange={(e) => onUpdate(idx, { guards: { ...trigger.guards, max_concurrent: parseInt(e.target.value) || 0 } })}
              placeholder="0 = unlimited"
              className="w-full bg-x-surface-2 text-[11px] text-x-ink px-2 py-1 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
            />
          </div>
        </div>
      ))}

      {/* Recent runs */}
      {runs.length > 0 && (
        <div className="mt-4">
          <span className="text-xs font-medium text-x-faint block mb-2">Recent Runs</span>
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="flex items-center justify-between py-1 border-b border-x-line">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLORS[run.status] || 'var(--x-faint)' }} />
                <span className="text-[11px] text-x-ink-secondary">{run.status}</span>
              </div>
              <button
                onClick={() => onOpenRunDetail?.(run.id)}
                className="text-[11px] text-x-accent hover:text-x-accent-ink"
              >
                detail
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


const SESSION_TYPE_DEFAULTS = {
  worker:     { model: 'sonnet',  permission_mode: 'auto', effort: null },
  planner:    { model: 'opus',    permission_mode: 'plan', effort: null },
  tester:     { model: 'sonnet',  permission_mode: 'auto', effort: null },
  commander:  { model: 'opus',    permission_mode: 'plan', effort: null },
  documentor: { model: 'sonnet',  permission_mode: 'auto', effort: null },
}

function AgentConfigFields({ agentConfig, cliType, sessionType, workspacePolicy, onUpdate }) {
  const staticDefaults = SESSION_TYPE_DEFAULTS[sessionType] || SESSION_TYPE_DEFAULTS.worker
  const policyRole = agentConfig.role || defaultPolicyRoleForSessionType(sessionType)
  const policyCfg = getPolicyRoleConfig(workspacePolicy, policyRole)
  const effectiveCli = cliType || policyCfg.cli_type || 'claude'
  const role = (sessionType === 'commander' || sessionType === 'planner') ? 'commander' : sessionType === 'tester' ? 'tester' : sessionType === 'documentor' ? 'documentor' : 'worker'
  const policyDefaultModel = (!policyCfg.cli_type || policyCfg.cli_type === effectiveCli) ? (policyCfg.model || '') : ''
  const defaults = {
    ...staticDefaults,
    model: policyDefaultModel || getRoleDefaultModel(effectiveCli, role),
    permission_mode: getDefaultPermissionMode(effectiveCli) || staticDefaults.permission_mode,
  }
  const models = getModelsForCli(effectiveCli)
  const permModes = getPermissionModesForCli(effectiveCli)
  const efforts = getEffortLevelsForCli(effectiveCli)

  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Policy Role</label>
        <select
          value={policyRole}
          onChange={(e) => onUpdate({ role: e.target.value })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        >
          {ORCHESTRATION_ROLE_OPTIONS.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
        <p className="text-[11px] text-x-faint mt-1">
          Drives model defaults from Workspace Settings. Session type still controls tools and permissions.
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Model</label>
        <select
          value={agentConfig.model || ''}
          onChange={(e) => onUpdate({ model: e.target.value || null })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        >
          <option value="">Default ({defaults.model})</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs font-medium text-x-ink-secondary block mb-1">Permission Mode</label>
        <select
          value={agentConfig.permission_mode || ''}
          onChange={(e) => onUpdate({ permission_mode: e.target.value || null })}
          className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
        >
          <option value="">Default ({defaults.permission_mode})</option>
          {permModes.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {efforts.length > 0 && (
        <div>
          <label className="text-xs font-medium text-x-ink-secondary block mb-1">Effort</label>
          <select
            value={agentConfig.effort || ''}
            onChange={(e) => onUpdate({ effort: e.target.value || null })}
            className="w-full bg-x-surface-2 text-xs text-x-ink px-2 py-1.5 rounded-md border border-x-line outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
          >
            {getEffortOptionsForCli(effectiveCli, agentConfig.model || defaults.model).map((o) => (
              <option key={o.value || 'default'} value={o.value}>{o.value ? o.label.charAt(0).toUpperCase() + o.label.slice(1) : o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
