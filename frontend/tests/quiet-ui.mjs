import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium,webkit} from 'playwright'
import {createTourFixture} from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'webkit'
const browser=await(engine==='webkit'?webkit:chromium).launch()
const out=new URL('../../packaging/artifacts/quiet-ui-20261015/',import.meta.url).pathname
await mkdir(out,{recursive:true})
const results=[]
try{
 for(const [theme,width] of [['light',1440],['dark',1100],['light',780]]){
  const f=await createTourFixture(browser,{theme,width,height:900,settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Demo',path:'/isolated/demo'}]})
  await f.context.route('**/api/mac-power',r=>r.fulfill({json:{state:'ready',lid_saver_supported:true}}))
  await f.context.route('**/api/phone/status',r=>r.fulfill({json:{is_local_owner:true,desktop:true,owner:true,role:'owner',setup:{consent_version:0},availability:{state:'not_registered'},tunnel:{running:false},devices:[],pin_enabled:false}}))
  await f.context.route('**/api/phone/devices',r=>r.fulfill({json:{devices:[]}}))
  await f.context.route('**/api/safety/status',r=>r.fulfill({json:{enabled:true,rule_count:0,decision_count:0}}))
  const p=f.page
  await p.getByRole('button',{name:'Settings',exact:true}).first().click()
  const shell=p.locator('[data-settings-shell]');await shell.waitFor()
  for(const id of ['general-settings','workspace-settings','model-providers','sound-settings','connectors','experimental','safety','phone-access','mac-power','sharing']){
   await shell.locator(`[data-settings-nav="${id}"]`).click()
   const panel=shell.locator(`[data-settings-content="${id}"]`)
   await panel.waitFor()
   assert.ok((await shell.innerText()).length>30)
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
   const help=shell.locator('details.ive-help-details').first()
   assert.equal(await help.getAttribute('open'),null)
   const summary=help.locator('summary');await summary.focus();await summary.press('Enter')
   await p.waitForFunction(()=>document.querySelector('[data-settings-shell] details.ive-help-details')?.open)
   assert.equal(await help.locator('.ive-help-content').isVisible(),true)
   await summary.press('Space');assert.equal(await help.locator('.ive-help-content').isVisible(),false)
   if(id==='general-settings'||id==='workspace-settings'||width===1440&&['phone-access','mac-power','safety'].includes(id))await p.screenshot({path:`${out}${engine}-${theme}-${width}-${id}.png`})
  }
  assert.deepEqual(f.errors,[])
  assert.equal(f.writes.length,0,'Reading explanations must not change settings')
  await f.context.close();results.push({theme,width,settings:true})
 }
 const welcome=await createTourFixture(browser,{width:780,height:800})
 await welcome.page.getByRole('heading',{name:'Dein Projekt. Dein erster Durchlauf.',exact:true}).waitFor()
 await welcome.page.screenshot({path:`${out}${engine}-welcome.png`})
 await welcome.page.getByRole('button',{name:'Selbst ausprobieren',exact:true}).click()
 const coach=welcome.page.locator('[data-tour-step="project"]');await coach.waitFor()
 assert.ok((await coach.innerText()).length<350)
 assert.equal(await coach.getByText('Ein Workspace ist dein Projektordner.',{exact:false}).isVisible(),false)
 await coach.locator('summary').click()
 assert.equal(await coach.getByText('Ein Workspace ist dein Projektordner.',{exact:false}).isVisible(),true)
 await coach.locator('summary').click()
 await welcome.page.screenshot({path:`${out}${engine}-coach.png`})
 assert.equal(welcome.writes.length,0)
 assert.deepEqual(welcome.errors,[]);await welcome.context.close();results.push({onboarding:true})
 const message='Connection needs attention. '+('The complete diagnostic remains available here without losing any information. '.repeat(8))
 const notice=await createTourFixture(browser,{settings:{product_tour_version:'2'},sessions:[{id:'n',name:'Test',workspace_id:null,cli_type:'claude',status:'idle',pty_alive:true}]})
 const p=notice.page
 await p.clock.install()
 notice.controls.emit({type:'account_switched',session_id:'n',old_account_name:'Old',new_account_name:message})
 const article=p.getByRole('article',{name:'info notification',exact:true});await article.waitFor()
 const preview=await article.locator('.ive-notice-message').innerText()
 assert.match(preview,/^Auto-cycled (Test|n): Old → Connection needs attention\.$/)
 const original=preview.replace('Connection needs attention.',message)

 await article.locator('summary').click()
 assert.equal(await article.locator('.ive-help-content').innerText(),original.trim())
 await p.mouse.move(10,10);await p.locator('.x-app-shell').click({position:{x:5,y:5}})
 await p.clock.fastForward(15000);assert.equal(await article.isVisible(),true,'An expanded message must not expire while being read')
 await article.locator('summary').click();await p.mouse.move(10,10);await p.locator('.x-app-shell').click({position:{x:5,y:5}})
 await p.clock.fastForward(11000);await article.waitFor({state:'hidden'})
 assert.deepEqual(notice.errors,[]);await notice.context.close();results.push({notifications:true})
 console.log(JSON.stringify({engine,passed:true,results}))
}finally{await browser.close()}
