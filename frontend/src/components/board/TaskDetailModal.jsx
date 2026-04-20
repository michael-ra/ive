import { useState, useEffect, useCallback, useRef } from 'react'
import {
  X, Save, Trash2, ExternalLink, Mic, MicOff,
  Play, ClipboardPaste, CheckSquare, PenTool, FileText, Download,
  Image, Upload, Globe, Camera, RotateCcw, ChevronDown, ChevronRight, Link
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { matchesKey, formatKeyCombo } from '../../lib/keybindings'
import { sendTerminalCommand } from '../../lib/terminal'
import { useVoiceInput } from '../../hooks/useVoiceInput'

import ExcalidrawWrapper, { extractDiagramNotes } from './ExcalidrawWrapper'

const STATUSES = ['backlog', 'todo', 'planning', 'in_progress', 'review', 'testing', 'documenting', 'done', 'blocked']
const PRIORITIES = ['normal', 'high', 'critical']
const TABS = ['details', 'history', 'scratchpad', 'preview', 'execute']

function parseScratchpad(raw) {
  if (!raw) return { text: '', diagram: null }
  try {
    const parsed = JSON.parse(raw)
    if (parsed.text !== undefined) return parsed
  } catch {}
  return { text: raw, diagram: null } // Legacy: plain text
}

export default function TaskDetailModal({ task, workspaceId, commanderSessionId, onSave, onDelete, onClose }) {
  const [tab, setTab] = useState('details')
  const [scratchMode, setScratchMode] = useState('text') // text | diagram
  const [title, setTitle] = useState(task.title || '')
  const [description, setDescription] = useState(task.description || '')
  const [acceptance, setAcceptance] = useState(task.acceptance_criteria || '')
  const [status, setStatus] = useState(task.status || 'backlog')
  const [priority, setPriority] = useState(task.priority || 'normal')
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
  const [pipelineMaxIter, setPipelineMaxIter] = useState(task.pipeline_max_iterations || 5)
  const [assignedSession, setAssignedSession] = useState(task.assigned_session_id || '')
  const [saving, setSaving] = useState(false)
  const [iterating, setIterating] = useState(false)
  const [showRevisionForm, setShowRevisionForm] = useState(false)
  const [revisionNotes, setRevisionNotes] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(task.preview_url || 'http://localhost:5173')
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
        video: { mediaSource: 'screen' },
        preferCurrentTab: true,
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
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId)
  const depsEnabled = currentWorkspace?.task_dependencies_enabled
  const workspaceSessions = Object.values(sessions).filter(
    (s) => s.workspace_id === workspaceId && s.session_type !== 'commander' && s.session_type !== 'tester'
  )

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
      plan_first: planFirst ? 1 : 0, auto_approve_plan: autoApprovePlan ? 1 : 0,
      ralph_loop: ralphLoop ? 1 : 0, deep_research: deepResearch ? 1 : 0,
      test_with_agent: testWithAgent ? 1 : 0,
      pipeline: pipeline ? 1 : 0, pipeline_max_iterations: pipelineMaxIter,
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
    await handleSave()
    if (!commanderSessionId) { alert('No Commander session. Start one from the sidebar.'); return }
    // Extract diagram text notes
    const diagramNotes = extractDiagramNotes(diagramData)
    const notesText = diagramNotes.length > 0
      ? `Diagram annotations:\n${diagramNotes.map((n) => `  note-${n.id}: ${n.text}`).join('\n')}`
      : ''

    // Include attachment file paths so the session can see images
    const imageAttachments = attachments.filter((a) => a.path && a.filename.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i))
    const attachmentText = imageAttachments.length > 0
      ? `Attached images:\n${imageAttachments.map((a) => `  ${a.path}`).join('\n')}`
      : ''

    const prompt = [
      `Pick up task: ${title}`,
      `Task ID: ${task.id}`,
      description ? `Description: ${description}` : '',
      acceptance ? `Acceptance criteria: ${acceptance}` : '',
      scratchText ? `Text notes:\n${scratchText}` : '',
      notesText,
      attachmentText,
      `Plan first: ${planFirst ? 'yes — research and plan, then come back for refinement before implementing' : 'no — implement directly'}`,
      ralphLoop ? 'Ralph mode: ON — worker must loop (execute→verify→fix) until ALL tests/build pass. Do not accept partial completion. Inject the ralph loop system prompt into the worker session.' : '',
      deepResearch ? 'Deep research: ON — invoke the deep_research MCP tool BEFORE creating the worker session. Use the research output to enrich the worker\'s task context. The research should focus on the task description and acceptance criteria.' : '',
      (task.iteration || 1) > 1 ? `This is iteration ${task.iteration} of this task (revision requested). Previous work was done by session ${task.last_agent_session_id || 'unknown'}. Build on previous work, don't start from scratch.` : '',
      assignedSession
        ? `Use session: ${sessions[assignedSession]?.name || assignedSession}`
        : 'Create new worker or assign to best-fit existing session.',
      `Status tracking: Update this task via update_task(task_id="${task.id}") — set status to "in_progress" when work begins, and "done" with a result_summary when complete.`,
    ].filter(Boolean).join('\n')
    sendTerminalCommand(commanderSessionId, prompt)
    await api.updateTask2(task.id, { status: 'todo' })
    useStore.getState().updateTaskInStore({ ...task, status: 'todo' })
    onClose()
  }

  const tabClass = (t) => `px-2.5 py-1.5 text-[11px] font-mono transition-colors cursor-pointer ${
    tab === t ? 'text-zinc-200 border-b-2 border-indigo-500' : 'text-zinc-500 hover:text-zinc-300'
  }`
  const subTabClass = (t) => `px-1.5 py-1.5 text-[11px] font-mono rounded transition-colors ${
    scratchMode === t ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30' : 'text-zinc-500 hover:text-zinc-300 border border-zinc-800'
  }`
  const inputClass = 'w-full px-2.5 py-1.5 text-[11px] bg-[#111118] border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className={`bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in ${
          (tab === 'scratchpad' || tab === 'preview')
            ? 'w-[95vw] h-[90vh]'
            : 'w-[780px] max-h-[90vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs */}
        <div ref={tabBarRef} className="flex items-center border-b border-zinc-800 px-4">
          <button data-tab="details" onClick={() => setTab('details')} className={tabClass('details')}>Details</button>
          <button data-tab="history" onClick={() => setTab('history')} className={tabClass('history')}>
            Agent History{(task.iteration || 1) > 1 ? ` (${(task.iteration || 1) - 1})` : ''}
          </button>
          <button data-tab="scratchpad" onClick={() => setTab('scratchpad')} className={tabClass('scratchpad')}>
            Scratchpad{(scratchText || diagramData) ? ' *' : ''}
          </button>
          <button data-tab="preview" onClick={() => setTab('preview')} className={tabClass('preview')}>
            <span className="flex items-center gap-1"><Globe size={10} /> Preview</span>
          </button>
          <button data-tab="execute" onClick={() => setTab('execute')} className={tabClass('execute')}>Execute</button>
          <div className="flex-1" />
          <button onClick={() => onDelete(task.id)} className="p-1 text-zinc-600 hover:text-red-400 mr-1"><Trash2 size={12} /></button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"><X size={16} /></button>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto p-4" style={{ minHeight: 0 }}>
          {/* ─── Details ─── */}
          {tab === 'details' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" className={`${inputClass} text-[11px] font-medium flex-1`} />
                {(task.iteration || 1) > 1 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 shrink-0">
                    v{task.iteration}
                  </span>
                )}
              </div>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description..." rows={4} className={`${inputClass} resize-none`} />
              <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="Acceptance criteria..." rows={3} className={`${inputClass} resize-none`} />
              <div className="flex gap-1.5">
                <div className="flex-1">
                  <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Priority</label>
                  <div className="flex gap-1">
                    {PRIORITIES.map((p) => (
                      <button key={p} onClick={() => setPriority(p)} className={`flex-1 px-1.5 py-1.5 text-[11px] font-mono rounded border transition-colors ${
                        priority === p
                          ? p === 'critical' ? 'bg-red-500/20 border-red-500/30 text-red-300' : p === 'high' ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-zinc-700 border-zinc-600 text-zinc-300'
                          : 'bg-[#111118] border-zinc-800 text-zinc-500 hover:border-zinc-600'
                      }`}>{p}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Labels</label>
                <input value={labelsStr} onChange={(e) => setLabelsStr(e.target.value)} placeholder="comma-separated" className={inputClass} />
              </div>
              {depsEnabled && (
                <div>
                  <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 flex items-center gap-1">
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
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border ${
                              isDone
                                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                            }`}
                          >
                            {depTask?.title || depId.slice(0, 8)}
                            <button onClick={() => setDependsOn((prev) => prev.filter((id) => id !== depId))} className="hover:text-red-400">
                              <X size={9} />
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
                      placeholder="Search tasks to add dependency..."
                      className={inputClass}
                    />
                    {depDropdownOpen && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-32 overflow-y-auto bg-[#111118] border border-zinc-700 rounded shadow-lg">
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
                              className="w-full text-left px-2.5 py-1.5 text-[11px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 truncate"
                            >
                              {t.title}
                              <span className="ml-1 text-[9px] text-zinc-600">{t.status}</span>
                            </button>
                          ))}
                        {Object.values(allTasks).filter((t) =>
                          t.id !== task.id && t.workspace_id === workspaceId && !dependsOn.includes(t.id) &&
                          (!depSearch || t.title?.toLowerCase().includes(depSearch.toLowerCase()))
                        ).length === 0 && (
                          <div className="px-2.5 py-1.5 text-[10px] text-zinc-600 font-mono">No matching tasks</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {task.result_summary && (
                <div>
                  <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Result</label>
                  <p className="text-[11px] text-zinc-400 font-mono bg-[#111118] rounded p-3 whitespace-pre-wrap">{task.result_summary}</p>
                </div>
              )}

              {/* Request Revision (visible on done/review/verified tasks) */}
              {['done', 'review', 'verified'].includes(task.status) && (
                <div className="border border-zinc-700 rounded p-3 space-y-2">
                  {!showRevisionForm ? (
                    <button
                      onClick={() => setShowRevisionForm(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 rounded transition-colors"
                    >
                      <RotateCcw size={11} /> Request Revision (v{(task.iteration || 1) + 1})
                    </button>
                  ) : (
                    <>
                      <label className="text-[11px] text-zinc-500 font-mono uppercase block">Revision Notes</label>
                      <textarea
                        value={revisionNotes}
                        onChange={(e) => setRevisionNotes(e.target.value)}
                        placeholder="What needs to change? Add feedback, corrections, new requirements..."
                        rows={3}
                        className={`${inputClass} resize-none`}
                        autoFocus
                      />
                      <p className="text-[10px] text-zinc-600">
                        You can also edit the description and acceptance criteria above before submitting.
                      </p>
                      <div className="flex gap-2">
                        <button
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
                          className="px-2.5 py-1.5 text-[11px] font-mono bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-50"
                        >
                          {iterating ? 'Submitting...' : `Submit as v${(task.iteration || 1) + 1}`}
                        </button>
                        <button
                          onClick={() => { setShowRevisionForm(false); setRevisionNotes('') }}
                          className="px-2.5 py-1.5 text-[11px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
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
                <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Attachments</label>
                <div className="flex flex-wrap gap-1 mb-2">
                  {attachments.map((a) => (
                    <a
                      key={a.filename}
                      href={a.url}
                      target="_blank"
                      rel="noopener"
                      className="group relative w-20 h-20 rounded border border-zinc-700 overflow-hidden hover:border-indigo-500 transition-colors"
                    >
                      {a.filename.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)
                        ? <img src={a.url} className="w-full h-full object-cover" />
                        : <div className="flex items-center justify-center h-full text-[11px] text-zinc-500 font-mono p-1 text-center break-all">{a.filename}</div>
                      }
                    </a>
                  ))}
                </div>
                <label className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-zinc-800 border border-zinc-700 border-dashed rounded text-zinc-400 hover:text-zinc-300 hover:border-zinc-500 cursor-pointer transition-colors w-fit">
                  <Upload size={10} /> attach image/file
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
          )}

          {/* ─── Agent History ─── */}
          {tab === 'history' && (() => {
            let history = []
            try { history = JSON.parse(task.iteration_history || '[]') } catch {}
            const currentIteration = task.iteration || 1

            if (!history.length && currentIteration <= 1) {
              return (
                <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
                  <RotateCcw size={24} className="mb-2 opacity-50" />
                  <p className="text-[11px] font-mono">No agent history yet</p>
                  <p className="text-[10px] mt-1">History appears after a task is completed and iterated</p>
                </div>
              )
            }

            return (
              <div className="space-y-4">
                {/* Current iteration indicator */}
                <div className="flex items-center gap-2 pb-2 border-b border-zinc-800">
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300">
                    Current: v{currentIteration}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono">
                    {task.status === 'in_progress' ? 'Agent working...' : task.status}
                  </span>
                  {task.last_agent_session_id && (
                    <span className="text-[10px] text-zinc-600 font-mono ml-auto">
                      Last agent: {sessions[task.last_agent_session_id]?.name || task.last_agent_session_id?.slice(0, 8)}
                    </span>
                  )}
                </div>

                {/* Current lessons (from latest completion) */}
                {task.lessons_learned && (
                  <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded">
                    <label className="text-[10px] text-emerald-400 font-mono uppercase block mb-1">Current Lessons Learned</label>
                    <p className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap">{task.lessons_learned}</p>
                  </div>
                )}

                {/* Past iterations — newest first */}
                {[...history].reverse().map((h, i) => (
                  <div key={i} className="border border-zinc-800 rounded overflow-hidden">
                    {/* Iteration header */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/50 border-b border-zinc-800">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-700 text-zinc-300">
                        v{h.iteration}
                      </span>
                      {h.completed_at && (
                        <span className="text-[10px] text-zinc-600 font-mono">
                          {new Date(h.completed_at).toLocaleDateString()} {new Date(h.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      {(h.agent_session_name || h.agent_session_id) && (
                        <span className="text-[10px] text-zinc-500 font-mono ml-auto flex items-center gap-1">
                          Agent: {h.agent_session_name || h.agent_session_id?.slice(0, 8)}
                        </span>
                      )}
                    </div>

                    <div className="p-3 space-y-2.5">
                      {/* Result summary */}
                      {h.result_summary && (
                        <div>
                          <label className="text-[10px] text-zinc-600 font-mono uppercase block mb-0.5">Result</label>
                          <p className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap">{h.result_summary}</p>
                        </div>
                      )}

                      {/* Discoveries & Decisions */}
                      {h.discoveries?.length > 0 && (
                        <div>
                          <label className="text-[10px] text-emerald-500/80 font-mono uppercase block mb-0.5">Discoveries</label>
                          <ul className="text-[11px] text-zinc-400 font-mono space-y-0.5">
                            {h.discoveries.map((d, j) => <li key={j} className="flex gap-1.5"><span className="text-emerald-500/60 shrink-0">-</span> {d}</li>)}
                          </ul>
                        </div>
                      )}

                      {h.decisions?.length > 0 && (
                        <div>
                          <label className="text-[10px] text-amber-500/80 font-mono uppercase block mb-0.5">Decisions</label>
                          <ul className="text-[11px] text-zinc-400 font-mono space-y-0.5">
                            {h.decisions.map((d, j) => <li key={j} className="flex gap-1.5"><span className="text-amber-500/60 shrink-0">-</span> {d}</li>)}
                          </ul>
                        </div>
                      )}

                      {/* Files touched */}
                      {h.files_touched?.length > 0 && (
                        <div>
                          <label className="text-[10px] text-zinc-600 font-mono uppercase block mb-0.5">Files Touched</label>
                          <div className="flex flex-wrap gap-1">
                            {h.files_touched.map((f, j) => (
                              <span key={j} className="px-1.5 py-0.5 text-[10px] font-mono bg-zinc-800 border border-zinc-700 rounded text-zinc-500 truncate max-w-[200px]">
                                {f.split('/').pop()}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Lessons & Notes */}
                      {h.lessons_learned && (
                        <div>
                          <label className="text-[10px] text-zinc-600 font-mono uppercase block mb-0.5">Lessons</label>
                          <p className="text-[11px] text-zinc-500 font-mono whitespace-pre-wrap">{h.lessons_learned}</p>
                        </div>
                      )}

                      {/* Previous description (collapsible if different from current) */}
                      {h.description && h.description !== task.description && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-zinc-600 font-mono cursor-pointer hover:text-zinc-400">Previous description</summary>
                          <p className="text-[11px] text-zinc-500 font-mono mt-1 whitespace-pre-wrap pl-2 border-l border-zinc-800">{h.description}</p>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}

          {/* ─── Scratchpad: side-by-side text + diagram ─── */}
          {tab === 'scratchpad' && (
            <div className="flex gap-1" style={{ height: 'calc(90vh - 120px)', minHeight: '500px' }}>
              {/* Left: text notes */}
              <div className="flex flex-col w-[320px] shrink-0">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[11px] text-zinc-600 font-mono uppercase">Notes</span>
                  <button onClick={toggleVoice} className={`flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono rounded border transition-colors ${
                    listening ? 'bg-red-500/20 border-red-500/30 text-red-300 animate-pulse' : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                  }`}>
                    {listening ? <MicOff size={9} /> : <Mic size={9} />}
                    {listening ? 'stop' : 'voice'}
                  </button>
                  <button onClick={handlePasteOverview} disabled={loadingOverview} className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-zinc-800 border border-zinc-700 text-zinc-500 hover:text-zinc-300 rounded transition-colors disabled:opacity-50">
                    <ClipboardPaste size={9} />
                    {loadingOverview ? '...' : 'code'}
                  </button>
                  <span className="text-[8px] text-zinc-700 font-mono ml-auto">{scratchText.length}c</span>
                </div>
                <textarea
                  value={scratchText}
                  onChange={(e) => setScratchText(e.target.value)}
                  placeholder="Notes, ideas, requirements..."
                  className={`${inputClass} resize-none leading-relaxed flex-1`}
                />
              </div>

              {/* Right: diagram canvas */}
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[11px] text-zinc-600 font-mono uppercase">Diagram</span>
                  <button
                    onClick={async () => {
                      // Attach PNG to task
                      const event = new CustomEvent('excalidraw-export-png')
                      window.dispatchEvent(event)
                    }}
                    className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-zinc-800 border border-zinc-700 text-zinc-500 hover:text-zinc-300 rounded transition-colors"
                  >
                    <Download size={9} /> attach PNG
                  </button>
                  <span className="text-[8px] text-zinc-700 font-mono ml-auto">
                    right-click: text · 2x right-click: voice · scroll: zoom
                  </span>
                </div>
                <div className="flex-1 rounded border border-zinc-700 overflow-hidden">
                  <ExcalidrawWrapper
                    initialData={diagramData}
                    onChange={(data) => setDiagramData(data)}
                    taskId={task.id}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ─── Preview ─── */}
          {tab === 'preview' && (
            <div className="flex flex-col" style={{ height: 'calc(90vh - 120px)', minHeight: '400px' }}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  value={previewUrl}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                  placeholder="http://localhost:3000"
                  className="flex-1 px-2.5 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={() => {
                    // Open URL in new tab as fallback
                    window.open(previewUrl, '_blank')
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-mono bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-300 rounded transition-colors"
                >
                  <ExternalLink size={10} /> open
                </button>
                <button
                  onClick={captureScreenshot}
                  className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-mono bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 rounded transition-colors"
                  title="Browser will ask you to pick a screen/window to capture"
                >
                  <Camera size={10} /> screenshot & attach
                </button>
              </div>
              <div className="flex-1 rounded border border-zinc-700 overflow-hidden bg-white">
                <iframe
                  ref={iframeRef}
                  src={previewUrl}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                  title="Preview"
                />
              </div>
              <p className="text-[9px] text-zinc-600 font-mono mt-1">
                Paste images anywhere in this modal with Cmd+V. Or use "screenshot & attach" to capture any window. Localhost URLs work best in the iframe.
              </p>
            </div>
          )}

          {/* ─── Execute ─── */}
          {tab === 'execute' && (
            <div className="space-y-4">
              <label className="flex items-center gap-1 cursor-pointer">
                <button onClick={() => setPlanFirst(!planFirst)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  planFirst ? 'bg-indigo-600 border-indigo-500' : 'border-zinc-600 hover:border-zinc-400'
                }`}>
                  {planFirst && <CheckSquare size={10} className="text-white" />}
                </button>
                <span className="text-[11px] text-zinc-300 font-mono">Plan first</span>
                <span className="text-[11px] text-zinc-600 font-mono">— research and plan before implementing</span>
              </label>

              {planFirst && (
                <label className="flex items-center gap-1 cursor-pointer ml-6">
                  <button onClick={() => setAutoApprovePlan(!autoApprovePlan)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    autoApprovePlan ? 'bg-green-600 border-green-500' : 'border-zinc-600 hover:border-zinc-400'
                  }`}>
                    {autoApprovePlan && <CheckSquare size={10} className="text-white" />}
                  </button>
                  <span className="text-[11px] text-zinc-300 font-mono">Auto-approve plan</span>
                  <span className="text-[11px] text-zinc-600 font-mono">— proceed automatically after planning</span>
                </label>
              )}

              <label className="flex items-center gap-1 cursor-pointer">
                <button onClick={() => setRalphLoop(!ralphLoop)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  ralphLoop ? 'bg-orange-600 border-orange-500' : 'border-zinc-600 hover:border-zinc-400'
                }`}>
                  {ralphLoop && <CheckSquare size={10} className="text-white" />}
                </button>
                <span className="text-[11px] text-zinc-300 font-mono">Ralph loop</span>
                <span className="text-[11px] text-zinc-600 font-mono">— execute→verify→fix until all checks pass</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer">
                <button onClick={() => setDeepResearch(!deepResearch)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  deepResearch ? 'bg-purple-600 border-purple-500' : 'border-zinc-600 hover:border-zinc-400'
                }`}>
                  {deepResearch && <CheckSquare size={10} className="text-white" />}
                </button>
                <span className="text-[11px] text-zinc-300 font-mono">Deep research</span>
                <span className="text-[11px] text-zinc-600 font-mono">— gather context with deep_research before implementation</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer">
                <button onClick={() => setTestWithAgent(!testWithAgent)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  testWithAgent ? 'bg-cyan-600 border-cyan-500' : 'border-zinc-600 hover:border-zinc-400'
                }`}>
                  {testWithAgent && <CheckSquare size={10} className="text-white" />}
                </button>
                <span className="text-[11px] text-zinc-300 font-mono">Test with agent</span>
                <span className="text-[11px] text-zinc-600 font-mono">— verify via testing agent (Playwright, read-only)</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer">
                <button onClick={() => setPipeline(!pipeline)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  pipeline ? 'bg-emerald-600 border-emerald-500' : 'border-zinc-600 hover:border-zinc-400'
                }`}>
                  {pipeline && <CheckSquare size={10} className="text-white" />}
                </button>
                <span className="text-[11px] text-zinc-300 font-mono">Pipeline</span>
                <span className="text-[11px] text-zinc-600 font-mono">— auto loop: implement → test → document → done</span>
              </label>
              {pipeline && (
                <div className="ml-5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-zinc-500 font-mono">Max iterations</label>
                    <input type="number" min={1} max={20} value={pipelineMaxIter}
                      onChange={(e) => setPipelineMaxIter(parseInt(e.target.value) || 5)}
                      className="w-14 px-1.5 py-0.5 text-[11px] bg-[#111118] border border-zinc-700 rounded text-zinc-300 font-mono focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  {task.pipeline_stage && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border w-fit ${
                      task.pipeline_stage === 'testing' ? 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' :
                      task.pipeline_stage === 'documenting' ? 'text-purple-400 border-purple-500/30 bg-purple-500/10' :
                      task.pipeline_stage === 'done' ? 'text-green-400 border-green-500/30 bg-green-500/10' :
                      'text-indigo-400 border-indigo-500/30 bg-indigo-500/10'
                    }`}>
                      Stage: {task.pipeline_stage}
                    </span>
                  )}
                </div>
              )}

              <div>
                <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Assign to session</label>
                <select value={assignedSession} onChange={(e) => setAssignedSession(e.target.value)} className={inputClass}>
                  <option value="">auto — Commander creates new or assigns to best fit</option>
                  {workspaceSessions.map((s) => (
                    <option key={s.id} value={s.id}>{sessionLabel(s)}</option>
                  ))}
                </select>
                <p className="text-[11px] text-zinc-700 font-mono mt-1">
                  Sessions show their current task/status. Commander picks the best idle session or creates a new one.
                </p>
              </div>

              {task.assigned_session_id && (
                <button onClick={() => { useStore.getState().openSession(task.assigned_session_id); onClose() }} className="flex items-center gap-1 text-[11px] font-mono text-indigo-400 hover:text-indigo-300">
                  <ExternalLink size={10} /> Go to assigned session
                </button>
              )}

              <div className="pt-3 border-t border-zinc-800">
                <p className="text-[11px] text-zinc-600 font-mono mb-3">
                  Sends task to Commander with details + scratchpad + diagram. Commander creates/assigns workers and tracks progress.
                </p>
                <button onClick={handleExecute} className="flex items-center gap-1 px-4 py-1.5 text-[11px] font-mono bg-green-600/20 hover:bg-green-600/30 text-green-300 border border-green-500/30 rounded transition-colors">
                  <Play size={12} /> Execute Task
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1 px-4 py-1.5 border-t border-zinc-800">
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded transition-colors disabled:opacity-50">
            <Save size={11} /> {saving ? 'saving...' : 'save'}
          </button>
          <div className="flex-1" />
          <span className="text-[10px] text-zinc-700 font-mono">
            <kbd className="text-zinc-600">⌘S</kbd> save · <kbd className="text-zinc-600">{formatKeyCombo(useStore.getState().keybindings.taskTabPrev)}/{formatKeyCombo(useStore.getState().keybindings.taskTabNext)}</kbd> tabs · <kbd className="text-zinc-600">{formatKeyCombo(useStore.getState().keybindings.taskFieldPrev)}/{formatKeyCombo(useStore.getState().keybindings.taskFieldNext)}</kbd> fields
          </span>
          <span className="text-[11px] text-zinc-700 font-mono">created {task.created_at?.replace('T', ' ').slice(0, 16)}</span>
        </div>
      </div>
    </div>
  )
}
