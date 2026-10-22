/**
 * A turn that ended with an error (Claude StopFailure → backend `session_error`
 * and `prompt_state{state:"error"}`). The CLI is back at its prompt, so the
 * session leaves "Working"; `session_error` also tells the user why.
 * Returns true when the event changed the session.
 */
export function handleSessionError(store, sessionId, data) {
  if (data.type === 'prompt_state' && data.state !== 'error') return false
  const session = store.sessions[sessionId]
  if (!session || session.status === 'auth_failed') return false
  store.setSessionPlanWaiting(sessionId, false)
  store.setSessionAgentState?.(sessionId, 'idle')
  if (session.pty_alive !== false) store.setSessionStatus(sessionId, 'idle', { pty_alive: true })
  if (data.type === 'session_error') {
    const reason = data.error_type && data.error_type !== 'unknown' ? `: ${data.error_type}` : ''
    store.addNotification({
      sessionId,
      type: 'error',
      message: `${session.name || 'Session'} stopped with an error${reason}. Send the message again to retry.`,
    })
  }
  return true
}
