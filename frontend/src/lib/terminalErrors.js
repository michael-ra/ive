// Sessions whose login notice was shown recently: sessionId -> timestamp.
const recentAuthNotices = new Map()
const AUTH_NOTICE_COOLDOWN_MS = 5 * 60 * 1000

/** Test hook: forget which sessions already got a login notice. */
export function resetAuthNotices() {
  recentAuthNotices.clear()
}

/**
 * Keep login failures out of xterm: terminal input can repeat the same error.
 * A detected login prompt only shows the recovery notice. It never stops the
 * session or blocks input: the detection is a heuristic on terminal text, and
 * the user may need to type `/login` into the very same terminal.
 */
export function handleTerminalError(store, sessionId, event, write, now = Date.now()) {
  const session = store.sessions[sessionId]
  const authBlocked = ['auth_error', 'auth_required'].includes(event.startup_blocker?.type)

  if (authBlocked) {
    if (!session) return
    const hasNotice = store.notifications.some((n) => n.sessionId === sessionId && n.type === 'auth_failed')
    const last = recentAuthNotices.get(sessionId)
    // One notice per burst; a dismissed notice stays dismissed for a while.
    if (hasNotice || (last && now - last < AUTH_NOTICE_COOLDOWN_MS)) return
    recentAuthNotices.set(sessionId, now)
    store.addNotification({
      sessionId,
      type: 'auth_failed',
      cli: session.cli_type,
      message: 'This session looks like it needs a sign-in. Reconnect your account, use Restart / re-sync, or sign in inside the terminal.',
    })
    return
  }

  // Input already in flight can arrive after a backend-confirmed auth stop.
  if (session?.status === 'auth_failed' && event.message === 'Session not running') return

  if (write) write(`\r\n\x1b[31m[error: ${event.message}]\x1b[0m\r\n`)
}
