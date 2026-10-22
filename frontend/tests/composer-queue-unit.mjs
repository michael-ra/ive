// Composer queue (lib/composerQueue.js): messages typed while a Claude/Codex
// session works. Loads the real store + queue through Vite's SSR loader with a
// fake socket and a fake input/transcript API; no backend or PTY involved.
//   enqueue while working -> delivered once after idle, confirmed by transcript
//   remove before delivery, session switch (right session only), Stop pauses,
//   connection loss + reconnect, 409 busy retry, unknown outcome never resent,
//   reload keeps the queue, concurrent ticks never double-send.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
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
globalThis.CustomEvent = globalThis.CustomEvent || class extends Event { constructor(t, o) { super(t); this.detail = o?.detail } }
globalThis.WebSocket = globalThis.WebSocket || { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(10) }
  return false
}

let server, useStore, q, api
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  })
  useStore = (await server.ssrLoadModule('/src/state/store.js')).default
  q = await server.ssrLoadModule('/src/lib/composerQueue.js')
  ;({ api } = await server.ssrLoadModule('/src/lib/api.js'))
})
after(async () => { q?.__resetComposerQueue(); await server?.close() })

// Fake backend: per-session transcripts and an input endpoint that "types".
let transcripts, sent, inputMode
const ws = { readyState: 1, send() {} }
const session = (id, extra = {}) => ({ id, workspace_id: 'w', name: id, cli_type: 'claude', status: 'idle', pty_alive: true, ...extra })
const setStatus = (id, status) => useStore.setState((s) => ({
  sessions: { ...s.sessions, [id]: { ...s.sessions[id], status, agentState: status === 'running' ? 'working' : 'idle' } },
}))
const queueOf = (id) => q.getQueue(id)
const states = (id) => queueOf(id).items.map((i) => `${i.state}:${i.text}`)
const sentTo = (id) => sent.filter((s) => s.id === id).map((s) => s.message)

function installFakeApi() {
  api.getMessages = async (id, cursor, { tail } = {}) => {
    const rows = transcripts[id] || []
    return { rows: rows.slice(-(tail || 40)).map((r, i, arr) => ({ ...r, id: `msg-${rows.length - arr.length + i}` })), total: rows.length, cursor: `1:${rows.length}` }
  }
  api.sendSessionInput = async (id, message, opts) => {
    if (inputMode === 'busy') {
      inputMode = 'ok'
      const err = new Error('still generating'); err.status = 409; err.body = { state: 'busy' }; throw err
    }
    if (inputMode === 'network') {
      inputMode = 'ok'
      sent.push({ id, message, opts, lost: true })
      throw new TypeError('Failed to fetch')
    }
    sent.push({ id, message, opts })
    // The CLI writes the user turn into its transcript a moment later.
    setTimeout(() => { (transcripts[id] ||= []).push({ role: 'user', content: message, created_at: new Date().toISOString() }) }, 30)
    return { ok: true, session_id: id }
  }
}

beforeEach(() => {
  q.__resetComposerQueue()
  q.setQueueTiming({ SETTLE_MS: 40, SEND_GAP_MS: 400, CONFIRM_POLL_MS: 20, CONFIRM_TIMEOUT_MS: 1500, UNCERTAIN_TIMEOUT_MS: 250, DELIVERED_LINGER_MS: 80, TICK_MS: 15 })
  transcripts = {}
  sent = []
  inputMode = 'ok'
  installFakeApi()
  useStore.setState({ sessions: {}, sessionInputs: {}, notifications: [], pendingOptimisticMessages: {}, lastSentPrompts: {}, ws, connected: true })
  useStore.getState().loadSessions([session('a', { status: 'running', agentState: 'working' }), session('b', { cli_type: 'codex' })])
  q.ensureStarted()
})

test('only Claude and Codex sessions queue; read-only views do not', () => {
  assert.equal(q.queueSupported(session('x')), true)
  assert.equal(q.queueSupported(session('x', { cli_type: 'codex' })), true)
  assert.equal(q.queueSupported(session('x', { cli_type: 'gemini' })), false)
  assert.equal(q.queueSupported(session('x', { read_only: true })), false)
})

