import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'chromium'
const browser=await (engine==='webkit'?webkit:chromium).launch()
const f=await createTourFixture(browser,{settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Test project',path:'/isolated/project'}],sessions:[{id:'s',name:'Shared mode test',workspace_id:'w',cli_type:'claude',permission_mode:'default',model:'sonnet',status:'waiting',agentState:'waiting',pty_alive:true,session_type:'worker',archived:0,tags:[]}],messages:{s:[{id:'old',session_id:'s',role:'assistant',content:'Permission mode test.',created_at:'2020-01-01T00:00:00Z'}]},storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s',openTabs:['s'],showHome:false},'cc-sidebarVisible':'1'}})
let snapshot={state:'none'},socket,applies=0
const updates=[], terminalInput=[]
await f.context.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(raw=>terminalInput.push(String(raw)))})
await f.context.route('**/api/sessions/s/permission-mode/apply',route=>route.fulfill({json:snapshot}))
// API names intentionally match the actual client, including explicit apply.
await f.context.route('**/api/sessions/s/permission-mode/apply-now',async route=>{
 applies++;snapshot={session_id:'s',state:'none'}
 socket.send(JSON.stringify({type:'permission_mode_apply',session_id:'s',state:'applied',mode:'bypassPermissions'}))
 await route.fulfill({json:{state:'applied',mode:'bypassPermissions'}})
})
await f.context.route('**/api/sessions/s',async route=>{
 if(route.request().method()!=='PUT')return route.fallback()
 const patch=route.request().postDataJSON();updates.push(patch)
 const current=snapshot.from||f.data.sessions[0].permission_mode
 snapshot={session_id:'s',state:'pending',from:current,mode:patch.permission_mode}
 Object.assign(f.data.sessions[0],patch)
 await route.fulfill({json:{...f.data.sessions[0],permission_apply:snapshot}})
})
const p=f.page;p.setDefaultTimeout(10000)
try{
 await p.goto('http://ive-guide.test/#session-s')
 const overview=p.getByTestId('perms'),ovValue=p.getByTestId('perms-value')
 await overview.waitFor()
 await overview.getByRole('button').click()
 await p.getByTestId('perms-menu').getByRole('button',{name:'Skip agent approvals',exact:false}).click()
 await p.getByTestId('perms-pending').waitFor()
 assert.match(await ovValue.innerText(),/Default.*change pending/i)
 assert.match(await p.getByTestId('perms-menu').innerText(),/Additional IVE checks remain separate/)
 assert.match(await p.getByTestId('perms-menu').innerText(),/Answer the current request first/)
 assert.equal(updates[0].apply_live,true)
 await p.keyboard.press('Escape')
 await p.getByTitle('Toggle PTY Terminal Drawer',{exact:true}).click()
 const term=p.getByTestId('terminal-perms'),termValue=p.getByTestId('terminal-perms-value')
 await term.waitFor()
 assert.match(await termValue.innerText(),/Default.*change pending/i)
 await term.getByRole('button').click()
 await p.getByTestId('terminal-perms-menu').getByRole('button',{name:'Interrupt & apply',exact:true}).click()
 await p.waitForFunction(()=>document.querySelector('[data-testid="perms-value"]')?.textContent==='Skip agent approvals')
 assert.equal(await termValue.innerText(),'Skip agent approvals')
 assert.equal(applies,1)
 // A terminal selection also applies live, with the same old/new state.
 await p.getByTestId('terminal-perms-menu').getByRole('button',{name:'Plan',exact:false}).click()
 await p.getByTestId('terminal-perms-pending').waitFor()
 assert.equal(updates.at(-1).apply_live,true)
 assert.equal(updates.at(-1).permission_mode,'plan')
 snapshot={session_id:'s',state:'failed',from:'bypassPermissions',mode:'plan',error:'Test restart failed'}
 socket.send(JSON.stringify({type:'permission_mode_apply',...snapshot}))
 await p.waitForFunction(()=>document.querySelector('[data-testid="perms-value"]')?.textContent==='Change failed')
 assert.equal(await termValue.innerText(),'Change failed')
 assert.match(await p.getByTestId('terminal-perms-menu').innerText(),/Test restart failed/)
 await p.screenshot({path:`packaging/artifacts/reply-loading-20261014/shared-mode-${engine}.png`})
 await p.keyboard.press('Escape')
 const count=updates.length
 await p.locator('.xterm-helper-textarea').focus()
 await p.keyboard.press('Shift+Tab')
 await p.waitForFunction(()=>document.querySelector('[data-testid="terminal-perms-pending"]'))
 assert.equal(updates.length,count+1)
 assert.equal(updates.at(-1).apply_live,true)
 assert.equal(terminalInput.some(raw=>raw.includes('\\u001b[Z')),false)
 assert.deepEqual(f.errors,[])
 console.log(JSON.stringify({engine,passed:true,sameModeInBothViews:true,appliesLive:true,waitingKeepsOldMode:true,explicitInterrupt:true,failureShown:true}))
} finally {await f.context.close();await browser.close()}
