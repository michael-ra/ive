/** Context is ordinary message content: tokens such as @ralph must stay literal. */
export async function submitSessionContext(sessionId, message, { ensureRunning, sendInput }) {
  if (!sessionId || !String(message || '').trim()) throw new Error('Add a note or choose a guideline first.')
  if (!await ensureRunning(sessionId)) throw new Error('The session could not be started. Your context is still here; reconnect and retry.')
  const result = await sendInput(sessionId, message, { ready_timeout: 30 })
  if (!result?.ok || result.intercepted) throw new Error('The agent has not accepted this context. Check the session and retry.')
  return result
}
