import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const session = (id, name) => ({id, name, workspace_id:'w',cli_type:'claude',model:'sonnet',status:'idle',agentState:'idle',pty_alive:true,session_type:'worker',archived:0,tags:[]})
const f = await createTourFixture(browser, {settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/orbit'}],sessions:[session('old','Traffic planning')],messages:{old:[{id:'reply',session_id:'old',role:'assistant',content:'We left off at the traffic model.',created_at:'2026-10-14T09:56:00Z'}]},storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'old',openTabs:['old'],showHome:false},'cc-sidebarVisible':'1'}})
const p=f.page
p.setDefaultTimeout(10000)
let created=0
await f.context.route('**/api/sessions/quick',async route=>{
 const body=route.request().postDataJSON();assert.equal(body.workspace_id,'w');created++
 const s={...session('new','New conversation'),...body};f.data.sessions.push(s);f.data.messages.new=[]
 await route.fulfill({json:s})
})
try {
 await p.goto('http://ive-guide.test/#session-old')
 const sidebar=p.locator('#ive-project-sidebar')
 await sidebar.getByRole('button',{name:'Add project',exact:true}).click()
 await p.getByLabel('What would you like to work on?',{exact:true}).fill('Tour practice')
 await p.getByRole('button',{name:/Tour practice.*git repository/}).click()
 await p.getByRole('button',{name:'Skip for now',exact:true}).click()
 assert.equal(f.data.workspaces.length,2)
 await sidebar.locator('[data-session-id="old"]').getByText('Traffic planning',{exact:true}).click()
 await p.locator('[data-session-view="old"]').waitFor()
 await p.getByText('We left off at the traffic model.',{exact:true}).waitFor()
 await p.locator('.ive-session-composer textarea').fill('Continue from the traffic model')
 await sidebar.locator('[data-sidebar-new-chat]').click()
 await p.getByRole('dialog',{name:'New session',exact:true}).getByRole('button',{name:/Quick chat/}).click()
 assert.equal(await p.getByRole('combobox',{name:'Project',exact:true}).inputValue(),'w')
 await p.getByRole('button',{name:'Start session',exact:true}).click()
 await p.locator('[data-session-view="new"]').waitFor()
 assert.equal(created,1)
 await sidebar.locator('[data-session-id="old"]').getByText('Traffic planning',{exact:true}).click()
 await p.locator('[data-session-view="old"]').waitFor()
 assert.equal(await p.locator('.ive-session-composer textarea').inputValue(),'Continue from the traffic model')
 const sent=p.waitForRequest(r=>r.url().endsWith('/api/sessions/old/input') && r.method()==='POST')
 await p.locator('.ive-session-composer textarea').press('Enter')
 await p.waitForFunction(()=>!document.querySelector('.ive-session-composer textarea')?.value)
 const request=await sent
 assert.equal(request.postDataJSON().message,'Continue from the traffic model')
 assert.ok(!f.writes.some(r=>r.path==='/sessions/new/input'))
 assert.equal(created,1)
 assert.equal(await sidebar.getByText('Review graph',{exact:true}).first().isVisible(),false)
 await sidebar.locator('.ive-sidebar-project-tools').first().locator('summary').click()
 assert.equal(await sidebar.getByText('Review graph',{exact:true}).first().isVisible(),true)
 await sidebar.locator('.ive-sidebar-project-tools').first().locator('summary').click()
 await p.screenshot({path:`packaging/artifacts/overview-chat-20261014/sidebar-${engine}.png`,fullPage:true})
 assert.deepEqual(f.errors,[])
 console.log(JSON.stringify({engine,passed:true,projectAdded:true,newChatCreated:true,continuedOriginalSession:true,draftPreserved:true}))
} finally {await f.context.close();await browser.close()}
