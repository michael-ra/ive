import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  X, Save, Trash2, ExternalLink, Mic, MicOff,
  Play, ClipboardPaste, CheckSquare, PenTool, Download,
  Upload, Globe, Camera, RotateCcw, Link,
  Search, Map as MapIcon, ShieldCheck, PauseCircle, Code2,
  TestTube2, Wrench, CheckCircle2, Activity, GitBranch,
  Terminal, Clock3, CircleDot
} from 'lucide-react'
import { api } from '../../lib/api'
import { isSurfaceAvailable } from '../../lib/extensionRegistry'
import useStore from '../../state/store'
import { matchesKey, formatKeyCombo } from '../../lib/keybindings'
import { sendTerminalCommand } from '../../lib/terminal'
import { useVoiceInput } from '../../hooks/useVoiceInput'

import ExcalidrawWrapper, { extractDiagramNotes } from './ExcalidrawWrapper'
import PipelineRunDetail from '../pipeline/PipelineRunDetail'
import { Button } from '../ui'

const STATUSES = ['backlog', 'todo', 'planning', 'in_progress', 'review', 'testing', 'documenting', 'done', 'blocked']
const PRIORITIES = ['normal', 'high', 'critical']
const TABS = ['details', 'history', 'scratchpad', 'preview', 'execute']
const DELIVERY_UNAVAILABLE = 'Pipeline delivery is unavailable in this profile. Open integrated-dev to run saved recipes or stage-based execution.'

function normalizePriority(priority) {
  if (priority === 2 || priority === '2') return 'critical'
  if (priority === 1 || priority === '1') return 'high'
  if (priority === 0 || priority === '0' || priority == null) return 'normal'
  return PRIORITIES.includes(priority) ? priority : 'normal'
}

