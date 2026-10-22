import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
let vite, store, api, requestSessionRename, cancelSessionRename, saveSessionRename, useSessionRename, calls
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  store = (await vite.ssrLoadModule('/src/state/store.js')).default
  api = (await vite.ssrLoadModule('/src/lib/api.js')).api
  ;({ requestSessionRename, cancelSessionRename, saveSessionRename, useSessionRename } = await vite.ssrLoadModule('/src/lib/sessionRename.js'))
})
after(async () => { await vite?.close() })
beforeEach(() => {
  calls = []
  useSessionRename.setState({ request: null })
  store.setState({ sessions: { a: { id: 'a', name: 'Original', status: 'running', pty_alive: true } }, messages: { a: [{ content: 'Keep history' }] } })
  api.renameSession = async (id, name) => { calls.push({ id, name }); return { id, name, status: 'idle', pty_alive: false } }
})

test('opening, cancelling, empty and unchanged names never write', async () => {
  window.prompt = () => { throw new Error('Native prompt must not be used') }
  requestSessionRename('missing')
  assert.equal(useSessionRename.getState().request, null)
  requestSessionRename('a')
  assert.equal(useSessionRename.getState().request.name, 'Original')
  assert.equal(await saveSessionRename('   '), false)
  assert.ok(useSessionRename.getState().request)
  cancelSessionRename()
  requestSessionRename('a')
  assert.equal(await saveSessionRename('Original'), true)
  assert.equal(useSessionRename.getState().request, null)
  assert.deepEqual(calls, [])
})

test('renaming trims the name and preserves live process state and history', async () => {
  requestSessionRename('a')
  assert.equal(await saveSessionRename('  New name  '), true)
  assert.deepEqual(calls, [{ id: 'a', name: 'New name' }])
  assert.equal(store.getState().sessions.a.name, 'New name')
  assert.equal(store.getState().sessions.a.status, 'running')
  assert.equal(store.getState().sessions.a.pty_alive, true)
  assert.equal(store.getState().messages.a[0].content, 'Keep history')
})

test('pending rename cannot be submitted twice, cancelled or retargeted', async () => {
  let finish
  api.renameSession = (id, name) => { calls.push({ id, name }); return new Promise(resolve => { finish = resolve }) }
  store.setState({ sessions: { ...store.getState().sessions, b: { id: 'b', name: 'Other' } } })
  requestSessionRename('a')
  const operation = saveSessionRename('Saved')
  cancelSessionRename()
  requestSessionRename('b')
  assert.equal(await saveSessionRename('Duplicate'), false)
  assert.equal(useSessionRename.getState().request.id, 'a')
  assert.equal(store.getState().sessions.a.name, 'Original')
  finish({ name: 'Saved' })
  assert.equal(await operation, true)
  assert.equal(calls.length, 1)
})

test('failed persistence retains the old name and allows retry', async () => {
  api.renameSession = async () => { throw new Error('Offline') }
  requestSessionRename('a')
  assert.equal(await saveSessionRename('Retry me'), false)
  assert.match(useSessionRename.getState().request.error, /Offline/)
  assert.equal(useSessionRename.getState().request.pending, false)
  assert.equal(store.getState().sessions.a.name, 'Original')
  api.renameSession = async (id, name) => ({ id, name })
  assert.equal(await saveSessionRename('Retry me'), true)
  assert.equal(store.getState().sessions.a.name, 'Retry me')
})

test('response cannot recreate a session removed while saving', async () => {
  let finish
  api.renameSession = () => new Promise(resolve => { finish = resolve })
  requestSessionRename('a')
  const operation = saveSessionRename('Gone')
  store.setState({ sessions: {} })
  finish({ name: 'Gone' })
  assert.equal(await operation, true)
  assert.equal(store.getState().sessions.a, undefined)
})
