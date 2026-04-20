import { GripVertical, User, Circle, Link } from 'lucide-react'

const priorityStyles = {
  normal: 'bg-zinc-700/50 text-zinc-400 border-zinc-600',
  high: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  critical: 'bg-red-500/10 text-red-400 border-red-500/30',
}

const statusDot = {
  backlog: 'bg-zinc-600',
  todo: 'bg-zinc-400',
  in_progress: 'bg-indigo-400 animate-pulse',
  review: 'bg-amber-400',
  testing: 'bg-cyan-400 animate-pulse',
  documenting: 'bg-purple-400 animate-pulse',
  done: 'bg-green-400',
}

const labelColors = [
  'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'bg-rose-500/20 text-rose-300 border-rose-500/30',
  'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'bg-violet-500/20 text-violet-300 border-violet-500/30',
]

function hashLabel(label) {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return Math.abs(h) % labelColors.length
}

export default function TaskCard({ task, onDragStart, onClick, isFocused, workspaceName }) {
  const labels = Array.isArray(task.labels)
    ? task.labels
    : typeof task.labels === 'string' && task.labels
      ? task.labels.split(',').map((l) => l.trim()).filter(Boolean)
      : []
  const hasDeps = (() => {
    const raw = task.depends_on
    if (!raw || raw === '[]') return false
    if (Array.isArray(raw)) return raw.length > 0
    try { return JSON.parse(raw).length > 0 } catch { return false }
  })()

  return (
    <div
      draggable="true"
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(e, task)
      }}
      onClick={() => onClick?.(task)}
      className={`group relative flex flex-col gap-1.5 p-2.5 bg-[#111118]/80 border rounded-md hover:border-zinc-700 hover:bg-[#111118] cursor-pointer transition-all ${
        isFocused ? 'border-indigo-500/60 ring-1 ring-indigo-500/30 bg-[#111118]' : 'border-zinc-800'
      }`}
    >
      {/* Drag handle */}
      <GripVertical
        size={10}
        className="absolute top-2 right-2 text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
      />

      {/* Status dot + title */}
      <div className="flex items-start gap-1.5 pr-4">
        <Circle
          size={6}
          className={`mt-1 shrink-0 fill-current ${statusDot[task.status] || 'bg-zinc-600'}`}
          style={{ color: 'currentColor' }}
        />
        <span className="text-[11px] font-mono text-zinc-300 leading-tight line-clamp-2">
          {task.title}
        </span>
        {(task.iteration || 1) > 1 && (
          <span className="px-1 py-0.5 rounded text-[9px] font-mono font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 shrink-0">
            v{task.iteration}
          </span>
        )}
      </div>

      {/* Labels */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className={`px-1.5 py-1.5 text-[11px] font-mono rounded border ${labelColors[hashLabel(label)]}`}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Pipeline progress indicator */}
      {!!task.pipeline && (
        <div className="flex items-center gap-1 text-[9px] font-mono">
          <span className={task.pipeline_stage === 'implementing' || task.status === 'in_progress' ? 'text-indigo-400' : 'text-zinc-600'}>impl</span>
          <span className="text-zinc-700">&rarr;</span>
          <span className={task.pipeline_stage === 'testing' ? 'text-cyan-400' : 'text-zinc-600'}>test</span>
          <span className="text-zinc-700">&rarr;</span>
          <span className={task.pipeline_stage === 'documenting' ? 'text-purple-400' : 'text-zinc-600'}>docs</span>
        </div>
      )}

      {/* Footer: priority + workspace + assigned session */}
      <div className="flex items-center gap-1 mt-0.5">
        <span
          className={`px-1.5 py-1.5 text-[11px] font-mono rounded border ${priorityStyles[task.priority] || priorityStyles.normal}`}
        >
          {task.priority || 'normal'}
        </span>
        {workspaceName && (
          <span className="px-1.5 py-0.5 text-[9px] font-mono text-zinc-500 bg-zinc-800/80 rounded border border-zinc-700/50 truncate max-w-[80px]">
            {workspaceName}
          </span>
        )}
        {task.assigned_session_name && (
          <span className="flex items-center gap-1 text-[11px] font-mono text-zinc-500 truncate">
            <User size={8} />
            {task.assigned_session_name}
          </span>
        )}
        {hasDeps && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono text-zinc-500" title="Has dependencies">
            <Link size={8} />
          </span>
        )}
        {task.queued_for_session_id && (
          <span className="flex items-center gap-1 text-[9px] font-mono text-indigo-400 bg-indigo-500/10 px-1 rounded border border-indigo-500/20">
            queued
          </span>
        )}
      </div>
    </div>
  )
}