function parseScratchpad(raw) {
  if (!raw) return { text: '', diagram: null }
  try {
    const parsed = JSON.parse(raw)
    if (parsed.text !== undefined) return parsed
  } catch {}
  return { text: raw, diagram: null } // Legacy: plain text
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

// Autocomplete Tag Chips component
function TaskLabelEditor({ labelsStr, setLabelsStr, allTasks }) {
  const [inputValue, setInputValue] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const inputRef = useRef(null)

  const activeLabels = useMemo(() => {
    return labelsStr
      ? labelsStr.split(',').map((l) => l.trim()).filter(Boolean)
      : []
  }, [labelsStr])

  // Extract all unique labels used in the workspace for autocomplete
  const availableLabels = useMemo(() => {
    const allLabelsSet = new Set()
    Object.values(allTasks).forEach((t) => {
      const labels = Array.isArray(t.labels)
        ? t.labels
        : typeof t.labels === 'string' && t.labels
          ? t.labels.split(',').map((l) => l.trim()).filter(Boolean)
          : []
      labels.forEach((l) => allLabelsSet.add(l))
    })
    // Filter out tags already added
    return Array.from(allLabelsSet).filter((l) => !activeLabels.includes(l))
  }, [allTasks, activeLabels])

  const filteredSuggestions = useMemo(() => {
    if (!inputValue) return availableLabels.slice(0, 5)
    const query = inputValue.toLowerCase().trim()
    return availableLabels.filter((l) => l.toLowerCase().includes(query)).slice(0, 5)
  }, [inputValue, availableLabels])

  const handleAddLabel = (label) => {
    const trimmed = label.trim()
    if (!trimmed) return
    if (!activeLabels.includes(trimmed)) {
      const updated = [...activeLabels, trimmed].join(', ')
      setLabelsStr(updated)
    }
    setInputValue('')
    setDropdownOpen(false)
  }

  const handleRemoveLabel = (label) => {
    const updated = activeLabels.filter((l) => l !== label).join(', ')
    setLabelsStr(updated)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (inputValue.trim()) {
        handleAddLabel(inputValue)
      }
    } else if (e.key === 'Backspace' && !inputValue && activeLabels.length > 0) {
      handleRemoveLabel(activeLabels[activeLabels.length - 1])
    }
  }

  return (
    <div className="space-y-1.5">
      {/* Dynamic chip list */}
      <div className="flex flex-wrap gap-1 min-h-[32px] p-1.5 bg-x-surface-2 border border-x-line rounded-lg focus-within:border-x-accent focus-within:ring-[3px] focus-within:ring-x-focus transition-colors duration-[80ms]">
        {activeLabels.map((l) => (
          <span
            key={l}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-x-accent/10 border border-x-accent/20 text-x-accent rounded-md"
          >
            {l}
            <button
              type="button"
              onClick={() => handleRemoveLabel(l)}
              className="hover:text-x-accent-ink focus:outline-none cursor-pointer"
            >
              <X size={8} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => { setInputValue(e.target.value); setDropdownOpen(true) }}
          onFocus={() => setDropdownOpen(true)}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder={activeLabels.length === 0 ? "Add label..." : ""}
          className="flex-1 bg-transparent border-0 outline-none text-[12px] text-x-ink-secondary placeholder:text-x-faint p-0 min-w-[50px] focus:ring-0"
        />
      </div>

      {/* Autocomplete Dropdown */}
      {dropdownOpen && (inputValue.trim() || filteredSuggestions.length > 0) && (
        <div className="relative">
          <div className="absolute z-50 left-0 right-0 max-h-32 overflow-y-auto bg-x-surface border border-x-line rounded-lg shadow-x-1 flex flex-col p-1 gap-0.5">
            {filteredSuggestions.map((suggestion) => (
              <Button
                type="button"
                onMouseDown={() => handleAddLabel(suggestion)}
                className="w-full text-left px-2.5 py-1.5 text-[12px] text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms] cursor-pointer"
              >
                {suggestion}
              </Button>
            ))}
            {inputValue.trim() && !activeLabels.includes(inputValue.trim()) && !availableLabels.includes(inputValue.trim()) && (
              <Button
                type="button"
                onMouseDown={() => handleAddLabel(inputValue)}
                className="w-full text-left px-2.5 py-1.5 text-[12px] text-x-accent hover:bg-x-hover hover:text-x-accent-ink border-t border-x-line-subtle mt-0.5 pt-1.5 transition-colors duration-[80ms] cursor-pointer"
              >
                Create new label: <span className="text-x-ink font-semibold">"{inputValue.trim()}"</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Six legacy hues collapse onto the app's three sanctioned non-neutral tokens (accent/success/
// warn) — each option keeps its own icon + label, so hue is reinforcement, not the identifier.
const executionToneClasses = {
  indigo: { checked: 'border-x-accent/35 bg-x-tint', box: 'bg-x-accent border-x-accent text-x-on-accent', icon: 'text-x-accent' },
  green: { checked: 'border-x-good/35 bg-x-good/10', box: 'bg-x-good border-x-good text-x-on-accent', icon: 'text-x-good' },
  orange: { checked: 'border-x-accent-ink/35 bg-x-accent-ink/10', box: 'bg-x-accent-ink border-x-accent-ink text-x-on-accent', icon: 'text-x-accent-ink' },
  purple: { checked: 'border-x-accent/35 bg-x-tint', box: 'bg-x-accent border-x-accent text-x-on-accent', icon: 'text-x-accent' },
  cyan: { checked: 'border-x-accent/35 bg-x-tint', box: 'bg-x-accent border-x-accent text-x-on-accent', icon: 'text-x-accent' },
  emerald: { checked: 'border-x-good/35 bg-x-good/10', box: 'bg-x-good border-x-good text-x-on-accent', icon: 'text-x-good' },
}

function ExecutionOption({ checked, onToggle, label, detail, tone = 'indigo', icon: Icon = CheckSquare, disabled = false }) {
  const toneClass = executionToneClasses[tone] || executionToneClasses.indigo
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      className={`flex min-h-[68px] w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors duration-[80ms] ease-x cursor-pointer ${
        checked
          ? toneClass.checked
          : 'border-x-line bg-x-surface-2 hover:border-x-line-strong hover:bg-x-hover'
      } ${disabled ? 'cursor-default opacity-40' : ''}`}
    >
      <span className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors duration-[80ms] ${
        checked ? toneClass.box : 'border-x-line bg-x-surface-2 text-transparent'
      }`}>
        {checked && <CheckSquare size={10} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-x-ink">
          <Icon size={12} className={checked ? toneClass.icon : 'text-x-faint'} />
          <span>{label}</span>
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-x-muted">{detail}</span>
      </span>
    </button>
  )
}

export default function TaskDetailModal({ task, workspaceId, commanderSessionId, onSave, onDelete, onClose, onCloseBoard, onDirtyChange }) {
  const deliveryAvailable = isSurfaceAvailable('pipeline-editor')
  const [tab, setTab] = useState('details')
  const [scratchMode, setScratchMode] = useState('text') // text | diagram
  const [title, setTitle] = useState(task.title || '')
  const [description, setDescription] = useState(task.description || '')
  const [acceptance, setAcceptance] = useState(task.acceptance_criteria || '')
  const [status, setStatus] = useState(task.status || 'backlog')
  const [priority, setPriority] = useState(normalizePriority(task.priority))
  const [labelsStr, setLabelsStr] = useState(
    Array.isArray(task.labels) ? task.labels.join(', ') : task.labels || ''
  )

  const scratchData = parseScratchpad(task.scratchpad)
  const [scratchText, setScratchText] = useState(scratchData.text)
  const [diagramData, setDiagramData] = useState(scratchData.diagram)
  const [planFirst, setPlanFirst] = useState(task.plan_first || false)
  const [autoApprovePlan, setAutoApprovePlan] = useState(task.auto_approve_plan || false)
  const [ralphLoop, setRalphLoop] = useState(task.ralph_loop || false)
  const [deepResearch, setDeepResearch] = useState(task.deep_research || false)
  const [testWithAgent, setTestWithAgent] = useState(task.test_with_agent || false)
  const [pipeline, setPipeline] = useState(task.pipeline || false)
  const [selectedTaskPipelineId, setSelectedTaskPipelineId] = useState('')
  const [pipelineMaxIter, setPipelineMaxIter] = useState(task.pipeline_max_iterations || 5)
  const [assignedSession, setAssignedSession] = useState(task.assigned_session_id || '')
  const [saving, setSaving] = useState(false)
  const [iterating, setIterating] = useState(false)
  const [showRevisionForm, setShowRevisionForm] = useState(false)
  const [revisionNotes, setRevisionNotes] = useState('')
  const [taskEvents, setTaskEvents] = useState([])
  const [taskPipelineRuns, setTaskPipelineRuns] = useState([])
  const [selectedRunDetailId, setSelectedRunDetailId] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(task.preview_url || window.location.origin)
  const iframeRef = useCallback((node) => { if (node) node.__iframeRef = node }, [])
  const [attachments, setAttachments] = useState([])
  const [dependsOn, setDependsOn] = useState(() => {
    const raw = task.depends_on
    if (!raw || raw === '[]') return []
    if (Array.isArray(raw)) return raw
    try { return JSON.parse(raw) } catch { return [] }
  })
  const [depSearch, setDepSearch] = useState('')
  const [depDropdownOpen, setDepDropdownOpen] = useState(false)
  const contentRef = useRef(null)
  const tabBarRef = useRef(null)
  const saveRef = useRef(null)

  // Load attachments on mount + refresh when diagram is attached
  const loadAttachments = () => {
    if (task.id) {
      fetch(`/api/tasks/${task.id}/attachments`).then((r) => r.json()).then(setAttachments).catch(() => {})
    }
  }
  useEffect(() => { loadAttachments() }, [task.id])
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.taskId === task.id) loadAttachments()
    }
    window.addEventListener('attachments-updated', handler)
    return () => window.removeEventListener('attachments-updated', handler)
  }, [task.id])

  // Paste images anywhere in the modal → attach to task
  useEffect(() => {
    const handler = async (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob || !task.id) return
          const formData = new FormData()
          formData.append('file', blob, `paste-${Date.now()}.${item.type.split('/')[1]}`)
          try {
            await fetch(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: formData })
            loadAttachments()
          } catch (err) { console.error('Paste upload failed:', err) }
          return
        }
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [task.id])

  // ── Keyboard navigation ────────────────────────────────────────────────
  // saveRef is populated below, after handleSave is defined, so the keydown
  // handler can call the latest version without re-binding listeners.

  // Auto-focus first input when switching tabs.
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector('input, textarea, select')
      el?.focus()
    })
  }, [tab])

  useEffect(() => {
    const handler = (e) => {
      const target = e.target
      const tag = target?.tagName?.toLowerCase()
      const isFormField = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable
      const meta = e.metaKey || e.ctrlKey

      // ⌘S → save
      if (meta && e.key === 's') {
        e.preventDefault()
        saveRef.current?.()
        return
      }

      // ⌘Enter → save
      if (meta && e.key === 'Enter') {
        e.preventDefault()
        saveRef.current?.()
        return
      }

      // ── Configurable tab switching (works from ANYWHERE, even textareas) ──
      // Default: ⌘←/→. Remappable via Keyboard Shortcuts panel.
      const kb = useStore.getState().keybindings
      if (matchesKey(e, kb.taskTabPrev) || matchesKey(e, kb.taskTabNext)) {
        e.preventDefault()
        e.stopPropagation()
        const curIdx = TABS.indexOf(tab)
        if (matchesKey(e, kb.taskTabPrev) && curIdx > 0) setTab(TABS[curIdx - 1])
        if (matchesKey(e, kb.taskTabNext) && curIdx < TABS.length - 1) setTab(TABS[curIdx + 1])
        return
      }

      // ── Configurable field cycling (works in textareas too) ──
      // Default: ⌘↑/↓. Remappable via Keyboard Shortcuts panel.
      if (matchesKey(e, kb.taskFieldNext) || matchesKey(e, kb.taskFieldPrev)) {
        const focusables = [...(contentRef.current?.querySelectorAll('input, textarea, select') || [])]
        if (focusables.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const idx = focusables.indexOf(target)
        if (matchesKey(e, kb.taskFieldNext)) {
          const next = idx >= 0 ? focusables[idx + 1] : focusables[0]
          ;(next || focusables[focusables.length - 1])?.focus()
        } else {
          if (idx <= 0) {
            // At first field → jump up to the active tab button
            if (typeof target?.blur === 'function') target.blur()
            const tabBtn = tabBarRef.current?.querySelector(`[data-tab="${tab}"]`)
            tabBtn?.focus()
          } else {
            focusables[idx - 1]?.focus()
          }
        }
        return
      }

      // ── Tab switching (when not in a form field) ──
      if (!isFormField) {
        const curIdx = TABS.indexOf(tab)
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          if (curIdx > 0) setTab(TABS[curIdx - 1])
          return
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          if (curIdx < TABS.length - 1) setTab(TABS[curIdx + 1])
          return
        }
        // ArrowDown → enter the content area
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const el = contentRef.current?.querySelector('input, textarea, select')
          el?.focus()
          return
        }
      }

      // ── Field cycling with ArrowUp/Down in single-line inputs ──
      if (tag === 'input') {
        const focusables = [...(contentRef.current?.querySelectorAll('input, textarea, select') || [])]
        const idx = focusables.indexOf(target)
        if (idx < 0) return

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const next = focusables[idx + 1]
          if (next) next.focus()
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (idx === 0) {
            // First field → move focus to the active tab button
            target.blur()
            const tabBtn = tabBarRef.current?.querySelector(`[data-tab="${tab}"]`)
            tabBtn?.focus()
            return
          }
          const prev = focusables[idx - 1]
          if (prev) prev.focus()
          return
        }
      }

      // ── In select: Escape blurs, ArrowUp at top exits to prev field ──
      // (ArrowUp/Down natively change options — we leave that alone)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tab])

  // Screenshot using browser's screen capture API
  const captureScreenshot = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: false,
      })
      const video = document.createElement('video')
      video.srcObject = stream
      await video.play()

      // Wait a frame for video to render
      await new Promise((r) => requestAnimationFrame(r))

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)

      // Stop all tracks
      stream.getTracks().forEach((t) => t.stop())

      canvas.toBlob(async (blob) => {
        if (!blob || !task.id) return
        const formData = new FormData()
        formData.append('file', blob, `screenshot-${Date.now()}.png`)
        await fetch(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: formData })
        loadAttachments()
      }, 'image/png')
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.error('Screenshot failed:', err)
      }
    }
  }

  const sessions = useStore((s) => s.sessions)
  const allTasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const pipelines = useStore((s) => s.pipelines)
  const pipelineRuns = useStore((s) => s.pipelineRuns)
  const loadPipelines = useStore((s) => s.loadPipelines)
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId)
  const depsEnabled = currentWorkspace?.task_dependencies_enabled
  const workspaceSessions = Object.values(sessions).filter(
    (s) => s.workspace_id === workspaceId && s.session_type !== 'commander'
  )
  const taskPipelineOptions = useMemo(() => (
    pipelines
      .filter((p) => (p.workspace_id === workspaceId || p.workspace_id == null) && p.description !== 'Generated visible task execution pipeline.')
      .sort((a, b) => Number(b.preset || 0) - Number(a.preset || 0) || String(a.name || '').localeCompare(String(b.name || '')))
  ), [pipelines, workspaceId])
  const selectedTaskPipeline = useMemo(
    () => taskPipelineOptions.find((p) => p.id === selectedTaskPipelineId) || null,
    [taskPipelineOptions, selectedTaskPipelineId]
  )
  const selectedTaskPipelineVars = useMemo(() => {
    if (!selectedTaskPipeline) return { all: [], manual: [] }
    const autoVars = new Set([
      'task_id', 'task_title', 'task_description', 'task_criteria',
      'task_labels', 'task_priority', 'task_status', 'topic', 'execution_context',
    ])
    const vars = new Set()
    for (const stage of selectedTaskPipeline.stages || []) {
      const tpl = stage.prompt_template || ''
      for (const match of tpl.matchAll(/\{([a-zA-Z_]\w*)\}/g)) vars.add(match[1])
    }
    const all = [...vars]
    return { all, manual: all.filter((v) => !autoVars.has(v)) }
  }, [selectedTaskPipeline])
  const taskRuns = useMemo(() => {
    const byId = new Map()
    for (const run of [...taskPipelineRuns, ...pipelineRuns]) {
      if (run?.task_id === task.id) byId.set(run.id, run)
    }
    return [...byId.values()].sort((a, b) => {
      const ad = asDate(a.created_at || a.started_at)?.getTime() || 0
      const bd = asDate(b.created_at || b.started_at)?.getTime() || 0
      return bd - ad
    })
  }, [pipelineRuns, task.id, taskPipelineRuns])

  useEffect(() => {
    if (deliveryAvailable) loadPipelines?.(workspaceId)
  }, [deliveryAvailable, loadPipelines, workspaceId])

  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      if (!task.id) return
      setHistoryLoading(true)
      try {
        const [events, runs] = await Promise.all([
          api.getTaskEvents(task.id).catch(() => []),
          deliveryAvailable ? api.listPipelineRuns(workspaceId, null, false, task.id).catch(() => []) : Promise.resolve([]),
        ])
        if (!cancelled) {
          setTaskEvents(Array.isArray(events) ? events : [])
          setTaskPipelineRuns(Array.isArray(runs) ? runs : [])
        }
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }
    loadHistory()
    return () => { cancelled = true }
  }, [deliveryAvailable, task.id, workspaceId])

  const { listening, toggle: toggleVoice } = useVoiceInput((text) => {
    setScratchText((prev) => prev + (prev ? ' ' : '') + text)
  })

  const buildScratchpad = () => JSON.stringify({ text: scratchText, diagram: diagramData })

  const handleSave = async () => {
    setSaving(true)
    const labels = labelsStr.split(',').map((l) => l.trim()).filter(Boolean)
    await onSave({
      ...task, title, description, acceptance_criteria: acceptance,
      status, priority, labels, scratchpad: buildScratchpad(),
      plan_first: planFirst ? 1 : 0, auto_approve_plan: (planFirst && autoApprovePlan) ? 1 : 0,
      ralph_loop: ralphLoop ? 1 : 0, deep_research: deepResearch ? 1 : 0,
      test_with_agent: testWithAgent ? 1 : 0,
      pipeline: (pipeline || selectedTaskPipelineId) ? 1 : 0, pipeline_max_iterations: pipelineMaxIter,
      assigned_session_id: assignedSession || null,
      depends_on: dependsOn,
    })
    setSaving(false)
  }

  // Keep saveRef fresh so the keydown handler always calls the latest handleSave.
  saveRef.current = handleSave

  const handlePasteOverview = async () => {
    setLoadingOverview(true)
    try {
      const data = await api.getWorkspaceOverview(workspaceId)
      setScratchText((prev) => prev + (prev ? '\n\n' : '') + `## Code Overview\n\n${data.summary}\n\n\`\`\`\n${data.tree}\n\`\`\``)
    } catch (e) { console.error(e) }
    setLoadingOverview(false)
  }

  const handleExportPng = useCallback(async () => {
    // Excalidraw handles this internally via the ExcalidrawWrapper
    const event = new CustomEvent('excalidraw-export-png')
    window.dispatchEvent(event)
  }, [])

  const handleExecute = async () => {
    // Direct worker assignment is core IVE. Only recipes/stage-based delivery
    // require the compatibility profile; preserve saved options rather than
    // silently changing a pipeline task into a different execution strategy.
    if (!deliveryAvailable && executeUsesPipeline) {
      alert(DELIVERY_UNAVAILABLE)
      return
    }
    await handleSave()
    // Extract diagram text notes
    const diagramNotes = extractDiagramNotes(diagramData)
    const notesText = diagramNotes.length > 0
      ? `Diagram annotations:\n${diagramNotes.map((n) => `  note-${n.id}: ${n.text}`).join('\n')}`
      : ''

    // Re-fetch attachments at dispatch time — the modal's `attachments`
    // state can lag behind a just-saved Excalidraw diagram (the upload +
    // `attachments-updated` event may not have settled before the user
    // clicks Execute), which left the dispatch prompt with an empty
    // "Attached images:" section even though the file existed on disk.
    let freshAttachments = attachments
    try {
      const r = await fetch(`/api/tasks/${task.id}/attachments`)
      if (r.ok) freshAttachments = await r.json()
    } catch { /* fall back to in-memory state */ }

    // Include attachment file paths so the session can see images
    const imageAttachments = freshAttachments.filter((a) => a.path && a.filename.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i))
    const attachmentText = imageAttachments.length > 0
      ? `Attached images:\n${imageAttachments.map((a) => `  ${a.path}`).join('\n')}`
      : ''

    const prompt = [
      `Pick up task: ${title}`,
      `Task ID: ${task.id}`,
      `IMPORTANT: Call get_task(task_id="${task.id}") FIRST to fetch the full record — description, acceptance criteria, labels, priority, attachments (image paths), iteration history. The lines below only include fields that were non-empty at dispatch time, so anything blank here may still have content on the ticket.`,
      description ? `Description: ${description}` : '',
      acceptance ? `Acceptance criteria: ${acceptance}` : '',
      scratchText ? `Text notes:\n${scratchText}` : '',
      notesText,
      attachmentText,
      `Plan first: ${planFirst ? 'yes — create and review a plan before implementing' : 'no — implement directly'}`,
      ralphLoop ? 'Ralph mode: ON — worker must loop (execute→verify→fix) until ALL tests/build pass. Do not accept partial completion. Inject the ralph loop system prompt into the worker session.' : '',
      deepResearch ? 'Deep research: ON — invoke the deep_research MCP tool BEFORE creating the worker session. Use the research output to enrich the worker\'s task context. The research should focus on the task description and acceptance criteria.' : '',
      testWithAgent ? `Test with agent: ON — after the worker reports status=review, call request_capability_handoff(capability="testing", task_id="${task.id}", prompt="Verify ${title} against the task description, acceptance criteria, and worker result_summary. Use browser automation if relevant and report pass/fail with evidence."). Read the testing worker's output and update the task accordingly: status='done' if all checks pass, status='blocked' with details if any fail.` : '',
      (task.iteration || 1) > 1 ? `This is iteration ${task.iteration} of this task (revision requested). Previous work was done by session ${task.last_agent_session_id || 'unknown'}. Build on previous work, don't start from scratch.` : '',
      assignedSession
        ? `Use session: ${sessions[assignedSession]?.name || assignedSession}`
        : 'Create new worker or assign to best-fit existing session.',
      `Status tracking: Update this task via update_task(task_id="${task.id}") — set status to "in_progress" when work begins, and "done" with a result_summary when complete.`,
    ].filter(Boolean).join('\n')
    const executionContext = [
      scratchText ? `Text notes:\n${scratchText}` : '',
      notesText,
      attachmentText,
    ].filter(Boolean).join('\n\n')
    const usesVisiblePipeline = planFirst || ralphLoop || deepResearch || testWithAgent || pipeline
    const canRunDirectly = !usesVisiblePipeline && !selectedTaskPipelineId

    if (canRunDirectly) {
      const workerPrompt = prompt
        .replace('Create new worker or assign to best-fit existing session.', 'Do the work in this session.')
        .replaceAll('get_task(', 'get_my_task(')
        .replaceAll('update_task(', 'update_my_task(')

      if (assignedSession) {
        await useStore.getState().ensureSessionRunning(assignedSession)
        await api.assignTaskToWorker(assignedSession, task.id, workerPrompt)
        await api.updateTask2(task.id, { status: 'todo' })
        useStore.getState().updateTaskInStore({ ...task, status: 'todo', assigned_session_id: assignedSession })
        onClose()
        return
      }

      let route = null
      try {
        route = await api.routeTask(task.id, { mode: 'direct_worker' })
      } catch (e) {
        console.debug('Direct task route fallback to fresh worker:', e)
      }
      if (route?.decision === 'reuse' && route.session_id) {
        await useStore.getState().ensureSessionRunning(route.session_id)
        await api.assignTaskToWorker(route.session_id, task.id, workerPrompt)
        await api.updateTask2(task.id, { status: 'todo' })
        useStore.getState().updateTaskInStore({ ...task, status: 'todo', assigned_session_id: route.session_id })
        onClose()
        return
      }

      try {
        const worker = await api.createSession(workspaceId, {
          name: `Worker — ${title}`,
          session_type: 'worker',
          policy_role: route?.policy_role || 'default_worker',
          task_id: task.id,
          auto_start: true,
        })
        if (!worker?.id) { alert('Failed to start worker.'); return }
        useStore.getState().setActiveWorkspace(worker.workspace_id)
        useStore.getState().addSession(worker)
        useStore.getState().setActiveSession(worker.id)
        await new Promise((r) => setTimeout(r, 1500))
        sendTerminalCommand(worker.id, [
          'You are the assigned worker for this task.',
          workerPrompt,
        ].join('\n'))
        await api.updateTask2(task.id, { status: 'todo' })
        useStore.getState().updateTaskInStore({ ...task, status: 'todo', assigned_session_id: worker.id })
        onClose()
        return
      } catch (e) {
        console.error('Direct worker start failed:', e)
        alert(`Failed to start worker: ${e.message}`)
        return
      }
    }

    if (selectedTaskPipelineId) {
      if (selectedTaskPipelineVars.manual.length > 0) {
        alert(`This pipeline needs manual variables before it can run from a task: ${selectedTaskPipelineVars.manual.join(', ')}`)
        return
      }
      try {
        const run = await api.startPipelineRun({
          pipeline_id: selectedTaskPipelineId,
          workspace_id: workspaceId,
          task_id: task.id,
          variables: { execution_context: executionContext },
          trigger_type: 'task_execute_custom',
        })
        if (run) {
          useStore.getState().handlePipelineRunUpdate(run)
          useStore.getState().loadPipelineRuns(workspaceId)
          await api.updateTask2(task.id, { status: 'in_progress', pipeline: 1, pipeline_stage: 'queued' })
          useStore.getState().updateTaskInStore({
            ...task,
            status: 'in_progress',
            pipeline: 1,
            pipeline_stage: 'queued',
            assigned_session_id: assignedSession || task.assigned_session_id,
          })
        }
        onClose()
        return
      } catch (e) {
        console.error('Custom task pipeline start failed:', e)
        alert(`Failed to start selected pipeline: ${e.message}`)
        return
      }
    }

    try {
      const result = await api.executeTask(task.id, {
        execution_context: executionContext,
        assigned_session_id: assignedSession || undefined,
        plan_first: planFirst,
        auto_approve_plan: planFirst && autoApprovePlan,
        deep_research: deepResearch,
        ralph_loop: ralphLoop,
        test_with_agent: testWithAgent,
        pipeline,
        pipeline_max_iterations: pipelineMaxIter,
      })
      if (result?.run) {
        useStore.getState().handlePipelineRunUpdate(result.run)
        useStore.getState().loadPipelines(workspaceId)
      }
      const nextStatus = planFirst ? 'planning' : 'in_progress'
      useStore.getState().updateTaskInStore({
        ...task,
        status: nextStatus,
        pipeline: 1,
        pipeline_stage: 'queued',
        assigned_session_id: assignedSession || task.assigned_session_id,
      })
      onClose()
      return
    } catch (e) {
      console.error('Task pipeline start failed:', e)
      alert(`Failed to start task pipeline: ${e.message}`)
      return
    }
  }

  const handlePipelineRunAction = useCallback(async (runId, action) => {
    if (!deliveryAvailable) return
    try {
      const updated = await api.updatePipelineRun(runId, action)
      if (updated?.id) {
        useStore.getState().handlePipelineRunUpdate(updated)
        setTaskPipelineRuns((prev) => {
          const exists = prev.some((r) => r.id === updated.id)
          return exists ? prev.map((r) => (r.id === updated.id ? updated : r)) : [updated, ...prev]
        })
      }
    } catch (e) {
      console.error(`Pipeline run ${action} failed:`, e)
      alert(`Pipeline run ${action} failed: ${e.message}`)
    }
  }, [deliveryAvailable])

  const tabClass = (t) => `px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-[80ms] ease-x cursor-pointer border-b-[1.5px] ${
    tab === t ? 'text-x-ink border-x-accent' : 'text-x-muted hover:text-x-ink-secondary border-transparent'
  }`
  const inputClass = 'w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]'
  const pipelineIsImplied = planFirst || ralphLoop || deepResearch || testWithAgent
  const customPipelineSelected = Boolean(selectedTaskPipelineId)
  const executeUsesPipeline = customPipelineSelected || pipelineIsImplied || pipeline
  const executeNeedsVerify = testWithAgent || ralphLoop
  const executeStageItems = [
    deepResearch ? { id: 'research', label: 'Research', detail: 'context', icon: Search, tone: 'purple' } : null,
    planFirst ? { id: 'plan', label: 'Plan', detail: 'planner', icon: MapIcon, tone: 'indigo' } : null,
    planFirst ? { id: 'plan_review', label: 'Plan review', detail: 'gate', icon: ShieldCheck, tone: 'amber' } : null,
    planFirst && !autoApprovePlan ? { id: 'approval', label: 'Approval', detail: 'pause', icon: PauseCircle, tone: 'orange' } : null,
    { id: 'implement', label: 'Implement', detail: assignedSession ? 'selected session' : 'routed worker', icon: Code2, tone: 'emerald' },
    executeNeedsVerify ? {
      id: 'verify',
      label: 'Verify',
      detail: testWithAgent ? 'test agent' : 'required loop',
      icon: TestTube2,
      tone: 'cyan',
    } : null,
    ralphLoop ? { id: 'fix', label: 'Fix loop', detail: `${pipelineMaxIter || 5} max`, icon: Wrench, tone: 'rose' } : null,
    executeUsesPipeline ? {
      id: 'status',
      label: 'Status',
      detail: executeNeedsVerify ? 'done/blocked' : 'review',
      icon: CheckCircle2,
      tone: 'green',
    } : null,
  ].filter(Boolean)
  const directStageItems = [
    { id: 'route', label: 'Route', detail: 'auto', icon: Link, tone: 'indigo' },
    { id: 'worker', label: 'Worker', detail: assignedSession ? 'selected' : 'reuse/fresh', icon: Code2, tone: 'emerald' },
  ]
  const customPipelineStageItems = selectedTaskPipeline
    ? (selectedTaskPipeline.stages || []).slice(0, 8).map((stage) => ({
        id: stage.id,
        label: stage.name || stage.type || 'Stage',
        detail: stage.type || 'stage',
        icon: stage.type === 'research' ? Search
          : stage.type === 'approval' ? PauseCircle
            : stage.type === 'condition' ? ShieldCheck
              : stage.type === 'task_update' ? CheckCircle2
                : Code2,
        tone: stage.type === 'condition' ? 'amber'
          : stage.type === 'approval' ? 'orange'
            : stage.type === 'task_update' ? 'green'
              : 'emerald',
      }))
    : []
  const previewStageItems = customPipelineSelected
    ? customPipelineStageItems
    : executeUsesPipeline ? executeStageItems : directStageItems
  // Eight legacy hues collapse onto the four sanctioned semantic tokens.
  const stageToneClass = {
    purple: 'border-x-accent/30 bg-x-accent/10 text-x-accent',
    indigo: 'border-x-accent/30 bg-x-accent/10 text-x-accent',
    amber: 'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink',
    orange: 'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink',
    emerald: 'border-x-good/30 bg-x-good/10 text-x-good',
    cyan: 'border-x-accent/30 bg-x-accent/10 text-x-accent',
    rose: 'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink',
    green: 'border-x-good/30 bg-x-good/10 text-x-good',
  }

  // Get recent output summary for each session (first 50 chars of name + status)
  const sessionLabel = (s) => {
    const parts = [s.name]
    if (s.task_id) {
      const t = useStore.getState().tasks[s.task_id]
      if (t) parts.push(`working on: ${t.title}`)
    }
    parts.push(`${s.model}, ${s.status || 'idle'}`)
    return parts.join(' — ')
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 md:p-4 bg-x-scrim backdrop-blur-[4px] animate-in" onClick={onClose}>
      <div
        className={`x-panel shadow-x-3 overflow-hidden flex flex-col scale-in ${
          (tab === 'scratchpad' || tab === 'preview')
            ? 'w-[calc(100vw-1rem)] md:w-[95vw] h-[calc(100dvh-1rem)] md:h-[90vh]'
            : 'w-[min(820px,calc(100vw-1rem))] max-h-[calc(100dvh-1rem)] md:max-h-[90vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
        onChangeCapture={() => onDirtyChange?.(true)}
      >
        {/* Tabs and Actions bar */}
        <div ref={tabBarRef} className="flex flex-wrap items-center justify-between gap-3 border-b border-x-line px-4 md:px-5 py-2.5 bg-x-surface-2 shrink-0 select-none">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto bg-x-surface-2 p-0.5 rounded-xl border border-x-line tab-scroll-hide">
            {TABS.map((t) => {
              const label = t === 'details' ? 'Details' :
                            t === 'history' ? `History${(task.iteration || 1) > 1 ? ` (${(task.iteration || 1) - 1})` : ''}` :
                            t === 'scratchpad' ? `Scratchpad${(scratchText || diagramData) ? ' *' : ''}` :
                            t === 'preview' ? 'Preview' : 'Execute'
              const isActive = tab === t
              return (
                <button
                  key={t}
                  type="button"
                  data-tab={t}
                  onClick={() => setTab(t)}
                  className={`shrink-0 px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors duration-[80ms] ease-x cursor-pointer border ${
                    isActive
                      ? 'bg-x-tint text-x-accent border-x-accent/35'
                      : 'border-transparent text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
                  }`}
                >
                  {t === 'preview' && <Globe size={10} className="inline mr-1" />}
                  {label}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={async () => {
                try {
                  // Ensure commander row exists
                  const commander = await api.startCommander(workspaceId)
                  if (commander?.id) {
                    // Switch to commander tab
                    useStore.getState().setActiveSession(commander.id)
                    // Make sure the PTY is actually alive before paste —
                    // startCommander is idempotent and won't respawn a dead PTY.
                    await useStore.getState().ensureSessionRunning(commander.id)
                    // Send refine prompt
                    const refinePrompt = `I want to refine ticket #${task.id.slice(0, 8)} "${task.title}". Here are the current details:\n\nDescription: ${task.description || '(none)'}\nAcceptance Criteria: ${task.acceptance_criteria || '(none)'}\nStatus: ${task.status}\nLabels: ${task.labels || '(none)'}\n\nHelp me improve this ticket. Listen to what I say and help me refine the description, acceptance criteria, and implementation approach. Use update_task to apply changes when we agree.`
                    useStore.getState().setSessionInput(commander.id, refinePrompt)
                    onClose()
                    onCloseBoard?.()
                  }
                } catch (e) { console.error('Refine with Commander failed:', e) }
              }}
              className="px-3 py-1.5 text-[11px] font-medium text-x-accent hover:text-x-accent-ink hover:bg-x-accent/10 rounded-lg border border-x-accent/25 transition-colors duration-[80ms] ease-x flex items-center gap-1.5 cursor-pointer"
              title="Refine this ticket with Commander"
            >
              <PenTool size={11} /> Refine
            </button>
            <button onClick={() => onDelete(task.id)} className="p-2 text-x-faint hover:text-x-accent-ink rounded-lg hover:bg-x-accent-ink/10 transition-colors duration-[80ms] cursor-pointer" title="Delete Task">
              <Trash2 size={13} />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms] cursor-pointer" title="Close Modal">
              <X size={16} />
            </button>
          </div>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto p-3 md:p-4" style={{ minHeight: 0 }}>
          {/* ─── Details ─── */}
          {tab === 'details' && (
            <div className="flex flex-col md:flex-row gap-5 h-full">
              {/* Left Column (Content area) */}
              <div className="flex-1 space-y-3.5">
                <div className="flex items-center gap-2">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Task title"
                    className={`${inputClass} text-xs font-semibold flex-1 py-2`}
                  />
                  {(task.iteration || 1) > 1 && (
                    <span className="px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-x-accent/25 border border-x-accent/30 text-x-accent shrink-0">
                      v{task.iteration}
                    </span>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe the task features and goals..."
                    rows={6}
                    className={`${inputClass} resize-none leading-relaxed`}
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Acceptance Criteria</label>
                  <textarea
                    value={acceptance}
                    onChange={(e) => setAcceptance(e.target.value)}
                    placeholder="What requirements must be met for this to be accepted?"
                    rows={4}
                    className={`${inputClass} resize-none leading-relaxed`}
                  />
                </div>

                {task.result_summary && (
                  <div>
                    <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Agent Result Summary</label>
                    <p className="text-[11px] text-x-ink-secondary font-mono bg-x-surface-2 border border-x-line rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
                      {task.result_summary}
                    </p>
                  </div>
                )}

                {/* Request Revision (visible on done/review/verified tasks) */}
                {['done', 'review', 'verified'].includes(task.status) && (
                  <div className="border border-x-line bg-x-surface-2 rounded-lg p-3.5 space-y-2.5">
                    {!showRevisionForm ? (
                      <Button
                        type="button"
                        onClick={() => setShowRevisionForm(true)}
                        className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium bg-x-accent/10 border border-x-accent/30 text-x-accent hover:bg-x-accent/15 hover:border-x-accent/45 transition-colors duration-[80ms] ease-x"
                      >
                        <RotateCcw size={11} /> Request Revision (v{(task.iteration || 1) + 1})
                      </Button>
                    ) : (
                      <>
                        <label className="text-xs font-medium text-x-ink-secondary block">Revision Feedback</label>
                        <textarea
                          value={revisionNotes}
                          onChange={(e) => setRevisionNotes(e.target.value)}
                          placeholder="What needs to change? Add feedback, corrections, new requirements..."
                          rows={3}
                          className={`${inputClass} resize-none`}
                          autoFocus
                        />
                        <p className="text-[11px] text-x-faint">
                          You can also edit the description and acceptance criteria above before submitting.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            onClick={async () => {
                              setIterating(true)
                              try {
                                const updated = await api.iterateTask(task.id, {
                                  revision_notes: revisionNotes,
                                  description,
                                  acceptance_criteria: acceptance,
                                })
                                useStore.getState().updateTaskInStore(updated)
                                setShowRevisionForm(false)
                                setRevisionNotes('')
                                onClose()
                              } catch (e) { console.error('Iterate failed:', e) }
                              setIterating(false)
                            }}
                            disabled={iterating}
                            className="px-3 py-1.5 text-[13px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors duration-[80ms] ease-x disabled:opacity-40"
                          >
                            {iterating ? 'Submitting...' : `Submit as v${(task.iteration || 1) + 1}`}
                          </Button>
                          <button
                            type="button"
                            onClick={() => { setShowRevisionForm(false); setRevisionNotes('') }}
                            className="px-3 py-1.5 text-[13px] font-medium text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Attachments */}
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Attachments</label>
                  <div className="flex flex-wrap gap-2 mb-2.5">
                    {attachments.map((a) => (
                      <a
                        key={a.filename}
                        href={a.url}
                        target="_blank"
                        rel="noopener"
                        className="group relative w-16 h-16 rounded-lg border border-x-line overflow-hidden hover:border-x-line-strong transition-colors duration-[80ms] flex items-center justify-center bg-x-surface-2"
                      >
                        {a.filename.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)
                          ? <img src={a.url} className="w-full h-full object-cover" />
                          : <div className="flex items-center justify-center h-full text-[11px] text-x-faint font-mono p-1 text-center break-all">{a.filename}</div>
                        }
                      </a>
                    ))}
                    <label className="flex flex-col items-center justify-center w-16 h-16 text-[11px] bg-x-surface border border-x-line border-dashed rounded-lg text-x-faint hover:text-x-ink-secondary hover:border-x-line-strong cursor-pointer transition-colors duration-[80ms]">
                      <Upload size={14} className="mb-1" /> Add
                      <input
                        type="file"
                        multiple
                        accept="image/*,.pdf,.md,.txt"
                        className="hidden"
                        onChange={async (e) => {
                          const files = e.target.files
                          if (!files?.length) return
                          const formData = new FormData()
                          for (const f of files) formData.append('file', f)
                          try {
                            const res = await fetch(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: formData })
                            const data = await res.json()
                            setAttachments((prev) => [...prev, ...(data.files || [])])
                          } catch (err) { console.error('Upload failed:', err) }
                          e.target.value = ''
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Right Column (Metadata sidebar) */}
              <div className="w-full md:w-[240px] border-t md:border-t-0 md:border-l border-x-line/80 pt-4 md:pt-0 md:pl-4 space-y-4 shrink-0">
                {/* Status selector */}
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  </select>
                </div>

                {/* Priority toggle buttons */}
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Priority</label>
                  <div className="flex gap-1 bg-x-surface-2 p-0.5 rounded-md border border-x-line">
                    {PRIORITIES.map((p) => {
                      const isSelected = priority === p
                      const accentClass = p === 'critical' ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30' :
                                          p === 'high' ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30' :
                                          'text-x-ink-secondary bg-x-surface border-x-line-strong'
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPriority(p)}
                          className={`flex-1 py-1 text-[11px] font-medium rounded border transition-colors duration-[80ms] ease-x ${
                            isSelected
                              ? accentClass
                              : 'bg-transparent border-transparent text-x-muted hover:text-x-ink-secondary'
                          }`}
                        >
                          {p}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Autocomplete Tag Chips */}
                <div>
                  <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Labels / Tags</label>
                  <TaskLabelEditor
                    labelsStr={labelsStr}
                    setLabelsStr={setLabelsStr}
                    allTasks={allTasks}
                  />
                </div>

                {/* Dependency selector */}
                {depsEnabled && (
                  <div className="border-t border-x-line-subtle/40 pt-3">
                    <label className="text-xs font-medium text-x-ink-secondary mb-1 flex items-center gap-1">
                      <Link size={10} /> Depends On
                    </label>
                    {dependsOn.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {dependsOn.map((depId) => {
                          const depTask = allTasks[depId]
                          const isDone = depTask && (depTask.status === 'done' || depTask.status === 'verified')
                          return (
                            <span
                              key={depId}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded border ${
                                isDone
                                  ? 'bg-x-good/10 border-x-good/25 text-x-good'
                                  : 'bg-x-surface border-x-line text-x-ink-secondary'
                              }`}
                            >
                              <span className="truncate max-w-[120px]">{depTask?.title || depId.slice(0, 8)}</span>
                              <button onClick={() => setDependsOn((prev) => prev.filter((id) => id !== depId))} className="hover:text-x-accent-ink ml-0.5">
                                <X size={8} />
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    )}
                    <div className="relative">
                      <input
                        value={depSearch}
                        onChange={(e) => { setDepSearch(e.target.value); setDepDropdownOpen(true) }}
                        onFocus={() => setDepDropdownOpen(true)}
                        onBlur={() => setTimeout(() => setDepDropdownOpen(false), 150)}
                        placeholder="Search tasks to link..."
                        className={inputClass}
                      />
                      {depDropdownOpen && (
                        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-32 overflow-y-auto bg-x-surface border border-x-line rounded-md shadow-x-1">
                          {Object.values(allTasks)
                            .filter((t) =>
                              t.id !== task.id &&
                              t.workspace_id === workspaceId &&
                              !dependsOn.includes(t.id) &&
                              (!depSearch || t.title?.toLowerCase().includes(depSearch.toLowerCase()))
                            )
                            .slice(0, 8)
                            .map((t) => (
                              <button
                                key={t.id}
                                onClick={() => {
                                  setDependsOn((prev) => [...prev, t.id])
                                  setDepSearch('')
                                  setDepDropdownOpen(false)
                                }}
                                className="w-full text-left px-2.5 py-1.5 text-[12px] text-x-ink-secondary hover:bg-x-hover hover:text-x-ink truncate border-b border-x-line-subtle last:border-0"
                              >
                                {t.title}
                                <span className="ml-1.5 text-[11px] text-x-faint font-medium">{t.status}</span>
                              </button>
                            ))}
                          {Object.values(allTasks).filter((t) =>
                            t.id !== task.id && t.workspace_id === workspaceId && !dependsOn.includes(t.id) &&
                            (!depSearch || t.title?.toLowerCase().includes(depSearch.toLowerCase()))
                          ).length === 0 && (
                            <div className="px-2.5 py-1.5 text-[11px] text-x-faint">No matching tasks</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Activity / Runs */}
          {tab === 'history' && (() => {
            let history = []
            try { history = JSON.parse(task.iteration_history || '[]') } catch {}
            const currentIteration = task.iteration || 1
            const events = [...taskEvents].sort((a, b) => {
              const ad = asDate(a.created_at)?.getTime() || 0
              const bd = asDate(b.created_at)?.getTime() || 0
              return bd - ad
            })
            const hasActivity = history.length || taskRuns.length || events.length || task.result_summary || task.lessons_learned || currentIteration > 1

            if (!hasActivity) {
              return (
                <div className="flex flex-col items-center justify-center py-16 text-x-faint">
                  <Activity size={24} className="mb-2 opacity-50" />
                  <p className="text-[13px] font-medium text-x-ink-secondary">No task activity yet</p>
                  <p className="text-[11px] mt-1">Runs, status changes, and iteration summaries appear here.</p>
                </div>
              )
            }

            return (
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b border-x-line">
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-x-accent/20 border border-x-accent/30 text-x-accent">
                    Current: v{currentIteration}
                  </span>
                  <span className="text-[11px] text-x-faint">
                    {task.status === 'in_progress' ? 'Agent working...' : task.status}
                  </span>
                  {historyLoading && (
                    <span className="text-[11px] text-x-faint">loading...</span>
                  )}
                  {task.last_agent_session_id && (
                    <span className="text-[11px] text-x-faint ml-auto">
                      Last agent: {sessions[task.last_agent_session_id]?.name || task.last_agent_session_id?.slice(0, 8)}
                    </span>
                  )}
                </div>

                {task.result_summary && (
                  <div className="p-3 bg-x-surface-2 border border-x-line rounded-lg">
                    <label className="text-xs font-medium text-x-accent block mb-1">Current Result</label>
                    <p className="text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">{task.result_summary}</p>
                  </div>
                )}

                {task.lessons_learned && (
                  <div className="p-3 bg-x-good/5 border border-x-good/20 rounded-lg">
                    <label className="text-xs font-medium text-x-good block mb-1">Current Lessons Learned</label>
                    <p className="text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">{task.lessons_learned}</p>
                  </div>
                )}

                {taskRuns.length > 0 && (
                  <section className="space-y-2">
                    <div className="flex items-center gap-2">
                      <GitBranch size={13} className="text-x-accent" />
                      <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-x-ink-secondary">Pipeline Runs</h3>
                      <span className="text-[11px] text-x-faint">{taskRuns.length}</span>
                    </div>

                    {taskRuns.map((run) => {
                      const defn = pipelines.find((p) => p.id === run.pipeline_id)
                      const stageById = new Map((defn?.stages || []).map((s) => [s.id, s]))
                      const stageEntries = Object.entries(run.stage_history || {})
                      return (
                        <div key={run.id} className="border border-x-line rounded-lg overflow-hidden">
                          <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-x-surface-2 border-b border-x-line">
                            <span className={`px-1.5 py-0.5 rounded-md text-[11px] font-medium ${
                              run.status === 'running' ? 'bg-x-good/10 text-x-good border border-x-good/20' :
                              run.status === 'paused' ? 'bg-x-accent-ink/10 text-x-accent-ink border border-x-accent-ink/20' :
                              run.status === 'completed' ? 'bg-x-good/10 text-x-good border border-x-good/20' :
                              run.status === 'failed' || run.status === 'max_iterations' ? 'bg-x-accent-ink/10 text-x-accent-ink border border-x-accent-ink/20' :
                              'bg-x-surface text-x-ink-secondary border border-x-line'
                            }`}>
                              {run.status}
                            </span>
                            <span className="text-[11px] text-x-ink-secondary truncate max-w-[260px]">
                              {defn?.name || 'Task pipeline'}
                            </span>
                            <span className="text-[11px] text-x-faint tabular-nums">
                              iter {run.iteration || 1}
                            </span>
                            {run.started_at && (
                              <span className="text-[11px] text-x-faint">
                                {formatDateTime(run.started_at)}
                              </span>
                            )}
                            {run.completed_at && (
                              <span className="text-[11px] text-x-faint flex items-center gap-1">
                                <Clock3 size={10} /> {formatDuration(run.started_at, run.completed_at)}
                              </span>
                            )}
                            <div className="ml-auto flex items-center gap-1">
                              <Button type="submit" onClick={() => { if (deliveryAvailable) setSelectedRunDetailId(run.id) }} disabled={!deliveryAvailable} title={!deliveryAvailable ? DELIVERY_UNAVAILABLE : undefined} className="px-1.5 py-0.5 text-[11px] font-medium bg-x-tint text-x-accent border border-x-accent/30 hover:bg-x-accent/15 transition-colors duration-[80ms]">
                                Run Detail
                              </Button>
                              {run.status === 'paused' && (
                                <Button type="submit" onClick={() => handlePipelineRunAction(run.id, 'resume')} disabled={!deliveryAvailable} title={!deliveryAvailable ? DELIVERY_UNAVAILABLE : undefined} className="px-1.5 py-0.5 text-[11px] font-medium bg-x-good/10 text-x-good border border-x-good/30 hover:bg-x-good/15 transition-colors duration-[80ms]">
                                  Resume
                                </Button>
                              )}
                              {(run.status === 'running' || run.status === 'paused') && (
                                <Button type="submit" onClick={() => handlePipelineRunAction(run.id, 'cancel')} disabled={!deliveryAvailable} title={!deliveryAvailable ? DELIVERY_UNAVAILABLE : undefined} className="px-1.5 py-0.5 text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink border border-x-accent-ink/30 hover:bg-x-accent-ink/15 transition-colors duration-[80ms]">
                                  Cancel
                                </Button>
                              )}
                            </div>
                          </div>

                          <div className="divide-y divide-x-line">
                            {stageEntries.map(([stageId, sh]) => {
                              const stage = stageById.get(stageId) || {}
                              const parsed = parsePipelineOutput(sh.output_summary)
                              const session = sh.session_id ? sessions[sh.session_id] : null
                              return (
                                <details key={stageId} className="group">
                                  <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-x-hover">
                                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                                      sh.status === 'running' ? 'bg-x-good animate-subtle-pulse' :
                                      sh.status === 'completed' ? 'bg-x-good' :
                                      sh.status === 'failed' ? 'bg-x-accent-ink' :
                                      'bg-x-faint'
                                    }`} />
                                    <span className="text-[11px] text-x-ink-secondary truncate">
                                      {stage.name || stageId}
                                    </span>
                                    <span className="text-[11px] text-x-faint">
                                      {stage.type || 'stage'} · {sh.status || 'pending'}
                                    </span>
                                    {parsed.result && (
                                      <span className={`ml-auto px-1.5 py-0.5 rounded-md text-[11px] font-medium ${
                                        parsed.result === 'pass' ? 'bg-x-good/10 text-x-good' :
                                        parsed.result === 'fail' ? 'bg-x-accent-ink/10 text-x-accent-ink' :
                                        'bg-x-accent-ink/10 text-x-accent-ink'
                                      }`}>
                                        {parsed.result}
                                      </span>
                                    )}
                                  </summary>
                                  <div className="px-3 pb-3 pl-7 space-y-2">
                                    <div className="flex flex-wrap gap-2 text-[11px] text-x-faint">
                                      {sh.started_at && <span>started {formatDateTime(sh.started_at)}</span>}
                                      {sh.completed_at && <span>duration {formatDuration(sh.started_at, sh.completed_at)}</span>}
                                      {sh.session_id && (
                                        <button
                                          onClick={() => { useStore.getState().openSession(sh.session_id); onClose() }}
                                          className="inline-flex items-center gap-1 text-x-accent hover:text-x-accent-ink"
                                        >
                                          <Terminal size={10} /> {session?.name || sh.session_id.slice(0, 8)}
                                        </button>
                                      )}
                                    </div>
                                    {parsed.text && (
                                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-x-surface-2 border border-x-line p-2 text-[11px] text-x-ink-secondary font-mono">
                                        {parsed.text}
                                      </pre>
                                    )}
                                  </div>
                                </details>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </section>
                )}

                {events.length > 0 && (
                  <section className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Activity size={13} className="text-x-accent" />
                      <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-x-ink-secondary">Ticket Timeline</h3>
                      <span className="text-[11px] text-x-faint">{events.length}</span>
                    </div>
                    <div className="border border-x-line rounded-lg overflow-hidden divide-y divide-x-line">
                      {events.slice(0, 40).map((event) => (
                        <div key={event.id} className="px-3 py-2 bg-x-surface-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <CircleDot size={10} className="text-x-faint" />
                            <span className="text-[11px] font-medium text-x-ink-secondary uppercase tracking-[0.06em]">
                              {(event.event_type || 'event').replaceAll('_', ' ')}
                            </span>
                            {event.actor && <span className="text-[11px] text-x-faint">{event.actor}</span>}
                            <span className="text-[11px] text-x-faint ml-auto">{formatDateTime(event.created_at)}</span>
                          </div>
                          {(event.message || event.new_value) && (
                            <p className="mt-1 pl-5 text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">
                              {event.message || event.new_value}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {history.length > 0 && (
                  <section className="space-y-2">
                    <div className="flex items-center gap-2">
                      <RotateCcw size={13} className="text-x-accent-ink" />
                      <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-x-ink-secondary">Iteration Snapshots</h3>
                      <span className="text-[11px] text-x-faint">{history.length}</span>
                    </div>
                    {[...history].reverse().map((h, i) => (
                      <div key={i} className="border border-x-line rounded-lg overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-x-surface-2 border-b border-x-line">
                          <span className="px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-x-surface text-x-ink-secondary">
                            v{h.iteration}
                          </span>
                          {h.completed_at && (
                            <span className="text-[11px] text-x-faint">{formatDateTime(h.completed_at)}</span>
                          )}
                          {(h.agent_session_name || h.agent_session_id) && (
                            <span className="text-[11px] text-x-muted ml-auto flex items-center gap-1">
                              Agent: {h.agent_session_name || h.agent_session_id?.slice(0, 8)}
                            </span>
                          )}
                        </div>

                        <div className="p-3 space-y-2.5">
                          {h.result_summary && (
                            <div>
                              <label className="text-xs font-medium text-x-ink-secondary block mb-0.5">Result</label>
                              <p className="text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">{h.result_summary}</p>
                            </div>
                          )}

                          {h.pipeline_test_failure && (
                            <div>
                              <label className="text-xs font-medium text-x-accent-ink/80 block mb-0.5">Pipeline Failure</label>
                              <p className="text-[11px] text-x-ink-secondary font-mono whitespace-pre-wrap">{h.pipeline_test_failure}</p>
                            </div>
                          )}

                          {h.discoveries?.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-x-good/80 block mb-0.5">Discoveries</label>
                              <ul className="text-[11px] text-x-ink-secondary space-y-0.5">
                                {h.discoveries.map((d, j) => <li key={j} className="flex gap-1.5"><span className="text-x-good/60 shrink-0">-</span> {d}</li>)}
                              </ul>
                            </div>
                          )}

                          {h.decisions?.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-x-accent-ink/80 block mb-0.5">Decisions</label>
                              <ul className="text-[11px] text-x-ink-secondary space-y-0.5">
                                {h.decisions.map((d, j) => <li key={j} className="flex gap-1.5"><span className="text-x-accent-ink/60 shrink-0">-</span> {d}</li>)}
                              </ul>
                            </div>
                          )}

                          {h.files_touched?.length > 0 && (
                            <div>
                              <label className="text-xs font-medium text-x-ink-secondary block mb-0.5">Files Touched</label>
                              <div className="flex flex-wrap gap-1">
                                {h.files_touched.map((f, j) => (
                                  <span key={j} className="px-1.5 py-0.5 text-[11px] font-mono bg-x-surface border border-x-line rounded-md text-x-faint truncate max-w-[200px]">
                                    {f.split('/').pop()}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {h.lessons_learned && (
                            <div>
                              <label className="text-xs font-medium text-x-ink-secondary block mb-0.5">Lessons</label>
                              <p className="text-[11px] text-x-faint font-mono whitespace-pre-wrap">{h.lessons_learned}</p>
                            </div>
                          )}

                          {h.description && h.description !== task.description && (
                            <details className="mt-1">
                              <summary className="text-[11px] text-x-faint cursor-pointer hover:text-x-ink-secondary">Previous description</summary>
                              <p className="text-[11px] text-x-faint font-mono mt-1 whitespace-pre-wrap pl-2 border-l border-x-line">{h.description}</p>
                            </details>
                          )}
                        </div>
                      </div>
                    ))}
                  </section>
                )}
              </div>
            )
          })()}

          {/* Scratchpad */}
          {tab === 'scratchpad' && (
            <div className="flex flex-col md:flex-row gap-2 md:gap-1" style={{ height: 'calc(100dvh - 120px)', minHeight: '420px' }}>
              <div className="flex flex-col w-full md:w-[320px] min-h-[180px] md:min-h-0 shrink-0">
                <div className="flex flex-wrap items-center gap-1 mb-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-x-faint">Notes</span>
                  <Button type="submit" onClick={toggleVoice} className={`flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium border transition-colors duration-[80ms] ease-x ${
                    listening ? 'bg-x-accent-ink/10 border-x-accent-ink/30 text-x-accent-ink animate-subtle-pulse' : 'bg-x-surface border-x-line text-x-faint hover:text-x-ink-secondary'
                  }`}>
                    {listening ? <MicOff size={9} /> : <Mic size={9} />}
                    {listening ? 'stop' : 'voice'}
                  </Button>
                  <Button type="submit" onClick={handlePasteOverview} disabled={loadingOverview} className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium bg-x-surface border border-x-line text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms] disabled:opacity-40">
                    <ClipboardPaste size={9} />
                    {loadingOverview ? '...' : 'code'}
                  </Button>
                  <span className="text-[11px] text-x-faint ml-auto tabular-nums">{scratchText.length}c</span>
                </div>
                <textarea
                  value={scratchText}
                  onChange={(e) => setScratchText(e.target.value)}
                  placeholder="Notes, ideas, requirements..."
                  className={`${inputClass} resize-none leading-relaxed flex-1`}
                />
              </div>

              <div className="flex-1 flex flex-col min-w-0 min-h-[260px]">
                <div className="flex flex-wrap items-center gap-1 mb-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-x-faint">Diagram</span>
                  <Button type="submit"
                    onClick={handleExportPng}
                    className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium bg-x-surface border border-x-line text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
                  >
                    <Download size={9} /> attach PNG
                  </Button>
                  <span className="text-[11px] text-x-faint ml-auto">
                    right-click: text · 2x right-click: voice · scroll: zoom
                  </span>
                </div>
                <div className="flex-1 rounded-lg border border-x-line overflow-hidden">
                  <ExcalidrawWrapper
                    initialData={diagramData}
                    onChange={(data) => setDiagramData(data)}
                    taskId={task.id}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Preview */}
          {tab === 'preview' && (
            <div className="flex flex-col" style={{ height: 'calc(100dvh - 120px)', minHeight: '360px' }}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <input
                  value={previewUrl}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                  placeholder="http://localhost:3000 or any URL"
                  className={`${inputClass} min-w-[220px] flex-1 text-xs`}
                />
                <Button type="submit"
                  onClick={() => window.open(previewUrl, '_blank')}
                  className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-x-surface border border-x-line text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
                >
                  <ExternalLink size={10} /> open
                </Button>
                <Button type="submit"
                  onClick={captureScreenshot}
                  className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-x-tint border border-x-accent/30 text-x-accent hover:bg-x-accent/15 transition-colors duration-[80ms]"
                  title="Browser will ask you to pick a screen/window to capture"
                >
                  <Camera size={10} /> screenshot & attach
                </Button>
                <Button type="submit"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('open-live-preview', {
                      detail: { url: previewUrl, taskId: task.id }
                    }))
                    onClose()
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-x-accent-ink/10 border border-x-accent-ink/30 text-x-accent-ink hover:bg-x-accent-ink/15 transition-colors duration-[80ms]"
                  title="Open live browser/screen annotator with voice note support"
                >
                  <Camera size={10} /> Live Annotator
                </Button>
              </div>
              <div className="flex-1 rounded-lg border border-x-line overflow-hidden bg-white">
                <iframe
                  ref={iframeRef}
                  src={previewUrl}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                  title="Preview"
                />
              </div>
              <p className="text-[11px] text-x-faint mt-1">
                Paste images anywhere in this modal with Cmd+V. Or use "screenshot & attach" to capture any window. Localhost URLs work best in the iframe.
              </p>
            </div>
          )}

          {/* Execute */}
          {tab === 'execute' && (
            <div className="space-y-4">
              {!deliveryAvailable && <p role="status" className="rounded-md border border-x-line bg-x-surface-2 p-3 text-[12px] text-x-muted">{DELIVERY_UNAVAILABLE} Direct worker execution remains available for tasks without pipeline options. Existing saved options are preserved.</p>}
              <div>
                <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Execution recipe</label>
                <select
                  value={selectedTaskPipelineId}
                  onChange={(e) => setSelectedTaskPipelineId(e.target.value)}
                  disabled={!deliveryAvailable}
                  title={!deliveryAvailable ? DELIVERY_UNAVAILABLE : undefined}
                  className={inputClass}
                >
                  <option value="">auto — direct worker or dynamic stage pipeline</option>
                  {taskPipelineOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.preset ? 'preset — ' : ''}{p.name || 'Untitled Pipeline'}{p.status ? ` (${p.status})` : ''}
                    </option>
                  ))}
                </select>
                {selectedTaskPipelineId ? (
                  <p className="text-[11px] text-x-faint mt-1">
                    Saved pipelines come from the Pipeline Editor and run with task variables injected.
                  </p>
                ) : (
                  <p className="text-[11px] text-x-faint mt-1">
                    <span className="text-x-accent font-semibold">auto:</span> Dynamically runs either a multi-stage pipeline (if execution options below are enabled) or a single direct worker.
                  </p>
                )}
                {selectedTaskPipelineVars.manual.length > 0 && (
                  <p className="text-[11px] text-x-accent-ink mt-1">
                    Needs manual variables: {selectedTaskPipelineVars.manual.join(', ')}
                  </p>
                )}
              </div>

              <div className="rounded-md border border-x-line bg-x-surface-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-x-ink-secondary">Execution path</div>
                    <div className="text-sm text-x-ink font-medium mt-0.5">
                      {customPipelineSelected ? selectedTaskPipeline?.name || 'Custom pipeline' : executeUsesPipeline ? 'Pipeline run' : 'Direct worker'}
                    </div>
                  </div>
                  <span className={`text-[11px] font-medium px-2 py-1 rounded-md border ${
                    executeUsesPipeline
                      ? 'text-x-good border-x-good/30 bg-x-good/10'
                      : 'text-x-accent border-x-accent/30 bg-x-accent/10'
                  }`}>
                    {customPipelineSelected
                      ? 'saved recipe'
                      : executeUsesPipeline
                        ? 'stage-tracked'
                        : assignedSession
                          ? 'assigned session'
                          : 'auto-routed'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-y-3 gap-x-1.5 select-none">
                  {previewStageItems.map((stage, index) => {
                    const Icon = stage.icon
                    return (
                      <div key={stage.id} className="flex items-center">
                        {index > 0 && (
                          <div className="w-5 h-0.5 bg-x-line mx-0.5 shrink-0" />
                        )}
                        <div className={`min-w-[96px] rounded-lg border p-2 transition-colors duration-[80ms] ${stageToneClass[stage.tone] || stageToneClass.indigo}`}>
                          <div className="flex items-center gap-1.5">
                            <Icon size={12} className="shrink-0" />
                            <span className="text-[11px] font-semibold text-x-ink leading-none truncate">{stage.label}</span>
                          </div>
                          <div className="mt-1 text-[11px] opacity-70 leading-none truncate">{stage.detail}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-x-faint mt-2.5">
                  {customPipelineSelected
                    ? 'Runs the selected pipeline definition against this task. Session logs stay visible either way.'
                    : executeUsesPipeline
                      ? (assignedSession
                          ? 'Creates a structured pipeline run. The implementation stage runs on the selected session; other stages are automatically routed by the backend.'
                          : 'Creates a structured pipeline run. The backend automatically selects or starts the best worker session for each stage.')
                      : (assignedSession
                          ? 'Sends the task directly to the selected worker session.'
                          : 'Backend routing automatically selects/reuses an idle compatible worker session (or starts a fresh one) using task metadata and digests, then sends the task there directly.')}
                </p>
                {!customPipelineSelected && planFirst && !autoApprovePlan && (
                  <p className="text-[11px] text-x-accent-ink mt-1">
                    Plan approval pauses the pipeline run. Resume the run after approving the plan.
                  </p>
                )}
              </div>

              {customPipelineSelected ? (
                <div className="rounded-md border border-x-line bg-x-surface-2 p-2">
                  <div className="text-[11px] text-x-ink-secondary">Selected pipeline controls the stages for this run.</div>
                  <div className="text-[11px] text-x-faint mt-0.5">
                    Edit this recipe in Pipelines if you want different agents, gates, hooks, or prompts.
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-medium text-x-ink-secondary mb-2 block">Execution options</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <ExecutionOption
                        checked={planFirst}
                        disabled={!deliveryAvailable}
                        onToggle={() => {
                          const next = !planFirst
                          setPlanFirst(next)
                          if (!next) setAutoApprovePlan(false)
                        }}
                        label="Plan first"
                        detail="Plan and review before implementation."
                        icon={MapIcon}
                        tone="indigo"
                      />
                      <ExecutionOption
                        checked={planFirst && autoApprovePlan}
                        onToggle={() => setAutoApprovePlan(!autoApprovePlan)}
                        label="Auto-approve plan"
                        detail={planFirst ? 'Proceed automatically after planning.' : 'Enable plan first to use this.'}
                        icon={ShieldCheck}
                        tone="green"
                        disabled={!deliveryAvailable || !planFirst}
                      />
                      <ExecutionOption
                        checked={ralphLoop}
                        disabled={!deliveryAvailable}
                        onToggle={() => setRalphLoop(!ralphLoop)}
                        label="Auto-fix loop"
                        detail="Build, check, and retry fixes until checks pass or the cycle limit is reached."
                        icon={Wrench}
                        tone="orange"
                      />
                      <ExecutionOption
                        checked={deepResearch}
                        disabled={!deliveryAvailable}
                        onToggle={() => setDeepResearch(!deepResearch)}
                        label="Deep research"
                        detail="Gather context before implementation."
                        icon={Search}
                        tone="purple"
                      />
                      <ExecutionOption
                        checked={testWithAgent}
                        disabled={!deliveryAvailable}
                        onToggle={() => setTestWithAgent(!testWithAgent)}
                        label="Test with agent"
                        detail="Verify with a read-only testing agent."
                        icon={TestTube2}
                        tone="cyan"
                      />
                      <ExecutionOption
                        checked={pipelineIsImplied || pipeline}
                        onToggle={() => setPipeline(!pipeline)}
                        label="Pipeline run"
                        detail={pipelineIsImplied ? 'Enabled by selected stages.' : 'Use stage history instead of direct worker.'}
                        icon={CheckCircle2}
                        tone="emerald"
                        disabled={!deliveryAvailable || pipelineIsImplied}
                      />
                    </div>
                  </div>
                  {(pipeline || ralphLoop) && (
                    <div className="rounded-md border border-x-line bg-x-surface-2 p-2.5 flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-[11px] text-x-ink-secondary">Maximum cycles</label>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={pipelineMaxIter}
                          disabled={!deliveryAvailable}
                          onChange={(e) => setPipelineMaxIter(parseInt(e.target.value) || 5)}
                          className="w-14 px-1.5 py-0.5 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary font-mono focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]"
                        />
                      </div>
                      {task.pipeline_stage && (
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md border w-fit ${
                          task.pipeline_stage === 'testing' ? 'text-x-accent border-x-accent/30 bg-x-accent/10' :
                          task.pipeline_stage === 'documenting' ? 'text-x-accent border-x-accent/30 bg-x-accent/10' :
                          task.pipeline_stage === 'done' ? 'text-x-good border-x-good/30 bg-x-good/10' :
                          'text-x-accent border-x-accent/30 bg-x-accent/10'
                        }`}>
                          Stage: {task.pipeline_stage}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="text-xs font-medium text-x-ink-secondary mb-1 block">Assign to session</label>
                <select value={assignedSession} onChange={(e) => setAssignedSession(e.target.value)} className={inputClass}>
                  <option value="">auto — backend auto-selects (reuse vs fresh)</option>
                  {workspaceSessions.map((s) => (
                    <option key={s.id} value={s.id}>{sessionLabel(s)}</option>
                  ))}
                </select>
                {assignedSession ? (
                  <p className="text-[11px] text-x-faint mt-1">
                    Direct tasks will execute on the selected session. Pipeline runs will use this session for the implementation stage.
                  </p>
                ) : (
                  <p className="text-[11px] text-x-faint mt-1">
                    <span className="text-x-accent font-semibold">auto-routed:</span> The backend's orchestration policy automatically reuses an idle compatible session or starts a fresh worker using task metadata and digests.
                  </p>
                )}
              </div>

              {task.assigned_session_id && (
                <button onClick={() => { useStore.getState().openSession(task.assigned_session_id); onClose() }} className="flex items-center gap-1 text-[11px] font-medium text-x-accent hover:text-x-accent-ink">
                  <ExternalLink size={10} /> Go to assigned session
                </button>
              )}

              <div className="pt-3 border-t border-x-line">
                <p className="text-[11px] text-x-faint mb-3">
                  {executeUsesPipeline
                    ? 'Starts a pipeline run with stage history, retries, and task status updates.'
                    : 'Sends the task directly to a worker. Commander remains optional for inspection and intervention.'}
                </p>
                <Button type="submit"
                  onClick={handleExecute}
                  disabled={!deliveryAvailable && executeUsesPipeline}
                  title={!deliveryAvailable && executeUsesPipeline ? DELIVERY_UNAVAILABLE : undefined}
                  className="flex items-center justify-center gap-1.5 h-[30px] px-4 text-[13px] bg-x-accent hover:bg-x-accent-ink text-x-on-accent font-medium active:scale-[0.98] transition-colors duration-[80ms] ease-x cursor-pointer"
                >
                  <Play size={13} strokeWidth={1.75} /> {executeUsesPipeline ? 'Start Pipeline Run' : 'Execute Task'}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 px-4 md:px-5 py-2.5 border-t border-x-line bg-x-surface-2 shrink-0 select-none text-[11px] text-x-faint">
          <Button type="submit"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 h-[30px] px-4 text-[13px] bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 text-x-on-accent font-medium active:scale-[0.98] transition-colors duration-[80ms] ease-x cursor-pointer"
          >
            <Save size={13} strokeWidth={1.75} /> {saving ? 'saving...' : 'Save Changes'}
          </Button>
          <div className="flex-1" />
          <span className="hidden md:inline text-[11px] text-x-faint">
            <kbd className="text-x-faint">⌘S</kbd> save · <kbd className="text-x-faint">{formatKeyCombo(useStore.getState().keybindings.taskTabPrev)}/{formatKeyCombo(useStore.getState().keybindings.taskTabNext)}</kbd> tabs · <kbd className="text-x-faint">{formatKeyCombo(useStore.getState().keybindings.taskFieldPrev)}/{formatKeyCombo(useStore.getState().keybindings.taskFieldNext)}</kbd> fields
          </span>
          {task.created_at && (
            <span>created {task.created_at?.replace('T', ' ').slice(0, 16)}</span>
          )}
        </div>
      </div>
    </div>
    {selectedRunDetailId && deliveryAvailable && (
      <PipelineRunDetail
        runId={selectedRunDetailId}
        initialRun={taskRuns.find((r) => r.id === selectedRunDetailId)}
        onClose={() => setSelectedRunDetailId(null)}
        onRunUpdate={(updated) => {
          setTaskPipelineRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        }}
      />
    )}
    </>
  )
}
