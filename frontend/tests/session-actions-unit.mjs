import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
let vite, store, api, closeSession, calls, deleteWorkspaceWithConfirm, deleteSessionWithConfirm, confirmSessionDeletion, cancelSessionDeletion, useSessionDelete
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  store = (await vite.ssrLoadModule('/src/state/store.js')).default
  api = (await vite.ssrLoadModule('/src/lib/api.js')).api
  ;({ closeSession, deleteWorkspaceWithConfirm, deleteSessionWithConfirm, confirmSessionDeletion, cancelSessionDeletion, useSessionDelete } = await vite.ssrLoadModule('/src/lib/sessionActions.js'))
})
after(async () => { await vite?.close() })
beforeEach(() => {
  calls = []
  store.setState({ sessions: { a: { id: 'a', name: 'Quick session', workspace_id: 'w', status: 'idle', archived: 0 } }, openTabs: ['a'], activeSessionId: 'a', activeWorkspaceId: 'w', showHome: false, sessionFocus: true, messages: { a: [{ id: 'm', content: 'Keep my conversation' }] }, notifications: [] })
  api.updateSession = async (id, body) => { calls.push({ id, body }); return { id, ...body } }
})

test('close archives only after persistence, retains history, and removes the active view', async () => {
  let finish
  api.updateSession = (id, body) => { calls.push({ id, body }); return new Promise((resolve) => { finish = resolve }) }
  const pending = closeSession('a')
  assert.deepEqual(store.getState().openTabs, ['a'])
  assert.equal(store.getState().sessions.a.archived, 0)
  assert.equal(closeSession('a'), pending, 'two close entry points share the in-flight operation')
  finish({ id: 'a', archived: 1 })
  assert.equal(await pending, true)
  assert.deepEqual(calls, [{ id: 'a', body: { archived: 1 } }])
  assert.equal(store.getState().sessions.a.archived, 1)
  assert.deepEqual(store.getState().openTabs, [])
  assert.equal(store.getState().showHome, true)
  assert.equal(store.getState().messages.a[0].content, 'Keep my conversation')
})

test('failed close keeps the session accessible, reports the error, and allows retry', async () => {
  api.updateSession = async () => { throw new Error('Connection lost') }
  assert.equal(await closeSession('a'), false)
  assert.equal(store.getState().sessions.a.archived, 0)
  assert.deepEqual(store.getState().openTabs, ['a'])
  assert.match(store.getState().notifications.at(-1).message, /Could not close.*Connection lost/)
  api.updateSession = async () => ({ archived: 1 })
  assert.equal(await closeSession('a'), true)
  assert.deepEqual(store.getState().openTabs, [])
})

