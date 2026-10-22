import assert from 'node:assert/strict'
import {chromium,webkit} from 'playwright'
import {createTourFixture} from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'chromium',browser=await(engine==='webkit'?webkit:chromium).launch()
const out='packaging/artifacts/notifications-20261014'
const sessions=['s1','s2','s3'].map((id,i)=>({id,workspace_id:'w',name:i===0?'Fix sign-in':'Quick session',cli_type:'codex',model:'gpt-6-astra',permission_mode:'auto',status:'idle',agentState:'idle',pty_alive:true,session_type:'worker',archived:0,tags:[]}))
let count=0
try{
 for(const [theme,width] of [['light',1440],['dark',1440],['light',390]]){
 const notifications=sessions.map(s=>({id:s.id,sessionId:s.id,reason:'codex_hooks_untrusted',type:'warning',timestamp:Date.now(),message:'Old long setup description'}))
 const f=await createTourFixture(browser,{theme,width,height:960,settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/app'}],sessions,storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s1',openTabs:['s1'],showHome:false,notifications}}})
 const p=f.page;p.setDefaultTimeout(10000);await p.goto('http://ive-guide.test/#session-s1')
 const region=p.getByRole('region',{name:'Notifications',exact:true}),notice=p.getByRole('article',{name:'Codex setup notice',exact:true})
 await notice.getByText('3 sessions affected',{exact:true}).waitFor()
 assert.equal(await notice.count(),1)
 assert.ok((await notice.boundingBox()).height < 200)
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await p.screenshot({path:`${out}/${engine}-${theme}-${width}.png`,fullPage:true})
 await notice.getByRole('button',{name:'Review setup',exact:true}).click()
 assert.equal(await notice.getByRole('button',{name:/Open terminal for/}).count(),3)
 await notice.getByRole('button',{name:'Open terminal for Quick session (s2)',exact:true}).click()
 if(width===390)await p.locator('[data-phone-session-head] button[aria-label="Terminal view"][aria-pressed="true"]').waitFor();else await p.locator('[data-session-view="s2"] [data-session-terminal-drawer]').waitFor()
 assert.equal(f.data.pty.filter(r=>r.action==='input').length,0,'Opening terminal must not send a command or approve trust')
 await notice.getByRole('button',{name:'Dismiss Codex setup notification',exact:true}).click()
 await notice.waitFor({state:'hidden'})
 if(width===1440){
  // Separate warnings remain individually reachable, with only two visible.
  for(let i=0;i<4;i++)f.controls.emit({type:'hooks_notice',session_id:i%2?'s1':'s2',reason:`fixture-${i}`,message:`Connection issue ${i}`})
  await region.getByRole('button',{name:'2 more notifications',exact:true}).waitFor()
  assert.equal(await region.locator('article').count(),2)
  await region.getByRole('button',{name:'2 more notifications',exact:true}).click()
  assert.equal(await region.locator('article').count(),4)
  await region.getByRole('button',{name:'Show fewer notifications',exact:true}).click()
  assert.equal(await region.locator('article').count(),2)
  while(await region.getByRole('button',{name:'Dismiss notification',exact:true}).count())await region.getByRole('button',{name:'Dismiss notification',exact:true}).first().click()
  await p.clock.install()
  f.controls.emit({type:'account_switched',session_id:'s1',old_account_name:'Old account',new_account_name:'Verified account'})
  const info=region.getByRole('article',{name:'info notification',exact:true});await info.waitFor()
  await info.hover();await p.clock.fastForward(20000);assert.equal(await info.isVisible(),true)
  await p.mouse.move(10,10);await p.clock.fastForward(10001);await info.waitFor({state:'hidden'})
 }
 assert.deepEqual(f.errors,[]);count++;await f.context.close()
 }
 console.log(JSON.stringify({engine,count,passed:true}))
}finally{await browser.close()}
