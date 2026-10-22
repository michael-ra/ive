import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageOnceFilter } from '../src/lib/usageOnce.js'

const usage = { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 2000 }

test('rows of one API message count once by id', () => {
  const once = createUsageOnceFilter()
  const rows = [
    { api_message_id: 'msg_1', usage }, { api_message_id: 'msg_1', usage }, { api_message_id: 'msg_1', usage },
    { role: 'user' },
    { api_message_id: 'msg_2', usage }, { api_message_id: 'msg_2', usage },
  ]
  assert.equal(rows.filter((r) => r.usage && once(r)).length, 2)
})

test('without ids, identical consecutive usage counts once', () => {
  const once = createUsageOnceFilter()
  const other = { ...usage, output_tokens: 7 }
  const rows = [{ usage }, { usage: { ...usage } }, { usage: other }, { usage }]
  assert.deepEqual(rows.map(once), [true, false, true, true])
})
