import { useState, useEffect, useRef } from 'react'
import { Plus, X, Mic, MicOff } from 'lucide-react'
import { api } from '../../lib/api'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import usePanelCreate from '../../hooks/usePanelCreate'

const PRIORITIES = ['normal', 'high', 'critical']

export default function NewTaskForm({ workspaceId, onCreated, onClose }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [labelsStr, setLabelsStr] = useState('')
  const [pipelineOn, setPipelineOn] = useState(false)
  const [creating, setCreating] = useState(false)
  const [duplicates, setDuplicates] = useState(null)
  const formRef = useRef(null)

  // ⌘↑ / ⌘↓ → cycle fields. Plain Tab also works, but the description textarea
  // swallows plain ↑/↓ for caret movement, so users need a meta-modified escape.
  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const form = formRef.current
      if (!form || !form.contains(e.target)) return
      const focusables = [...form.querySelectorAll('input, textarea')]
      if (focusables.length === 0) return
      const idx = focusables.indexOf(e.target)
      e.preventDefault()
      e.stopPropagation()
      const len = focusables.length
      const nextIdx = e.key === 'ArrowDown'
        ? (idx < 0 ? 0 : (idx + 1) % len)
        : (idx <= 0 ? len - 1 : idx - 1)
      focusables[nextIdx]?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const { listening, toggle: toggleVoice } = useVoiceInput((text) => {
    // If title is empty, fill title first; otherwise append to description
    if (!title.trim()) {
      setTitle(text)
    } else {
      setDescription((prev) => prev + (prev ? ' ' : '') + text)
    }
  })

  const handleCreate = async (e, opts = {}) => {
    e?.preventDefault?.()
    if (!title.trim() || !workspaceId) return
    setCreating(true)
    try {
      const labels = labelsStr.split(',').map((l) => l.trim()).filter(Boolean)
      const task = await api.createTask({
        workspace_id: workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        labels: labels.length > 0 ? labels : undefined,
        ...(pipelineOn && { pipeline: 1 }),
        ...(opts.force && { force: true }),
      })
      setDuplicates(null)
      onCreated?.(task)
    } catch (err) {
      // Backend dedup gate returns 409 with {candidates} when an open ticket
      // already covers this intent. Surface the candidates inline so the user
      // can either reuse one or click "Create anyway" (force=true).
      if (err?.status === 409 && err.body?.candidates) {
        setDuplicates(err.body.candidates)
      } else {
        console.error('Failed to create task:', err)
      }
    } finally {
      setCreating(false)
    }
  }

  // ⌘↵ submits the form so users can save without leaving the textarea.
  usePanelCreate({ onSubmit: () => handleCreate() })

  const inputClass = 'w-full px-2.5 py-1.5 text-[11px] bg-[#111118] border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-[500px] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden animate-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-zinc-800">
          <Plus size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-300 font-mono font-medium">New Task</span>
          <div className="flex-1" />
          <button
            onClick={toggleVoice}
            className={`flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono rounded border transition-colors ${
              listening
                ? 'bg-red-500/20 border-red-500/30 text-red-300 animate-pulse'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
            }`}
            title="Voice input — dictate title and description"
          >
            {listening ? <MicOff size={10} /> : <Mic size={10} />}
            {listening ? 'stop' : 'voice'}
          </button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        <form ref={formRef} onSubmit={handleCreate} className="p-4 space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            className={`${inputClass} text-[11px]`}
            autoFocus
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description, requirements, context... (optional)"
            rows={4}
            className={`${inputClass} resize-none leading-relaxed`}
          />

          <div className="flex items-center gap-1.5">
            <div>
              <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Priority</label>
              <div className="flex gap-1">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-2.5 py-1.5 text-[11px] font-mono rounded border transition-colors ${
                      priority === p
                        ? p === 'critical' ? 'bg-red-500/20 text-red-400 border-red-500/40'
                          : p === 'high' ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                          : 'bg-zinc-700/50 text-zinc-300 border-zinc-600'
                        : 'bg-[#111118] text-zinc-600 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1">
              <label className="text-[11px] text-zinc-600 font-mono uppercase mb-1 block">Labels</label>
              <input
                value={labelsStr}
                onChange={(e) => setLabelsStr(e.target.value)}
                placeholder="bug, frontend, urgent"
                className={inputClass}
              />
            </div>
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <button type="button" onClick={() => setPipelineOn(!pipelineOn)} className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              pipelineOn ? 'bg-emerald-600 border-emerald-500' : 'border-zinc-600 hover:border-zinc-400'
            }`}>
              {pipelineOn && <Plus size={8} className="text-white rotate-45" />}
            </button>
            <span className="text-[11px] text-zinc-300 font-mono">Pipeline</span>
            <span className="text-[11px] text-zinc-600 font-mono">— auto: implement → test → document</span>
          </label>

          {duplicates && duplicates.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-2 space-y-1.5">
              <div className="text-[11px] text-amber-300 font-mono">
                Possible duplicate{duplicates.length > 1 ? 's' : ''} already open:
              </div>
              <ul className="space-y-0.5">
                {duplicates.map((c) => (
                  <li key={c.task_id} className="text-[11px] text-zinc-400 font-mono">
                    • {c.title}
                    {c.status && <span className="text-zinc-600"> ({c.status})</span>}
                    {typeof c.score === 'number' && (
                      <span className="text-zinc-600"> — {c.score.toFixed(2)}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex gap-1 pt-1">
                <button
                  type="button"
                  onClick={() => handleCreate(undefined, { force: true })}
                  disabled={creating}
                  className="px-2.5 py-1 text-[11px] bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 rounded font-mono transition-colors"
                >
                  Create anyway
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicates(null)}
                  className="px-2.5 py-1 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded font-mono transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-1 pt-1">
            <button
              type="submit"
              disabled={creating || !title.trim()}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded font-mono transition-colors"
            >
              <Plus size={12} />
              {creating ? 'creating...' : 'Create Task'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded font-mono transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
