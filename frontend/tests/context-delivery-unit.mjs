import assert from 'node:assert/strict'
import { test } from 'node:test'
import { submitSessionContext } from '../src/lib/contextDelivery.js'

test('context waits for backend acknowledgement and preserves automation tokens as text', async () => {
  let acknowledge, received, finished = false
  const pending = submitSessionContext('s', 'Explain @ralph and @research; do not start them.', {
    ensureRunning: async () => true,
    sendInput: (...args) => { received = args; return new Promise((resolve) => { acknowledge = resolve }) },
  }).then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  assert.deepEqual(received, ['s', 'Explain @ralph and @research; do not start them.', { ready_timeout: 30 }])
  acknowledge({ ok: true }); await pending
  assert.equal(finished, true)
})

test('a failed start does not submit context', async () => {
  await assert.rejects(submitSessionContext('s', 'Keep my note', {
    ensureRunning: async () => false,
    sendInput: () => assert.fail('must not send'),
  }), /could not be started/)
})

test('rejection and intercepted input never report context delivered', async () => {
  for (const result of [null, { ok: false }, { ok: true, intercepted: true }]) {
    await assert.rejects(submitSessionContext('s', 'note', { ensureRunning: async () => true, sendInput: async () => result }), /not accepted/)
  }
  const busy = new Error('Agent is still generating')
  await assert.rejects(submitSessionContext('s', 'note', { ensureRunning: async () => true, sendInput: async () => { throw busy } }), (err) => err === busy)
})
