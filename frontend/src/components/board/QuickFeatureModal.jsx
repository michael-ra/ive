import { useState, useEffect, useRef, useCallback } from 'react'
import { Zap, X, Mic, MicOff } from 'lucide-react'
import { api } from '../../lib/api'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import useStore from '../../state/store'

const PRIORITIES = ['normal', 'high', 'critical']
const PRIORITY_KEYS = { '1': 'normal', '2': 'high', '3': 'critical' }

export default function QuickFeatureModal({ prefillText, autoVoice, onCreated, onClose }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState(prefillText || '')
  const [priority, setPriority] = useState('normal')
  const [creating, setCreating] = useState(false)
  const [duplicates, setDuplicates] = useState(null)
  const titleRef = useRef(null)
  const voiceStarted = useRef(false)

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const workspaceId = activeWorkspaceId || workspaces[0]?.id

  const { listening, toggle: toggleVoice } = useVoiceInput(useCallback((text) => {
    if (!titleRef.current?.value?.trim()) {
      setTitle(text)
    } else {
      setDescription((prev) => prev + (prev ? ' ' : '') + text)
    }
  }, []))

  // Auto-start voice if requested
  useEffect(() => {
    if (autoVoice && !voiceStarted.current) {
      voiceStarted.current = true
      // Small delay so modal is visible first
      const t = setTimeout(toggleVoice, 150)
      return () => clearTimeout(t)
    }
  }, [autoVoice, toggleVoice])

  // Focus title on mount (skip if auto-voice)
  useEffect(() => {
    if (!autoVoice && titleRef.current) titleRef.current.focus()
  }, [autoVoice])

  const handleCreate = useCallback(async (opts = {}) => {
    if (!title.trim() || !workspaceId) return
    setCreating(true)
    try {
      const task = await api.createTask({
        workspace_id: workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        ...(opts.force && { force: true }),
      })
      setDuplicates(null)
      // Stop voice if still listening
      if (listening) toggleVoice()
      onCreated?.(task)
      onClose()
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates) {
        setDuplicates(err.body.candidates)
      } else {
        console.error('Failed to create feature:', err)
      }
      setCreating(false)
    }
  }, [title, description, priority, workspaceId, listening, toggleVoice, onCreated, onClose])

  // Keyboard: ⌘Enter to submit, ⌘V for voice, 1/2/3 for priority (when not in input)
  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey

      // ⌘Enter → submit
      if (meta && e.key === 'Enter') {
        e.preventDefault()
        handleCreate()
        return
      }

      // ⌘V → toggle voice (override paste only when meta is held — paste is handled by browser default for the inputs)
      // We intercept Cmd+Shift+V to avoid conflict with paste-without-formatting
      if (meta && e.key === 'v' && !e.shiftKey) {
        // Only toggle voice if focus is NOT on an input/textarea (let paste work in inputs)
        const tag = document.activeElement?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          toggleVoice()
        }
        return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleCreate, toggleVoice])

  const ws = workspaces.find((w) => w.id === workspaceId)

  const inputClass = 'w-full px-2.5 py-1.5 text-[11px] bg-[#111118] border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={onClose}>
      <div
        className="w-[480px] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden animate-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800">
          <Zap size={12} className="text-amber-400" />
          <span className="text-[11px] text-zinc-300 font-mono font-medium">Quick Feature</span>
          {ws && (
            <span className="text-[10px] text-zinc-600 font-mono ml-1">
              → {ws.name}
            </span>
          )}
          <div className="flex-1" />

          {/* Voice toggle */}
          <button
            onClick={toggleVoice}
            className={`flex items-center gap-1 px-1.5 py-1 text-[10px] font-mono rounded border transition-colors ${
              listening
                ? 'bg-red-500/20 border-red-500/30 text-red-300 animate-pulse'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
            }`}
            title="Toggle voice input (⌘V when not in a text field)"
          >
            {listening ? <MicOff size={10} /> : <Mic size={10} />}
            {listening ? 'stop' : 'voice'}
          </button>

          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Voice indicator */}
        {listening && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20">
            <Mic size={11} className="text-red-400 animate-pulse" />
            <span className="text-[10px] font-mono text-red-300">
              listening... speak your feature idea
            </span>
          </div>
        )}

        {/* Form */}
        <div className="p-3 space-y-2.5">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Feature title — what should it do?"
            className={inputClass}
            onKeyDown={(e) => {
              // Quick priority with Alt+1/2/3
              if (e.altKey && PRIORITY_KEYS[e.key]) {
                e.preventDefault()
                setPriority(PRIORITY_KEYS[e.key])
              }
            }}
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Details, context, requirements... (optional)"
            rows={3}
            className={`${inputClass} resize-none leading-relaxed`}
          />

          {duplicates && duplicates.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-2 space-y-1.5">
              <div className="text-[10px] text-amber-300 font-mono">
                Possible duplicate{duplicates.length > 1 ? 's' : ''} already open:
              </div>
              <ul className="space-y-0.5">
                {duplicates.map((c) => (
                  <li key={c.task_id} className="text-[10px] text-zinc-400 font-mono truncate">
                    • {c.title}
                  </li>
                ))}
              </ul>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => handleCreate({ force: true })}
                  disabled={creating}
                  className="px-2 py-0.5 text-[10px] bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 rounded font-mono transition-colors"
                >
                  Create anyway
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicates(null)}
                  className="px-2 py-0.5 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded font-mono transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Priority + Submit row */}
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {PRIORITIES.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                    priority === p
                      ? p === 'critical' ? 'bg-red-500/20 text-red-400 border-red-500/40'
                        : p === 'high' ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                        : 'bg-zinc-700/50 text-zinc-300 border-zinc-600'
                      : 'bg-[#111118] text-zinc-600 border-zinc-800 hover:border-zinc-700'
                  }`}
                  title={`Alt+${i + 1}`}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <span className="text-[9px] text-zinc-600 font-mono">⌘↵ save</span>
            <button
              onClick={handleCreate}
              disabled={creating || !title.trim() || !workspaceId}
              className="flex items-center gap-1 px-3 py-1 text-[11px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded font-mono transition-colors"
            >
              <Zap size={10} />
              {creating ? 'saving...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
