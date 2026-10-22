import { useEffect, useRef } from 'react'
import { CheckCircle2, Circle, GripVertical, Link, Play, User } from 'lucide-react'
import { taskLabels } from '../../lib/boardColumns'

function TitleEditor({ value, onChange, onCommit, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      data-testid="board-inline-title"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      aria-label="Edit card title"
      className="min-w-0 flex-1 h-8 px-2 text-[12px] font-semibold bg-x-surface border border-x-accent rounded-lg text-x-ink focus:outline-none focus:ring-[3px] focus:ring-x-focus"
    />
  )
}

export default function TaskCard({
  task,
  onDragStart,
  onClick,
  onStart,
  isFocused,
  workspaceName,
  relState,
  onMouseEnter,
  onMouseLeave,
  isEditing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  attentionReasons = [],
}) {
  const labels = taskLabels(task).filter((label) => !label.startsWith('parked:'))
  const hasDeps = (() => {
    const raw = task.depends_on
    if (!raw || raw === '[]') return false
    if (Array.isArray(raw)) return raw.length > 0
    try { return JSON.parse(raw).length > 0 } catch { return false }
  })()
  const done = task.status === 'done'
  const active = ['in_progress', 'testing', 'documenting'].includes(task.status)

  let stateClasses = 'border-x-line bg-x-surface'
  if (isFocused) stateClasses = 'border-x-accent bg-x-tint ring-2 ring-x-focus'
  else if (relState === 'hovered') stateClasses = 'border-x-line-strong bg-x-hover'
  else if (relState === 'blocker' || relState === 'dependent') stateClasses = 'border-x-line-strong bg-x-surface-2'
  else if (relState === 'unrelated') stateClasses = 'border-x-line opacity-35'

  return (
    <article
      data-task-id={task.id}
      data-focused={isFocused ? 'true' : 'false'}
      draggable={!isEditing}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart?.(event, task)
      }}
      onClick={() => { if (!isEditing) onClick?.(task) }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-current={isFocused ? 'true' : undefined}
      className={`x-task-card group relative flex flex-col gap-2 p-3 border cursor-pointer transition-colors duration-[80ms] ease-x hover:border-x-line-strong ${stateClasses}`}
    >
      <GripVertical
        size={10}
        className="absolute top-3 right-3 text-x-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[80ms]"
      />

      <div className="flex items-start gap-2 pr-4">
        <span className="x-row-icon" aria-hidden="true">
          {done ? (
            <CheckCircle2 size={12} className="text-x-good" />
          ) : (
            <Circle size={7} className={`fill-current ${isFocused ? 'text-x-accent' : 'text-x-muted'} ${active ? 'animate-subtle-pulse' : ''}`} />
          )}
        </span>
        {isEditing ? (
          <TitleEditor
            value={editValue}
            onChange={onEditChange}
            onCommit={onEditCommit}
            onCancel={onEditCancel}
          />
        ) : (
          <span className="min-w-0 flex-1 text-[12px] font-semibold text-x-ink leading-snug line-clamp-2">
            {task.title}
          </span>
        )}
      </div>

      {attentionReasons.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-9" data-testid="attention-reasons">
          {attentionReasons.map((reason) => (
            <span key={reason} className="px-1.5 py-0.5 text-[10px] font-mono text-x-muted bg-x-surface-2 border border-x-line rounded-full">
              {reason}
            </span>
          ))}
        </div>
      )}

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-9">
          {labels.slice(0, 4).map((label) => (
            <span key={label} className="px-1.5 py-0.5 text-[10px] font-mono text-x-muted bg-x-surface-2 border border-x-line rounded-full">
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-0.5 pt-2 border-t border-x-line text-[10px] font-mono text-x-muted">
        <span>{task.status?.replaceAll('_', ' ') || 'backlog'}</span>
        {workspaceName && <span className="truncate max-w-[84px]">· {workspaceName}</span>}
        {task.assigned_session_name && (
          <span className="flex items-center gap-1 truncate max-w-[88px]" title={task.assigned_session_name}>
            <User size={8} /> {task.assigned_session_name}
          </span>
        )}
        <span className="flex-1" />
        {onStart && task.status !== 'done' && (
          <button
            onClick={(event) => { event.stopPropagation(); onStart(task) }}
            title="Route to a worker"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-x-accent text-x-on-accent opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-[80ms]"
          >
            <Play size={8} className="fill-current" /> route
          </button>
        )}
        {hasDeps && <Link size={9} title="Has dependencies" />}
        {task.queued_for_session_id && <span>queued</span>}
      </div>
    </article>
  )
}
