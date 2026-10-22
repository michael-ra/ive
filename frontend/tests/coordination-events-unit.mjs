import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleCoordinationEvent, handleStartupBlockerNotice } from '../src/lib/coordinationEvents.js'

function fixture() {
  return {
    sessions: { a: { id: 'a', name: 'Fix login' } },
    notifications: [],
    addNotification(n) { this.notifications.push(n) },
  }
}

test('peer_warning shows one toast per distinct warning, blocking as error', () => {
  const store = fixture()
  const event = { type: 'peer_warning', session_id: 'a', from_session: 'Billing', priority: 'blocking', topic: 'api', content: 'Do not touch auth.py', matched_file: '/repo/auth.py' }
  assert.equal(handleCoordinationEvent(store, 'a', event), true)
  assert.equal(handleCoordinationEvent(store, 'a', event), true)
  assert.equal(store.notifications.length, 1)
  assert.equal(store.notifications[0].type, 'error')
  assert.match(store.notifications[0].message, /Fix login: warning from Billing about auth\.py\. Do not touch auth\.py/)
})

test('file_conflict names the file and the other sessions once', () => {
  const store = fixture()
  const event = { type: 'file_conflict', file_path: '/repo/src/app.js', conflicting_sessions: [{ session_id: 'b1234567890', session_name: 'Refactor' }] }
  handleCoordinationEvent(store, 'a', event)
  handleCoordinationEvent(store, 'a', event)
  assert.equal(store.notifications.length, 1)
  assert.equal(store.notifications[0].type, 'warning')
  assert.match(store.notifications[0].message, /app\.js was recently edited by Refactor/)
})

test('worker_queue_delivery reports the handed-off task', () => {
  const store = fixture()
  handleCoordinationEvent(store, 'a', { type: 'worker_queue_delivery', task_id: 't1', title: 'Add tests' })
  assert.equal(store.notifications[0].type, 'info')
  assert.match(store.notifications[0].message, /Next queued task sent to Fix login: Add tests/)
})

test('other event types are left alone', () => {
  const store = fixture()
  assert.equal(handleCoordinationEvent(store, 'a', { type: 'output' }), false)
  assert.equal(store.notifications.length, 0)
})

test('setup, trust and update blockers explain the swallowed keystroke once; auth is not handled here', () => {
  const store = fixture()
  for (const kind of ['setup_required', 'trust_required', 'update_required']) {
    assert.equal(handleStartupBlockerNotice(store, 'a', { type: 'error', startup_blocker: { type: kind } }), true)
    handleStartupBlockerNotice(store, 'a', { type: 'error', startup_blocker: { type: kind } })
  }
  assert.equal(store.notifications.length, 3)
  assert.match(store.notifications[1].message, /trust this folder/)
  assert.equal(handleStartupBlockerNotice(store, 'a', { type: 'error', startup_blocker: { type: 'auth_required' } }), false)
  assert.equal(handleStartupBlockerNotice(store, 'zz', { type: 'error', startup_blocker: { type: 'trust_required' } }), false)
})
