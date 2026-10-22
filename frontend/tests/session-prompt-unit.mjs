import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSessionPermissionPromptFragment, parseSessionPermissionPrompt, submitSessionPromptReply } from '../src/lib/sessionPrompt.js'

const screen = `Earlier assistant output
 Tool use
 worker-board — Get My Task Tool: (MCP)
 task_id: "fixture-task"
 About the worker-board — Get My Task Tool:
 │ Get full details of one of your assigned tasks.

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for worker-board — Get My Task commands in ~/demo
   3. No

 Esc to cancel · Tab to amend
`

const hookScreen = `ToolSearch
──────────────────────────────
│ Hook PreToolUse:ToolSearch requires confirmation for this tool:
│ [Safety Gate] LLM safety classifier provider 'gemini_api' is not configured: missing API key 'api_key_gemini_api' (fail-closed)
settings.json to update hooks

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for ToolSearch commands in /test/project
  3. No

Esc to cancel · Tab to amend`

test('named hook menus show the complete request and all choices', () => {
  const prompt = parseSessionPermissionPrompt(hookScreen)
  assert.deepEqual(prompt.choices.map(choice => choice.value), ['1', '2', '3'])
  assert.match(prompt.excerpt, /^ToolSearch\n/)
  assert.match(prompt.excerpt, /missing API key/)
  assert.equal(isSessionPermissionPromptFragment(hookScreen), false)
  for (const invalid of [hookScreen.replace(/^ToolSearch\n/, ''), hookScreen.replace(/^ToolSearch\n/, 'Read\n'), hookScreen.replace('Hook PreToolUse:ToolSearch', 'Hook PreToolUse:Read')]) {
    assert.equal(parseSessionPermissionPrompt(invalid), null)
    assert.equal(isSessionPermissionPromptFragment(invalid), true)
  }
})

