import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'chromium'
const browser=await (engine==='webkit'?webkit:chromium).launch()
const out='packaging/artifacts/session-entry-20261014'
let checks=0
try {
 for (const width of [1440,390]) {
  const f=await createTourFixture(browser,{width,height:960,settings:{product_tour_version:'2'},workspaces:[{id:'q',name:'Quick sessions',path:'/isolated',is_quick:true},{id:'w',name:'Orbit',path:'/isolated/orbit'}]})
  const p=f.page;p.setDefaultTimeout(10000)
  await f.context.route('**/api/quick-start',r=>r.fulfill({json:{root:'/isolated',workspace_id:'q'}}))
  await p.goto('http://ive-guide.test/#board')
  // Exercise the same entry function as the desktop + and sidebar button.
  if(width===1440) await p.locator('[data-new-session-button]').click()
  else await p.getByRole('button',{name:'Create a new session',exact:true}).click()
  const chooser=p.getByRole('dialog',{name:'New session',exact:true});await chooser.waitFor()
  await chooser.getByRole('combobox',{name:'Project',exact:true}).selectOption('w')
  assert.equal(await chooser.getByRole('button',{name:/Set up session/}).count(),1)
  assert.equal(await chooser.getByRole('button',{name:/Quick chat/}).count(),1)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await p.screenshot({path:`${out}/entry-${engine}-${width}.png`})
  await chooser.getByRole('button',{name:/Set up session/}).click()
  await p.getByRole('heading',{name:'New AI session',exact:true}).waitFor()
  assert.match(await p.locator('[data-session-setup-where]').innerText(),/Orbit/)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await p.screenshot({path:`${out}/setup-${engine}-${width}.png`})
  await p.getByLabel(/Session name/).fill('Traffic model review')
  await p.getByRole('button',{name:'Create Session',exact:true}).click()
  await p.locator('[data-session-view]').waitFor()
  const created=f.data.sessions.find(s=>s.name==='Traffic model review');assert.ok(created);assert.equal(created.workspace_id,'w')
  assert.ok(!f.writes.some(w=>w.path==='/sessions/quick'))
  assert.deepEqual(f.errors,[])
  if(width===1440){
   const groups=await p.locator('#ive-project-sidebar [data-workspace-id]').evaluateAll(els=>els.map(e=>e.getAttribute('data-workspace-id')))
   assert.deepEqual(groups,['w','q'])
   assert.ok(await p.locator('#ive-project-sidebar').getByText('Without project',{exact:true}).count())
  }
  checks++;await f.context.close()
 }
 // Starting with no project: connect one inside the chooser and continue
 // into the full setup, with no intermediate quick session created.
 const f=await createTourFixture(browser,{settings:{product_tour_version:'2'},workspaces:[{id:'q',name:'Quick sessions',path:'/isolated',is_quick:true}]})
 const p=f.page;p.setDefaultTimeout(10000)
 await f.context.route('**/api/quick-start/workspace',r=>r.fulfill({json:f.data.workspaces[0]}))
 await p.goto('http://ive-guide.test/#board')
 await p.locator('[data-sidebar-new-chat]').click()
 await p.getByRole('dialog',{name:'New session',exact:true}).getByRole('button',{name:/Set up session/}).click()
 await p.getByRole('heading',{name:'New AI session',exact:true}).waitFor()
 assert.match(await p.locator('[data-session-setup-where]').innerText(),/No project/ )
 await p.getByRole('button',{name:'Cancel',exact:true}).click()
 assert.equal(f.data.sessions.length,0)
 await p.locator('[data-sidebar-new-chat]').click()
 await p.getByRole('dialog',{name:'New session',exact:true}).getByRole('button',{name:'Add project',exact:true}).click()
 await p.getByLabel('What would you like to work on?',{exact:true}).fill('Tour practice')
 await p.getByRole('button',{name:/Tour practice.*git repository/}).click()
 const chooser=p.getByRole('dialog',{name:'New session',exact:true})
 await chooser.waitFor()
 assert.equal(await chooser.getByRole('combobox',{name:'Project',exact:true}).inputValue(),f.data.workspaces.at(-1).id)
 await chooser.getByRole('button',{name:/Quick chat/}).click()
 await p.getByRole('dialog',{name:'Quick chat',exact:true}).getByLabel('What do you want to work on?',{exact:true}).fill('Review the traffic model')
 await p.getByRole('button',{name:/Set up session/}).click()
 await p.getByRole('heading',{name:'New AI session',exact:true}).waitFor()
 assert.equal(await p.getByLabel('What would you like to do?',{exact:true}).inputValue(),'Review the traffic model')
 assert.equal(f.data.sessions.length,0)
 assert.deepEqual(f.errors,[]);checks++;await f.context.close()
 console.log(JSON.stringify({engine,checks,passed:true}))
}finally{await browser.close()}
