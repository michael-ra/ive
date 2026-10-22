import { useState, useEffect, useRef } from 'react'
import { Shield, Plus, Trash2, Check, X, Pencil, RotateCcw, Sparkles, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { callExtensionApi, isExtensionAvailable } from '../../lib/extensionRegistry'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function GuidelinePanel({ onClose }) {
  const advisorAvailable = isExtensionAvailable('myelin')
  const [guidelines, setGuidelines] = useState([])
  const [attached, setAttached] = useState({}) // guideline_id → boolean
  const [mode, setMode] = useState('list') // 'list' | 'create' | 'edit'
  const [editingId, setEditingId] = useState(null)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newWhenToUse, setNewWhenToUse] = useState('')
  const [newDefault, setNewDefault] = useState(false)
  const [formError, setFormError] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [recommendations, setRecommendations] = useState([])
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessionStatus = useStore((s) => s.sessions[s.activeSessionId]?.status)
  const isRunning = sessionStatus === 'running'
  // The ACTUAL set of guideline IDs that were loaded into the system prompt
  // at PTY start time. Read from sessions.active_guideline_ids, which is set
  // by the server when the PTY starts. This is the source of truth for
  // "is this guideline in the running system prompt?" — unlike the DB toggle
  // state which can change mid-session without affecting the running CLI.
  const [activeInPrompt, setActiveInPrompt] = useState(new Set()) // guideline IDs in system prompt
  // Whether the user has modified guidelines while session is running.
  const [hasChanges, setHasChanges] = useState(false)
  const listRef = useRef(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    api.getGuidelines().then(setGuidelines)
    if (activeSessionId) {
      api.getSessionGuidelines(activeSessionId).then((resp) => {
        // The endpoint now returns { guidelines: [...], active_guideline_ids: [...] }
        // For backward compat, also handle the old array-only format.
        const gs = Array.isArray(resp) ? resp : (resp.guidelines || [])
        const activeIds = Array.isArray(resp) ? [] : (resp.active_guideline_ids || [])

        const map = {}
        gs.forEach((g) => (map[g.id] = true))
        setAttached(map)
        setActiveInPrompt(new Set(activeIds))
      })
      // Session Advisor: fetch recommendations
      if (advisorAvailable) {
        callExtensionApi('myelin', 'getGuidelineRecommendations', activeSessionId).then((resp) => {
          setRecommendations(resp?.recommendations || [])
        }).catch(() => {})
      } else {
        setRecommendations([])
      }
    }
  }, [activeSessionId, advisorAvailable])

  // Listen for live recommendation pushes via WebSocket
  useEffect(() => {
    if (!advisorAvailable) return
    const handler = (e) => {
      if (e.detail?.session_id === activeSessionId) {
        setRecommendations(e.detail.recommendations || [])
      }
    }
    window.addEventListener('cc-guideline_recommendation', handler)
    return () => window.removeEventListener('cc-guideline_recommendation', handler)
  }, [activeSessionId, advisorAvailable])

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!newName.trim() || !newContent.trim()) return
    const g = await api.createGuideline({
      name: newName.trim(),
      content: newContent.trim(),
      when_to_use: newWhenToUse.trim() || undefined,
      is_default: newDefault,
    })
    setGuidelines([...guidelines, g])
    resetForm()
  }

  const handleEdit = (g) => {
    setFormError('')
    setEditingId(g.id)
    setNewName(g.name)
    setNewContent(g.content)
    setNewWhenToUse(g.when_to_use || '')
    setNewDefault(!!g.is_default)
    setMode('edit')
  }

  const handleUpdate = async (e) => {
    e?.preventDefault?.()
    if (!newName.trim() || !newContent.trim() || !editingId) return
    setFormError('')
    try {
      const updated = await api.updateGuideline(editingId, {
        name: newName.trim(),
        content: newContent.trim(),
        when_to_use: newWhenToUse.trim() || null,
        is_default: newDefault,
      })
      setGuidelines(guidelines.map((g) => (g.id === editingId ? updated : g)))
      resetForm()
    } catch (error) {
      setFormError(error.message || 'Guideline was not saved. Your draft is still here.')
    }
  }

  const resetForm = () => {
    setFormError('')
    setMode('list')
    setEditingId(null)
    setNewName('')
    setNewContent('')
    setNewWhenToUse('')
    setNewDefault(false)
  }

  const handleDismissRec = async (guidelineId) => {
    if (activeSessionId && advisorAvailable) {
      await callExtensionApi('myelin', 'dismissGuidelineRecommendation', activeSessionId, guidelineId).catch(() => {})
    }
    setRecommendations(recommendations.filter((r) => r.guideline_id !== guidelineId))
  }

  const handleAttachRec = async (rec) => {
    if (!activeSessionId) return
    const next = { ...attached, [rec.guideline_id]: true }
    setAttached(next)
    if (isRunning) setHasChanges(true)
    await api.setSessionGuidelines(activeSessionId, Object.keys(next).filter((k) => next[k]))
    setRecommendations(recommendations.filter((r) => r.guideline_id !== rec.guideline_id))
  }

  // ⌘= opens the create form; ⌘↵ saves it. Saves are gated on form mode so
  // ⌘↵ from the list view doesn't fire an empty save.
  usePanelCreate({
    onAdd: () => setMode('create'),
    onSubmit: () => {
      if (mode === 'create') handleCreate()
      else if (mode === 'edit') handleUpdate()
    },
  })

  // Keep selected row in view as the user pages through with arrows.
  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // ↑/↓ navigates, Enter toggles attach, ⌘⌫ deletes. Disabled in create mode
  // so the form's textarea isn't shadowed.
  useListKeyboardNav({
    enabled: mode === 'list',
    itemCount: guidelines.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const g = guidelines[idx]
      if (g) handleToggle(g.id)
    },
    onDelete: (idx) => {
      const g = guidelines[idx]
      if (g) handleDelete(g.id)
    },
  })

  const handleDelete = async (id) => {
    await api.deleteGuideline(id)
    setGuidelines(guidelines.filter((g) => g.id !== id))
    const { [id]: _, ...rest } = attached
    setAttached(rest)
  }

  const handleToggle = async (gid) => {
    if (!activeSessionId) return
    const next = { ...attached, [gid]: !attached[gid] }
    if (!next[gid]) delete next[gid]
    setAttached(next)
    if (isRunning) setHasChanges(true)
    await api.setSessionGuidelines(activeSessionId, Object.keys(next).filter((k) => next[k]))
  }

  const handleRestart = () => {
    const store = useStore.getState()
    if (activeSessionId) {
      store.stopSession(activeSessionId)
      // Brief delay to let the PTY stop, then restart. On restart the PTY
      // start handler reads session_guidelines fresh → newly attached
      // guidelines flow into --append-system-prompt → prompt-cached.
      // After a second delay, re-fetch active_guideline_ids so the UI
      // shows the correct "active" labels.
      setTimeout(() => {
        store.restartSession(activeSessionId)
        setHasChanges(false)
        // Give the PTY start handler time to write active_guideline_ids
        setTimeout(() => {
          api.getSessionGuidelines(activeSessionId).then((resp) => {
            const activeIds = Array.isArray(resp) ? [] : (resp.active_guideline_ids || [])
            setActiveInPrompt(new Set(activeIds))
          })
        }, 2000)
      }, 500)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[560px] x-panel shadow-x-3 overflow-hidden scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <Shield size={14} strokeWidth={1.75} className="text-x-accent" />
          <span className="text-xs text-x-ink-secondary font-medium">Guidelines</span>
          <div className="flex-1" />
          <button
            onClick={() => mode === 'list' ? setMode('create') : resetForm()}
            className="flex items-center gap-1 px-2 py-1 text-xs text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
          >
            {mode === 'list' ? <><Plus size={11} /> new</> : 'back'}
          </button>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms] ease-x">
            <X size={15} />
          </button>
        </div>

        {/* Restart banner — shown when user toggled guidelines on a running session.
            Guidelines only take effect when baked into --append-system-prompt at PTY
            start. Toggling mid-session writes to the DB but the running CLI doesn't
            see the change. Restarting re-reads the DB and includes the new guidelines
            in the cached system prompt. */}
        {isRunning && hasChanges && (
          <div className="flex items-center gap-2 px-4 py-2 bg-x-surface-2 border-b border-x-line">
            <span className="text-[11px] text-x-accent-ink flex-1">
              Guidelines changed — restart session to apply. Changes will be cached in the system prompt (cheaper per turn).
            </span>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded-md transition-colors duration-[80ms] ease-x shrink-0"
            >
              <RotateCcw size={10} />
              restart
            </button>
          </div>
        )}

        {(mode === 'create' || mode === 'edit') ? (
          <form onSubmit={mode === 'edit' ? handleUpdate : handleCreate} className="p-4 space-y-2.5">
            <div className="text-xs font-medium text-x-ink-secondary">
              {mode === 'edit' ? 'edit guideline' : 'new guideline'}
            </div>
            {formError && <p role="alert" className="text-xs text-red-400">{formError}</p>}
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="guideline name"
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] ease-x"
              autoFocus
            />
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="guideline content (system prompt fragment)..."
              rows={6}
              className="w-full px-2.5 py-1.5 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono resize-none leading-relaxed transition-colors duration-[80ms] ease-x"
            />
            <input
              value={newWhenToUse}
              onChange={(e) => setNewWhenToUse(e.target.value)}
              placeholder="when to use (e.g. frontend work, testing, refactoring)..."
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] ease-x"
            />
            <label className="flex items-center gap-1.5 text-xs text-x-ink-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={newDefault}
                onChange={(e) => setNewDefault(e.target.checked)}
                className="rounded border-x-line-strong"
              />
              auto-attach to new sessions
            </label>
            <div className="flex gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x">
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button type="button" onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">cancel</button>
            </div>
          </form>
        ) : (
          <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
            {/* Session Advisor: recommended guidelines */}
            {recommendations.length > 0 && (
              <div className="border-b border-x-line">
                <div className="flex items-center gap-1.5 px-4 py-1.5 bg-x-surface-2">
                  <Sparkles size={11} className="text-x-accent" />
                  <span className="text-[11px] text-x-accent font-medium">recommended</span>
                </div>
                {recommendations.map((rec) => (
                  <div
                    key={rec.guideline_id}
                    className="group flex items-start gap-2 px-4 py-2 border-b border-x-line bg-x-surface-2 hover:bg-x-hover transition-colors duration-[80ms] ease-x"
                  >
                    <button
                      onClick={() => handleAttachRec(rec)}
                      className="mt-0.5 shrink-0 w-4 h-4 rounded border border-x-accent/40 hover:border-x-accent flex items-center justify-center transition-colors duration-[80ms] ease-x"
                      title="Attach this guideline"
                    >
                      <Plus size={10} className="text-x-accent" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-x-ink font-medium">{rec.name}</span>
                        <span className={`text-[11px] font-medium px-1 py-0.5 rounded tabular-nums ${
                          rec.score >= 0.7 ? 'bg-x-good/15 text-x-good' :
                          rec.score >= 0.5 ? 'bg-x-accent-ink/15 text-x-accent-ink' :
                          'bg-x-muted/15 text-x-muted'
                        }`}>
                          {Math.round(rec.score * 100)}%
                        </span>
                      </div>
                      <p className="text-[11px] text-x-accent/60 mt-0.5">{rec.reason}</p>
                    </div>
                    <button
                      onClick={() => handleDismissRec(rec.guideline_id)}
                      className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent-ink transition-opacity duration-[80ms] ease-x mt-0.5"
                      title="Dismiss"
                    >
                      <XCircle size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {guidelines.map((g, idx) => (
              <div
                key={g.id}
                data-idx={idx}
                onClick={() => setSelectedIdx(idx)}
                className={`group flex items-start gap-2 px-4 py-2.5 border-b border-x-line transition-colors duration-[80ms] ease-x cursor-pointer ${
                  selectedIdx === idx
                    ? 'bg-x-tint border-l-2 border-l-x-accent'
                    : 'hover:bg-x-hover'
                }`}
              >
                <button
                  onClick={() => handleToggle(g.id)}
                  className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                    attached[g.id]
                      ? 'bg-x-accent border-x-accent'
                      : 'border-x-line-strong hover:border-x-muted'
                  }`}
                  title={activeSessionId ? 'Toggle for active session' : 'Select a session first'}
                >
                  {attached[g.id] && <Check size={10} className="text-x-on-accent" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-x-ink font-medium">{g.name}</span>
                    {g.is_default ? (
                      <span className="text-[11px] text-x-accent font-medium">default</span>
                    ) : null}
                    {/* Status indicator based on ACTUAL system prompt state (from
                        sessions.active_guideline_ids set at PTY start), not the DB
                        toggle state which can diverge mid-session.
                        Three states:
                          "active" = checked AND in system prompt (prompt-cached, cheap)
                          "pending" = checked but NOT in system prompt (restart to apply)
                          "still cached" = unchecked but still IN system prompt (restart to remove)
                    */}
                    {isRunning && attached[g.id] && activeInPrompt.has(g.id) && (
                      <span className="text-[11px] text-x-good/70" title="Active in system prompt (prompt-cached, 90% cheaper per turn)">active</span>
                    )}
                    {isRunning && attached[g.id] && !activeInPrompt.has(g.id) && (
                      <span className="text-[11px] text-x-accent-ink/70" title="Not yet in system prompt — restart session to apply">pending</span>
                    )}
                    {isRunning && !attached[g.id] && activeInPrompt.has(g.id) && (
                      <span className="text-[11px] text-x-accent-ink/70" title="Still in system prompt — restart session to remove">still cached</span>
                    )}
                  </div>
                  {g.when_to_use && (
                    <p className="text-[11px] text-x-accent/50 mt-0.5">when: {g.when_to_use}</p>
                  )}
                  <p className="text-[11px] text-x-muted font-mono mt-0.5 line-clamp-2">
                    {g.content}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleEdit(g) }}
                  className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent transition-opacity duration-[80ms] ease-x mt-0.5"
                  title="Edit guideline"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => handleDelete(g.id)}
                  className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent-ink transition-opacity duration-[80ms] ease-x mt-0.5"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {guidelines.length === 0 && (
              <div className="px-4 py-10 text-xs text-x-faint text-center">
                No guidelines yet — click "+ new" to create one
                <br />
                <span className="text-x-faint/60">guidelines are system prompt fragments attached to sessions</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
