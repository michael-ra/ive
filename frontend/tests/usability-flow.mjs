import assert from 'node:assert/strict'
import {chromium,webkit} from 'playwright'
import {createTourFixture} from './interactive-onboarding-fixture.mjs'
const engine=process.env.IVE_QA_BROWSER||'chromium',browser=await(engine==='webkit'?webkit:chromium).launch()
const out='packaging/artifacts/usability-20261015'
const session={id:'s',workspace_id:'w',name:'Fix sign-in',cli_type:'claude',model:'sonnet',permission_mode:'auto',status:'idle',agentState:'idle',pty_alive:true,session_type:'worker',archived:0,tags:[],updated_at:'2026-10-15T12:00:00Z'}
const rows=[{id:'u',session_id:'s',role:'user',content:'Fix sign-in and run tests.'},
 {id:'call',session_id:'s',role:'assistant',content:[{type:'tool_use',name:'Bash',id:'test',input:{command:'npm test',description:'Run login tests'}},{type:'tool_use',name:'mcp__worker-board__post_message',id:'share',input:{message:'Login is updated'}}]},
 {id:'result',session_id:'s',role:'user',content:[{type:'tool_result',tool_use_id:'test',content:'PASS 2 tests'},{type:'tool_result',tool_use_id:'share',content:'sent'}]},
 {id:'a',session_id:'s',role:'assistant',content:JSON.stringify({role:'assistant',content:[{type:'text',text:'Updated [**login.ts**](/isolated/app/login.ts).\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[context]\n</citation_entries>\n</oai-mem-citation>'}]})}].map((r,i)=>({...r,created_at:`2026-10-15T12:00:0${i}Z`}))
