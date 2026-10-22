import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interruptPhoneSession, phoneApplyFeedback, phoneControlReason, phoneInterruptBytes, phoneSessionPatch, savePhoneSession } from '../src/components/mobile/phoneControlActions.js'

const session = { id: 'fixture-agent', name: 'Agent', cli_type: 'claude', model: 'sonnet', effort: '', permission_mode: 'default', pty_alive: true }
const access = { connected: true, auth: { actor_kind: 'owner_device', mode: 'full' } }
const options = { model: [{ value: 'sonnet' }, { value: 'opus' }], effort: [{ value: '' }, { value: 'high' }], permission_mode: [{ value: 'default' }, { value: 'plan' }] }

test('mobile controls respect read-only, archive, disconnected and restricted access', async () => {
  const cases = [[null, access], [{ ...session, read_only: true }, access], [{ ...session, archived: true }, access], [{ ...session, is_external: true }, access], [session, { ...access, connected: false }], [session, { ...access, auth: null }], [session, { ...access, auth: { mode: 'brief' } }], [session, { ...access, auth: { mode: 'unknown' } }]]
  let calls = 0
  const api = { sendSessionInput: async () => { calls++ }, updateSession: async () => { calls++ } }
  for (const [target, state] of cases) {
    assert.ok(phoneControlReason(target, state))
    await assert.rejects(interruptPhoneSession(api, target, state))
    await assert.rejects(savePhoneSession(api, target, session, options, state))
  }
  assert.equal(calls, 0)
  assert.equal(phoneControlReason(session, access), '')
})

test('interrupt sends one raw CLI-aware key to the exact session and requires acknowledgment', async () => {
  const calls = []
  const api = { sendSessionInput: async (...args) => { calls.push(args); return { ok: true, session_id: session.id } } }
  await interruptPhoneSession(api, session, access)
  assert.deepEqual(calls, [[session.id, '\x1b', { raw: true }]])
  assert.equal(phoneInterruptBytes({ cli_type: 'codex' }), '\x1b')
  assert.equal(phoneInterruptBytes({ cli_type: 'gemini' }), '\x03')
  assert.equal(phoneInterruptBytes({ cli_type: 'shell' }), '\x03')
  await assert.rejects(interruptPhoneSession(api, { ...session, pty_alive: false }, access))
  for (const result of [{}, { ok: false }, { ok: true, session_id: 'other' }]) await assert.rejects(interruptPhoneSession({ sendSessionInput: async () => result }, session, access))
  await assert.rejects(interruptPhoneSession({ sendSessionInput: async () => { throw new Error('PIN required') } }, session, access), /PIN required/)
})

test('model, effort and permissions are confirmed together in a single live update', async () => {
  const draft = { ...session, model: 'opus', effort: 'high', permission_mode: 'plan' }
  const calls = []
  const result = await savePhoneSession({ updateSession: async (id, patch) => { calls.push({ id, patch }); return { ...session, ...patch, launch_apply: { model: { state: 'pending' } } } } }, session, draft, options, access)
  assert.deepEqual(calls, [{ id: session.id, patch: { model: 'opus', effort: 'high', permission_mode: 'plan', apply_live: true } }])
  assert.equal(phoneApplyFeedback(result.launch_apply).tone, 'pending')
})

test('unavailable CLI settings never reach the API and shell rename never sends agent configuration', async () => {
  const api = { updateSession: async () => assert.fail('invalid choice must not reach API') }
  await assert.rejects(savePhoneSession(api, session, { ...session, model: 'made-up' }, options, access))
  await assert.rejects(savePhoneSession(api, session, { ...session, name: ' ' }, options, access))
  assert.deepEqual(phoneSessionPatch({ ...session, cli_type: 'shell' }, { ...session, name: 'Build shell', model: 'opus', permission_mode: 'plan' }, options), { name: 'Build shell' })
  assert.deepEqual(phoneSessionPatch(session, session, options), {})
})

test('failed or mismatched save never announces an applied setting', async () => {
  const draft = { ...session, model: 'opus' }
  for (const result of [{}, { ...session, id: 'other' }]) await assert.rejects(savePhoneSession({ updateSession: async () => result }, session, draft, options, access))
  await assert.rejects(savePhoneSession({ updateSession: async () => { throw new Error('Mode-blocked') } }, session, draft, options, access), /Mode-blocked/)
  for (const state of ['failed', 'error', 'unsupported']) assert.equal(phoneApplyFeedback({ model: { state } }).tone, 'error')
  assert.equal(phoneApplyFeedback({ model: { state: 'saved' } }).tone, 'saved')
  assert.equal(phoneApplyFeedback({ model: { state: 'applying' } }).tone, 'pending')
  assert.equal(phoneApplyFeedback({ model: { state: 'applied' } }).tone, 'applied')
})
