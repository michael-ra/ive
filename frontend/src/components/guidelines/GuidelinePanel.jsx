import { useState, useEffect, useRef } from 'react'
import { Shield, Plus, Trash2, Check, X, Pencil, RotateCcw, Sparkles, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function GuidelinePanel({ onClose }) {
  const [guidelines, setGuidelines] = useState([])
  const [attached, setAttached] = useState({}) // guideline_id → boolean
  const [mode, setMode] = useState('list') // 'list' | 'create' | 'edit'
  const [editingId, setEditingId] = useState(null)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newWhenToUse, setNewWhenToUse] = useState('')
  const [newDefault, setNewDefault] = useState(false)
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
      api.getGuidelineRecommendations(activeSessionId).then((resp) => {
        setRecommendations(resp?.recommendations || [])
      }).catch(() => {})
    }
  }, [activeSessionId])

  // Listen for live recommendation pushes via WebSocket
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.session_id === activeSessionId) {
        setRecommendations(e.detail.recommendations || [])
      }
    }
    window.addEventListener('cc-guideline_recommendation', handler)
    return () => window.removeEventListener('cc-guideline_recommendation', handler)
  }, [activeSessionId])

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
    const updated = await api.updateGuideline(editingId, {
      name: newName.trim(),
      content: newContent.trim(),
      when_to_use: newWhenToUse.trim() || null,
      is_default: newDefault,
    })
    setGuidelines(guidelines.map((g) => (g.id === editingId ? updated : g)))
    resetForm()
  }

  const resetForm = () => {
    setMode('list')
    setEditingId(null)
    setNewName('')
    setNewContent('')
    setNewWhenToUse('')
    setNewDefault(false)
  }

  const handleDismissRec = async (guidelineId) => {
    if (activeSessionId) {
      await api.dismissGuidelineRecommendation(activeSessionId, guidelineId).catch(() => {})
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[560px] ide-panel overflow-hidden scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Shield size={14} className="text-accent-primary" />
          <span className="text-xs text-text-secondary font-medium">Guidelines</span>
          <div className="flex-1" />
          <button
            onClick={() => mode === 'list' ? setMode('create') : resetForm()}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
          >
            {mode === 'list' ? <><Plus size={11} /> new</> : 'back'}
          </button>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Restart banner — shown when user toggled guidelines on a running session.
            Guidelines only take effect when baked into --append-system-prompt at PTY
            start. Toggling mid-session writes to the DB but the running CLI doesn't
            see the change. Restarting re-reads the DB and includes the new guidelines
            in the cached system prompt. */}
        {isRunning && hasChanges && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
            <span className="text-[11px] text-amber-400 flex-1">
              Guidelines changed — restart session to apply. Changes will be cached in the system prompt (cheaper per turn).
            </span>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-md transition-colors shrink-0"
            >
              <RotateCcw size={10} />
              restart
            </button>
          </div>
        )}

        {(mode === 'create' || mode === 'edit') ? (
          <form onSubmit={mode === 'edit' ? handleUpdate : handleCreate} className="p-4 space-y-2.5">
            <div className="text-[10px] text-text-faint font-mono uppercase tracking-wider">
              {mode === 'edit' ? 'edit guideline' : 'new guideline'}
            </div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="guideline name"
              className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono transition-colors"
              autoFocus
            />
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="guideline content (system prompt fragment)..."
              rows={6}
              className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none leading-relaxed transition-colors"
            />
            <input
              value={newWhenToUse}
              onChange={(e) => setNewWhenToUse(e.target.value)}
              placeholder="when to use (e.g. frontend work, testing, refactoring)..."
              className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono transition-colors"
            />
            <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={newDefault}
                onChange={(e) => setNewDefault(e.target.checked)}
                className="rounded border-border-accent"
              />
              auto-attach to new sessions
            </label>
            <div className="flex gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors">
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button type="button" onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors">cancel</button>
            </div>
          </form>
        ) : (
          <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
            {/* Session Advisor: recommended guidelines */}
            {recommendations.length > 0 && (
              <div className="border-b border-indigo-500/20">
                <div className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-500/5">
                  <Sparkles size={11} className="text-indigo-400" />
                  <span className="text-[10px] text-indigo-400 font-medium uppercase tracking-wider">recommended</span>
                </div>
                {recommendations.map((rec) => (
                  <div
                    key={rec.guideline_id}
                    className="group flex items-start gap-2 px-4 py-2 border-b border-indigo-500/10 bg-indigo-500/[0.03] hover:bg-indigo-500/[0.06] transition-colors"
                  >
                    <button
                      onClick={() => handleAttachRec(rec)}
                      className="mt-0.5 shrink-0 w-4 h-4 rounded border border-indigo-400/40 hover:border-indigo-400 flex items-center justify-center transition-colors"
                      title="Attach this guideline"
                    >
                      <Plus size={10} className="text-indigo-400" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-text-primary font-mono">{rec.name}</span>
                        <span className={`text-[9px] font-medium px-1 py-0.5 rounded ${
                          rec.score >= 0.7 ? 'bg-emerald-500/15 text-emerald-400' :
                          rec.score >= 0.5 ? 'bg-amber-500/15 text-amber-400' :
                          'bg-zinc-500/15 text-zinc-400'
                        }`}>
                          {Math.round(rec.score * 100)}%
                        </span>
                      </div>
                      <p className="text-[10px] text-indigo-300/60 font-mono mt-0.5">{rec.reason}</p>
                    </div>
                    <button
                      onClick={() => handleDismissRec(rec.guideline_id)}
                      className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 transition-all mt-0.5"
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
                className={`group flex items-start gap-2 px-4 py-2.5 border-b border-border-secondary transition-colors cursor-pointer ${
                  selectedIdx === idx
                    ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
                    : 'hover:bg-bg-hover/50'
                }`}
              >
                <button
                  onClick={() => handleToggle(g.id)}
                  className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    attached[g.id]
                      ? 'bg-accent-primary border-accent-primary'
                      : 'border-border-accent hover:border-text-muted'
                  }`}
                  title={activeSessionId ? 'Toggle for active session' : 'Select a session first'}
                >
                  {attached[g.id] && <Check size={10} className="text-white" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text-primary font-mono">{g.name}</span>
                    {g.is_default ? (
                      <span className="text-[10px] text-accent-primary font-medium uppercase">default</span>
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
                      <span className="text-[9px] text-emerald-400/60" title="Active in system prompt (prompt-cached, 90% cheaper per turn)">active</span>
                    )}
                    {isRunning && attached[g.id] && !activeInPrompt.has(g.id) && (
                      <span className="text-[9px] text-amber-400/70" title="Not yet in system prompt — restart session to apply">pending</span>
                    )}
                    {isRunning && !attached[g.id] && activeInPrompt.has(g.id) && (
                      <span className="text-[9px] text-red-400/70" title="Still in system prompt — restart session to remove">still cached</span>
                    )}
                  </div>
                  {g.when_to_use && (
                    <p className="text-[10px] text-indigo-300/50 font-mono mt-0.5">when: {g.when_to_use}</p>
                  )}
                  <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-2">
                    {g.content}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleEdit(g) }}
                  className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-accent-primary transition-all mt-0.5"
                  title="Edit guideline"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => handleDelete(g.id)}
                  className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 transition-all mt-0.5"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {guidelines.length === 0 && (
              <div className="px-4 py-10 text-xs text-text-faint text-center">
                No guidelines yet — click "+ new" to create one
                <br />
                <span className="text-text-faint/60">guidelines are system prompt fragments attached to sessions</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
