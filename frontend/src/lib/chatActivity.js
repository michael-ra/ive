// A local send is not proof that the assistant is running a task. Keep the
// handoff distinct from observed work, especially while retrying a failed start.
export function getChatActivity(meta, {
  pending = false,
  restarting = false,
  hasStarted = true,
  interrupted = false,
  deliveryIssue = null,
} = {}) {
  if (interrupted) return null
  if (restarting) return { kind: 'pending', label: 'Starting session…' }
  if (meta?.isWorking) return { kind: 'working', label: 'Assistant is responding…' }
  if (!pending || deliveryIssue) return null
  if (!hasStarted || ['error', 'offline', 'not-started'].includes(meta?.tone)) {
    return { kind: 'pending', label: 'Starting session…' }
  }
  return { kind: 'pending', label: 'Waiting for the assistant to accept your message…' }
}
