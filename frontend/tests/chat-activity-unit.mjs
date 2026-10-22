import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getChatActivity } from '../src/lib/chatActivity.js'
import { getSessionDisplayStatus } from '../src/lib/sessionStatus.js'

const meta = (status, extra = {}) => getSessionDisplayStatus({ id: 's', status, ...extra }, { s: true })

test('an optimistic greeting does not claim an executing plan', () => {
  assert.deepEqual(getChatActivity(meta('idle'), { pending: true }), {
    kind: 'pending', label: 'Waiting for the assistant to accept your message…',
  })
})

test('a failed-start retry stays visible as starting, not assistant work', () => {
  assert.deepEqual(getChatActivity(meta('error'), { pending: true }), {
    kind: 'pending', label: 'Starting session…',
  })
  assert.equal(getChatActivity(meta('error')), null)
})

test('a known delivery failure stops optimistic activity immediately', () => {
  assert.equal(getChatActivity(meta('error'), { pending: true, deliveryIssue: 'Workspace trust confirmation required' }), null)
  assert.equal(getChatActivity(meta('idle'), { pending: true, deliveryIssue: 'Login required' }), null)
})

test('needs-you and authentication states never claim assistant work', () => {
  for (const status of ['waiting', 'auth_failed']) {
    assert.equal(getChatActivity(meta(status)), null)
    assert.equal(getChatActivity(meta(status), { pending: true }).kind, 'pending')
  }
})

test('only observed work uses responding and interruption removes it', () => {
  assert.deepEqual(getChatActivity(meta('working')), { kind: 'working', label: 'Assistant is responding…' })
  assert.equal(getChatActivity(meta('working'), { interrupted: true }), null)
})

test('explicit restart is visible without pretending to await a message reply', () => {
  assert.deepEqual(getChatActivity(meta('error'), { restarting: true }), { kind: 'pending', label: 'Starting session…' })
  assert.equal(getChatActivity(meta('idle')), null)
})
