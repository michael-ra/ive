import { useState, useEffect, useRef, useCallback } from 'react'
import { FileText, X, Send, Save, CheckCircle, RefreshCw, Edit3, Eye, MessageSquare, Trash2 } from 'lucide-react'
import useStore from '../../state/store'
import { sendPlanChoice, sendPlanFeedback } from '../../lib/terminal'
import { api } from '../../lib/api'
import { uuid } from '../../lib/uuid'
import { getSessionStatusMeta, hasSessionStarted } from '../../lib/sessionStatus'

function parseDependsOn(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default function PlanViewer({ onClose }) {
  const plan = useStore((s) => s.activePlan)
  const planFilePaths = useStore((s) => s.planFilePaths)
  const allPlanFiles = useStore((s) => s.allPlanFiles)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const tasks = useStore((s) => s.tasks)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setActiveSessionId = useStore((s) => s.setActiveSessionId)
  const planWaiting = useStore((s) => s.planWaiting)

  const [viewingSessionId, setViewingSessionId] = useState(null)
  // When viewing an unmatched plan file directly (no session)
  const [viewingPlanPath, setViewingPlanPath] = useState(null)
  const [showUnmatched, setShowUnmatched] = useState(false)
  const blueprintMode = plan?.type === 'blueprint'
  const blueprintTaskId = blueprintMode ? plan?.taskId : null
  const [blueprintGoal, setBlueprintGoal] = useState(null)
  const [blueprintEpics, setBlueprintEpics] = useState([])
  const [blueprintEdits, setBlueprintEdits] = useState({})
  const [blueprintLoading, setBlueprintLoading] = useState(false)
  const [blueprintActionLoading, setBlueprintActionLoading] = useState(false)
  const sessionId = blueprintMode ? null : (viewingSessionId || plan?.sessionId || activeSessionId)
  const filePath = viewingPlanPath || (blueprintMode
    ? (plan?.blueprintPath || blueprintGoal?.blueprint_path || null)
    : planFilePaths[sessionId]) || null

  // Discover all plan files on mount
  useEffect(() => {
    api.listPlanFiles(activeWorkspaceId).then((res) => {
      if (!res.plans) return
      const store = useStore.getState()
      // Populate planFilePaths for all matched session plans
      const mapping = {}
      for (const p of res.plans) {
        if (p.session_id) mapping[p.session_id] = p.path
      }
      store.setPlanFilePaths(mapping)
      store.setAllPlanFiles(res.plans)
    }).catch(() => {})
  }, [activeWorkspaceId])

  // All sessions in this workspace that have plans (matched)
  const matchedPlans = Object.entries(planFilePaths)
    .filter(([sid]) => {
      const s = sessions[sid]
      return s && (!activeWorkspaceId || s.workspace_id === activeWorkspaceId)
    })
    .map(([sid, path]) => {
      const s = sessions[sid]
      const slug = path.replace(/^~\/\.[^/]+\/plans\//, '').replace(/\.md$/, '')
      return { sid, path, name: s?.name || sid.slice(0, 8), slug, status: s?.status }
    })

  // Unmatched plan files (exist on disk but no session match)
  const unmatchedPlans = allPlanFiles.filter(
    (p) => !p.session_id && !p.sub_plan
  )

  // Combined list: matched first (current session pinned to front), then unmatched (if toggled)
  const workspacePlans = [
    ...matchedPlans.sort((a, b) => (a.sid === activeSessionId ? -1 : b.sid === activeSessionId ? 1 : 0)),
    ...(showUnmatched ? unmatchedPlans.map((p) => ({
      sid: null, path: p.path,
      name: p.filename.replace('.md', ''),
      slug: p.filename.replace('.md', ''),
      status: null,
    })) : []),
  ]

  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('preview') // 'edit' | 'preview'
  const [feedbackText, setFeedbackText] = useState('')

  // Inline comments: { id, selectedText, comment }
  const [comments, setComments] = useState([])
  const [commentPopover, setCommentPopover] = useState(null) // { x, y, selectedText }
  const [commentInput, setCommentInput] = useState('')
  const [hoverTooltip, setHoverTooltip] = useState(null) // { x, y, comment, selectedText }
  const previewRef = useRef(null)
  const popoverRef = useRef(null)

  const session = sessions[sessionId]
  const hasChanges = content !== originalContent
  const showFileEditor = !!filePath
  const editedEpics = blueprintEpics.map((epic) => ({
    ...epic,
    ...(blueprintEdits[epic.id] || {}),
  }))

  useEffect(() => {
    if (!blueprintTaskId) return
    let cancelled = false
    setBlueprintLoading(true)
    setError(null)
    api.getTask(blueprintTaskId)
      .then(async (goal) => {
        if (cancelled) return
        setBlueprintGoal(goal)
        const wsId = goal.workspace_id || activeWorkspaceId
        const taskList = wsId ? await api.getTasks(wsId) : []
        if (cancelled) return
        const epics = (Array.isArray(taskList) ? taskList : [])
          .filter((t) => t.parent_task_id === blueprintTaskId && t.tier === 'epic')
          .sort((a, b) => (Number(a.phase || 0) - Number(b.phase || 0)) || String(a.title || '').localeCompare(String(b.title || '')))
        setBlueprintEpics(epics)
        setBlueprintEdits(Object.fromEntries(epics.map((epic) => [epic.id, {
          title: epic.title || '',
          description: epic.description || '',
          acceptance_criteria: epic.acceptance_criteria || '',
          phase: Number(epic.phase || 1),
          depends_on: parseDependsOn(epic.depends_on),
          disabled: String(epic.labels || '').split(',').includes('blueprint-disabled'),
        }])))
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setBlueprintLoading(false) })
    return () => { cancelled = true }
  }, [blueprintTaskId, activeWorkspaceId])

  // Load plan file
  useEffect(() => {
    if (!filePath) return
    setLoading(true)
    setError(null)
    api.getPlanFile(filePath)
      .then((res) => {
        if (res.error) setError(res.error)
        else { setContent(res.content || ''); setOriginalContent(res.content || '') }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [filePath])

  const handleSave = async () => {
    if (!filePath || !hasChanges) return
    setSaving(true)
    try {
      const res = await api.putPlanFile(filePath, content)
      if (res.error) setError(res.error)
      else setOriginalContent(content)
    } catch (e) { setError(e.message) }
    setSaving(false)
  }

  const handleRefresh = async () => {
    if (!filePath) return
    setLoading(true)
    try {
      const res = await api.getPlanFile(filePath)
      if (!res.error) { setContent(res.content || ''); setOriginalContent(res.content || '') }
    } catch {}
    setLoading(false)
  }

  const updateBlueprintEpic = (id, patch) => {
    setBlueprintEdits((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }))
  }

  // Auto-refresh plan file while viewer is open (every 3s)
  useEffect(() => {
    if (!filePath) return
    const interval = setInterval(async () => {
      try {
        const res = await api.getPlanFile(filePath)
        if (!res.error && res.content !== originalContent) {
          setOriginalContent(res.content || '')
          // Only auto-update content if user hasn't made local edits
          if (!hasChanges) setContent(res.content || '')
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [filePath, originalContent, hasChanges])

  // Send typed feedback via option 3 of the plan prompt — stays open, auto-refresh picks up changes
  const handleSendFeedback = () => {
    if (blueprintMode) {
      handleReviseBlueprint()
      return
    }
    if (!sessionId) return
    const msg = feedbackText.trim()
    if (!msg) return
    sendPlanFeedback(sessionId, msg)
    setFeedbackText('')
  }

  const resumePlanningTask = () => {
    const planTask = Object.values(tasks).find(
      (t) => t.assigned_session_id === sessionId && t.status === 'planning'
    )
    if (planTask) {
      api.updateTask2(planTask.id, { status: 'in_progress' })
      useStore.getState().updateTaskInStore({ ...planTask, status: 'in_progress' })
    }
  }

  // Approve → select option 1 (auto-accept edits)
  const handleApprove = () => {
    if (!sessionId) return
    sendPlanChoice(sessionId, 1)
    resumePlanningTask()
    onClose()
  }

  // Save edits to the plan file, then tell Claude to re-read via option 3
  const handleSendEdited = async () => {
    if (!sessionId) return
    if (hasChanges && filePath) await handleSave()
    sendPlanFeedback(sessionId, 'I\'ve edited the plan file directly. Please re-read it and proceed with the updated plan.')
  }

  // Send all inline comments as structured feedback via option 3
  const handleSendComments = () => {
    if (blueprintMode) {
      if (comments.length === 0) return
      const parts = ['Blueprint revision comments:']
      comments.forEach((c, i) => {
        parts.push(`${i + 1}. Re: "${c.selectedText}" -> ${c.comment}`)
      })
      setFeedbackText(parts.join('\n'))
      setComments([])
      return
    }
    if (!sessionId || comments.length === 0) return
    const parts = ['Here is my feedback on the plan:']
    comments.forEach((c, i) => {
      parts.push(`${i + 1}. Re: "${c.selectedText}" → ${c.comment}`)
    })
    sendPlanFeedback(sessionId, parts.join('\n'))
    setComments([])
  }

  const handleApproveBlueprint = async () => {
    if (!blueprintTaskId) return
    setBlueprintActionLoading(true)
    try {
      if (hasChanges && filePath) await handleSave()
      const payload = {
        epics: editedEpics.map((epic) => ({
          id: epic.id,
          title: epic.title || '',
          description: epic.description || '',
          acceptance_criteria: epic.acceptance_criteria || '',
          phase: Number(epic.phase || 1),
          depends_on: parseDependsOn(epic.depends_on),
          disabled: Boolean(epic.disabled),
        })),
      }
      const res = await api.approveBlueprint(blueprintTaskId, payload)
      if (res?.goal) useStore.getState().updateTaskInStore(res.goal)
      useStore.getState().setActivePlan(null)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBlueprintActionLoading(false)
    }
  }

  const handleReviseBlueprint = async () => {
    if (!blueprintTaskId) return
    const msg = feedbackText.trim()
    if (!msg && comments.length === 0) return
    setBlueprintActionLoading(true)
    try {
      if (hasChanges && filePath) await handleSave()
      const commentLines = comments.map((c, i) => `${i + 1}. Re: "${c.selectedText}" -> ${c.comment}`)
      const feedback = [msg, ...commentLines].filter(Boolean).join('\n\n')
      const res = await api.reviseBlueprint(blueprintTaskId, { feedback })
      if (res?.goal) useStore.getState().updateTaskInStore(res.goal)
      setFeedbackText('')
      setComments([])
      useStore.getState().setActivePlan(null)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBlueprintActionLoading(false)
    }
  }

  // ─── Text selection → comment popover ───────────────────────────────

  const handleMouseUp = useCallback(() => {
    if (mode !== 'preview') return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text || text.length < 2) { setCommentPopover(null); return }

    // Check selection is inside the preview
    if (!previewRef.current?.contains(sel.anchorNode)) { setCommentPopover(null); return }

    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const containerRect = previewRef.current.getBoundingClientRect()

    setCommentPopover({
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.bottom - containerRect.top + 4,
      selectedText: text.substring(0, 200), // cap length
    })
    setCommentInput('')
  }, [mode])

  // Close popover on outside click
  useEffect(() => {
    if (!commentPopover) return
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setCommentPopover(null)
      }
    }
    // Delay to avoid closing immediately from the mouseup that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [commentPopover])

  const addComment = () => {
    if (!commentInput.trim() || !commentPopover) return
    setComments((prev) => [...prev, {
      id: uuid(),
      selectedText: commentPopover.selectedText,
      comment: commentInput.trim(),
    }])
    setCommentPopover(null)
    setCommentInput('')
    window.getSelection()?.removeAllRanges()
  }

  const removeComment = (id) => setComments((prev) => prev.filter((c) => c.id !== id))

  // ─── Markdown preview renderer ─────────────────────────────────────

  const renderPreview = (md) => {
    let html = md
    // Escape HTML first
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3 class="text-[11px] font-semibold text-x-ink mt-4 mb-1.5">$1</h3>')
    html = html.replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold text-x-ink mt-5 mb-2">$1</h2>')
    html = html.replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-x-ink mt-5 mb-2">$1</h1>')

    // Checkboxes
    html = html.replace(/^- \[x\] (.+)$/gm, '<div class="flex items-start gap-1 text-x-good text-[13px] font-mono py-1.5 pl-1"><span class="mt-0.5">&#9745;</span><span>$1</span></div>')
    html = html.replace(/^- \[ \] (.+)$/gm, '<div class="flex items-start gap-1 text-x-muted text-[13px] font-mono py-1.5 pl-1"><span class="mt-0.5">&#9744;</span><span>$1</span></div>')

    // Numbered + bullet lists
    html = html.replace(/^(\d+)\. (.+)$/gm, '<div class="text-[13px] font-mono text-x-ink-secondary py-1.5 pl-3"><span class="text-x-faint mr-1">$1.</span>$2</div>')
    html = html.replace(/^\- (.+)$/gm, '<div class="text-[13px] font-mono text-x-ink-secondary py-1.5 pl-3"><span class="text-x-faint mr-1">-</span>$1</div>')

    // Inline formatting
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="text-x-ink font-semibold">$1</strong>')
    html = html.replace(/`(.+?)`/g, '<code class="px-1.5 py-1.5 bg-x-surface rounded text-x-accent text-[12px]">$1</code>')

    // Paragraphs
    html = html.replace(/\n\n/g, '<div class="h-3"></div>')
    html = html.replace(/\n/g, '<br/>')

    // Horizontal rules
    html = html.replace(/^-{3,}$/gm, '<hr class="border-x-line my-3"/>')

    // Inject highlights for commented text
    // We search in text nodes only (skip inside HTML tags) to avoid breaking markup
    comments.forEach((c, idx) => {
      const escaped = c.selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Replace only in text content — use a lookahead/behind to avoid replacing inside tags
      // Split by tags, highlight in text parts only
      const parts = html.split(/(<[^>]+>)/)
      for (let i = 0; i < parts.length; i++) {
        // Skip HTML tags
        if (parts[i].startsWith('<')) continue
        // Replace first occurrence in this text node
        const re = new RegExp(escaped)
        if (re.test(parts[i])) {
          parts[i] = parts[i].replace(re,
            `<mark class="plan-comment" data-comment-idx="${idx}" style="background:color-mix(in srgb, var(--x-accent-ink) 25%, transparent);color:var(--x-accent-ink);border-bottom:2px solid color-mix(in srgb, var(--x-accent-ink) 50%, transparent);cursor:pointer;padding:0 2px;border-radius:2px;">$&</mark>`
          )
          break // Only highlight first occurrence per comment
        }
      }
      html = parts.join('')
    })

    return html
  }

  // ─── Hover tooltip for highlighted comments ──────────────────────────

  const handlePreviewMouseMove = useCallback((e) => {
    const mark = e.target.closest('.plan-comment')
    if (mark) {
      const idx = parseInt(mark.dataset.commentIdx, 10)
      const comment = comments[idx]
      if (comment) {
        const rect = mark.getBoundingClientRect()
        const containerRect = previewRef.current?.getBoundingClientRect() || { left: 0, top: 0 }
        setHoverTooltip({
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top - 4,
          comment: comment.comment,
          selectedText: comment.selectedText,
          idx,
        })
        return
      }
    }
    if (hoverTooltip) setHoverTooltip(null)
  }, [comments, hoverTooltip])

  const handlePreviewMouseLeave = useCallback(() => {
    if (hoverTooltip) setHoverTooltip(null)
  }, [hoverTooltip])

  const renderBlueprintRoadmap = () => {
    const phases = editedEpics.reduce((acc, epic) => {
      const phase = Number(epic.phase || 1)
      if (!acc[phase]) acc[phase] = []
      acc[phase].push(epic)
      return acc
    }, {})
    const phaseKeys = Object.keys(phases).map(Number).sort((a, b) => a - b)

    return (
      <div className="w-[360px] shrink-0 border-l border-x-line bg-x-surface/35 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-x-line/50">
          <div className="text-[11px] font-mono text-x-ink font-semibold">Epic Roadmap</div>
          <div className="text-[11px] font-mono text-x-faint mt-0.5">
            {editedEpics.length} epic{editedEpics.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          {blueprintLoading ? (
            <div className="text-[11px] font-mono text-x-faint">loading epics...</div>
          ) : phaseKeys.length === 0 ? (
            <div className="text-[11px] font-mono text-x-faint">No epics filed yet.</div>
          ) : phaseKeys.map((phase) => (
            <div key={phase}>
              <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-x-accent/80 mb-1.5">
                Phase {phase}
              </div>
              <div className="space-y-2">
                {phases[phase].map((epic) => (
                  <div
                    key={epic.id}
                    className={`border rounded bg-x-bg/45 p-2 ${epic.disabled ? 'border-x-accent-ink/25 opacity-60' : 'border-x-line/70'}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <input
                        type="number"
                        min="1"
                        value={Number(epic.phase || 1)}
                        onChange={(e) => updateBlueprintEpic(epic.id, { phase: Number(e.target.value || 1) })}
                        className="w-12 px-1.5 py-1 text-[11px] font-mono bg-x-surface border border-x-line rounded text-x-ink-secondary focus:outline-none focus:border-x-accent"
                        title="Phase"
                      />
                      <button
                        onClick={() => updateBlueprintEpic(epic.id, { disabled: !epic.disabled })}
                        className={`p-1 rounded transition-colors ${epic.disabled ? 'text-x-accent-ink bg-x-accent-ink/15' : 'text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10'}`}
                        title={epic.disabled ? 'Restore epic' : 'Disable epic'}
                      >
                        <Trash2 size={11} />
                      </button>
                      <span className="text-[11px] font-mono text-x-faint truncate">{epic.id.slice(0, 8)}</span>
                    </div>
                    <input
                      value={epic.title || ''}
                      onChange={(e) => updateBlueprintEpic(epic.id, { title: e.target.value })}
                      className="w-full px-2 py-1.5 text-[11px] font-mono bg-x-surface border border-x-line rounded text-x-ink focus:outline-none focus:border-x-accent"
                    />
                    <textarea
                      value={epic.acceptance_criteria || ''}
                      onChange={(e) => updateBlueprintEpic(epic.id, { acceptance_criteria: e.target.value })}
                      rows={3}
                      className="mt-1.5 w-full px-2 py-1.5 text-[11px] font-mono bg-x-surface border border-x-line rounded text-x-ink-secondary resize-none focus:outline-none focus:border-x-accent"
                      placeholder="Acceptance criteria"
                    />
                    {parseDependsOn(epic.depends_on).length > 0 && (
                      <div className="mt-1.5 text-[11px] font-mono text-x-faint">
                        waits on {parseDependsOn(epic.depends_on).map((id) => id.slice(0, 8)).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Escape to close popover first, then the viewer
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && commentPopover) {
        e.stopImmediatePropagation()
        setCommentPopover(null)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [commentPopover])

  return (
    <div className="fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-[1100px] h-[calc(100vh-80px)] x-panel overflow-hidden flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-5 py-3 border-b border-x-line shrink-0">
          <FileText size={14} className="text-x-accent" />
          <span className="text-[11px] text-x-ink font-mono font-medium">
            {blueprintMode ? 'Blueprint Review' : 'Plan Editor'}
          </span>
          {session && (
            <span className="text-[11px] text-x-faint font-mono truncate max-w-[200px]">
              {session.name}
            </span>
          )}
          {filePath && (
            <span className="text-[11px] text-x-faint/80 font-mono truncate max-w-[300px]" title={filePath}>
              {filePath.replace(/^~\/\.[^/]+\/plans\//, '')}
            </span>
          )}
          <div className="flex-1" />

          {showFileEditor && (
            <div className="flex items-center gap-0.5 bg-x-surface rounded p-0.5 mr-2">
              <button
                onClick={() => setMode('edit')}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-mono transition-colors ${
                  mode === 'edit' ? 'bg-x-surface text-x-ink border border-x-line/45' : 'text-x-muted hover:text-x-ink-secondary'
                }`}
              >
                <Edit3 size={11} /> Edit
              </button>
              <button
                onClick={() => setMode('preview')}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-mono transition-colors ${
                  mode === 'preview' ? 'bg-x-surface text-x-ink border border-x-line/45' : 'text-x-muted hover:text-x-ink-secondary'
                }`}
              >
                <Eye size={11} /> Review
              </button>
            </div>
          )}

          {showFileEditor && (
            <button onClick={handleRefresh} className="p-1.5 text-x-muted hover:text-x-ink-secondary transition-colors" title="Refresh from disk">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          )}

          {hasChanges && <span className="text-[11px] text-x-accent-ink font-mono px-1.5">modified</span>}

          <button onClick={onClose} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Plan selector */}
        {!blueprintMode && workspacePlans.length > 0 && (
          <div className="flex items-center gap-1.5 px-5 py-1.5 border-b border-x-line/50 bg-x-surface/30 overflow-x-auto shrink-0">
            {workspacePlans.map(({ sid, path, name, slug, status }) => {
              const isActive = sid ? sid === sessionId && !viewingPlanPath : viewingPlanPath === path
              const isCurrent = sid === activeSessionId
              const statusMeta = getSessionStatusMeta(status, sessions[sid]?.agentState, hasSessionStarted(sessions[sid], sessionStarted))
              return (
              <button
                key={sid || path}
                onClick={() => {
                  if (sid) {
                    setViewingSessionId(sid)
                    setViewingPlanPath(null)
                    setActiveSessionId(sid)
                  } else {
                    setViewingSessionId(null)
                    setViewingPlanPath(path)
                  }
                }}
                className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors ${
                  isActive
                    ? 'bg-x-tint text-x-accent border border-x-accent/40'
                    : sid
                      ? 'text-x-muted hover:text-x-ink-secondary border border-transparent hover:border-x-line-subtle'
                      : 'text-x-faint hover:text-x-muted border border-transparent hover:border-x-line-subtle'
                }`}
                title={sid ? `${name}\n${path}` : `Orphaned plan: ${path}`}
              >
                {sid && (
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusMeta.dotClass}`} title={statusMeta.label} />
                )}
                <span className="flex flex-col items-start leading-none gap-0.5">
                  <span className={`text-[11px] font-mono ${!sid ? 'italic' : ''}`}>
                    {sid ? name : slug}{isCurrent ? ' (current)' : ''}{!sid ? ' *' : ''}
                  </span>
                  {sid && slug !== name && (
                    <span className="text-[11px] text-x-faint font-mono">{slug}</span>
                  )}
                </span>
              </button>
              )
            })}
            {unmatchedPlans.length > 0 && (
              <button
                onClick={() => setShowUnmatched((v) => !v)}
                className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-colors ml-1 ${
                  showUnmatched
                    ? 'text-x-ink-secondary bg-x-surface border border-x-line/40'
                    : 'text-x-faint hover:text-x-muted border border-transparent hover:border-x-line-subtle'
                }`}
                title={showUnmatched ? 'Hide orphaned plans' : `Show ${unmatchedPlans.length} orphaned plan${unmatchedPlans.length !== 1 ? 's' : ''}`}
              >
                {showUnmatched ? 'Hide' : `+${unmatchedPlans.length}`} orphaned
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {error && (
            <div className="absolute top-14 left-0 right-0 px-5 py-1.5 text-[11px] font-mono text-x-accent-ink bg-x-accent-ink/10 border-b border-x-accent-ink/20 z-10">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex-1 flex items-center justify-center text-x-faint text-[11px] font-mono">
              loading plan...
            </div>
          ) : blueprintMode ? (
            mode === 'edit' ? (
              <>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave() }
                  }}
                  className="flex-1 w-full px-6 py-4 bg-transparent text-[13px] font-mono text-x-ink-secondary leading-[1.7] resize-none focus:outline-none placeholder-x-muted"
                  placeholder="Blueprint content..."
                  spellCheck={false}
                  autoFocus
                />
                {renderBlueprintRoadmap()}
              </>
            ) : (
              <>
                <div
                  ref={previewRef}
                  className="flex-1 overflow-y-auto px-6 py-4 relative select-text cursor-text"
                  onMouseUp={handleMouseUp}
                  onMouseMove={handlePreviewMouseMove}
                  onMouseLeave={handlePreviewMouseLeave}
                >
                  <div
                    className="max-w-[720px] leading-[1.7]"
                    dangerouslySetInnerHTML={{ __html: renderPreview(content || '# Blueprint\n\nNo blueprint file content found.') }}
                  />

                  {hoverTooltip && (
                    <div
                      className="absolute z-30 pointer-events-none"
                      style={{
                        left: Math.max(8, Math.min(hoverTooltip.x - 140, (previewRef.current?.offsetWidth || 600) - 296)),
                        top: hoverTooltip.y,
                        transform: 'translateY(-100%)',
                      }}
                    >
                      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 px-2.5 py-1.5 w-[280px]">
                        <div className="text-[11px] text-x-accent-ink/70 font-mono mb-1">
                          Comment #{hoverTooltip.idx + 1}
                        </div>
                        <div className="text-[11px] text-x-accent-ink font-mono leading-relaxed">
                          {hoverTooltip.comment}
                        </div>
                      </div>
                      <div className="w-2 h-2 bg-x-surface border-r border-b border-x-line rotate-45 mx-auto -mt-1" />
                    </div>
                  )}

                  {commentPopover && (
                    <div
                      ref={popoverRef}
                      className="absolute z-20 bg-x-surface border border-x-line rounded-lg shadow-x-1 p-3 w-[320px]"
                      style={{
                        left: Math.min(commentPopover.x - 160, (previewRef.current?.offsetWidth || 600) - 340),
                        top: commentPopover.y + 8,
                      }}
                    >
                      <div className="text-[11px] text-x-muted font-mono mb-2 truncate">
                        &ldquo;{commentPopover.selectedText.substring(0, 60)}{commentPopover.selectedText.length > 60 ? '...' : ''}&rdquo;
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          value={commentInput}
                          onChange={(e) => setCommentInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); addComment() }
                            if (e.key === 'Escape') { e.stopPropagation(); setCommentPopover(null) }
                          }}
                          placeholder="Add your comment..."
                          className="flex-1 px-2.5 py-1.5 text-[11px] font-mono bg-x-surface border border-x-line rounded text-x-ink-secondary placeholder-x-muted focus:outline-none focus:border-x-accent"
                          autoFocus
                        />
                        <button
                          onClick={addComment}
                          disabled={!commentInput.trim()}
                          className="px-2.5 py-1.5 text-[11px] font-mono bg-x-accent/30 hover:bg-x-accent/40 text-x-accent rounded disabled:opacity-30 transition-colors"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {renderBlueprintRoadmap()}
              </>
            )
          ) : showFileEditor ? (
            mode === 'edit' ? (
              /* ─── Edit mode: full-width textarea ─── */
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave() }
                }}
                className="flex-1 w-full px-6 py-4 bg-transparent text-[13px] font-mono text-x-ink-secondary leading-[1.7] resize-none focus:outline-none placeholder-x-muted"
                placeholder="Plan content..."
                spellCheck={false}
                autoFocus
              />
            ) : (
              /* ─── Preview mode: rendered markdown + comments sidebar ─── */
              <>
                <div
                  ref={previewRef}
                  className="flex-1 overflow-y-auto px-6 py-4 relative select-text cursor-text"
                  onMouseUp={handleMouseUp}
                  onMouseMove={handlePreviewMouseMove}
                  onMouseLeave={handlePreviewMouseLeave}
                >
                  <div
                    className="max-w-[700px] leading-[1.7]"
                    dangerouslySetInnerHTML={{ __html: renderPreview(content) }}
                  />

                  {mode === 'preview' && !commentPopover && comments.length === 0 && (
                    <div className="mt-6 text-[11px] text-x-faint font-mono border-t border-x-line/50 pt-3">
                      Select text to add a comment
                    </div>
                  )}

                  {/* Hover tooltip for highlighted comments */}
                  {hoverTooltip && (
                    <div
                      className="absolute z-30 pointer-events-none"
                      style={{
                        left: Math.max(8, Math.min(hoverTooltip.x - 140, (previewRef.current?.offsetWidth || 600) - 296)),
                        top: hoverTooltip.y,
                        transform: 'translateY(-100%)',
                      }}
                    >
                      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 px-2.5 py-1.5 w-[280px]">
                        <div className="text-[11px] text-x-accent-ink/70 font-mono mb-1">
                          Comment #{hoverTooltip.idx + 1}
                        </div>
                        <div className="text-[11px] text-x-accent-ink font-mono leading-relaxed">
                          {hoverTooltip.comment}
                        </div>
                      </div>
                      <div className="w-2 h-2 bg-x-surface border-r border-b border-x-line rotate-45 mx-auto -mt-1" />
                    </div>
                  )}

                  {/* Comment popover */}
                  {commentPopover && (
                    <div
                      ref={popoverRef}
                      className="absolute z-20 bg-x-surface border border-x-line rounded-lg shadow-x-1 p-3 w-[320px]"
                      style={{
                        left: Math.min(commentPopover.x - 160, (previewRef.current?.offsetWidth || 600) - 340),
                        top: commentPopover.y + 8,
                      }}
                    >
                      <div className="text-[11px] text-x-muted font-mono mb-2 truncate">
                        &ldquo;{commentPopover.selectedText.substring(0, 60)}{commentPopover.selectedText.length > 60 ? '...' : ''}&rdquo;
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          value={commentInput}
                          onChange={(e) => setCommentInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); addComment() }
                            if (e.key === 'Escape') { e.stopPropagation(); setCommentPopover(null) }
                          }}
                          placeholder="Add your comment..."
                          className="flex-1 px-2.5 py-1.5 text-[11px] font-mono bg-x-surface border border-x-line rounded text-x-ink-secondary placeholder-x-muted focus:outline-none focus:border-x-accent"
                          autoFocus
                        />
                        <button
                          onClick={addComment}
                          disabled={!commentInput.trim()}
                          className="px-2.5 py-1.5 text-[11px] font-mono bg-x-accent/30 hover:bg-x-accent/40 text-x-accent rounded disabled:opacity-30 transition-colors"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Comments sidebar */}
                {comments.length > 0 && (
                  <div className="w-[280px] shrink-0 border-l border-x-line flex flex-col bg-x-surface-2">
                    <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-x-line/50">
                      <MessageSquare size={12} className="text-x-accent-ink" />
                      <span className="text-[11px] font-mono text-x-muted">{comments.length} comment{comments.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {comments.map((c, i) => (
                        <div key={c.id} className="px-2.5 py-1.5 border-b border-x-line/30 group">
                          <div className="flex items-start gap-1.5">
                            <span className="text-[11px] text-x-faint font-mono shrink-0 mt-0.5">{i + 1}.</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] text-x-faint font-mono truncate italic">
                                &ldquo;{c.selectedText.substring(0, 50)}{c.selectedText.length > 50 ? '...' : ''}&rdquo;
                              </div>
                              <div className="text-[11px] text-x-accent-ink/80 font-mono mt-1 leading-relaxed">
                                {c.comment}
                              </div>
                            </div>
                            <button
                              onClick={() => removeComment(c.id)}
                              className="shrink-0 p-0.5 text-x-faint hover:text-x-accent-ink opacity-0 group-hover:opacity-100 transition-all"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-2.5 py-1.5 border-t border-x-line shrink-0">
                      <button
                        onClick={handleSendComments}
                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
                      >
                        <Send size={10} />
                        Send {comments.length} comment{comments.length !== 1 ? 's' : ''} to session
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          ) : plan ? (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {plan.items.map((item, i) => (
                <div key={i} className="flex items-start gap-1.5 py-1.5 border-b border-x-line/30">
                  <span className="text-[12px] font-mono text-x-muted w-5 text-right shrink-0 mt-0.5">
                    {item.index || i + 1}.
                  </span>
                  <p className="text-[13px] font-mono text-x-ink-secondary leading-relaxed">{item.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-x-faint text-[11px] font-mono">
              {workspacePlans.length > 0
                ? 'Select a plan above to view it.'
                : 'No plans found. Enter plan mode in a session to create one.'}
            </div>
          )}
        </div>

        {/* Feedback input */}
        {(sessionId || blueprintMode) && (
          <div className="px-5 py-1.5 border-t border-x-line/50 shrink-0">
            <div className="flex gap-1">
              <input
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendFeedback() }
                }}
                placeholder={blueprintMode ? 'Revision feedback for Architect...' : 'Type feedback to send to the session...'}
                className="flex-1 px-2.5 py-1.5 text-[12px] font-mono bg-x-surface border border-x-line rounded text-x-ink-secondary placeholder-x-muted focus:outline-none focus:border-x-accent"
              />
              <button
                onClick={handleSendFeedback}
                disabled={!feedbackText.trim()}
                className="px-2.5 py-1.5 text-x-faint hover:text-x-accent disabled:opacity-30 transition-colors"
                title={blueprintMode ? 'Request blueprint revision' : 'Send feedback'}
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center gap-1 px-5 py-3 border-t border-x-line bg-x-surface/30 shrink-0">
          {!blueprintMode && sessionId && (plan?.items?.length > 0 || planWaiting[sessionId]) && (
            <>
              <button
                onClick={handleApprove}
                className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30 rounded transition-colors"
                title="Select option 1: auto-accept edits"
              >
                <CheckCircle size={12} />
                Approve &amp; Auto-accept
              </button>
              <button
                onClick={() => { sendPlanChoice(sessionId, 2); resumePlanningTask(); onClose() }}
                className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-transparent hover:bg-x-hover text-x-ink-secondary border border-x-line hover:border-x-line-strong rounded transition-colors"
                title="Select option 2: manually approve each edit"
              >
                <CheckCircle size={12} />
                Approve &amp; Review Edits
              </button>
            </>
          )}

          {blueprintMode && (
            <>
              <button
                onClick={handleApproveBlueprint}
                disabled={blueprintActionLoading || blueprintLoading}
                className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30 rounded transition-colors disabled:opacity-40"
              >
                <CheckCircle size={12} />
                {blueprintActionLoading ? 'Approving...' : 'Approve Blueprint'}
              </button>
              <button
                onClick={handleReviseBlueprint}
                disabled={blueprintActionLoading || (!feedbackText.trim() && comments.length === 0)}
                className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors disabled:opacity-40"
              >
                <Send size={12} />
                Request Revision{comments.length > 0 ? ` (${comments.length})` : ''}
              </button>
            </>
          )}

          {showFileEditor && hasChanges && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
              >
                <Save size={12} />
                {saving ? 'Saving...' : 'Save'}
              </button>
              {!blueprintMode && (
                <button
                  onClick={handleSendEdited}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-mono bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border border-x-accent/30 rounded transition-colors"
                >
                  <Send size={12} />
                  Save &amp; Send to Instance
                </button>
              )}
            </>
          )}

          <div className="flex-1" />
          <span className="text-[11px] text-x-faint font-mono">
            {mode === 'edit' ? '⌘S to save' : mode === 'preview' && showFileEditor ? 'select text to comment' : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
