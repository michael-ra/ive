import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectTerminalAttention, attentionDetails, handleAttentionEvent, taskAttention } from '../src/lib/sessionAttention.js'
import { getSessionStatusMeta } from '../src/lib/sessionStatus.js'

const prompt = `[Safety Gate] provider 'gemini_api' is not configured: missing API key
Do you want to proceed?
❯ 1. Yes
2. No
Esc to cancel · Tab to amend`

test('only the live footer creates attention, including old stripped output', () => {
  assert.equal(detectTerminalAttention(prompt).kind, 'configuration')
  assert.equal(detectTerminalAttention(prompt.replace(/\s/g, '')).kind, 'configuration')
  assert.equal(detectTerminalAttention(prompt + '\nInterrupted · What should Claude do instead?\n❯\nauto mode on'), null)
  assert.equal(detectTerminalAttention(prompt + '\nWorking... esc to interrupt'), null)
  assert.equal(detectTerminalAttention('ordinary question in completed output?'), null)
})
test('waiting is never hidden by a stale working state', () => {
  assert.deepEqual([getSessionStatusMeta('waiting', 'working').label, getSessionStatusMeta('waiting', 'working').state], ['Waiting', 'waiting'])
  assert.deepEqual([getSessionStatusMeta('auth_failed', 'prompting').label, getSessionStatusMeta('auth_failed', 'prompting').state], ['Failed', 'failed'])
  assert.deepEqual([getSessionStatusMeta('exited', 'prompting').label, getSessionStatusMeta('exited', 'prompting').state], ['Stopped', 'stopped'])
  assert.equal(getSessionStatusMeta('auth_failed').tone, 'auth', 'the finer tone survives for older callers')
})
test('native permission hooks and completion update attention without approving', () => {
  const calls = [], store = { sessions: { test: { status: 'running' } }, setSessionAttention: (...args) => calls.push(args) }
  handleAttentionEvent(store, 'test', { type: 'permission_event', phase: 'request', tool_name: 'Bash' })
  assert.equal(calls[0][1].title, 'Permission needed')
  handleAttentionEvent(store, 'test', { type: 'session_state', state: 'working' })
  assert.equal(calls[1][1], null)
  store.sessions.test.status = 'auth_failed'
  handleAttentionEvent(store, 'test', { type: 'permission_event', phase: 'request' })
  assert.equal(calls.length, 2)
  assert.equal(attentionDetails({ message: 'Which project?' }).title, 'Your answer is needed')
})
test('attention mirrors the backend question fields and stays stable for terminal detection', () => {
  const details = attentionDetails({ tool_name: 'Bash', tool_input: { command: 'ls', content: 'y'.repeat(1000), nested: { a: 1 } },
    options: [{ num: 1, text: 'Yes' }], actions: [{ label: 'Allow', key: 'enter', style: 'primary' }], notification_type: 'permission_prompt', asked_at: 12.5 })
  assert.equal(details.kind, 'permission')
  assert.deepEqual(details.options, [{ num: 1, text: 'Yes' }])
  assert.equal(details.actions[0].key, 'enter')
  assert.equal(details.notification_type, 'permission_prompt')
  assert.equal(details.asked_at, 12.5)
  assert.equal(details.tool_input.command, 'ls')
  assert.equal(details.tool_input.content.length, 240)
  assert.equal(details.tool_input.nested, '{"a":1}')
  assert.deepEqual(attentionDetails({ message: 'x' }).options, [])
  assert.equal(attentionDetails({ message: 'x' }).tool_input, null)
  assert.equal(attentionDetails({ message: 'x' }).asked_at, null)
  assert.deepEqual(detectTerminalAttention(prompt), detectTerminalAttention(prompt), 'polling compares snapshots byte for byte')
  const calls = [], store = { sessions: { s: { status: 'running' } }, setSessionAttention: (...args) => calls.push(args) }
  handleAttentionEvent(store, 's', { type: 'session_state', state: 'prompting', message: 'Pick one', options: [{ num: 1, text: 'A' }] })
  assert.ok(typeof calls[0][1].asked_at === 'number' && calls[0][1].asked_at > 1e9, 'live events are stamped when they arrive')
  assert.equal(calls[0][1].options.length, 1)
})
test('a startup blocker also needs the user', async () => {
  const { sessionNeedsAttention } = await import('../src/lib/sessionAttention.js')
  assert.equal(sessionNeedsAttention({ status: 'idle', startup_blocker: { type: 'trust_required' } }), true)
  assert.equal(sessionNeedsAttention({ status: 'idle' }), false)
})
test('human approval gates appear even while the task itself is in progress', () => {
  const task = { id: 'task', status: 'in_progress' }
  const run = { task_id: task.id, status: 'paused', current_stages: ['execute'], stage_history: { execute: { output_summary: 'waiting_for_command_approval:check' } } }
  assert.equal(taskAttention(task, [run]).title, 'Command approval needed')
  assert.equal(taskAttention(task, [{ ...run, status: 'running' }]), null)
  assert.equal(taskAttention({ ...task, status: 'review' }).title, 'Result ready for review')
})
