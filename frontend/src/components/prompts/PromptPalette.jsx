import { useState, useEffect, useRef } from 'react'
import { BookOpen, Plus, Pin, Trash2, Eye, Edit3, Zap, ListOrdered, Play, RotateCcw, X as XIcon, Variable } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { sendTerminalCommand } from '../../lib/terminal'
import usePanelCreate from '../../hooks/usePanelCreate'
import CascadeVariableEditor from './CascadeVariableEditor'

export default function PromptPalette({ onClose, startInCreate = false, startTab = 'prompts' }) {
  const [tab, setTab] = useState(startTab) // 'prompts' | 'cascades'
  const [prompts, setPrompts] = useState([])
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [mode, setMode] = useState(startInCreate ? 'create' : 'list') // list | create
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('General')
  const [showPreview, setShowPreview] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const inputRef = useRef(null)

  // ── Cascade state ────────────────────────────────────────
  const [cascades, setCascades] = useState([])
  const [cascadeMode, setCascadeMode] = useState('list') // list | create | edit
  const [cascadeEditId, setCascadeEditId] = useState(null)
  const [cascadeName, setCascadeName] = useState('')
  const [cascadeSteps, setCascadeSteps] = useState(['', ''])
  const [cascadeLoop, setCascadeLoop] = useState(false)
  const [cascadeAutoApprove, setCascadeAutoApprove] = useState(false)
  const [cascadeBypass, setCascadeBypass] = useState(false)
  const [cascadeAutoApprovePlan, setCascadeAutoApprovePlan] = useState(false)
  const [cascadeVariables, setCascadeVariables] = useState([])
  const [cascadeLoopReprompt, setCascadeLoopReprompt] = useState(false)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const cascadeRunner = useStore((s) => activeSessionId ? s.cascadeRunners[activeSessionId] : null)

  useEffect(() => {
    api.getPrompts().then((list) => {
      setPrompts(list)
      useStore.getState().setPrompts(list)
    })
    api.getCascades().then((list) => {
      setCascades(list)
      useStore.getState().setCascades(list)
    }).catch(() => {})
    inputRef.current?.focus()
  }, [])

  // Mirror local list edits into the global cache so @prompt:<name>
  // token expansion + chip previews stay accurate without a refetch.
  const syncCache = (list) => useStore.getState().setPrompts(list)

  useEffect(() => { setSelectedIdx(0) }, [query])

  const filtered = query
    ? prompts.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.content.toLowerCase().includes(query.toLowerCase()) ||
        (p.category || '').toLowerCase().includes(query.toLowerCase())
      )
    : prompts

  const handleUse = async (prompt) => {
    await api.usePrompt(prompt.id)
    // Send prompt content to active session's terminal
    const store = useStore.getState()
    const sid = store.activeSessionId
    if (sid) {
      sendTerminalCommand(sid, prompt.content)
    }
    onClose()
  }

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!newName.trim() || !newContent.trim()) return
    if (editingId) {
      const updated = await api.updatePrompt(editingId, {
        name: newName.trim(),
        content: newContent.trim(),
        category: newCategory,
      })
      const next = prompts.map((p) => (p.id === editingId ? updated : p))
      setPrompts(next)
      syncCache(next)
    } else {
      const p = await api.createPrompt({
        name: newName.trim(),
        content: newContent.trim(),
        category: newCategory,
      })
      const next = [p, ...prompts]
      setPrompts(next)
      syncCache(next)
    }
    setMode('list')
    setEditingId(null)
    setNewName('')
    setNewContent('')
  }

  const handleEdit = (e, prompt) => {
    e.stopPropagation()
    setNewName(prompt.name)
    setNewContent(prompt.content)
    setNewCategory(prompt.category || 'General')
    setEditingId(prompt.id)
    setMode('create')
  }

  // ⌘= → switch to create mode; ⌘↵ → save (only when create mode is active so
  // pressing ⌘↵ in the search list doesn't accidentally fire an empty save).
  usePanelCreate({
    onAdd: () => setMode('create'),
    onSubmit: () => { if (mode === 'create') handleCreate() },
  })

  const handleDelete = async (e, id) => {
    e.stopPropagation()
    await api.deletePrompt(id)
    const next = prompts.filter((p) => p.id !== id)
    setPrompts(next)
    syncCache(next)
  }

  const handlePin = async (e, prompt) => {
    e.stopPropagation()
    const updated = await api.updatePrompt(prompt.id, { pinned: prompt.pinned ? 0 : 1 })
    const next = prompts.map((p) => (p.id === prompt.id ? updated : p))
    setPrompts(next)
    syncCache(next)
  }

  const handleToggleQuickAction = async (e, prompt) => {
    e.stopPropagation()
    const updated = await api.updatePrompt(prompt.id, { is_quickaction: prompt.is_quickaction ? 0 : 1 })
    const next = prompts.map((p) => (p.id === prompt.id ? updated : p))
    setPrompts(next)
    syncCache(next)
  }

  // ── Cascade handlers ──────────────────────────────────────────
  const resetCascadeForm = () => {
    setCascadeMode('list')
    setCascadeEditId(null)
    setCascadeName('')
    setCascadeSteps(['', ''])
    setCascadeLoop(false)
    setCascadeAutoApprove(false)
    setCascadeBypass(false)
    setCascadeAutoApprovePlan(false)
    setCascadeVariables([])
    setCascadeLoopReprompt(false)
  }

  const handleCascadeSave = async (e) => {
    e?.preventDefault?.()
    const cleanSteps = cascadeSteps.filter((s) => s.trim())
    if (!cascadeName.trim() || cleanSteps.length === 0) return
    try {
      if (cascadeMode === 'edit' && cascadeEditId) {
        const updated = await api.updateCascade(cascadeEditId, {
          name: cascadeName.trim(), steps: cleanSteps, loop: cascadeLoop,
          auto_approve: cascadeAutoApprove, bypass_permissions: cascadeBypass,
          auto_approve_plan: cascadeAutoApprovePlan,
          variables: cascadeVariables, loop_reprompt: cascadeLoopReprompt,
        })
        const next = cascades.map((c) => (c.id === cascadeEditId ? updated : c))
        setCascades(next)
        useStore.getState().setCascades(next)
      } else {
        const created = await api.createCascade({
          name: cascadeName.trim(), steps: cleanSteps, loop: cascadeLoop,
          auto_approve: cascadeAutoApprove, bypass_permissions: cascadeBypass,
          auto_approve_plan: cascadeAutoApprovePlan,
          variables: cascadeVariables, loop_reprompt: cascadeLoopReprompt,
        })
        const next = [...cascades, created]
        setCascades(next)
        useStore.getState().setCascades(next)
      }
      resetCascadeForm()
    } catch (err) {
      alert(`Failed to save: ${err.message}`)
    }
  }

  const handleCascadeRun = (cascade) => {
    if (!activeSessionId) return
    const started = useStore.getState().startCascade(activeSessionId, cascade)
    if (started) onClose()
  }

  const handleCascadeRunNow = () => {
    const cleanSteps = cascadeSteps.filter((s) => s.trim())
    if (cleanSteps.length > 0 && activeSessionId) {
      const started = useStore.getState().startCascade(activeSessionId, {
        name: cascadeName.trim() || 'Untitled cascade',
        steps: cleanSteps,
        loop: cascadeLoop,
        auto_approve: cascadeAutoApprove,
        bypass_permissions: cascadeBypass,
        auto_approve_plan: cascadeAutoApprovePlan,
        variables: cascadeVariables,
        loop_reprompt: cascadeLoopReprompt,
      })
      if (started) onClose()
    }
  }

  const handleCascadeDelete = async (id) => {
    await api.deleteCascade(id)
    const next = cascades.filter((c) => c.id !== id)
    setCascades(next)
    useStore.getState().setCascades(next)
  }

  const handleToggleCascadeQuickAction = async (e, cascade) => {
    e.stopPropagation()
    const updated = await api.updateCascade(cascade.id, { is_quickaction: cascade.is_quickaction ? 0 : 1 })
    const next = cascades.map((c) => (c.id === cascade.id ? updated : c))
    setCascades(next)
    useStore.getState().setCascades(next)
  }

  const handleCascadeEdit = (cascade) => {
    setCascadeMode('edit')
    setCascadeEditId(cascade.id)
    setCascadeName(cascade.name)
    const s = Array.isArray(cascade.steps) ? cascade.steps.map(String) : []
    setCascadeSteps([...s, ''])
    setCascadeLoop(!!cascade.loop)
    setCascadeAutoApprove(!!cascade.auto_approve)
    setCascadeBypass(!!cascade.bypass_permissions)
    setCascadeAutoApprovePlan(!!cascade.auto_approve_plan)
    setCascadeVariables(cascade.variables || [])
    setCascadeLoopReprompt(!!cascade.loop_reprompt)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (mode === 'create') setMode('list')
      else onClose()
    } else if (mode === 'list') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && filtered[selectedIdx]) {
        handleUse(filtered[selectedIdx])
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[720px] x-panel shadow-x-3 overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <BookOpen size={14} strokeWidth={1.75} className="text-x-accent" />
          <span className="text-xs text-x-ink-secondary font-medium">Prompt Library</span>
          <div className="flex-1" />
          {/* Tab toggle: Prompts | Cascades */}
          <div className="flex border border-x-line rounded-md overflow-hidden">
            <button
              onClick={() => { setTab('prompts'); setMode('list'); resetCascadeForm() }}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-[80ms] ease-x ${
                tab === 'prompts'
                  ? 'bg-x-tint text-x-accent'
                  : 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
              }`}
            >
              Prompts
            </button>
            <button
              onClick={() => { setTab('cascades'); setMode('list'); resetCascadeForm() }}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-[80ms] ease-x border-l border-x-line ${
                tab === 'cascades'
                  ? 'bg-x-tint text-x-accent'
                  : 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
              }`}
            >
              <span className="flex items-center gap-1">
                <ListOrdered size={11} />
                Cascades
              </span>
            </button>
          </div>
          <button
            onClick={() => {
              if (tab === 'cascades') {
                setCascadeMode(cascadeMode === 'create' ? 'list' : 'create')
              } else {
                setMode(mode === 'create' ? 'list' : 'create')
              }
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
          >
            <Plus size={11} />
            new
          </button>
        </div>

        {tab === 'cascades' ? (
          /* ── Cascades tab ─────────────────────────────────────── */
          cascadeMode === 'create' || cascadeMode === 'edit' ? (
            <form onSubmit={handleCascadeSave} className="p-4 space-y-3 max-h-[65vh] overflow-y-auto">
              <input
                value={cascadeName}
                onChange={(e) => setCascadeName(e.target.value)}
                placeholder="cascade name"
                className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                autoFocus
              />
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-x-ink-secondary">
                  Steps (run in order, one at a time)
                </label>
                {cascadeSteps.map((step, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start">
                    <span className="text-[11px] text-x-faint font-mono mt-2 w-4 text-right shrink-0">
                      {idx + 1}.
                    </span>
                    <textarea
                      value={step}
                      onChange={(e) => {
                        const next = [...cascadeSteps]
                        next[idx] = e.target.value
                        setCascadeSteps(next)
                      }}
                      placeholder={`prompt for step ${idx + 1}...`}
                      rows={2}
                      className="flex-1 px-2.5 py-1.5 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono resize-none leading-relaxed"
                    />
                    {cascadeSteps.length > 1 && (
                      <button type="button" onClick={() => setCascadeSteps(cascadeSteps.filter((_, i) => i !== idx))}
                        className="mt-1.5 p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x">
                        <XIcon size={11} />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => setCascadeSteps([...cascadeSteps, ''])}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x">
                  <Plus size={10} /> add step
                </button>
              </div>
              <CascadeVariableEditor
                steps={cascadeSteps}
                variables={cascadeVariables}
                onVariablesChange={setCascadeVariables}
              />

              {/* Loop + permission mode options */}
              <div className="space-y-2 pt-1 border-t border-x-line/50">
                <label className="flex items-center gap-2 cursor-pointer" onClick={() => setCascadeLoop(!cascadeLoop)}>
                  <span className={`relative inline-block w-8 h-4 rounded-full transition-colors duration-[80ms] ease-x ${
                    cascadeLoop ? 'bg-x-accent' : 'bg-x-surface-2 border border-x-line'}`}>
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-x-on-accent transition-all duration-[80ms] ease-x ${
                      cascadeLoop ? 'left-[14px]' : 'left-0.5'}`} />
                  </span>
                  <span className="text-xs text-x-ink-secondary">Repeat after last step</span>
                  <span className="text-[11px] text-x-faint">(⌘+Esc on the session to stop)</span>
                </label>

                {cascadeLoop && cascadeVariables.length > 0 && (
                  <div className="flex items-center gap-2 cursor-pointer ml-5" onClick={() => setCascadeLoopReprompt(!cascadeLoopReprompt)}>
                    <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                      cascadeLoopReprompt ? 'bg-x-accent border-x-accent' : 'border-x-line-strong hover:border-x-muted'
                    }`}>
                      {cascadeLoopReprompt && <span className="text-x-on-accent text-[11px] font-semibold">✓</span>}
                    </span>
                    <span className="text-xs text-x-ink-secondary">Re-prompt variables each iteration</span>
                  </div>
                )}

                <div className="flex items-center gap-2 cursor-pointer ml-5" onClick={() => {
                  if (cascadeBypass) return // bypass controls this; uncheck bypass first
                  setCascadeAutoApprove(!cascadeAutoApprove)
                  if (cascadeAutoApprove) setCascadeBypass(false) // unchecking auto also unchecks bypass
                }}>
                  <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                    (cascadeAutoApprove || cascadeBypass) ? 'bg-x-accent border-x-accent' : 'border-x-line-strong hover:border-x-muted'
                  } ${cascadeBypass ? 'opacity-50' : ''}`}>
                    {(cascadeAutoApprove || cascadeBypass) && <span className="text-x-on-accent text-[11px] font-semibold">✓</span>}
                  </span>
                  <span className={`text-xs ${cascadeBypass ? 'text-x-faint' : 'text-x-ink-secondary'}`}>
                    Restart session in auto-approve mode
                  </span>
                </div>

                <div className="flex items-center gap-2 cursor-pointer ml-5" onClick={() => {
                  const next = !cascadeBypass
                  setCascadeBypass(next)
                  if (next) setCascadeAutoApprove(true) // bypass implies auto-approve
                }}>
                  <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                    cascadeBypass ? 'bg-x-accent-ink border-x-accent-ink' : 'border-x-line-strong hover:border-x-muted'
                  }`}>
                    {cascadeBypass && <span className="text-x-on-accent text-[11px] font-semibold">✓</span>}
                  </span>
                  <span className="text-xs text-x-accent-ink/80">Use dangerously skip permissions</span>
                </div>
                {cascadeBypass && (
                  <div className="ml-10 text-[11px] text-x-accent-ink/60 leading-relaxed">
                    Maps to the active CLI's highest-permission mode.
                    The agent will not ask for approval on any action.
                  </div>
                )}

                <div className="flex items-center gap-2 cursor-pointer ml-5" onClick={() => setCascadeAutoApprovePlan(!cascadeAutoApprovePlan)}>
                  <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                    cascadeAutoApprovePlan ? 'bg-x-good border-x-good' : 'border-x-line-strong hover:border-x-muted'
                  }`}>
                    {cascadeAutoApprovePlan && <span className="text-x-on-accent text-[11px] font-semibold">✓</span>}
                  </span>
                  <span className="text-xs text-x-ink-secondary">
                    Auto-approve plans (skip review, proceed immediately)
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5">
                <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x">
                  {cascadeMode === 'edit' ? 'update' : 'save'}
                </button>
                <button type="button" onClick={resetCascadeForm} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">
                  cancel
                </button>
                {cascadeMode === 'edit' && cascadeEditId && (() => {
                  const c = cascades.find((x) => x.id === cascadeEditId)
                  if (!c) return null
                  return (
                    <div className="flex items-center gap-1 ml-auto">
                      <button type="button" onClick={(e) => handleToggleCascadeQuickAction(e, c)} className={`p-1 rounded-md transition-colors duration-[80ms] ease-x ${c.is_quickaction ? 'text-x-accent-ink' : 'text-x-faint hover:text-x-accent-ink'}`} title={c.is_quickaction ? 'Remove from Quick Actions' : 'Add to Quick Actions'}>
                        <Zap size={11} />
                      </button>
                    </div>
                  )
                })()}
                {cascadeSteps.filter((s) => s.trim()).length > 0 && activeSessionId && (
                  <button type="button" onClick={handleCascadeRunNow}
                    className={`${(cascadeMode === 'edit' && cascadeEditId) ? 'ml-1' : 'ml-auto'} flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x`}>
                    <Play size={10} /> run now
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto">
              {cascadeRunner?.running && (
                <div className="px-4 py-2 bg-x-accent/10 border-b border-x-accent/20 text-[11px] text-x-accent">
                  Running: {cascadeRunner.name} — step {cascadeRunner.currentStep + 1}/{cascadeRunner.totalSteps || cascadeRunner.steps?.length || 0}
                  {cascadeRunner.loop && cascadeRunner.iteration > 0 && ` (loop #${cascadeRunner.iteration + 1})`}
                </div>
              )}
              {cascades.map((cascade) => {
                const cSteps = Array.isArray(cascade.steps) ? cascade.steps : []
                return (
                <div key={cascade.id}
                  className="group flex items-start gap-2 px-4 py-2.5 border-b border-x-line hover:bg-x-hover transition-colors duration-[80ms] ease-x">
                  <ListOrdered size={13} strokeWidth={1.75} className="text-x-accent/60 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-x-ink font-medium">{cascade.name}</span>
                      <span className="text-[11px] text-x-faint">{cSteps.length} steps</span>
                      {cascade.variables?.length > 0 && (
                        <span className="flex items-center gap-0.5 text-[11px] text-x-accent/60">
                          <Variable size={10} />{cascade.variables.length}
                        </span>
                      )}
                      {cascade.loop ? <RotateCcw size={11} className="text-x-accent/50" title="Loops" /> : null}
                      {cascade.is_quickaction ? <Zap size={11} className="text-x-accent-ink" /> : null}
                    </div>
                    <div className="flex flex-col gap-0.5 mt-1">
                      {cSteps.slice(0, 3).map((step, i) => (
                        <span key={i} className="text-[11px] text-x-muted font-mono truncate">
                          {i + 1}. {String(step).length > 80 ? String(step).slice(0, 80) + '...' : String(step)}
                        </span>
                      ))}
                      {cSteps.length > 3 && (
                        <span className="text-[11px] text-x-faint">+{cSteps.length - 3} more</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-[80ms] ease-x">
                    <button onClick={() => handleCascadeRun(cascade)}
                      disabled={!activeSessionId || cascadeRunner?.running}
                      className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-30"
                      title={!activeSessionId ? 'Select a session first' : cascadeRunner?.running ? 'A cascade is already running' : 'Run on active session'}>
                      <Play size={10} /> run
                    </button>
                    <button onClick={(e) => handleToggleCascadeQuickAction(e, cascade)} className={`p-1 rounded-md transition-colors duration-[80ms] ease-x ${cascade.is_quickaction ? 'text-x-accent-ink' : 'text-x-faint hover:text-x-accent-ink'}`} title={cascade.is_quickaction ? 'Remove from Quick Actions' : 'Add to Quick Actions'}>
                      <Zap size={11} />
                    </button>
                    <button onClick={() => handleCascadeEdit(cascade)} className="p-1 text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms] ease-x">
                      <Edit3 size={11} />
                    </button>
                    <button onClick={() => handleCascadeDelete(cascade.id)} className="p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              )})}

              {cascades.length === 0 && (
                <div className="px-4 py-10 text-xs text-x-faint text-center space-y-1">
                  <ListOrdered size={20} className="mx-auto text-x-faint/30" />
                  <div>No cascades yet.</div>
                  <div className="text-[11px]">A cascade sends multiple prompts in sequence, each waiting for the session to finish.</div>
                </div>
              )}
            </div>
          )
        ) : mode === 'create' ? (
          <form onSubmit={handleCreate} className="p-4 space-y-2.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="prompt name"
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] ease-x"
              autoFocus
            />
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="category (e.g. Review, Debug, Test)"
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] ease-x"
            />
            <div className="flex items-center justify-between text-[11px] text-x-faint">
              <span>markdown supported — headings, lists, code, tables</span>
              <button
                type="button"
                onClick={() => setShowPreview((p) => !p)}
                className="flex items-center gap-1 px-2 py-1 text-x-faint hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
              >
                {showPreview ? <Edit3 size={10} /> : <Eye size={10} />}
                {showPreview ? 'edit' : 'preview'}
              </button>
            </div>
            {showPreview ? (
              <div className="w-full min-h-[220px] max-h-[50vh] overflow-y-auto px-3 py-2 text-xs bg-x-surface-2 border border-x-line rounded-md prose prose-sm">
                {newContent.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{newContent}</ReactMarkdown>
                ) : (
                  <span className="text-x-faint not-prose">nothing to preview</span>
                )}
              </div>
            ) : (
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={'prompt content (markdown ok)\n\n# example\n- bullet\n`inline code`'}
                rows={12}
                className="w-full px-2.5 py-1.5 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono resize-none transition-colors duration-[80ms] ease-x"
              />
            )}
            <div className="flex items-center gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x">{editingId ? 'update' : 'save'}</button>
              <button type="button" onClick={() => { setMode('list'); setEditingId(null); setNewName(''); setNewContent('') }} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">cancel</button>
              {editingId && (() => {
                const p = prompts.find((x) => x.id === editingId)
                if (!p) return null
                return (
                  <div className="flex items-center gap-1 ml-auto">
                    <button type="button" onClick={(e) => handlePin(e, p)} className={`p-1 rounded-md transition-colors duration-[80ms] ease-x ${p.pinned ? 'text-x-accent' : 'text-x-faint hover:text-x-accent'}`} title={p.pinned ? 'Unpin' : 'Pin'}>
                      <Pin size={11} />
                    </button>
                    <button type="button" onClick={(e) => handleToggleQuickAction(e, p)} className={`p-1 rounded-md transition-colors duration-[80ms] ease-x ${p.is_quickaction ? 'text-x-accent-ink' : 'text-x-faint hover:text-x-accent-ink'}`} title={p.is_quickaction ? 'Remove from Quick Actions' : 'Add to Quick Actions'}>
                      <Zap size={11} />
                    </button>
                  </div>
                )
              })()}
            </div>
          </form>
        ) : (
          <>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="search prompts..."
              className="w-full px-4 py-2.5 text-[13px] bg-transparent border-b border-x-line text-x-ink placeholder:text-x-muted focus:outline-none"
            />
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {filtered.map((prompt, i) => (
                <div key={prompt.id}>
                  <button
                    onClick={() => handleUse(prompt)}
                    className={`group w-full text-left px-4 py-2 transition-colors duration-[80ms] ease-x ${
                      i === selectedIdx ? 'bg-x-tint text-x-ink' : 'hover:bg-x-hover'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-x-ink font-medium flex-1">{prompt.name}</span>
                      <span className="text-[11px] text-x-faint">{prompt.category}</span>
                      {prompt.pinned ? <Pin size={11} className="text-x-accent" /> : null}
                      {prompt.is_quickaction ? <Zap size={11} className="text-x-accent-ink" /> : null}
                      <Eye
                        size={11}
                        className={`${expandedId === prompt.id ? 'text-x-accent opacity-100' : 'opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent'} transition-opacity duration-[80ms] ease-x cursor-pointer`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedId(expandedId === prompt.id ? null : prompt.id)
                        }}
                        title="Preview"
                      />
                      <Edit3
                        size={11}
                        className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent transition-opacity duration-[80ms] ease-x cursor-pointer"
                        onClick={(e) => handleEdit(e, prompt)}
                        title="Edit prompt"
                      />
                      <Trash2
                        size={11}
                        className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent-ink transition-opacity duration-[80ms] ease-x cursor-pointer"
                        onClick={(e) => handleDelete(e, prompt.id)}
                        title="Delete"
                      />
                    </div>
                    <div className="text-[11px] text-x-muted font-mono mt-0.5 truncate">
                      {prompt.content.substring(0, 100)}
                    </div>
                  </button>
                  {expandedId === prompt.id && (
                    <div
                      className="mx-4 mb-2 px-3 py-2 text-xs bg-x-surface-2 border border-x-line rounded-md prose prose-sm max-h-[40vh] overflow-y-auto"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-8 text-xs text-x-faint text-center">
                  {prompts.length === 0 ? 'No prompts yet — click "+ new" to create one' : 'No matching prompts'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
