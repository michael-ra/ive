import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleSessionError } from '../src/lib/sessionErrors.js'

function fixture(extra = {}) {
  const store = {
    sessions: { a: { id: 'a', name: 'Fix login', status: 'running', agentState: 'working', pty_alive: true, ...extra } },
    notifications: [],
    planWaiting: { a: true },
    setSessionPlanWaiting(id, v) { this.planWaiting[id] = v },
    setSessionAgentState(id, v) { this.sessions[id].agentState = v },
    setSessionStatus(id, status, more) { Object.assign(this.sessions[id], { status }, more) },
    addNotification(n) { this.notifications.push(n) },
  }
  return store
}

test('session_error after StopFailure leaves Working and tells the user', () => {
  const store = fixture()
  assert.equal(handleSessionError(store, 'a', { type: 'session_error', state: 'error', error_type: 'rate_limit' }), true)
  assert.equal(store.sessions.a.agentState, 'idle')
  assert.equal(store.sessions.a.status, 'idle')
  assert.equal(store.sessions.a.pty_alive, true)
  assert.equal(store.planWaiting.a, false)
  assert.equal(store.notifications.length, 1)
  assert.match(store.notifications[0].message, /Fix login.*rate_limit/)
})

test('prompt_state error only resets state, without a second toast', () => {
  const store = fixture()
  assert.equal(handleSessionError(store, 'a', { type: 'prompt_state', state: 'error' }), true)
  assert.equal(store.sessions.a.agentState, 'idle')
  assert.equal(store.notifications.length, 0)
  assert.equal(handleSessionError(fixture(), 'a', { type: 'prompt_state', state: 'working' }), false)
})

test('unknown, auth-blocked and exited sessions are left alone', () => {
  const store = fixture({ status: 'auth_failed' })
  assert.equal(handleSessionError(store, 'a', { type: 'session_error' }), false)
  assert.equal(handleSessionError(store, 'zzz', { type: 'session_error' }), false)
  const exited = fixture({ status: 'exited', pty_alive: false })
  handleSessionError(exited, 'a', { type: 'session_error', error_type: 'unknown' })
  assert.equal(exited.sessions.a.status, 'exited')
  assert.doesNotMatch(exited.notifications[0].message, /unknown/)
})