test('current native permission menu preserves one-time and persistent choices', () => {
  const prompt = parseSessionPermissionPrompt(screen)
  assert.equal(prompt.question, 'Do you want to proceed?')
  assert.deepEqual(prompt.choices.map((choice) => choice.value), ['1', '2', '3'])
  assert.equal(prompt.choices[0].label, 'Yes')
  assert.match(prompt.choices[1].label, /don't ask again.*~\/demo/)
  assert.equal(prompt.choices[2].label, 'No')
  assert.match(prompt.excerpt, /Get My Task Tool/)
  assert.match(prompt.excerpt, /fixture-task/)
  assert.doesNotMatch(prompt.excerpt, /Earlier assistant output/)
})

test('wrapped options and styled selectors retain the full choice text', () => {
  const wrapped = screen.replace('commands in ~/demo', 'commands\n      in ~/demo').replace('❯ 1. Yes', '\x1b[32m❯ 1. Yes\x1b[0m')
  assert.match(parseSessionPermissionPrompt(wrapped).choices[1].label, /commands in ~\/demo$/)
})

test('historical menus, ordinary lists and changed prompt layouts do not invent approval buttons', () => {
  for (const value of [
    '', '1. Yes\n2. Yes, always\n3. No',
    screen + '\n❯ Ready for your next message',
    screen.replace('Do you want to proceed?', 'What should we call this project?'),
    screen.replace('3. No', '3. Continue'),
    screen.replace('2. Yes,', '4. Yes,'),
    screen.replace('❯ 1. Yes', '1. Yes'),
    screen.replace('3. No', '❯ 3. No'),
    screen.replace('Esc to cancel · Tab to amend', ''),
  ]) assert.equal(parseSessionPermissionPrompt(value), null, value)
})

test('an explicit choice sends the unchanged screen guard and waits for acknowledgement', async () => {
  const rawScreen = screen.replaceAll('\n', '\r\n')
  let sent, acknowledge, settled = false
  const pending = submitSessionPromptReply('session-a', rawScreen, '1', {
    sendInput: (...args) => { sent = args; return new Promise((resolve) => { acknowledge = resolve }) },
  }).then(() => { settled = true })
  assert.deepEqual(sent, ['session-a', '1', { expected_screen: rawScreen, ready_timeout: 0 }])
  assert.equal(settled, false)
  acknowledge({ ok: true })
  await pending
  assert.equal(settled, true)
})

test('missing snapshots and invented choices never send input', async () => {
  let calls = 0
  const opts = { sendInput: async () => { calls++; return { ok: true } } }
  for (const [snapshot, reply] of [['', '1'], [screen, '4'], ['Unrecognized menu', '1']]) {
    await assert.rejects(submitSessionPromptReply('session-a', snapshot, reply, opts))
  }
  assert.equal(calls, 0)
})

test('stale and partial failures propagate once without automatic resubmission', async () => {
  for (const partial of [false, true]) {
    let calls = 0
    const stale = Object.assign(new Error('Request changed'), { status: 409, body: { code: 'stale_session_prompt', partial } })
    await assert.rejects(submitSessionPromptReply('session-a', screen, '1', {
      sendInput: async () => { calls++; throw stale },
    }), (error) => error === stale)
    assert.equal(calls, 1)
  }
})

test('unknown questions support only explicit guarded single-line manual replies', async () => {
  let sent
  await submitSessionPromptReply('session-a', 'What should this project be called?', 'Demo', {
    manual: true,
    sendInput: async (...args) => { sent = args; return { ok: true } },
  })
  assert.deepEqual(sent, ['session-a', 'Demo', { expected_screen: 'What should this project be called?', ready_timeout: 0, prompt_reply: true }])
  for (const reply of ['first\nsecond', 'escape\x1bkey', 'x'.repeat(2001)]) {
    await assert.rejects(submitSessionPromptReply('session-a', 'Question?', reply, {
      manual: true, sendInput: () => assert.fail('unsafe control input must never be sent'),
    }), /single line/)
  }
})

test('an unacknowledged or intercepted reply is not marked accepted', async () => {
  for (const result of [null, { ok: false }, { ok: true, intercepted: true }]) {
    await assert.rejects(submitSessionPromptReply('session-a', screen, '3', { sendInput: async () => result }), /did not accept/)
  }
})

test('a clipped permission menu has no approval choices or manual reply fallback', async () => {
  const clipped = screen.slice(screen.indexOf(' task_id:'))
  assert.equal(parseSessionPermissionPrompt(clipped), null)
  assert.equal(isSessionPermissionPromptFragment(clipped), true)
  for (const manual of [false, true]) {
    await assert.rejects(submitSessionPromptReply('session-a', clipped, '1', {
      manual, sendInput: () => assert.fail('a clipped permission request must not send input'),
    }), /permission request is incomplete/)
  }
})

test('a long current frame retains the tool header and complete request body', () => {
  const longScreen = screen.replace(' task_id:', `${Array.from({ length: 65 }, (_, index) => ` payload line ${index}`).join('\n')}\n task_id:`)
  const full = parseSessionPermissionPrompt(longScreen)
  assert.match(full.excerpt, /^Tool use/)
  assert.match(full.excerpt, /payload line 0/)
  assert.match(full.excerpt, /payload line 64/)
  const clipped = longScreen.split('\n').slice(-40).join('\n')
  assert.equal(parseSessionPermissionPrompt(clipped), null)
  assert.equal(isSessionPermissionPromptFragment(clipped), true)
})

test('permission fragments remain blocked while ordinary questions keep manual replies', () => {
  assert.equal(isSessionPermissionPromptFragment(screen.slice(screen.indexOf(' ❯ 1. Yes'))), true)
  assert.equal(isSessionPermissionPromptFragment(screen.replace('3. No', '3. Unexpected choice')), true)
  assert.equal(isSessionPermissionPromptFragment('What should this project be called?'), false)
  assert.equal(isSessionPermissionPromptFragment(screen), false)
})
