const WORKING = new Set(['running', 'working', 'executing'])
const WAITING = new Set(['prompting', 'waiting', 'input_needed', 'needs_input'])

export function formatElapsed(startedAt, now = Date.now()) {
  const start = Number(startedAt)
  if (!Number.isFinite(start) || start <= 0) return ''
  const total = Math.max(0, Math.floor((now - start) / 1000))
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function isSessionWorking(session) {
  const status = String(session?.status || '').toLowerCase()
  const agentState = String(session?.agentState || '').toLowerCase()
  return WORKING.has(status) || WORKING.has(agentState)
}

export function isSessionWaiting(session) {
  const status = String(session?.status || '').toLowerCase()
  const agentState = String(session?.agentState || '').toLowerCase()
  return WAITING.has(status) || WAITING.has(agentState)
}

export function isTerminalVisibleSession(session, sessionStarted = {}) {
  if (!session) return false
  return Boolean(
    session.pty_alive ||
    session.is_external ||
    sessionStarted[session.id] ||
    isSessionWorking(session) ||
    isSessionWaiting(session)
  )
}

export function hasBadThinkingSignatureError(value) {
  const text = String(value || '').toLowerCase()
  const hasThinkingBlockReference = text.includes('thinking block') ||
    text.includes('`thinking`') ||
    text.includes('`redacted_thinking`') ||
    text.includes('redacted_thinking')
  return text.includes('invalid signature in thinking block') ||
    (text.includes('api error: 400') && hasThinkingBlockReference && text.includes('signature')) ||
    (
      text.includes('api error: 400') &&
      hasThinkingBlockReference &&
      (text.includes('cannot be modified') || text.includes('must remain as they were'))
    )
}