let count=0
try {
 for(const width of [1440,390]){
 const f=await createTourFixture(browser,{width,height:960,settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/app'},{id:'z',name:'Other project',path:'/isolated/other'}],sessions:[session],messages:{s:rows},storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s',openTabs:['s'],showHome:false,activeNavGroup:'work'}}})
 const p=f.page;p.setDefaultTimeout(10000)
 await f.context.route('**/api/sessions/s/digest',r=>r.fulfill({json:{files_touched:['login.ts']}}))
 await f.context.route('**/api/workspaces/w/git/status',r=>r.fulfill({json:{staged:[],unstaged:[{path:'login.ts',status:'M'}],untracked:[]}}))
 await p.goto('http://ive-guide.test/#session-s')

 const brief=p.locator('[data-session-brief]');await brief.getByRole('button',{name:'Reply ready',exact:true}).click()
 await brief.getByText('Project message sent',{exact:true}).waitFor()
 await brief.getByText('Run login tests',{exact:true}).waitFor()
 assert.match(await brief.innerText(),/Includes work from other sessions/)
 assert.equal(await p.locator('[data-chat-message-id="a"] a').innerText(),'login.ts')
 assert.equal(await p.locator('[data-chat-message-id="a"]').innerText().then(t=>t.includes('<oai-mem-citation>')),false)
 await p.locator('[data-chat-message-id="a"] summary').filter({hasText:'Sources'}).click()
 await p.locator('[data-chat-message-id="a"]').getByText('MEMORY.md:1-2',{exact:true}).waitFor()
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await p.screenshot({path:`${out}/session-${engine}-${width}.png`,fullPage:true})
 await brief.getByRole('button',{name:'Run login tests Output recorded · review the result'}).click()
 await p.getByText('PASS 2 tests',{exact:true}).waitFor()
 if(width===1440){
  await p.getByRole('button',{name:'Pin project Other project',exact:true}).click()
  let projects=await p.locator('#ive-project-sidebar [data-workspace-id]').evaluateAll(es=>es.map(e=>e.dataset.workspaceId));assert.equal(projects[0],'z')
  await p.reload();await p.getByRole('button',{name:'Unpin project Other project',exact:true}).waitFor()
  await p.getByRole('button',{name:'More actions for Fix sign-in',exact:true}).click()
  await p.getByRole('menuitem',{name:'Close session',exact:true}).click()
  await p.getByRole('button',{name:'Undo',exact:true}).waitFor();assert.equal(f.data.sessions[0].archived,1)
  f.controls.failArchive=true
  await p.getByRole('button',{name:'Undo',exact:true}).click()
  await p.getByText(/Could not undo:/).waitFor()
  assert.equal(f.data.sessions[0].archived,1)
  f.controls.failArchive=false
  await p.getByRole('button',{name:'Undo',exact:true}).click()
  await p.locator('[data-session-view="s"]').waitFor();assert.equal(f.data.sessions[0].archived,0)
  f.controls.setSessionStatus('s','waiting',{agentState:'waiting',attention:{kind:'question',title:'Your answer is needed'}})
  await p.locator('.ive-needs-you').click()
  await p.getByRole('dialog',{name:'Needs your attention',exact:true}).getByRole('button',{name:'Review',exact:false}).click()
  await brief.getByRole('button',{name:'Your answer is needed',exact:true}).waitFor()
  f.controls.emit({type:'hooks_notice',session_id:'s',cli:'codex',reason:'codex_hooks_untrusted',message:'Setup needed'})
  const notice=p.getByRole('article',{name:'Codex setup notice',exact:true});await notice.getByText('Finish connecting Codex',{exact:true}).waitFor()
  await notice.getByText('Review setup',{exact:true}).click()
  await notice.getByText('Review the IVE hooks and enable the ones you trust. Restart the session when it is idle.',{exact:true}).waitFor()
  await notice.getByRole('button',{name:'Dismiss Codex setup notification',exact:true}).click()
  await f.context.route('**/api/workspaces/w/git/status',r=>r.fulfill({status:503,json:{error:'Unavailable'}}))
  await brief.getByRole('button',{name:'Your answer is needed',exact:true}).click()
  await brief.getByText('Project changes could not be loaded. Try refreshing.',{exact:true}).waitFor()
  await f.context.route('**/api/workspaces/w/git/status',r=>r.fulfill({json:{staged:[],unstaged:[],untracked:[]}}))
  await brief.getByRole('button',{name:'Refresh session overview',exact:true}).click()
  await brief.getByText('0 uncommitted project files. Includes work from other sessions.',{exact:true}).waitFor()
  await f.context.route('**/api/workspaces/w/git/status',r=>r.fulfill({json:{is_git_repo:false,staged:[],unstaged:[],untracked:[]}}))
  await brief.getByRole('button',{name:'Refresh session overview',exact:true}).click()
  await brief.getByText('This folder is not a Git repository. Change tracking is unavailable.',{exact:true}).waitFor()
 }
 assert.deepEqual(f.errors,[]);count++;await f.context.close()
 }
 const f=await createTourFixture(browser,{settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/app'}]});const p=f.page
 await p.goto('http://ive-guide.test/#board');await p.locator('[data-sidebar-new-chat]').click();await p.getByRole('dialog',{name:'New session',exact:true}).getByRole('button',{name:/Set up session/}).click()
 const setup=p.getByRole('dialog',{name:'New AI session',exact:true});await setup.waitFor()
 await p.screenshot({path:`${out}/setup-${engine}.png`,fullPage:true})
 assert.equal(await setup.getByLabel('AI model',{exact:true}).isVisible(),false)
 await setup.locator('summary').filter({hasText:'Model & permissions'}).click()
 await setup.getByLabel('AI model',{exact:true}).waitFor()
 await setup.getByRole('button',{name:'More options & presets',exact:true}).click()
 await setup.getByText('Session Presets',{exact:true}).waitFor()

 assert.deepEqual(f.errors,[]);count++;await f.context.close()
 console.log(JSON.stringify({engine,count,passed:true}))
}finally{await browser.close()}
