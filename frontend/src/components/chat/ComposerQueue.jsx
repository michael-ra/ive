import { memo, useRef } from 'react'
import { Check, Clock, Loader2, Paperclip, Pencil, RotateCcw, Send, X, AlertCircle } from 'lucide-react'
import useStore from '../../state/store'
import { useComposerQueue } from '../../hooks/useComposerQueue'
import { editQueued, removeQueued, sendQueuedNow } from '../../lib/composerQueue'
import { contextLabel } from '../../lib/chatContext'
import { restoreChatContext } from '../../hooks/useChatContext'

const STATE_META = {
  queued: { label: 'Queued', tone: 'text-x-ink-secondary' },
  sending: { label: 'Sending…', tone: 'text-x-ink-secondary' },
  sent: { label: 'Sent', tone: 'text-x-ink-secondary' },
  delivered: { label: 'Delivered', tone: 'text-x-good' },
  failed: { label: 'Not sent', tone: 'text-x-danger' },
  unconfirmed: { label: 'Not confirmed', tone: 'text-x-warning' },
}

const STATE_HELP = {
  queued: 'Waits for the turn to end, then goes out',
  sending: 'Being typed into the session',
  sent: 'The session took it, waiting for the transcript',
  delivered: 'In the transcript',
  failed: 'Not sent. It will not go out on its own',
  unconfirmed: 'The session took it, the transcript does not show it yet',
}

function StateIcon({ state }) {
  if (state === 'sending' || state === 'sent') return <Loader2 size={10} className="animate-spin" aria-hidden="true" />
  if (state === 'delivered') return <Check size={10} aria-hidden="true" />
  if (state === 'failed' || state === 'unconfirmed') return <AlertCircle size={10} aria-hidden="true" />
  return <Clock size={10} aria-hidden="true" />
}

