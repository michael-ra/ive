/**
 * Session-scoped backend broadcasts that only need to tell the user something:
 * peer warnings, file conflicts and worker-queue handoffs. The agent already
 * gets the same text in its PTY; the UI shows one toast per distinct event.
 * Returns true when the event type is handled here.
 */
const COORDINATION_TYPES = new Set(['peer_warning', 'file_conflict', 'worker_queue_delivery'])

function sessionLabel(store, sessionId) {
  const session = store.sessions?.[sessionId]
  return session?.name || (sessionId ? sessionId.slice(0, 8) : 'Session')
}

function fileName(path) {
  return (path || '').split('/').filter(Boolean).at(-1) || path || 'a file'
}

function addOnce(store, notification) {
  const exists = store.notifications.some((n) => n.sessionId === notification.sessionId && n.dedupeKey === notification.dedupeKey)
  if (!exists) store.addNotification(notification)
}

export function handleCoordinationEvent(store, sessionId, data) {
  if (!COORDINATION_TYPES.has(data?.type)) return false
  const name = sessionLabel(store, sessionId)

  if (data.type === 'peer_warning') {
    const content = String(data.content || '').trim()
    addOnce(store, {
      sessionId,
      type: data.priority === 'blocking' ? 'error' : 'warning',
      dedupeKey: `peer:${data.from_session || ''}:${data.topic || ''}:${content}`,
      message: `${name}: warning from ${data.from_session || 'another session'}${data.matched_file ? ` about ${fileName(data.matched_file)}` : ''}. ${content.slice(0, 200)}`,
    })
    return true
  }

  if (data.type === 'file_conflict') {
    const others = (data.conflicting_sessions || [])
      .map((item) => item.session_name || (item.session_id || '').slice(0, 8))
      .filter(Boolean)
    addOnce(store, {
      sessionId,
      type: 'warning',
      dedupeKey: `conflict:${data.file_path || ''}`,
      message: `${name}: ${fileName(data.file_path)} was recently edited by ${others.length ? others.join(', ') : 'another session'}. The agent will check the diff before editing.`,
    })
    return true
  }

  // worker_queue_delivery
  addOnce(store, {
    sessionId,
    type: 'info',
    dedupeKey: `queue:${data.task_id || ''}`,
    message: `Next queued task sent to ${name}${data.title ? `: ${data.title}` : ''}.`,
  })
  return true
}

const BLOCKER_HINTS = {
  setup_required: 'is waiting at its first-run setup. Finish it in the terminal, then type again.',
  trust_required: 'is asking whether to trust this folder. Answer the prompt in the terminal, then type again.',
  update_required: 'showed an update prompt. It was dismissed; type again once the prompt returns.',
}

/**
 * Non-auth startup blockers arrive as `type:"error"` with `startup_blocker`.
 * The keystroke was not delivered, so say why once per session and blocker.
 */
export function handleStartupBlockerNotice(store, sessionId, event) {
  const kind = event?.startup_blocker?.type
  const hint = BLOCKER_HINTS[kind]
  if (!hint || !store.sessions?.[sessionId]) return false
  addOnce(store, {
    sessionId,
    type: 'warning',
    dedupeKey: `blocker:${kind}`,
    message: `${sessionLabel(store, sessionId)} ${hint}`,
  })
  return true
}
