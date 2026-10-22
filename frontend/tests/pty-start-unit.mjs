// Store-level regression for the PTY start handshake: a session must not
// count as running (and input must not be sent) before start_pty is on the
// wire, and a socket that closes during the layout wait must not leave the
// session marked as started. Loads the real store through Vite's SSR loader
// with a fake WebSocket; no server, backend or PTY is involved.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.window = globalThis.window || Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
globalThis.WebSocket = globalThis.WebSocket || { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }

class FakeWs {
  constructor() { this.readyState = 1; this.sent = [] }
  send(raw) { this.sent.push(JSON.parse(raw)) }
}

let server, useStore, startedSessions
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  })
  useStore = (await server.ssrLoadModule('/src/state/store.js')).default
  ;({ startedSessions } = await server.ssrLoadModule('/src/lib/terminalWriters.js'))
})
after(async () => { await server?.close() })

const session = (id, extra = {}) => ({ id, workspace_id: 'w', name: id, status: 'exited', pty_alive: false, ...extra })

test('a restart is not reported as running before start_pty is sent', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws, sessions: { a: session('a') }, sessionStarted: {}, sessionPtyStartedAt: {} })
  const ready = useStore.getState().restartSession('a')
  // Synchronously after the call nothing is on the wire yet ...
  assert.equal(ws.sent.length, 0)
  const s = useStore.getState()
  assert.equal(s.sessions.a.pty_alive, false, 'pty_alive must stay false until start_pty is sent')
  assert.ok(!s.sessionStarted.a)

  // ... so a caller asking "is it running?" must wait for the start
  // instead of taking the pty_alive shortcut.
  const order = []
  const ensured = useStore.getState().ensureSessionRunning('a').then((ok) => { order.push(['ensured', ws.sent.length]); return ok })
  assert.equal(await ensured, true)
  assert.equal(await ready, true)
  assert.equal(ws.sent[0].action, 'start_pty')
  assert.deepEqual(order, [['ensured', 1]], 'ensureSessionRunning resolved only after start_pty')
  assert.equal(useStore.getState().sessions.a.pty_alive, true)
  assert.equal(useStore.getState().sessions.a.status, 'idle')
  assert.ok(useStore.getState().sessionStarted.a)
})

test('a socket closing during the layout wait rolls the start back', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws, sessions: { b: session('b') }, sessionStarted: {}, sessionPtyStartedAt: {} })
  const ready = useStore.getState().restartSession('b')
  ws.readyState = 3
  assert.equal(await ready, false)
  assert.equal(ws.sent.length, 0)
  const s = useStore.getState()
  assert.equal(s.sessions.b.pty_alive, false)
  assert.ok(!s.sessionStarted.b)
  assert.ok(!s.sessionPtyStartedAt.b)
  assert.ok(!startedSessions.has('b'))
  // A later ensureSessionRunning on a closed socket reports failure too.
  assert.equal(await useStore.getState().ensureSessionRunning('b'), false)
})
