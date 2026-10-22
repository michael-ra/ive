import { useState } from 'react'
import { X, LoaderCircle } from 'lucide-react'
import { closeSession } from '../../lib/sessionActions'

export default function SessionCloseButton({ sessionId, name }) {
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Close ${name || 'session'}`}
      title="Close session — move to Archive; history is kept"
      disabled={pending}
      aria-busy={pending}
      className="ive-session-close"
      onClick={async (event) => {
        event.stopPropagation()
        setPending(true)
        try { await closeSession(sessionId) } finally { setPending(false) }
      }}
    >
      {pending ? <LoaderCircle size={14} className="animate-spin" /> : <X size={14} />}
    </button>
  )
}
