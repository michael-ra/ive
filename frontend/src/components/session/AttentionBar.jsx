import { useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronUp, CircleHelp, ShieldAlert } from 'lucide-react'
import useStore from '../../state/store'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { visibleSessions } from '../../lib/visibleSessions'
import useTaskAttention from '../../hooks/useTaskAttention'

// hideSessions: the phone session list already shows each waiting session as a
// card; only tasks and setup problems (Safety settings) are listed here then.
export default function AttentionBar({ onReviewSession, onReviewTask, onSafetySettings, hideSessions = false, showAll = false, emptyMessage = null }) {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const connected = useStore((s) => s.connected)
  const [expanded, setExpanded] = useState(false)
  const taskItems = useTaskAttention().items.map((item) => ({
    id: `task-${item.taskId}`, name: item.name, workspace: item.workspaceId,
    attention: { title: item.title, message: item.message },
    review: () => onReviewTask(item.taskId),
  }))
  const waiting = visibleSessions(sessions).filter(sessionNeedsAttention).filter((s) => !hideSessions || s.attention?.kind === 'configuration').map((s) => ({
    id: s.id, name: s.name || s.id.slice(0, 8), workspace: s.workspace_id,
    attention: s.attention || { title: s.status === 'auth_failed' ? 'Sign in required' : ['error', 'failed', 'crashed'].includes(s.status) ? 'Session error' : 'Your answer is needed', message: 'Open the session to continue.' },
    review: () => onReviewSession(s.id),
  }))
  const items = [...waiting, ...taskItems]
  if (!items.length) return emptyMessage ? <p role="status" className="p-4 text-sm text-x-muted">{emptyMessage}</p> : null
  const visible = showAll || expanded ? items : items.slice(0, 1)
  return <section className="ive-attention space-y-3" aria-label="Needs your attention">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <span className="ive-attention-count flex items-center gap-2 text-sm font-medium text-x-ink" aria-live="polite"><ShieldAlert size={16} />{items.length} {items.length === 1 ? 'item needs' : 'items need'} your attention</span>
      {!connected && <span className="text-xs text-x-muted">Reconnecting · status may be out of date</span>}
      {!showAll && items.length > 1 && <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>{expanded ? 'Show less' : `Show all ${items.length}`}{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
    </header>
    <div className="ive-attention-items space-y-2">
      {visible.map((item) => <div key={item.id} className="ive-attention-item flex flex-wrap items-start gap-3 rounded-lg border border-x-line bg-x-surface-2 p-4">
        <CircleHelp size={19} className="shrink-0 text-x-warning" />
        <div className="ive-attention-copy min-w-0 flex-1 space-y-2 break-words text-sm">
          <p><strong className="block text-x-ink">{item.name}</strong><span className="text-xs text-x-muted">{workspaces.find((w) => w.id === item.workspace)?.name}</span></p>
          <p><strong className="block text-x-ink-secondary">{item.attention.title}</strong><span className="text-xs text-x-muted">{item.attention.message}</span></p>
        </div>
        <div className="ive-attention-actions flex flex-wrap gap-2">
          {item.attention.kind === 'configuration' && onSafetySettings && <button type="button" className="ive-btn" onClick={onSafetySettings}>Safety settings</button>}
          <button type="button" className="ive-btn ive-btn--primary" onClick={item.review}>Review <ArrowUpRight size={15} /></button>
        </div>
      </div>)}
    </div>
  </section>
}