test('queued while working, delivered once after the turn ends, confirmed by the transcript', async () => {
  q.enqueueMessage('a', 'first follow-up')
  q.enqueueMessage('a', 'second follow-up')
  await sleep(150)
  assert.deepEqual(sent, [], 'nothing is typed while the agent works')
  assert.deepEqual(states('a'), ['queued:first follow-up', 'queued:second follow-up'])
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  assert.deepEqual(sentTo('a'), ['first follow-up\n\nsecond follow-up'], 'queued messages go out together as one prompt')
  assert.equal(sent[0].opts.ready_timeout, 8, 'the backend re-checks readiness before typing')
  assert.ok(await until(() => states('a').every((s) => s.startsWith('delivered:'))), states('a').join())
  assert.ok(await until(() => queueOf('a').items.length === 0), 'delivered rows leave the queue')
  await sleep(200)
  assert.equal(sent.length, 1, 'no second delivery')
  assert.ok((useStore.getState().pendingOptimisticMessages.a || []).some((m) => m.content === 'first follow-up\n\nsecond follow-up'))
})

test('a removed message is never sent; Edit puts it back into the composer', async () => {
  const keep = q.enqueueMessage('a', 'keep me')
  const drop = q.enqueueMessage('a', 'drop me')
  const edit = q.enqueueMessage('a', 'edit me')
  q.removeQueued('a', drop)
  useStore.getState().setSessionInput('a', 'typing')
  assert.equal(q.editQueued('a', edit), true)
  assert.equal(useStore.getState().sessionInputs.a, 'edit me\n\ntyping')
  assert.deepEqual(states('a'), ['queued:keep me'])
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  assert.deepEqual(sentTo('a'), ['keep me'])
  void keep
})

test('queue + context: the CLI gets the block once, Edit gives back the typed text (chips come back separately)', async () => {
  const block = 'Attached context:\n@docs/a.md\nUse the files and folders above as context for this message.'
  const ctx = [{ key: 'p:docs/a.md', source: 'project', kind: 'file', path: 'docs/a.md', status: 'ok' }]
  const keep = q.enqueueMessage('a', `check this\n\n${block}`, { body: 'check this', context: ctx })
  const edit = q.enqueueMessage('a', `edit me\n\n${block}`, { body: 'edit me', context: ctx })
  const item = queueOf('a').items.find((i) => i.id === edit)
  assert.deepEqual(item.context, ctx, 'the row keeps its chips (shown on the row, restored on Edit)')
  useStore.getState().setSessionInput('a', 'typing')
  assert.equal(q.editQueued('a', edit), true)
  assert.equal(useStore.getState().sessionInputs.a, 'edit me\n\ntyping', 'no raw context block in the composer')
  // Only context, no typed text: Edit leaves the draft as it was.
  const only = q.enqueueMessage('a', block, { body: '', context: ctx })
  assert.equal(q.editQueued('a', only), true)
  assert.equal(useStore.getState().sessionInputs.a, 'edit me\n\ntyping')
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  assert.equal(sentTo('a')[0], `check this\n\n${block}`)
  assert.equal(sentTo('a')[0].split('Attached context:').length, 2, 'context block exactly once')
  void keep
})

test('session switch: each queue goes to its own session only, when that one is idle', async () => {
  setStatus('b', 'running')
  q.enqueueMessage('a', 'for a')
  q.enqueueMessage('b', 'for b')
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  assert.deepEqual(sent.map((s) => [s.id, s.message]), [['a', 'for a']])
  await sleep(150)
  assert.deepEqual(sentTo('b'), [], 'b still works: its message waits')
  setStatus('b', 'idle')
  assert.ok(await until(() => sentTo('b').length === 1))
  assert.deepEqual(sentTo('b'), ['for b'])
  assert.deepEqual(sentTo('a'), ['for a'])
})

test('Stop pauses the queue until "Send queued now"', async () => {
  q.enqueueMessage('a', 'after stop')
  window.dispatchEvent(new CustomEvent('cc-session-interrupted', { detail: { sessionId: 'a' } }))
  setStatus('a', 'idle')
  await sleep(250)
  assert.deepEqual(sent, [])
  assert.equal(queueOf('a').hold?.reason, 'stopped')
  q.sendQueuedNow('a')
  assert.ok(await until(() => sent.length === 1))
  assert.deepEqual(sentTo('a'), ['after stop'])
  assert.equal(queueOf('a').hold, null)
})

test('the session exiting pauses its queue (no auto-send into a fresh start)', async () => {
  q.enqueueMessage('a', 'after exit')
  setStatus('a', 'exited')
  await sleep(60)
  assert.equal(queueOf('a').hold?.reason, 'offline')
  setStatus('a', 'idle')
  await sleep(200)
  assert.deepEqual(sent, [])
})