// Messages typed while the agent works: what waits, what is on its way, what
// arrived. Lives above the composer of the session the queue belongs to.
function ComposerQueue({ sessionId, agentLabel = 'the agent', busy = false, connected = true, offline = false }) {
  const { items, hold } = useComposerQueue(sessionId)
  const draft = useStore((s) => String(s.sessionInputs?.[sessionId] || '').trim())
  const waiting = items.filter((i) => i.state === 'queued').length
  const sectionRef = useRef(null)
  // After Remove/Edit the clicked button is gone: keep the keyboard user in
  // the queue (next row's same action) or in this session's message box.
  const refocus = (index, label) => requestAnimationFrame(() => {
    const same = label ? sectionRef.current?.querySelectorAll(`li button[aria-label="${label}"]`) : null
    if (same?.length) { same[Math.min(index, same.length - 1)].focus(); return }
    const boxes = [...document.querySelectorAll(`[data-session-view="${sessionId}"] form.x-composer textarea`)]
    boxes.find((el) => el.offsetParent !== null)?.focus()
  })
  const removeLabel = (item) => (item.state === 'queued' || item.state === 'failed' ? 'Remove queued message' : 'Hide from queue')
  const onRemove = (item) => {
    const label = removeLabel(item)
    const index = items.filter((i) => i.state !== 'sending' && removeLabel(i) === label).indexOf(item)
    removeQueued(sessionId, item.id)
    refocus(index, label)
  }
  const onEdit = (item) => {
    if (editQueued(sessionId, item.id) && item.context?.length) restoreChatContext(sessionId, item.context)
    refocus(0, null)
  }

  if (!items.length) {
    if (!busy || !draft) return null
    return (
      <p className="flex items-center gap-1.5 px-1 text-[11px] text-x-muted select-none" data-composer-draft-hint>
        <span className="rounded border border-x-line px-1 py-px font-mono text-[10px] uppercase tracking-wide text-x-ink-secondary">Draft</span>
        Press Enter to queue this follow-up. It sends when {agentLabel} is done.
      </p>
    )
  }

  let note
  if (hold) {
    note = hold.reason === 'stopped'
      ? 'Paused because you stopped the agent.'
      : hold.reason === 'offline'
        ? 'Paused because the session stopped. Restart it, then send.'
        : `Paused: ${hold.message || 'the last delivery failed.'}`
  } else if (!connected) {
    note = 'Reconnecting to IVE. The queue is kept and waits.'
  } else if (offline) {
    note = 'The session is not running. The queue waits.'
  } else if (waiting) {
    note = busy ? `Sends when ${agentLabel} finishes this turn.` : 'Ready to send after the current turn…'
  } else {
    note = null
  }
  const canSendNow = !!hold && items.some((i) => i.state === 'queued' || i.state === 'failed')

  return (
    <section ref={sectionRef} aria-label="Message queue" data-composer-queue className="flex flex-col gap-1.5 rounded-xl border border-x-line bg-x-surface px-2.5 py-2 shadow-x-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5 text-[11px]">
        <span className="inline-flex items-center gap-1 font-mono uppercase tracking-wide font-bold text-x-ink-secondary">
          <Clock size={10} aria-hidden="true" /> Up next{waiting ? ` · ${waiting}` : ''}
        </span>
        {note && <span role="status" className={hold ? 'text-x-warning' : 'text-x-muted'}>{note}</span>}
        {canSendNow && (
          <button
            type="button"
            onClick={() => sendQueuedNow(sessionId)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-x-line bg-x-surface-2 px-2 py-0.5 font-medium text-x-ink-secondary hover:bg-x-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-focus"
          >
            <Send size={11} aria-hidden="true" /> Send queued now
          </button>
        )}
      </div>
      <ol className="flex max-h-40 flex-col gap-1 overflow-y-auto scrollbar-thin" aria-label="Queued messages">
        {items.map((item) => {
          const meta = STATE_META[item.state] || STATE_META.queued
          const editable = item.state === 'queued' || item.state === 'failed'
          const removable = item.state !== 'sending'
          return (
            <li
              key={item.id}
              data-queue-state={item.state}
              className="flex items-start gap-2 border-b border-x-line-subtle px-2 py-1.5 last:border-b-0"
            >
              <span
                className={`mt-px inline-flex shrink-0 items-center gap-1 px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-wide ${meta.tone}`}
                title={STATE_HELP[item.state]}
              >
                <StateIcon state={item.state} />
                {meta.label}
              </span>
              <div className="min-w-0 flex-1">
                {(!item.context?.length || item.body) && (
                  <p className="line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-[18px] text-x-ink">{item.context?.length ? item.body : item.text}</p>
                )}
                {item.context?.length > 0 && (
                  <p data-queue-context className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-x-muted"
                    title={item.context.map(contextLabel).join('\n')}>
                    <Paperclip size={10} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {item.context.length === 1 ? 'With context: ' : `With ${item.context.length} context items: `}
                      {item.context.map(contextLabel).join(', ')}
                    </span>
                  </p>
                )}
                {item.error && <p className="mt-0.5 text-[11px] leading-4 text-x-danger">{item.error}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {item.state === 'failed' && !hold && (
                  <button type="button" onClick={() => sendQueuedNow(sessionId)} aria-label="Send again" title="Send again"
                    className="rounded p-1 text-x-muted hover:bg-x-hover hover:text-x-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-focus">
                    <RotateCcw size={12} />
                  </button>
                )}
                {editable && (
                  <button type="button" onClick={() => onEdit(item)} aria-label="Edit queued message" title="Back into the message box to edit"
                    className="rounded p-1 text-x-muted hover:bg-x-hover hover:text-x-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-focus">
                    <Pencil size={12} />
                  </button>
                )}
                {removable && (
                  <button type="button" onClick={() => onRemove(item)}
                    aria-label={removeLabel(item)}
                    title={item.state === 'queued' || item.state === 'failed' ? 'Remove, it will not be sent' : 'Hide this row'}
                    className="rounded p-1 text-x-muted hover:bg-x-hover hover:text-x-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-focus">
                    <X size={12} />
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default memo(ComposerQueue)
