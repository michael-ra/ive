import assert from 'node:assert/strict'
import { beginReplyWait, hasNewReply } from '../src/lib/replyPending.js'
const old = { id: 'old', role: 'assistant', content: 'Old answer', created_at: '2020-01-01T00:00:00Z' }
const prompt = { id: 'local', role: 'user', content: 'New question' }
const wait = beginReplyWait(prompt, [old], 10000)
assert.equal(hasNewReply(wait, [old]), false)
assert.equal(hasNewReply(wait, [old, prompt]), false)
for (const content of ['', '[{"type":"thinking","thinking":"Reasoning"}]', '[{"type":"tool_use","name":"Bash"}]']) {
  assert.equal(hasNewReply(wait, [old, prompt, { id:'new', role:'assistant', content }]), false)
}
assert.equal(hasNewReply(wait, [old, prompt, { id:'new', role:'assistant', content:'42' }]), true)
assert.equal(hasNewReply(wait, [old, { id:'history', role:'assistant', content:'Older history', created_at:'1970-01-01T00:00:01Z' }]), false)
assert.equal(hasNewReply(wait, [old, { id:'new', role:'assistant', content:'New answer', created_at:'1970-01-01T00:00:11Z' }]), true)
assert.equal(hasNewReply(wait, [old, { id:'echo', role:'user', content:'New question' }, { id:'new', role:'assistant', content:'[{"type":"text","text":"First streamed words"}]' }]), true)
console.log('Reply wait: stale history, empty/thinking/tool blocks, user echo, numeric and streaming replies passed.')
