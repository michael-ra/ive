import { useState, useEffect, useRef } from 'react'
import { ListOrdered, Plus, Trash2, Play, X, RotateCcw, GripVertical } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import CascadeVariableEditor from './CascadeVariableEditor'

/**
 * CascadePalette — create, browse, and run prompt cascades.
 *
 * A cascade is an ordered sequence of prompts sent one-by-one to a session,
 * each waiting for the session to finish before sending the next. Optionally
 * loops until the user stops it (⌘+Esc).
 *
 * Opened via ⌘K → "Prompt Cascades" or a dedicated keybinding.
 */
export default function CascadePalette({ onClose }) {
  const [cascades, setCascades] = useState([])
  const [mode, setMode] = useState('list') // list | create | edit
  const [editId, setEditId] = useState(null)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState(['', ''])
  const [loop, setLoop] = useState(false)
  const [loopReprompt, setLoopReprompt] = useState(false)
  const [variables, setVariables] = useState([])
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const cascadeRunner = useStore((s) => activeSessionId ? s.cascadeRunners[activeSessionId] : null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    api.getCascades().then(setCascades).catch(() => {})
    inputRef.current?.focus()
  }, [])

  const resetForm = () => {
    setMode('list')
    setEditId(null)
    setName('')
    setSteps(['', ''])
    setLoop(false)
    setLoopReprompt(false)
    setVariables([])
  }

  const handleSave = async (e) => {
    e?.preventDefault?.()
    const cleanSteps = steps.filter((s) => s.trim())
    if (!name.trim() || cleanSteps.length === 0) return

    try {
      if (mode === 'edit' && editId) {
        const updated = await api.updateCascade(editId, {
          name: name.trim(),
          steps: cleanSteps,
          loop,
          variables,
          loop_reprompt: loopReprompt,
        })
        setCascades((prev) => prev.map((c) => (c.id === editId ? updated : c)))
      } else {
        const created = await api.createCascade({
          name: name.trim(),
          steps: cleanSteps,
          loop,
          variables,
          loop_reprompt: loopReprompt,
        })
        setCascades((prev) => [...prev, created])
      }
      resetForm()
    } catch (err) {
      alert(`Failed to save: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    await api.deleteCascade(id)
    setCascades((prev) => prev.filter((c) => c.id !== id))
  }

  const handleEdit = (cascade) => {
    setMode('edit')
    setEditId(cascade.id)
    setName(cascade.name)
    setSteps([...cascade.steps, ''])
    setLoop(!!cascade.loop)
    setLoopReprompt(!!cascade.loop_reprompt)
    setVariables(cascade.variables || [])
  }

  const handleRun = (cascade) => {
    if (!activeSessionId) return
    const started = useStore.getState().startCascade(activeSessionId, cascade)
    if (started) onClose()
  }

  const addStep = () => setSteps([...steps, ''])
  const removeStep = (idx) => setSteps(steps.filter((_, i) => i !== idx))
  const updateStep = (idx, val) => {
    const next = [...steps]
    next[idx] = val
    setSteps(next)
  }

  const filtered = query
    ? cascades.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.steps.some((s) => s.toLowerCase().includes(query.toLowerCase()))
      )
    : cascades

  // Reset selection when query changes
  useEffect(() => { setSelectedIdx(-1) }, [query])

  useListKeyboardNav({
    enabled: mode === 'list',
    itemCount: filtered.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const cascade = filtered[idx]
      if (cascade && activeSessionId && !cascadeRunner?.running) handleRun(cascade)
    },
    onDelete: (idx) => {
      const cascade = filtered[idx]
      if (cascade) handleDelete(cascade.id)
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[600px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <ListOrdered size={14} className="text-indigo-400" />
          <span className="text-xs text-text-secondary font-medium">
            Prompt Cascades
          </span>
          {cascadeRunner?.running && (
            <span className="text-[10px] text-indigo-400 font-mono animate-pulse">
              running: {cascadeRunner.name}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => (mode === 'list' ? setMode('create') : resetForm())}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
          >
            {mode === 'list' ? (
              <>
                <Plus size={11} /> new
              </>
            ) : (
              'back'
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {mode === 'list' ? (
          <>
            {/* Search */}
            <div className="px-4 py-2 border-b border-border-secondary">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => i < filtered.length - 1 ? i + 1 : i) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => i > 0 ? i - 1 : 0) }
                  else if (e.key === 'Enter' && selectedIdx >= 0) {
                    e.preventDefault()
                    const cascade = filtered[selectedIdx]
                    if (cascade && activeSessionId && !cascadeRunner?.running) handleRun(cascade)
                  }
                }}
                placeholder="search cascades..."
                className="w-full bg-transparent text-xs text-text-primary placeholder-text-faint font-mono focus:outline-none"
              />
            </div>

            {/* Cascade list */}
            <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
              {filtered.map((cascade, idx) => (
                <div
                  key={cascade.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`group flex items-start gap-2 px-4 py-2.5 border-b border-border-secondary transition-colors cursor-pointer ${
                    selectedIdx === idx
                      ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
                      : 'hover:bg-bg-hover/50'
                  }`}
                >
                  <ListOrdered size={12} className="text-indigo-400/60 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-text-primary font-mono font-medium">
                        {cascade.name}
                      </span>
                      <span className="text-[10px] text-text-faint font-mono">
                        {cascade.steps.length} steps
                      </span>
                      {cascade.loop ? (
                        <RotateCcw size={9} className="text-indigo-400/50" title="Loops" />
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-0.5 mt-1">
                      {cascade.steps.slice(0, 3).map((step, i) => (
                        <span
                          key={i}
                          className="text-[10px] text-text-muted font-mono truncate"
                        >
                          {i + 1}. {step.length > 80 ? step.slice(0, 80) + '...' : step}
                        </span>
                      ))}
                      {cascade.steps.length > 3 && (
                        <span className="text-[10px] text-text-faint font-mono">
                          +{cascade.steps.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleRun(cascade)}
                      disabled={!activeSessionId || cascadeRunner?.running}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-indigo-500/80 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-30"
                      title={
                        !activeSessionId
                          ? 'Select a session first'
                          : cascadeRunner?.running
                          ? 'A cascade is already running'
                          : `Run on active session`
                      }
                    >
                      <Play size={9} />
                      run
                    </button>
                    <button
                      onClick={() => handleEdit(cascade)}
                      className="p-1 text-text-faint hover:text-text-secondary transition-colors"
                    >
                      <Plus size={10} />
                    </button>
                    <button
                      onClick={() => handleDelete(cascade.id)}
                      className="p-1 text-text-faint hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-10 text-xs text-text-faint text-center space-y-1">
                  <ListOrdered size={20} className="mx-auto text-text-faint/30" />
                  <div>No cascades yet.</div>
                  <div className="text-[10px]">
                    A cascade sends multiple prompts in sequence, each
                    waiting for the session to finish before sending the
                    next.
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* ── Create/Edit form ─────────────────────────────────── */
          <form onSubmit={handleSave} className="p-4 space-y-3 max-h-[65vh] overflow-y-auto">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cascade name"
              className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
              autoFocus
            />

            <div className="space-y-1.5">
              <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider">
                Steps (run in order, one at a time)
              </label>
              {steps.map((step, idx) => (
                <div key={idx} className="flex gap-1.5 items-start">
                  <span className="text-[10px] text-text-faint font-mono mt-2 w-4 text-right shrink-0">
                    {idx + 1}.
                  </span>
                  <textarea
                    value={step}
                    onChange={(e) => updateStep(idx, e.target.value)}
                    placeholder={`prompt for step ${idx + 1}...`}
                    rows={2}
                    className="flex-1 px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono resize-none leading-relaxed"
                  />
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeStep(idx)}
                      className="mt-1.5 p-1 text-text-faint hover:text-red-400 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addStep}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded transition-colors"
              >
                <Plus size={10} /> add step
              </button>
            </div>

            <CascadeVariableEditor
              steps={steps}
              variables={variables}
              onVariablesChange={setVariables}
            />

            <label className="flex items-center gap-2 cursor-pointer">
              <span
                className={`relative inline-block w-8 h-4 rounded-full transition-colors ${
                  loop
                    ? 'bg-indigo-500'
                    : 'bg-bg-tertiary border border-border-secondary'
                }`}
                onClick={() => setLoop(!loop)}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                    loop ? 'left-[14px]' : 'left-0.5'
                  }`}
                />
              </span>
              <span className="text-xs text-text-secondary">
                Loop until stopped
              </span>
              {loop && (
                <span className="text-[10px] text-text-faint">
                  (stop with ⌘+Esc)
                </span>
              )}
            </label>

            {loop && variables.length > 0 && (
              <div className="flex items-center gap-2 cursor-pointer ml-5" onClick={() => setLoopReprompt(!loopReprompt)}>
                <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                  loopReprompt ? 'bg-indigo-500 border-indigo-500' : 'border-border-accent hover:border-text-muted'
                }`}>
                  {loopReprompt && <span className="text-white text-[9px] font-bold">✓</span>}
                </span>
                <span className="text-xs text-text-secondary">Re-prompt variables each iteration</span>
              </div>
            )}

            <div className="flex gap-1.5">
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors"
              >
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors"
              >
                cancel
              </button>
              {/* Quick run without saving */}
              {steps.filter((s) => s.trim()).length > 0 && activeSessionId && (
                <button
                  type="button"
                  onClick={() => {
                    const cleanSteps = steps.filter((s) => s.trim())
                    if (cleanSteps.length > 0) {
                      const started = useStore.getState().startCascade(activeSessionId, {
                        name: name.trim() || 'Untitled cascade',
                        steps: cleanSteps,
                        loop,
                        variables,
                        loop_reprompt: loopReprompt,
                      })
                      if (started) onClose()
                    }
                  }}
                  className="ml-auto flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-indigo-500/80 hover:bg-indigo-500 text-white rounded-md transition-colors"
                >
                  <Play size={10} /> run now
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
