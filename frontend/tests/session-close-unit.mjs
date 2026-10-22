// Exercise the real Zustand store without contacting a backend or browser.
import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { getFocusableSessionIds } from '../src/lib/focusableSessions.js'
import { persistOperatorDesk, restoreOperatorDesk } from '../src/lib/operatorDesk.js'

const memory = new Map()
globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: (key) => memory.delete(key) }
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
let vite, store, starts
const session = (id, workspace_id = 'w1') => ({ id, name: id, workspace_id, cli_type: 'claude', status: 'idle', pty_alive: true })
const layout = { id: 'layout', cell_assignments: { first: 'a', second: 'b', duplicate: 'a', other: 'c', missing: 'deleted' } }
const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 10))
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
  store = (await vite.ssrLoadModule('/src/state/store.js')).default
})
after(async () => { await settleTimers(); await vite?.close() })
beforeEach(() => {
  memory.clear()
  starts = []
  store.setState({ sessions: { a: session('a'), b: session('b'), c: session('c', 'w2') }, openTabs: ['a', 'b', 'c'], activeSessionId: 'a', activeWorkspaceId: 'w1', tabScope: 'workspace', activeGridTemplateId: null, gridTemplates: [layout], sessionFocus: true, terminalFocusRequest: { id: 'a', seq: 1 }, showHome: false, notifications: [], planWaiting: {}, ensureSessionRunning: async (id) => { starts.push(id) } })
})

test('closing a view preserves session, process state, history and shared layout assignments', () => {
  store.setState({ activeGridTemplateId: 'layout', messages: { a: [{ id: 'message', content: 'preserved' }] } })
  store.getState().closeTab('a')
  const state = store.getState()
  assert.deepEqual(state.openTabs, ['b', 'c'])
  assert.equal(state.activeSessionId, 'b')
  assert.equal(state.terminalFocusRequest, null)
  assert.equal(state.sessions.a.pty_alive, true)
  assert.equal(state.messages.a[0].content, 'preserved')
  assert.equal(state.gridTemplates[0], layout)
  assert.deepEqual(getFocusableSessionIds(state), ['b'])
  assert.deepEqual(starts, [])
})

test('closing the active tab chooses right then left within the visible workspace', () => {
  store.setState({ sessions: { a: session('a'), b: session('b'), c: session('c', 'w2'), d: session('d') }, openTabs: ['a', 'b', 'c', 'd'], activeSessionId: 'b' })
  store.getState().closeTab('b')
  assert.equal(store.getState().activeSessionId, 'd')
  store.getState().closeTab('d')
  assert.equal(store.getState().activeSessionId, 'a')
  assert.equal(store.getState().showHome, false)
})

test('closing the last visible tab goes Home despite tabs in another workspace', () => {
  store.setState({ openTabs: ['a', 'c'] })
  store.getState().closeTab('a')
  const state = store.getState()
  assert.deepEqual(state.openTabs, ['c'])
  assert.equal(state.activeSessionId, null)
  assert.equal(state.showHome, true)
  assert.equal(state.sessionFocus, false)
  assert.equal(state.terminalFocusRequest, null)
})

test('closing a background tab does not steal focus and clears its delayed focus request', () => {
  store.setState({ terminalFocusRequest: { id: 'b', seq: 2 } })
  store.getState().closeTab('b')
  assert.equal(store.getState().activeSessionId, 'a')
  assert.equal(store.getState().showHome, false)
  assert.equal(store.getState().sessionFocus, true)
  assert.equal(store.getState().terminalFocusRequest, null)
})

test('closed template views stay closed through desk and template restoration', () => {
  store.setState({ activeGridTemplateId: 'layout' })
  store.getState().closeTab('a')
  persistOperatorDesk(store.getState(), localStorage)
  localStorage.setItem('cc-activeGridTemplateIds', JSON.stringify({ w1: 'layout' }))
  store.setState({ openTabs: [], activeGridTemplateId: null })
  restoreOperatorDesk(store, localStorage)
  store.getState()._restoreActiveGridTemplate()
  assert.deepEqual(store.getState().openTabs, ['b', 'c'])
  assert.deepEqual(getFocusableSessionIds(store.getState()), ['b'])
  assert.equal(store.getState().gridTemplates[0], layout)
})

