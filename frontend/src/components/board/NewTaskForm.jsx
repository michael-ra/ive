import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '../../lib/api'

export default function NewTaskForm({ workspaceId, onCreated, onClose, onDirtyChange }) {
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [duplicates, setDuplicates] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => onDirtyChange?.(false)
  }, [onDirtyChange])

  const updateTitle = (value) => {
    setTitle(value)
    setError('')
    setDuplicates(null)
    onDirtyChange?.(Boolean(value.trim()))
  }

  const create = async (force = false) => {
    const nextTitle = title.trim()
    if (!nextTitle || !workspaceId || creating) return
    setCreating(true)
    setError('')
    try {
      const task = await api.createTask({
        workspace_id: workspaceId,
        title: nextTitle,
        ...(force ? { force: true } : {}),
      })
      onDirtyChange?.(false)
      onCreated?.(task)
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates) {
        setDuplicates(err.body.candidates)
      } else {
        setError(err?.message || 'Could not create card')
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      data-testid="board-new-composer"
      className="border-b border-x-line p-2.5 bg-x-surface"
      onSubmit={(event) => { event.preventDefault(); create(false) }}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          data-testid="board-new-title"
          value={title}
          onChange={(event) => updateTitle(event.target.value)}
          placeholder="Card title"
          aria-label="New card title"
          className="min-w-0 flex-1 h-8 px-2.5 text-[12px] bg-x-surface border border-x-line rounded-lg text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
        />
        <button
          type="submit"
          disabled={!title.trim() || creating}
          aria-label="Create card"
          className="h-8 w-8 inline-flex items-center justify-center rounded-full bg-x-accent text-x-on-accent hover:bg-x-accent-ink disabled:opacity-35 transition-colors duration-[80ms]"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel new card"
          className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-x-muted hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-1.5 min-h-4 text-[11px] text-x-muted">
        {duplicates?.length ? (
          <span>
            A similar card exists ·{' '}
            <button type="button" onClick={() => create(true)} className="text-x-accent-ink hover:text-x-accent">
              create anyway
            </button>
          </span>
        ) : error ? (
          <span className="text-x-accent-ink">{error}</span>
        ) : (
          <span className="font-mono">enter create · esc cancel</span>
        )}
      </div>
    </form>
  )
}
