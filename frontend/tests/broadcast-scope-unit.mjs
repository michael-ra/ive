import test from 'node:test'
import assert from 'node:assert/strict'
import { getBroadcastRecipients } from '../src/lib/broadcastScope.js'

const sessions = { a: { workspace_id: 'first' }, b: { workspace_id: 'second' }, c: { workspace_id: 'first' } }
test('narrowing from global to one project excludes hidden selected sessions immediately', () => {
  const selected = { a: true, b: true }
  assert.deepEqual(getBroadcastRecipients(selected, ['a', 'b'], ['a', 'b'], sessions), ['a', 'b'])
  assert.deepEqual(getBroadcastRecipients(selected, ['a'], ['a', 'b'], sessions), ['a'])
})
test('saved global group is constrained by current visible and open sessions', () => {
  assert.deepEqual(getBroadcastRecipients({ a: true, b: true, c: true }, ['a', 'c'], ['a', 'b'], sessions), ['a'])
})
test('missing, deselected, duplicate, and closed tabs are never recipients', () => {
  assert.deepEqual(getBroadcastRecipients({ a: true, b: false, c: true, missing: true }, ['a', 'a', 'b', 'c', 'missing'], ['a', 'b', 'missing'], sessions), ['a'])
})
test('empty selection and scope produce no recipients', () => {
  assert.deepEqual(getBroadcastRecipients({}, ['a'], ['a'], sessions), [])
  assert.deepEqual(getBroadcastRecipients({ a: true }, [], ['a'], sessions), [])
})
