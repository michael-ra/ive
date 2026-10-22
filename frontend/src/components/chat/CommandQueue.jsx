import { Clock, X } from 'lucide-react'

// Shared by Terminal and Overview: one quiet boundary for the whole queue.
export default function CommandQueue({ items, onCancel }) {
  if (!items.length) return null
  return (
    <section aria-label="Command queue" className="rounded-xl border border-x-line bg-x-surface px-3 py-2 shadow-x-1 animate-in">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-wide text-x-ink-secondary">
          <Clock size={10} aria-hidden="true" /> Queue ({items.length})
        </span>
        {items.map((item) => (
          <div key={item.id} data-command-queue-state={item.status}
            className="inline-flex min-w-0 max-w-[280px] shrink-0 items-center gap-1.5 rounded-md bg-x-surface-2 px-2 py-1 text-left font-mono text-[11px] text-x-ink-secondary"
            title={`${item.status === 'waiting' ? 'Waiting for agent to be ready' : 'Queued'}:\n\n${item.command}`}>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-x-muted">
              {item.status === 'waiting' ? 'waiting' : 'queued'}
            </span>
            <span className="max-w-[150px] truncate">{item.command}</span>
            <button type="button" onClick={() => onCancel(item.id)} aria-label="Cancel queued command" title="Cancel queued command"
              className="shrink-0 rounded p-0.5 text-x-muted transition-colors duration-[80ms] hover:bg-x-hover hover:text-x-ink x-focus-ring">
              <X size={10} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
