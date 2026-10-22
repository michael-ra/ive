import { useEffect, useId, useState } from 'react'
import { MessageCircle, Loader2, RefreshCw, ArrowUp } from 'lucide-react'
import useSessionPromptReply from '../../hooks/useSessionPromptReply'
import { permissionPresentation } from '../../lib/conversationPresentation'

/** Direct, guarded answers to the current request, in the conversation. */
export default function SessionPromptActions({ sessionId, active, disabled = false, onOpenTerminal }) {
  const fieldId = useId()
  const [reply, setReply] = useState('')
  const [slowRequest, setSlowRequest] = useState(false)
  const { snapshot: current, loading, error, sending, answered, unavailable: hookUnavailable, refresh, reply: send, clearError } = useSessionPromptReply(sessionId, { active })
  const waiting = active && !answered && (!current?.screen?.trim() || current?.incomplete)
  useEffect(() => {
    setSlowRequest(false)
    if (!waiting) return undefined
    const timer = setTimeout(() => setSlowRequest(true), 8000)
    return () => clearTimeout(timer)
  }, [waiting, sessionId])
  if (!active) return null
  const retry = () => { clearError(); refresh() }
  if (waiting) return (
    <section data-session-prompt-actions data-request-loading className="ive-chat-request-loading" aria-busy={!error && !slowRequest}>
      <div role="status" className="ive-chat-reply-status">
        {!error && !slowRequest && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        <span>{error ? 'Couldn’t load the request.' : slowRequest ? 'The request is taking longer than expected.' : 'Loading request…'}</span>
        {(error || slowRequest) && <button type="button" onClick={retry} className="ive-chat-text-button">Retry</button>}
      </div>
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(error || slowRequest) && current?.screen && <details className="ive-chat-request-details">
        <summary>Request details</summary>
        <pre>{current.screen}</pre>
        {onOpenTerminal && <button type="button" onClick={onOpenTerminal} className="ive-chat-text-button">Open terminal to review</button>}
      </details>}
    </section>
  )
  const unavailable = disabled || hookUnavailable
  const presentation = current?.prompt ? permissionPresentation(current.prompt) : null
  const sendReply = async (value, manual = false) => {
    if (unavailable) return
    if (await send(value, { manual })) setReply('')
  }
  const question = current?.screen?.split('\n').map((line) => line.trim()).filter((line) => /[?？]$/.test(line)).at(-1)
  const title = answered ? 'Reply sent' : presentation?.title || 'Your answer is needed'

  return (
    <section data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className="ive-chat-question" aria-busy={loading || sending}>
      <div className="ive-chat-question-heading">
        <MessageCircle size={17} aria-hidden="true" />
        <h3 id={`${fieldId}-title`}>{title}</h3>
        <button type="button" onClick={retry} disabled={sending} aria-label="Refresh current request" title="Refresh current request" className="ive-chat-icon-button"><RefreshCw size={15} /></button>
      </div>
      {presentation && !answered && <>
        <p className="ive-chat-question-description">{presentation.description}</p>
        {presentation.notice && <p className="ive-chat-question-notice">{presentation.notice}</p>}
      </>}
      {current?.screen && !current.prompt && !current.incomplete && !answered && <p>{question || 'The assistant is waiting for your reply. Review the request details below.'}</p>}
      {current?.screen && !answered && <details className="ive-chat-request-details">
        <summary>{presentation ? 'View exact request' : 'View request details'}</summary>
        <pre>{current.prompt?.excerpt || current.screen}</pre>
      </details>}
      {presentation && !answered && <div className="ive-chat-question-choices">
        {presentation.choices.map((choice) => <button key={choice.value} type="button" data-choice-kind={choice.kind} onClick={() => sendReply(choice.value)} disabled={unavailable}>
          {choice.label}
        </button>)}
      </div>}
      {current?.screen && !current.prompt && !current.incomplete && !answered && <form className="ive-chat-question-reply" onSubmit={(event) => { event.preventDefault(); sendReply(reply, true) }}>
        <label htmlFor={`${fieldId}-reply`}>Your reply</label>
        <div>
          <input id={`${fieldId}-reply`} value={reply} placeholder="Write your answer…" maxLength={2000} onChange={(event) => setReply(event.target.value)} disabled={unavailable} />
          <button type="submit" disabled={unavailable || !reply.trim()} aria-label="Send reply"><ArrowUp size={17} /></button>
        </div>
      </form>}
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(sending || answered) && <p role="status" className="ive-chat-reply-status">{sending && <Loader2 size={14} className="animate-spin" />}{sending ? 'Sending…' : 'The assistant can continue now.'}</p>}
    </section>
  )
}
