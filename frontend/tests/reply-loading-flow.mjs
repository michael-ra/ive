import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'chromium'
const browser=await (engine==='webkit'?webkit:chromium).launch()
const session=id=>({id,name:id,workspace_id:'w',cli_type:'claude',model:'sonnet',status:'idle',agentState:'idle',pty_alive:true,session_type:'worker',archived:0,tags:[]})
const f=await createTourFixture(browser,{settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/orbit'}],sessions:[session('s'),session('other')],messages:{s:[{id:'old',session_id:'s',role:'assistant',content:'An earlier answer.',created_at:'2020-01-01T00:00:00Z'}]},storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s',openTabs:['s','other'],showHome:false},'cc-sidebarVisible':'1'}})
const p=f.page;p.setDefaultTimeout(10000)
let release, held=false
await f.context.route('**/api/sessions/s/input',async route=>{
 held=true; await new Promise(resolve=>{release=resolve})
 await route.fulfill({json:{ok:true,state:'sent',session_id:'s'}})
})
try {
 await p.goto('http://ive-guide.test/#session-s')
 await p.getByText('An earlier answer.',{exact:true}).waitFor()
 const input=p.locator('.ive-session-composer textarea');await input.fill('Check the traffic model')
 await input.press('Enter')
 await p.locator('[data-awaiting-reply]').waitFor({timeout:1000})
 // No HTTP acknowledgement yet. Polling only sees the old assistant answer.
 await p.waitForTimeout(9000)
 assert.ok(held);assert.equal(await p.locator('[data-awaiting-reply]').isVisible(),true)
 const sidebar=p.locator('#ive-project-sidebar')
 await sidebar.locator('[data-session-id="other"]').getByText('other',{exact:true}).click()
 assert.equal(await p.locator('[data-awaiting-reply]').count(),0)
 await sidebar.locator('[data-session-id="s"]').getByText('s',{exact:true}).click()
 await p.locator('[data-awaiting-reply]').waitFor()
 release(); await p.waitForTimeout(200)
 f.data.messages.s.push({id:'thinking',session_id:'s',role:'assistant',content:'[{"type":"thinking","thinking":"Checking"}]',created_at:new Date().toISOString()})
 f.controls.setSessionStatus('s','running')
 await p.waitForTimeout(1800)
 assert.equal(await p.locator('[data-awaiting-reply]').isVisible(),true)
 await p.screenshot({path:`packaging/artifacts/reply-loading-20261014/waiting-${engine}.png`})
 f.controls.reply('s','Here is the first part of the new answer.')
 await p.getByText('Here is the first part of the new answer.',{exact:true}).waitFor()
 await p.locator('[data-awaiting-reply]').waitFor({state:'hidden'})
 // A failed request stops the feedback and restores the input.
 await f.context.unroute('**/api/sessions/s/input')
 f.controls.failInput=true
 await input.fill('Retry test');await input.press('Enter')
 await p.locator('[data-awaiting-reply]').waitFor({state:'hidden'})
 await p.waitForFunction(()=>document.querySelector('.ive-session-composer textarea')?.value==='Retry test')
 f.controls.failInput=false
 await input.fill('Cancel test');await input.press('Enter')
 await p.locator('[data-awaiting-reply]').waitFor()
 await p.getByRole('button',{name:'Cancel',exact:true}).click()
 await p.locator('[data-awaiting-reply]').waitFor({state:'hidden'})
 assert.deepEqual(f.errors,[])
 console.log(JSON.stringify({engine,passed:true,instant:true,survivesOldReplyAndNineSeconds:true,survivesViewSwitch:true,endsOnNewReply:true,endsOnErrorAndCancel:true}))
}finally{release?.();await f.context.close();await browser.close()}
