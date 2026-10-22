import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { handleTerminalError, resetAuthNotices } from '../src/lib/terminalErrors.js'

function fixture() {
  const writes = [], stops = [], statuses = []
  const store = {
    sessions: {
      a: { id: 'a', cli_type: 'claude', status: 'running', pty_alive: true },
      b: { id: 'b', cli_type: 'codex', status: 'running', pty_alive: true },
    },
    notifications: [],
    setSessionPlanWaiting() {},
    setSessionStatus(id, status, extra) { statuses.push([id, status]); Object.assign(this.sessions[id], { status }, extra) },
    stopSession(id) { stops.push(id) },
    addNotification(notification) { this.notifications.push(notification) },
  }
  const receive = (event, id = 'a', now) => handleTerminalError(store, id, event, (text) => writes.push(text), now)
  return { store, writes, stops, statuses, receive }
}

const authError = {
  type: 'error',
  message: 'Claude API auth error (401)',
  startup_blocker: { type: 'auth_error' },
}

beforeEach(() => resetAuthNotices())

test('a detected login prompt never stops the session or changes its status', () => {
  const { store, writes, stops, statuses, receive } = fixture()
  for (let i = 0; i < 100; i++) receive(authError)
  assert.deepEqual(stops, [], 'heuristic detection must not kill the PTY')
  assert.deepEqual(statuses, [], 'status stays as is, so input keeps flowing')
  assert.equal(store.sessions.a.status, 'running')
  assert.deepEqual(writes, [])
  assert.equal(store.notifications.length, 1)
  assert.equal(store.notifications[0].type, 'auth_failed')
})

test('a dismissed notice does not re-open on the next keystroke, but can after the cooldown', () => {
  const { store, receive } = fixture()
  receive(authError, 'a', 1000)
  store.notifications.length = 0
  receive(authError, 'a', 2000)
  assert.equal(store.notifications.length, 0)
  receive(authError, 'a', 1000 + 5 * 60 * 1000 + 1)
  assert.equal(store.notifications.length, 1)
})

test('independent sessions each get their own notice', () => {
  const { store, stops, receive } = fixture()
  receive(authError)
  receive({ ...authError, startup_blocker: { type: 'auth_required' } }, 'b')
  assert.deepEqual(stops, [])
  assert.equal(store.notifications.length, 2)
})

test('ordinary errors and non-auth setup blockers remain visible', () => {
  const { store, writes, stops, receive } = fixture()
  receive({ message: 'Connection failed' })
  receive({ message: 'Claude first-run setup required', startup_blocker: { type: 'setup_required' } })
  receive({ message: 'Session not running' })
  receive({ message: 'An API returned 401 while testing code' })
  assert.equal(writes.length, 4)
  assert.match(writes[0], /Connection failed/)
  assert.equal(store.sessions.a.status, 'running')
  assert.deepEqual(stops, [])
})

test('queued "Session not running" after a backend auth stop stays silent', () => {
  const { store, writes, receive } = fixture()
  store.sessions.a.status = 'auth_failed'
  receive({ message: 'Session not running' })
  assert.deepEqual(writes, [])
})