test('closing an explicitly opened archive or missing session makes no network request', async () => {
  store.setState({ sessions: { a: { ...store.getState().sessions.a, archived: 1 } } })
  assert.equal(await closeSession('a'), true)
  assert.equal(await closeSession('missing'), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(store.getState().openTabs, [])
})


test('delete waits for app confirmation and cancellation leaves history untouched', async () => {
  api.deleteSession = async (id) => { calls.push(id) }
  window.confirm = () => { throw new Error('Native dialog must not be called') }
  const pending = deleteSessionWithConfirm('a')
  assert.equal(useSessionDelete.getState().request.name, 'Quick session')
  assert.equal(deleteSessionWithConfirm('a'), pending)
  assert.deepEqual(calls, [])
  cancelSessionDeletion()
  assert.equal(await pending, false)
  assert.equal(store.getState().messages.a[0].content, 'Keep my conversation')
  assert.equal(useSessionDelete.getState().request, null)
})

test('confirmed delete is deduplicated and only reconciles state after successful persistence', async () => {
  let finish
  api.deleteSession = (id) => { calls.push(id); return new Promise(resolve => { finish = resolve }) }
  const pending = deleteSessionWithConfirm('a')
  const operation = confirmSessionDeletion()
  assert.equal(useSessionDelete.getState().request.pending, true)
  cancelSessionDeletion()
  assert.equal(await confirmSessionDeletion(), false)
  assert.ok(store.getState().sessions.a)
  assert.deepEqual(calls, ['a'])
  finish({ ok: true })
  assert.equal(await operation, true)
  assert.equal(await pending, true)
  assert.equal(store.getState().sessions.a, undefined)
  assert.equal(store.getState().messages.a, undefined)
  assert.equal(useSessionDelete.getState().request, null)
})

test('delete failure preserves request and history for retry; a second target cannot replace it', async () => {
  store.setState({ sessions: { ...store.getState().sessions, b: { id: 'b', name: 'Other' } } })
  api.deleteSession = async () => { throw new Error('Connection lost') }
  const pending = deleteSessionWithConfirm('a')
  assert.equal(await deleteSessionWithConfirm('b'), false)
  assert.equal(await confirmSessionDeletion(), false)
  assert.match(useSessionDelete.getState().request.error, /Connection lost/)
  assert.equal(useSessionDelete.getState().request.pending, false)
  assert.ok(store.getState().messages.a)
  api.deleteSession = async (id) => { calls.push(id) }
  assert.equal(await confirmSessionDeletion(), true)
  assert.equal(await pending, true)
  assert.deepEqual(calls, ['a'])
  assert.ok(store.getState().sessions.b)
  assert.equal(await deleteSessionWithConfirm('missing'), false)
})


function seedProjects() {
  const first = store.getState().sessions.a
  store.setState({workspaces:[{id:'w',name:'Remove this project',path:'/projects/keep-files'},{id:'other',name:'Other project'}],
    sessions:{a:first, child:{...first,id:'child'}, b:{id:'b',workspace_id:'other',name:'Keep me'}},
    openTabs:['a','child','b'],activeWorkspaceId:'w',activeSessionId:'a',
    messages:{a:[{content:'delete'}],child:[{content:'delete child'}],b:[{content:'keep'}]},
    chatDrafts:{a:{text:'drop'},b:{text:'retain'}},selectedSessionIds:['a'],selectionWorkspaceId:'w',
    tasks:{drop:{workspace_id:'w'},keep:{workspace_id:'other'}},
    gridTemplates:[{id:'drop-layout',workspace_id:'w',cell_assignments:{a:'a'}},{id:'keep-layout',workspace_id:'other',cell_assignments:{a:'b'}}],
    activeGridTemplateId:'drop-layout',newSessionWorkspaceId:'w'})
}

test('project confirmation uses the app dialog and cancel preserves all project sessions', async () => {
  seedProjects()
  api.deleteWorkspace = async id => { calls.push(id) }
  const pending=deleteWorkspaceWithConfirm('w')
  assert.equal(useSessionDelete.getState().request.kind,'workspace')
  assert.equal(useSessionDelete.getState().request.path,'/projects/keep-files')
  assert.equal(deleteWorkspaceWithConfirm('w'),pending)
  assert.equal(await deleteSessionWithConfirm('a'),false,'Another destructive target cannot replace this confirmation')
  cancelSessionDeletion()
  assert.equal(await pending,false)
  assert.deepEqual(calls,[])
  assert.equal(Object.keys(store.getState().sessions).length,3)
})

test('project delete errors preserve data; retry removes only that project and its state', async () => {
  seedProjects()
  api.deleteWorkspace=async id=>{calls.push(id);throw new Error('Offline')}
  const pending=deleteWorkspaceWithConfirm('w')
  assert.equal(await confirmSessionDeletion(),false)
  assert.match(useSessionDelete.getState().request.error,/Offline/)
  assert.equal(store.getState().workspaces.length,2)
  assert.equal(store.getState().messages.a[0].content,'delete')
  api.deleteWorkspace=async id=>{calls.push(id);return {ok:true,session_ids:['a','child']}}
  assert.equal(await confirmSessionDeletion(),true)
  assert.equal(await pending,true)
  const state=store.getState()
  assert.deepEqual(calls,['w','w'])
  assert.deepEqual(Object.keys(state.sessions),['b'])
  assert.deepEqual(Object.keys(state.messages),['b'])
  assert.deepEqual(state.openTabs,['b'])
  assert.equal(state.activeWorkspaceId,'other')
  assert.equal(state.messages.b[0].content,'keep')
  assert.equal(state.chatDrafts.b.text,'retain')
  assert.deepEqual(Object.keys(state.tasks),['keep'])
  assert.deepEqual(state.gridTemplates.map(x=>x.id),['keep-layout'])
  assert.equal(state.activeGridTemplateId,null)
  assert.equal(state.newSessionWorkspaceId,null)
  assert.deepEqual(state.selectedSessionIds,[])
  state.removeWorkspace('w',['a','child'])
  assert.deepEqual(Object.keys(store.getState().sessions),['b'],'Repeated WS event is harmless')
})

test('pending project deletion cannot repeat or cancel; removing the final project returns Home', async () => {
  seedProjects()
  store.getState().removeWorkspace('other')
  let finish
  api.deleteWorkspace=id=>{calls.push(id);return new Promise(resolve=>{finish=resolve})}
  const pending=deleteWorkspaceWithConfirm('w')
  const operation=confirmSessionDeletion()
  cancelSessionDeletion()
  assert.equal(await confirmSessionDeletion(),false)
  assert.ok(store.getState().sessions.a)
  finish({ok:true})
  assert.equal(await operation,true)
  assert.equal(await pending,true)
  assert.deepEqual(calls,['w'])
  assert.equal(store.getState().workspaces.length,0)
  assert.equal(store.getState().activeWorkspaceId,null)
  assert.deepEqual(store.getState().openTabs,[])
  assert.equal(store.getState().showHome,true)
})
