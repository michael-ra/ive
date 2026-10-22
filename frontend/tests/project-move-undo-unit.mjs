import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = Object.assign(new EventTarget(), { location: { protocol:'http:', host:'localhost', hostname:'localhost', search:'' } })
let vite, store, api, attach
before(async()=>{
 vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'})
 store=(await vite.ssrLoadModule('/src/state/store.js')).default
 api=(await vite.ssrLoadModule('/src/lib/api.js')).api
 attach=(await vite.ssrLoadModule('/src/lib/quickStart.js')).attachSessionToProject
})
after(async()=>{await vite.close()})
test('project move Undo restores quick state with a server receipt; failed Undo remains retryable',async()=>{
 const quick={id:'quick',name:'Quick sessions',is_quick:true},project={id:'project',name:'Project'}
 store.setState({sessions:{s:{id:'s',workspace_id:'quick',quick:true}},workspaces:[quick,project],quickStart:{workspace_id:'quick'},notifications:[]})
 const calls=[];let fail=false
 api.attachSession=async(id,body)=>{
  calls.push(body)
  if(fail)throw new Error('Move changed')
  return body.undo_token ? {session:{id,workspace_id:'quick',quick:true},workspace:quick} : {session:{id,workspace_id:'project',quick:false},workspace:project,undo_token:'receipt'}
 }
 await attach('s',{workspace_id:'project'})
 assert.equal(store.getState().sessions.s.quick,false)
 const undo=store.getState().notifications.find(n=>n.action)?.action.onClick
 assert.ok(undo)
 fail=true;assert.equal(await undo(),false)
 assert.equal(store.getState().sessions.s.workspace_id,'project')
 fail=false;assert.equal(await undo(),true)
 assert.equal(store.getState().sessions.s.quick,true)
 assert.equal(store.getState().sessions.s.workspace_id,'quick')
 assert.deepEqual(calls,[{workspace_id:'project'},{undo_token:'receipt'},{undo_token:'receipt'}])
 assert.equal(store.getState().notifications.filter(n=>n.action).length,1)
})