test('connection loss: nothing is sent while disconnected; sent once after the reconnect', async () => {
  q.enqueueMessage('a', 'while offline')
  useStore.setState({ connected: false, ws: null })
  setStatus('a', 'idle')
  await sleep(250)
  assert.deepEqual(sent, [])
  useStore.setState({ connected: true, ws })
  window.dispatchEvent(new CustomEvent('cc-websocket-reconnected', { detail: { ws } }))
  assert.ok(await until(() => sent.length === 1))
  await sleep(200)
  assert.deepEqual(sentTo('a'), ['while offline'])
})

test('backend says busy (409): stays queued and goes out once at the next idle', async () => {
  inputMode = 'busy'
  q.enqueueMessage('a', 'busy retry')
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1, 3000))
  await sleep(200)
  assert.deepEqual(sentTo('a'), ['busy retry'])
  assert.ok(await until(() => queueOf('a').items.length === 0))
})

test('send outcome unknown (connection dropped mid-request): checked, never resent automatically', async () => {
  inputMode = 'network'
  q.enqueueMessage('a', 'maybe arrived')
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  assert.ok(await until(() => states('a')[0]?.startsWith('failed:')), states('a').join())
  assert.equal(queueOf('a').hold?.reason, 'failed')
  await sleep(200)
  assert.equal(sent.length, 1, 'not resent on its own')
  // The user decides: send again.
  q.sendQueuedNow('a')
  assert.ok(await until(() => sent.length === 2))
  assert.ok(await until(() => queueOf('a').items.length === 0))
})

test('send outcome unknown but the transcript shows it: confirmed, not resent', async () => {
  inputMode = 'network'
  q.enqueueMessage('a', 'did arrive')
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 1))
  ;(transcripts.a ||= []).push({ role: 'user', content: 'did arrive', created_at: new Date().toISOString() })
  assert.ok(await until(() => states('a')[0]?.startsWith('delivered:')), states('a').join())
  await sleep(150)
  assert.equal(sent.length, 1)
})

test('reload: the queue persists; a send cut off by the reload is checked, not resent', async () => {
  q.enqueueMessage('a', 'survives reload')
  assert.match(localStorage.getItem(q.QUEUE_STORAGE_KEY), /survives reload/)
  // Simulate a page closed while a message was being sent.
  const raw = JSON.parse(localStorage.getItem(q.QUEUE_STORAGE_KEY))
  raw.a.items.push({ id: 'mid', text: 'mid send', state: 'sending', createdAt: Date.now(), dispatchedAt: Date.now() })
  localStorage.setItem(q.QUEUE_STORAGE_KEY, JSON.stringify(raw))
  q.__resetComposerQueue({ keepStorage: true })
  q.ensureStarted()
  assert.deepEqual(states('a'), ['queued:survives reload', 'sent:mid send'])
  assert.ok(await until(() => states('a').includes('failed:mid send')), states('a').join())
  setStatus('a', 'idle')
  await sleep(300)
  assert.deepEqual(sent, [], 'held: the uncertain one paused the queue')
  q.sendQueuedNow('a')
  assert.ok(await until(() => sent.length === 1))
  assert.deepEqual(sentTo('a'), ['survives reload\n\nmid send'])
})

test('drafts per session survive a reload', async () => {
  useStore.getState().setSessionInput('a', 'draft for a')
  useStore.getState().setSessionInput('b', 'draft for b')
  await sleep(400)
  useStore.setState({ sessionInputs: {} })
  q.__resetComposerQueue({ keepStorage: true })
  q.ensureStarted()
  assert.equal(useStore.getState().sessionInputs.a, 'draft for a')
  assert.equal(useStore.getState().sessionInputs.b, 'draft for b')
})

test('no double delivery from concurrent triggers', async () => {
  q.enqueueMessage('a', 'once only')
  setStatus('a', 'idle')
  for (let i = 0; i < 5; i++) window.dispatchEvent(new CustomEvent('cc-websocket-reconnected', { detail: { ws } }))
  useStore.setState({ connected: true })
  assert.ok(await until(() => sent.length >= 1))
  await sleep(300)
  assert.equal(sent.length, 1)
})

test('after a delivery the next queued message waits for that turn (no back-to-back typing)', async () => {
  setStatus('a', 'idle')
  q.enqueueMessage('a', 'one')
  assert.ok(await until(() => sent.length === 1))
  q.enqueueMessage('a', 'two')
  await sleep(150) // idle, but the turn for "one" has not been seen yet
  assert.equal(sent.length, 1)
  setStatus('a', 'running')
  await sleep(30)
  setStatus('a', 'idle')
  assert.ok(await until(() => sent.length === 2))
  assert.deepEqual(sentTo('a'), ['one', 'two'])
})