test('explicit template selection reopens valid assigned views in scope without starting processes', async () => {
  store.setState({ openTabs: ['b'] })
  store.getState().setActiveGridTemplateId('layout')
  assert.deepEqual(store.getState().openTabs, ['b', 'a'])
  assert.deepEqual(getFocusableSessionIds(store.getState()), ['a', 'b'])
  await settleTimers()
  assert.deepEqual(starts, [])
  store.getState().setActiveGridTemplateId(null)
  assert.deepEqual(store.getState().openTabs, ['b', 'a'])
})

test('immediate close cancels scheduled automatic starts from add, open and active selection', async () => {
  for (const action of ['add', 'open', 'active']) {
    store.setState({ openTabs: ['b'], activeSessionId: 'b' })
    if (action === 'add') store.getState().addSession(session('a'))
    if (action === 'open') store.getState().openSession('a')
    if (action === 'active') { store.getState().openSessionInBackground('a'); store.getState().setActiveSession('a') }
    store.getState().closeTab('a')
    await settleTimers()
    assert.deepEqual(starts, [], action)
  }
})

test('an open session still starts, while deleted or newly exited sessions do not', async () => {
  store.getState().openSession('a')
  await settleTimers()
  assert.deepEqual(starts, ['a'])
  store.getState().openSession('b')
  store.setState({ sessions: { a: session('a'), b: { ...session('b'), status: 'exited' } } })
  await settleTimers()
  assert.deepEqual(starts, ['a'])
  store.getState().addSession(session('new'))
  store.setState({ sessions: { a: session('a') } })
  await settleTimers()
  assert.deepEqual(starts, ['a'])
})

test('remote archive closes the local view and keeps history and template assignments', () => {
  store.setState({ openTabs: ['a', 'c'], messages: { a: [{ id: 'message' }] } })
  store.getState().setSessionArchived('a', true)
  const archived = store.getState()
  assert.equal(archived.sessions.a.archived, 1)
  assert.equal(archived.sessions.a.pty_alive, true)
  assert.deepEqual(archived.openTabs, ['c'])
  assert.equal(archived.showHome, true)
  assert.equal(archived.sessionFocus, false)
  assert.equal(archived.terminalFocusRequest, null)
  assert.equal(archived.messages.a[0].id, 'message')
  assert.equal(archived.gridTemplates[0], layout)
  store.getState().closeTab('a')
  assert.deepEqual(store.getState().openTabs, ['c'], 'duplicate cleanup is harmless')
  store.getState().setSessionArchived('a', false)
  assert.equal(store.getState().sessions.a.archived, 0)
  assert.deepEqual(store.getState().openTabs, ['c'], 'unarchive does not steal focus')
})

test('archived sessions can be explicitly viewed but are not auto-opened by templates', () => {
  store.setState({ sessions: { a: { ...session('a'), archived: 1 }, b: session('b') }, openTabs: ['a', 'b'] })
  assert.deepEqual(getFocusableSessionIds(store.getState()), ['a', 'b'])
  store.setState({ openTabs: [] })
  store.getState().setActiveGridTemplateId('layout')
  assert.deepEqual(store.getState().openTabs, ['b'])
  assert.deepEqual(getFocusableSessionIds(store.getState()), ['b'])
})

test('opening archived history never triggers an automatic process start', async () => {
  const archived = { ...session('archived'), archived: 1, pty_alive: false }
  store.getState().addSession(archived)
  store.getState().openSession('archived')
  store.getState().setActiveSession('archived')
  await settleTimers()
  assert.deepEqual(starts, [])
  assert.ok(store.getState().openTabs.includes('archived'), 'an explicit history view remains possible')
  assert.ok(getFocusableSessionIds(store.getState()).includes('archived'), 'the explicitly opened history can be read full size')
  store.getState().setSessionArchived('archived', true)
  assert.ok(!store.getState().openTabs.includes('archived'))
})

test('explicitly opened archived history is a valid neighboring tab when another view closes', () => {
  store.setState({ sessions: { a: session('a'), archived: { ...session('archived'), archived: 1 } }, openTabs: ['a', 'archived'] })
  store.getState().closeTab('a')
  assert.equal(store.getState().activeSessionId, 'archived')
  assert.equal(store.getState().showHome, false)
  assert.deepEqual(getFocusableSessionIds(store.getState()), ['archived'])
  assert.deepEqual(starts, [])
})
