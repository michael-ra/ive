import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  X, Plus, Play, Pause, Square, Save, Trash2, Copy, ChevronDown,
  Search, Code, GitBranch, CheckCircle, Eye, Zap, Wrench, Shield,
  Map, Clock, Settings, ArrowRight, RotateCcw, Sparkles,
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getModelsForCli, getPermissionModesForCli, getEffortLevelsForCli } from '../../lib/constants'

const STAGE_ICONS = {
  search: Search, code: Code, 'git-branch': GitBranch, 'check-circle': CheckCircle,
  eye: Eye, zap: Zap, wrench: Wrench, shield: Shield, map: Map, clock: Clock,
  settings: Settings, default: ArrowRight,
}

const STAGE_COLORS = {
  agent: { bg: '#1e1b4b', border: '#4f46e5', accent: '#818cf8' },
  condition: { bg: '#1c1917', border: '#d97706', accent: '#fbbf24' },
  delay: { bg: '#1a2332', border: '#0284c7', accent: '#38bdf8' },
}

const STATUS_COLORS = {
  pending: '#52525b',
  running: '#eab308',
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#71717a',
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
  const pipelines = useStore((s) => s.pipelines)
  const pipelineRuns = useStore((s) => s.pipelineRuns)
  const loadPipelines = useStore((s) => s.loadPipelines)
  const loadPipelineRuns = useStore((s) => s.loadPipelineRuns)
  const sessionsMap = useStore((s) => s.sessions)
  const sessions = useMemo(() => Object.values(sessionsMap || {}), [sessionsMap])
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

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
  const [activeRunId, setActiveRunId] = useState(null)
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

  const handleStartRun = useCallback(async () => {
    if (!pipeline) return
    // If pipeline has user-input variables, show dialog first
    if (pipelineVars.manual.length > 0) {
      const initial = {}
      for (const v of pipelineVars.manual) initial[v] = ''
      setPendingVars(initial)
      setShowVarDialog(true)
      return
    }
    const run = await api.startPipelineRun({
      pipeline_id: pipeline.id,
      workspace_id: activeWorkspaceId,
      variables: {},
    })
    if (run) {
      setActiveRunId(run.id)
      useStore.getState().loadPipelineRuns(activeWorkspaceId)
    }
  }, [pipeline, activeWorkspaceId, pipelineVars])

  const handleConfirmRun = useCallback(async () => {
    if (!pipeline) return
    setShowVarDialog(false)
    const run = await api.startPipelineRun({
      pipeline_id: pipeline.id,
      workspace_id: activeWorkspaceId,
      variables: pendingVars,
    })
    if (run) {
      setActiveRunId(run.id)
      useStore.getState().loadPipelineRuns(activeWorkspaceId)
    }
  }, [pipeline, activeWorkspaceId, pendingVars])

  const handlePauseRun = useCallback(async () => {
    if (!activeRunId) return
    await api.updatePipelineRun(activeRunId, 'pause')
  }, [activeRunId])

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return
    await api.updatePipelineRun(activeRunId, 'cancel')
    setActiveRunId(null)
  }, [activeRunId])

  // ── Stage Operations ─────────────────────────────────────────

  const addStage = useCallback((type = 'agent') => {
    if (!pipeline) return
    const id = `stage-${Date.now()}`
    const newStage = {
      id,
      name: type === 'condition' ? 'Evaluate' : 'New Stage',
      type,
      session_id: null,
      session_type: type === 'agent' ? 'worker' : null,
      prompt_template: '',
      position: { x: 300 + Math.random() * 200, y: 150 + Math.random() * 100 },
      config: type === 'condition'
        ? { mode: 'keyword', icon: 'git-branch', pass_keywords: ['pass', 'success'], fail_keywords: ['fail', 'error'] }
        : { icon: 'code' },
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
    const condColor = transition.condition === 'on_pass' ? '#22c55e'
      : transition.condition === 'on_fail' ? '#ef4444'
      : transition.condition === 'on_match' ? '#f59e0b'
      : '#6366f1'

    // Animate if this transition is actively flowing
    const srcStatus = getStageStatus(transition.source)
    const tgtStatus = getStageStatus(transition.target)
    const isFlowing = srcStatus === 'completed' && tgtStatus === 'running'

    return (
      <g key={transition.id} onClick={(e) => { e.stopPropagation(); setSelectedTransitionId(transition.id); setSelectedStageId(null) }}>
        <path
          d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke={isSelected ? '#a5b4fc' : condColor}
          strokeWidth={isSelected ? 2.5 : 1.5}
          strokeDasharray={isFlowing ? '8 4' : 'none'}
          style={isFlowing ? { animation: 'dash 0.6s linear infinite' } : {}}
          className="cursor-pointer"
        />
        {/* Arrow head */}
        <polygon
          points={`${x2},${y2} ${x2 - 8},${y2 - 4} ${x2 - 8},${y2 + 4}`}
          fill={isSelected ? '#a5b4fc' : condColor}
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
      <div className="fixed inset-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-sm flex flex-col" onClick={onClose}>
        <div className="flex-1 flex flex-col m-4 bg-[#111118] border border-zinc-700/60 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <GitBranch size={16} className="text-indigo-400" />
              <span className="text-sm font-semibold text-zinc-100">Pipeline Editor</span>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-zinc-700 rounded"><X size={16} className="text-zinc-400" /></button>
          </div>

          {/* Presets + list */}
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-lg font-semibold text-zinc-100 mb-1">Choose a Pipeline</h2>
              <p className="text-sm text-zinc-500 mb-6">Start from a preset or create from scratch.</p>

              {/* Presets grid */}
              <div className="grid grid-cols-2 gap-3 mb-8">
                {pipelines.filter((p) => p.preset).map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => handleSelectPreset(preset)}
                    className="text-left p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-lg hover:border-indigo-500/50 hover:bg-zinc-800 transition-all group"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={14} className="text-indigo-400" />
                      <span className="text-sm font-medium text-zinc-200">{preset.name}</span>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">{preset.description}</p>
                    <div className="mt-2 flex gap-1">
                      {(preset.stages || []).map((s) => {
                        const Icon = STAGE_ICONS[s.config?.icon] || STAGE_ICONS.default
                        const colors = STAGE_COLORS[s.type] || STAGE_COLORS.agent
                        return (
                          <span key={s.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
                            style={{ background: colors.bg, color: colors.accent, border: `1px solid ${colors.border}33` }}>
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
                  <h3 className="text-sm font-medium text-zinc-400 mb-3">Your Pipelines</h3>
                  <div className="space-y-2 mb-6">
                    {pipelines.filter((p) => !p.preset).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setSelectedPipelineId(p.id); setShowPresets(false) }}
                        className="w-full text-left p-3 bg-zinc-800/30 border border-zinc-700/40 rounded-lg hover:border-indigo-500/40 transition-all flex items-center justify-between"
                      >
                        <div>
                          <span className="text-sm text-zinc-200">{p.name}</span>
                          <span className="ml-2 text-xs text-zinc-500">{(p.stages || []).length} stages</span>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-zinc-700/50 text-zinc-500'}`}>
                          {p.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <button
                onClick={handleCreateNew}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-colors"
              >
                <Plus size={14} /> Create Blank Pipeline
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
    <div className="fixed inset-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-sm flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col m-3 bg-[#111118] border border-zinc-700/60 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>

        {/* ── Toolbar ────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-[#0f0f16]">
          <div className="flex items-center gap-3">
            <button onClick={() => { setPipeline(null); setSelectedPipelineId(null); setShowPresets(true) }}
              className="p-1 hover:bg-zinc-700 rounded" title="Back to list">
              <RotateCcw size={14} className="text-zinc-400" />
            </button>
            <input
              value={pipeline.name}
              onChange={(e) => { setPipeline((p) => ({ ...p, name: e.target.value })); setDirty(true) }}
              className="bg-transparent text-sm font-semibold text-zinc-100 border-none outline-none w-52"
            />
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${pipeline.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-zinc-700/50 text-zinc-500'}`}>
              {pipeline.status}
            </span>
            {dirty && <span className="text-[10px] text-amber-400">unsaved</span>}
          </div>

          <div className="flex items-center gap-1.5">
            {/* Add stage buttons */}
            <button onClick={() => addStage('agent')}
              className="flex items-center gap-1 px-2 py-1 text-[11px] bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 rounded border border-indigo-600/30">
              <Plus size={12} /> Agent
            </button>
            <button onClick={() => addStage('condition')}
              className="flex items-center gap-1 px-2 py-1 text-[11px] bg-amber-600/20 text-amber-300 hover:bg-amber-600/30 rounded border border-amber-600/30">
              <Plus size={12} /> Condition
            </button>

            <div className="w-px h-4 bg-zinc-700 mx-1" />

            {/* Run controls */}
            {!activeRun || activeRun.status !== 'running' ? (
              <button onClick={handleStartRun}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white rounded">
                <Play size={12} /> Run
              </button>
            ) : (
              <>
                <button onClick={handlePauseRun}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-amber-600/20 text-amber-300 rounded">
                  <Pause size={12} /> Pause
                </button>
                <button onClick={handleCancelRun}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] bg-red-600/20 text-red-300 rounded">
                  <Square size={12} /> Stop
                </button>
              </>
            )}

            {activeRun && (
              <span className="text-[10px] text-zinc-400">
                iter {activeRun.iteration || 1} | {activeRun.status}
              </span>
            )}

            <div className="w-px h-4 bg-zinc-700 mx-1" />

            <button onClick={handleActivate}
              className={`px-2 py-1 text-[11px] rounded border ${pipeline.status === 'active'
                ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/30'
                : 'bg-zinc-700/30 text-zinc-400 border-zinc-600/30'}`}>
              {pipeline.status === 'active' ? 'Deactivate' : 'Activate'}
            </button>
            <button onClick={handleSave} disabled={!dirty}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded ${dirty ? 'bg-indigo-600 text-white' : 'bg-zinc-700/30 text-zinc-500'}`}>
              <Save size={12} /> Save
            </button>
            <button onClick={handleDelete} className="p-1 hover:bg-red-900/30 rounded">
              <Trash2 size={13} className="text-zinc-500 hover:text-red-400" />
            </button>
            <button onClick={onClose} className="p-1 hover:bg-zinc-700 rounded ml-1">
              <X size={14} className="text-zinc-400" />
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
            style={{ background: 'radial-gradient(circle at 50% 50%, #13131d 0%, #0a0a0f 100%)' }}
          >
            {/* Grid dots */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"
                patternTransform={`translate(${canvasOffset.x % 40} ${canvasOffset.y % 40})`}>
                <circle cx="20" cy="20" r="0.8" fill="#4a4a5a" />
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
                      stroke="#6366f1"
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
                    className="absolute select-none transition-shadow"
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
                      className="w-full h-full rounded-lg border-[1.5px] cursor-pointer flex flex-col justify-center px-3 transition-all"
                      style={{
                        background: colors.bg,
                        borderColor: isSelected ? '#a5b4fc' : colors.border + '80',
                        boxShadow: status === 'running'
                          ? `0 0 20px ${statusColor}40, 0 0 4px ${statusColor}60`
                          : isSelected ? '0 0 12px #6366f140' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={14} style={{ color: colors.accent }} />
                        <span className="text-xs font-medium text-zinc-200 truncate">{stage.name}</span>
                        {status && (
                          <span className="ml-auto w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: statusColor, boxShadow: status === 'running' ? `0 0 6px ${statusColor}` : 'none' }} />
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1 truncate flex items-center gap-1">
                        {stage.type === 'condition' ? 'Condition gate' : (session?.name || stage.session_type || 'No session')}
                        {stage.cli_type && (
                          <span className={`px-1 py-px rounded text-[8px] font-medium ${
                            stage.cli_type === 'gemini' ? 'bg-blue-900/40 text-blue-300' : 'bg-orange-900/40 text-orange-300'
                          }`}>
                            {stage.cli_type === 'gemini' ? 'GEM' : 'CLA'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Input port (left) */}
                    <div
                      className="absolute w-3 h-3 rounded-full border-2 cursor-crosshair hover:scale-125 transition-transform"
                      style={{
                        left: -6, top: NODE_H / 2 - 6,
                        background: '#1a1a2e', borderColor: colors.accent,
                      }}
                      onMouseDown={(e) => handlePortClick(stage.id, e)}
                    />

                    {/* Output port (right) */}
                    <div
                      className="absolute w-3 h-3 rounded-full border-2 cursor-crosshair hover:scale-125 transition-transform"
                      style={{
                        right: -6, top: NODE_H / 2 - 6,
                        background: '#1a1a2e', borderColor: colors.accent,
                      }}
                      onMouseDown={(e) => handlePortClick(stage.id, e)}
                    />
                  </div>
                )
              })}
            </div>

            {/* Zoom indicator */}
            <div className="absolute bottom-3 right-3 text-[10px] text-zinc-600 bg-zinc-900/70 px-2 py-0.5 rounded">
              {Math.round(zoom * 100)}%
            </div>

            {/* Edge drawing hint */}
            {edgeInProgress && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 text-xs text-indigo-300 bg-indigo-900/40 px-3 py-1 rounded-full border border-indigo-600/30">
                Click a target node to connect, Esc to cancel
              </div>
            )}
          </div>

          {/* ── Properties Panel ────────────────── */}
          <div className="w-72 border-l border-zinc-800 bg-[#0d0d14] overflow-y-auto">
            {selectedStage ? (
              <StageProperties
                stage={selectedStage}
                sessions={sessions}
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
              />
            )}
          </div>
        </div>

        {/* Variable input dialog */}
        {showVarDialog && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setShowVarDialog(false)}>
            <div className="bg-[#161620] border border-zinc-700/60 rounded-lg shadow-2xl w-96 p-4"
              onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-100 mb-3">Pipeline Variables</h3>
              <div className="space-y-2.5 mb-4">
                {Object.keys(pendingVars).map((key) => (
                  <div key={key}>
                    <label className="text-[10px] text-zinc-400 block mb-1">{`{${key}}`}</label>
                    <textarea
                      value={pendingVars[key]}
                      onChange={(e) => setPendingVars((v) => ({ ...v, [key]: e.target.value }))}
                      rows={key === 'topic' || key.includes('description') ? 3 : 1}
                      placeholder={`Enter ${key}...`}
                      className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none focus:border-indigo-500/50 resize-none"
                      autoFocus={Object.keys(pendingVars)[0] === key}
                    />
                  </div>
                ))}
              </div>
              {/* Show auto-injected task vars as info when task-derived vars are used */}
              {pipelineVars.all.some((v) => TASK_AUTO_VARS.has(v)) && (
                <div className="mb-3 px-2 py-1.5 bg-zinc-800/30 rounded border border-zinc-700/30">
                  <span className="text-[10px] text-zinc-500 block mb-1">Auto-filled from task (when triggered by Feature Board):</span>
                  <div className="flex flex-wrap gap-1">
                    {pipelineVars.all.filter((v) => TASK_AUTO_VARS.has(v)).map((v) => (
                      <span key={v} className="text-[9px] px-1.5 py-0.5 bg-indigo-900/30 text-indigo-300 rounded border border-indigo-600/20">
                        {`{${v}}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowVarDialog(false)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded">
                  Cancel
                </button>
                <button onClick={handleConfirmRun}
                  className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1">
                  <Play size={12} /> Start Run
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


// ── Sub-components ─────────────────────────────────────────────────

function StageProperties({ stage, sessions, onUpdate, onDelete }) {
  const workspaceSessions = sessions || []

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">Stage Properties</span>
        <button onClick={onDelete} className="p-1 hover:bg-red-900/30 rounded">
          <Trash2 size={12} className="text-zinc-500 hover:text-red-400" />
        </button>
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Name</label>
        <input
          value={stage.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none focus:border-indigo-500/50"
        />
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Type</label>
        <select
          value={stage.type}
          onChange={(e) => onUpdate({ type: e.target.value })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
        >
          <option value="agent">Agent (sends prompt)</option>
          <option value="condition">Condition (evaluates)</option>
          <option value="delay">Delay (waits)</option>
        </select>
      </div>

      {stage.type === 'agent' && (
        <>
          <div>
            <label className="text-[10px] text-zinc-500 block mb-1">CLI</label>
            <select
              value={stage.cli_type || ''}
              onChange={(e) => onUpdate({ cli_type: e.target.value || null })}
              className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
            >
              <option value="">Any</option>
              <option value="claude">Claude Code</option>
              <option value="gemini">Gemini CLI</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] text-zinc-500 block mb-1">Session</label>
            <select
              value={stage.session_id || ''}
              onChange={(e) => onUpdate({ session_id: e.target.value || null })}
              className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
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
            <label className="text-[10px] text-zinc-500 block mb-1">Session Type (fallback)</label>
            <select
              value={stage.session_type || 'worker'}
              onChange={(e) => onUpdate({ session_type: e.target.value })}
              className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
            >
              <option value="worker">Worker</option>
              <option value="commander">Commander</option>
              <option value="tester">Tester</option>
              <option value="documentor">Documentor</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] text-zinc-500 block mb-1">Prompt Template</label>
            <textarea
              value={stage.prompt_template || ''}
              onChange={(e) => onUpdate({ prompt_template: e.target.value })}
              placeholder="Use {variables} for substitution..."
              rows={4}
              className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none focus:border-indigo-500/50 resize-none"
            />
          </div>

          {/* Agent Config — model, permission mode, effort */}
          <div className="border-t border-zinc-700/30 pt-2 mt-1">
            <span className="text-[10px] font-medium text-zinc-400 block mb-2">Agent Config</span>
            <AgentConfigFields
              agentConfig={stage.agent_config || {}}
              cliType={stage.cli_type || 'claude'}
              sessionType={stage.session_type || 'worker'}
              onUpdate={(ac) => onUpdate({ agent_config: { ...(stage.agent_config || {}), ...ac } })}
            />
          </div>
        </>
      )}

      {stage.type === 'condition' && (
        <>
          <div>
            <label className="text-[10px] text-zinc-500 block mb-1">Evaluation Mode</label>
            <select
              value={stage.config?.mode || 'keyword'}
              onChange={(e) => onUpdate({ config: { ...stage.config, mode: e.target.value } })}
              className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
            >
              <option value="keyword">Keyword match</option>
              <option value="always_pass">Always pass</option>
              <option value="always_fail">Always fail</option>
            </select>
          </div>
          {stage.config?.mode === 'keyword' && (
            <>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-1">Pass Keywords</label>
                <input
                  value={(stage.config?.pass_keywords || []).join(', ')}
                  onChange={(e) => onUpdate({ config: { ...stage.config, pass_keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } })}
                  className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
                  placeholder="pass, success, ok"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-1">Fail Keywords</label>
                <input
                  value={(stage.config?.fail_keywords || []).join(', ')}
                  onChange={(e) => onUpdate({ config: { ...stage.config, fail_keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } })}
                  className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
                  placeholder="fail, error, broken"
                />
              </div>
            </>
          )}
        </>
      )}

      {stage.type === 'delay' && (
        <div>
          <label className="text-[10px] text-zinc-500 block mb-1">Delay (seconds)</label>
          <input
            type="number"
            value={stage.config?.delay_seconds || 5}
            onChange={(e) => onUpdate({ config: { ...stage.config, delay_seconds: parseInt(e.target.value) || 5 } })}
            className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
          />
        </div>
      )}

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Icon</label>
        <div className="flex flex-wrap gap-1">
          {Object.entries(STAGE_ICONS).filter(([k]) => k !== 'default').map(([key, Icon]) => (
            <button
              key={key}
              onClick={() => onUpdate({ config: { ...stage.config, icon: key } })}
              className={`p-1.5 rounded ${stage.config?.icon === key ? 'bg-indigo-600/30 border border-indigo-500/50' : 'bg-zinc-800/50 hover:bg-zinc-700/50'}`}
            >
              <Icon size={12} className={stage.config?.icon === key ? 'text-indigo-300' : 'text-zinc-500'} />
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
        <span className="text-xs font-medium text-zinc-300">Transition</span>
        <button onClick={onDelete} className="p-1 hover:bg-red-900/30 rounded">
          <Trash2 size={12} className="text-zinc-500 hover:text-red-400" />
        </button>
      </div>

      <div className="text-[10px] text-zinc-500">
        {src?.name || '?'} <ArrowRight size={10} className="inline" /> {tgt?.name || '?'}
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Condition</label>
        <select
          value={transition.condition}
          onChange={(e) => onUpdate({ condition: e.target.value })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
        >
          {CONDITION_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Label</label>
        <input
          value={transition.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
          placeholder="e.g., 'Retry', 'Next cycle'"
        />
      </div>

      {transition.condition === 'on_match' && (
        <div>
          <label className="text-[10px] text-zinc-500 block mb-1">Match Pattern</label>
          <input
            value={transition.condition_config?.pattern || ''}
            onChange={(e) => onUpdate({ condition_config: { ...transition.condition_config, pattern: e.target.value } })}
            className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
            placeholder="keyword to match in output"
          />
        </div>
      )}
    </div>
  )
}


function TriggerPanel({ triggers, onAdd, onUpdate, onRemove, runs }) {
  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">Triggers</span>
        <div className="flex gap-1">
          <button onClick={() => onAdd('board_column')}
            className="text-[10px] px-1.5 py-0.5 bg-indigo-600/20 text-indigo-300 rounded hover:bg-indigo-600/30">
            + Column
          </button>
          <button onClick={() => onAdd('manual')}
            className="text-[10px] px-1.5 py-0.5 bg-zinc-700/30 text-zinc-400 rounded hover:bg-zinc-700/50">
            + Manual
          </button>
        </div>
      </div>

      {(triggers || []).length === 0 && (
        <p className="text-[10px] text-zinc-600 italic">No triggers — pipeline is manual only.</p>
      )}

      {(triggers || []).map((trigger, idx) => (
        <div key={idx} className="bg-zinc-800/30 rounded border border-zinc-700/40 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-zinc-400 uppercase">{trigger.type.replace('_', ' ')}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onUpdate(idx, { enabled: !trigger.enabled })}
                className={`text-[10px] px-1 rounded ${trigger.enabled ? 'text-emerald-400' : 'text-zinc-600'}`}
              >
                {trigger.enabled ? 'ON' : 'OFF'}
              </button>
              <button onClick={() => onRemove(idx)} className="p-0.5 hover:bg-red-900/30 rounded">
                <X size={10} className="text-zinc-500" />
              </button>
            </div>
          </div>

          {trigger.type === 'board_column' && (
            <div>
              <label className="text-[10px] text-zinc-500 block mb-1">When ticket enters column</label>
              <select
                value={trigger.config?.column || ''}
                onChange={(e) => onUpdate(idx, { config: { ...trigger.config, column: e.target.value } })}
                className="w-full bg-zinc-800/50 text-[10px] text-zinc-200 px-2 py-1 rounded border border-zinc-700/50 outline-none"
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
            <label className="text-[10px] text-zinc-500 block mb-1">Max concurrent runs</label>
            <input
              type="number"
              value={trigger.guards?.max_concurrent || ''}
              onChange={(e) => onUpdate(idx, { guards: { ...trigger.guards, max_concurrent: parseInt(e.target.value) || 0 } })}
              placeholder="0 = unlimited"
              className="w-full bg-zinc-800/50 text-[10px] text-zinc-200 px-2 py-1 rounded border border-zinc-700/50 outline-none"
            />
          </div>
        </div>
      ))}

      {/* Recent runs */}
      {runs.length > 0 && (
        <div className="mt-4">
          <span className="text-[10px] font-medium text-zinc-500 block mb-2">Recent Runs</span>
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="flex items-center justify-between py-1 border-b border-zinc-800/50">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLORS[run.status] || '#52525b' }} />
                <span className="text-[10px] text-zinc-400">{run.status}</span>
              </div>
              <span className="text-[10px] text-zinc-600">iter {run.iteration || 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


const SESSION_TYPE_DEFAULTS = {
  worker:     { model: 'sonnet',  permission_mode: 'auto', effort: 'high' },
  tester:     { model: 'sonnet',  permission_mode: 'auto', effort: 'high' },
  commander:  { model: 'opus',    permission_mode: 'plan', effort: 'high' },
  documentor: { model: 'sonnet',  permission_mode: 'auto', effort: 'high' },
}

function AgentConfigFields({ agentConfig, cliType, sessionType, onUpdate }) {
  const defaults = SESSION_TYPE_DEFAULTS[sessionType] || SESSION_TYPE_DEFAULTS.worker
  const models = getModelsForCli(cliType || 'claude')
  const permModes = getPermissionModesForCli(cliType || 'claude')
  const efforts = getEffortLevelsForCli(cliType || 'claude')

  return (
    <div className="space-y-2">
      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Model</label>
        <select
          value={agentConfig.model || ''}
          onChange={(e) => onUpdate({ model: e.target.value || null })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
        >
          <option value="">Default ({defaults.model})</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Permission Mode</label>
        <select
          value={agentConfig.permission_mode || ''}
          onChange={(e) => onUpdate({ permission_mode: e.target.value || null })}
          className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
        >
          <option value="">Default ({defaults.permission_mode})</option>
          {permModes.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {efforts.length > 0 && (
        <div>
          <label className="text-[10px] text-zinc-500 block mb-1">Effort</label>
          <select
            value={agentConfig.effort || ''}
            onChange={(e) => onUpdate({ effort: e.target.value || null })}
            className="w-full bg-zinc-800/50 text-xs text-zinc-200 px-2 py-1.5 rounded border border-zinc-700/50 outline-none"
          >
            <option value="">Default ({defaults.effort})</option>
            {efforts.map((e) => (
              <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
