import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityLabel, hasVisibleMessage, permissionPresentation } from '../src/lib/conversationPresentation.js'
import { parseSessionPermissionPrompt, submitSessionPromptReply } from '../src/lib/sessionPrompt.js'
import { promptChoices } from '../src/lib/sessionPrompt.js'

const two = `Bash command
Find Orbit and traffic projects
────────────────────────────────
ls -d */ Projects/*/ | grep -i 'orbit|traffic'
Safety check not configured: missing API key 'api_key_gemini_api' (fail-closed)
Do you want to proceed?
 ❯ 1. Yes
   2. No

Esc to cancel · Tab to amend`

test('two-choice permission exposes native refusal, not persistent approval', async () => {
  const prompt = parseSessionPermissionPrompt(two)
  assert.deepEqual(prompt.choices.map(c=>c.value), ['1','2'])
  assert.deepEqual(promptChoices({prompt}).allowSession, null)
  assert.equal(promptChoices({prompt}).deny, '2')
  const display=permissionPresentation(prompt)
  assert.equal(display.description, 'Find Orbit and traffic projects')
  assert.match(display.notice, /safety check needs setup/i)
  assert.deepEqual(display.choices.map(c=>c.label), ['Allow once', 'Don’t allow'])
  let sent
  await submitSessionPromptReply('s',two,'2',{sendInput:async (...args)=>{sent=args;return {ok:true}}})
  assert.deepEqual(sent,['s','2',{expected_screen:two,ready_timeout:0}])
})
test('incomplete and historical two-choice requests never expose approval', () => {
  for(const value of [two.slice(two.indexOf('Safety check')),two+'\n❯ new prompt',two.replace('2. No','2. Yes, always'),two.replace(' ❯','  ')]) assert.equal(parseSessionPermissionPrompt(value),null)
})
test('persistent scope stays verbatim and separate from one-time consent', () => {
  const prompt=parseSessionPermissionPrompt(two.replace('2. No',"2. Yes, and don't ask again in /production\n   3. No"))
  assert.equal(promptChoices({prompt}).deny,'3')
  const display=permissionPresentation(prompt)
  assert.equal(display.choices[1].label,"Yes, and don't ask again in /production")
  assert.equal(display.choices[1].kind,'persistent')
})
test('activity summaries do not expose shell commands or tool payloads', () => {
  const steps=[{type:'tool_execution',tool_use:{name:'Bash',input:{command:'cat secret.env'}}}]
  assert.equal(activityLabel(steps,true),'Running a project command')
  assert.equal(activityLabel(steps,false),'Activity · 1 step')
  steps[0].tool_use.input.description='Find project folders'
  assert.equal(activityLabel(steps,true),'Find project folders')
})
test('empty thinking disappears while user content and attachments remain', () => {
  for(const content of [[{type:'thinking',thinking:''}],JSON.stringify([{type:'thinking',thinking:''}]),'']) assert.equal(hasVisibleMessage(content),false)
  for(const content of ['0','false','null','Hello',[{type:'image',source:{url:'/image.png'}}],[{type:'thinking',thinking:''},{type:'text',text:'Ready'}]]) assert.equal(hasVisibleMessage(content),true)
})
