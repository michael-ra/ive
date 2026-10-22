import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const out = new URL('../../packaging/artifacts/overview-chat-20261014/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const two = `Bash command
Find Orbit and traffic projects
──────────────────────────────
ls -d */ Projects/*/ | grep -i 'orbit|traffic'
Safety check not configured: missing API key 'api_key_gemini_api' (fail-closed)
Do you want to proceed?
 ❯ 1. Yes
   2. No

Esc to cancel · Tab to amend`
let count = 0
async function fixture(screen = two, theme = 'light', width = 1440, expectLoading = false) {
 const f=await createTourFixture(browser,{width,height:960,theme,settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/orbit'}],sessions:[{id:'s',workspace_id:'w',name:'Orbit traffic software',cli_type:'claude',model:'sonnet',permission_mode:'auto',status:'waiting',agentState:'waiting',pty_alive:true,session_type:'worker',archived:0,tags:[],attention:{kind:'permission',title:'Permission needed'}}],storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s',openTabs:['s'],showHome:false,activeNavGroup:'work'},'ive.grid-session-views':{s:'chat'},'cc-gridColumns':'1'},messages:{s:[
 {id:'user',session_id:'s',role:'user',content:'Find the Orbit traffic project and help me continue working on it.',created_at:'2026-10-14T09:56:00Z'},
 {id:'empty',session_id:'s',role:'assistant',content:JSON.stringify([{type:'thinking',thinking:''}]),created_at:'2026-10-14T09:56:01Z'},
 {id:'reply',session_id:'s',role:'assistant',content:'I’ll find the project folder and check where you left off.',created_at:'2026-10-14T09:56:02Z'},
 {id:'tools',session_id:'s',role:'assistant',content:JSON.stringify([{type:'tool_use',name:'Bash',id:'t1',input:{command:'ls -d */ Projects/*/',description:'Find Orbit and traffic projects'}},{type:'tool_use',name:'mcp__worker-board__search_memory',id:'t2',input:{query:'orbit traffic software'}}]),created_at:'2026-10-14T09:56:03Z'},
 ]}})
 f.promptScreen=screen;f.inputs=[];f.reject=false
 await f.context.route('**/api/sessions/s/output**',route=>route.fulfill({json:{screen:f.promptScreen,text:'OLD HISTORICAL OUTPUT MUST NOT BE USED'}}))
 await f.context.route('**/api/sessions/s/input',async route=>{const body=route.request().postDataJSON();f.inputs.push(body);assert.equal(body.expected_screen,f.promptScreen);if(f.reject){f.promptScreen=two.replace('Find Orbit and traffic projects','Read a different project');return route.fulfill({status:409,json:{error:'The question changed.',code:'stale_session_prompt'}})}return route.fulfill({json:{ok:true}})})
 await f.page.goto('http://ive-guide.test/#board')
 await f.page.locator('[data-session-prompt-actions]').waitFor()
 if (expectLoading) await f.page.locator('[data-request-loading]').waitFor()
 else await f.page.getByRole('heading',{name:screen===two?'Allow this action?':/Allow|Your answer/}).waitFor()
 return f
}
try {
 for(const [theme,width] of [['light',1440],['dark',1440],['light',390]]) {
  const f=await fixture(two,theme,width);const p=f.page
  assert.equal(await p.locator('[data-chat-message-id="empty"]').count(),0)
  assert.equal(await p.locator('.ive-conversation-activity pre').count(),0)
  assert.equal(await p.locator('.ive-conversation-history').count(),0)
  assert.equal(await p.getByRole('button',{name:'Allow once',exact:true}).count(),1)
  assert.equal(await p.getByRole('button',{name:'Don’t allow',exact:true}).count(),1)
  assert.equal(await p.locator('.ive-chat-request-details pre').isVisible(),false)
  assert.equal(await p.locator('.ive-chat-question-notice').isVisible(),true)
  await p.locator('.ive-session-composer textarea').click()
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await p.screenshot({path:`${out}overview-${engine}-${theme}-${width}.png`,fullPage:true})
  if (width === 1440) {
   await p.getByRole('button',{name:'History',exact:true}).click()
   assert.equal(await p.locator('.ive-conversation-history').isVisible(),true)
   await p.locator('.ive-conversation-history button').filter({hasText:/Calling tool/}).last().click()
   assert.equal(await p.locator('.ive-conversation-process').isVisible(),true)
   await p.getByRole('button',{name:'History',exact:true}).click()
   await p.getByRole('button',{name:'Details',exact:true}).click()
   await p.locator('.ive-conversation-activity pre').first().waitFor()
   assert.equal(await p.locator('.ive-conversation-activity-toggle').getAttribute('aria-expanded'),'true')
   await p.getByRole('button',{name:'Details',exact:true}).click()
   await p.locator('.ive-conversation-activity pre').first().waitFor({state:'hidden'})
   assert.equal(await p.locator('.ive-conversation-activity pre').count(),0)
  }
  await p.getByRole('button',{name:'Allow once',exact:true}).click()
  await p.getByRole('heading',{name:'Reply sent',exact:true}).waitFor()
  assert.equal(f.inputs.length,1);assert.equal(f.inputs[0].message,'1')
  assert.equal(f.errors.length,0);count++;await f.context.close()
 }
 const deny=await fixture();await deny.page.getByRole('button',{name:'Don’t allow',exact:true}).click();await deny.page.getByRole('heading',{name:'Reply sent',exact:true}).waitFor();assert.equal(deny.inputs[0].message,'2');count++;await deny.context.close()
 const three=await fixture(two.replace('2. No',"2. Yes, and don't ask again for commands in /project\n   3. No"));await three.page.getByRole('button',{name:'Don’t allow',exact:true}).click();await three.page.getByRole('heading',{name:'Reply sent',exact:true}).waitFor();assert.equal(three.inputs[0].message,'3');count++;await three.context.close()
 const stale=await fixture();stale.reject=true;await stale.page.getByRole('button',{name:'Allow once',exact:true}).click();await stale.page.getByRole('alert').filter({hasText:'request changed'}).waitFor();assert.equal(stale.inputs.length,1);await stale.page.getByText('Read a different project',{exact:true}).waitFor();count++;await stale.context.close()
 const clipped=await fixture(two.slice(two.indexOf('Safety check')), 'light', 1440, true)
 assert.equal(await clipped.page.getByRole('button',{name:'Allow once',exact:true}).count(),0)
 assert.equal(await clipped.page.locator('.ive-chat-question-reply').count(),0)
 assert.equal(await clipped.page.getByRole('button',{name:'Open terminal to review',exact:true}).count(),0)
 assert.equal(await clipped.page.getByText('Loading request…',{exact:true}).isVisible(),true)
 assert((await clipped.page.locator('[data-request-loading]').boundingBox()).height < 70)
 await clipped.page.screenshot({path:`${out}loading-${engine}.png`,fullPage:true})
 await clipped.page.getByRole('button',{name:'Retry',exact:true}).waitFor({timeout:12000})
 assert.equal(await clipped.page.getByText('The request is taking longer than expected.',{exact:true}).isVisible(),true)
 assert.equal(clipped.inputs.length,0)
 clipped.promptScreen=two
 await clipped.page.getByRole('button',{name:'Allow once',exact:true}).waitFor()
 assert.equal(await clipped.page.locator('[data-request-loading]').count(),0)
 assert.equal(await clipped.page.locator('[data-board-screen]').count(),1)
 await clipped.page.getByRole('button',{name:'Allow once',exact:true}).click()
 await clipped.page.getByRole('heading',{name:'Reply sent',exact:true}).waitFor()
 assert.equal(clipped.inputs.length,1)
 count++;await clipped.context.close()
 const empty=await fixture('', 'light', 390, true)
 assert.equal(await empty.page.getByRole('alert').count(),0)
 empty.promptScreen=two
 await empty.page.getByRole('button',{name:'Don’t allow',exact:true}).waitFor()
 assert.equal(await empty.page.locator('[data-request-loading]').count(),0)
 count++;await empty.context.close()
 const recovery=await fixture('', 'light', 1440, true)
 let readFailed=true
 await recovery.context.route('**/api/sessions/s/output**',route=>readFailed
   ? route.fulfill({status:503,json:{error:'Temporary request read failure'}})
   : route.fulfill({json:{screen:two,text:''}}))
 await recovery.page.getByRole('alert').filter({hasText:'Temporary request read failure'}).waitFor()
 readFailed=false
 await recovery.page.getByRole('button',{name:'Allow once',exact:true}).waitFor()
 assert.equal(await recovery.page.getByRole('alert').count(),0)
 assert.equal(recovery.inputs.length,0)
 count++;await recovery.context.close()
 const manual=await fixture('What should this project be called?\n>');await manual.page.getByLabel('Your reply',{exact:true}).fill('Orbit');await manual.page.getByRole('button',{name:'Send reply',exact:true}).click();await manual.page.getByRole('heading',{name:'Reply sent',exact:true}).waitFor();assert.equal(manual.inputs[0].message,'Orbit');assert.equal(manual.inputs[0].prompt_reply,true);count++;await manual.context.close()
 const hook=await fixture(`ToolSearch
──────────────────────────────
│ Hook PreToolUse:ToolSearch requires confirmation for this tool:
│ [Safety Gate] LLM safety classifier provider 'gemini_api' is not configured: missing API key 'api_key_gemini_api' (fail-closed)
settings.json to update hooks
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for ToolSearch commands in /test/project
  3. No

Esc to cancel · Tab to amend`)
 assert.equal(await hook.page.getByRole('button',{name:'Open terminal to review',exact:true}).count(),0)
 assert.equal(await hook.page.getByRole('button',{name:'Allow once',exact:true}).count(),1)
 assert.equal(await hook.page.getByRole('button',{name:"Yes, and don't ask again for ToolSearch commands in /test/project",exact:true}).count(),1)
 assert.equal(await hook.page.locator('.ive-chat-question-notice').isVisible(),true)
 await hook.page.getByText('View exact request',{exact:true}).click()
 assert.match(await hook.page.locator('.ive-chat-request-details pre').innerText(),/missing API key/)
 await hook.page.screenshot({path:`${out}toolsearch-${engine}.png`,fullPage:true})
 await hook.page.getByRole('button',{name:'Don’t allow',exact:true}).click()
 await hook.page.getByRole('heading',{name:'Reply sent',exact:true}).waitFor()
 assert.equal(hook.inputs.length,1);assert.equal(hook.inputs[0].message,'3')
 assert.equal(hook.errors.length,0);count++;await hook.context.close()
 console.log(JSON.stringify({engine,passed:count}))
} finally {await browser.close()}
