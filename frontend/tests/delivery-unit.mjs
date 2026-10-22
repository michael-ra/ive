// Prompt delivery and reconnect resync, store level. Loads the real store and
// lib/terminal through Vite's SSR loader with fake WebSocket/API transports;
// no backend or PTY is involved.
//  - a prompt that cannot be delivered goes back into the composer (never a
//    hidden queue that only goes out in front of the next prompt)
//  - a prompt typed while the socket is down is held and sent after reconnect
//  - resyncSessions overwrites live status instead of wiping sessions
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

class FakeWs {
  constructor() { this.readyState = 1; this.sent = [] }
  send(raw) { this.sent.push(JSON.parse(raw)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let server, useStore, terminal, api
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  })
  useStore = (await server.ssrLoadModule('/src/state/store.js')).default
  terminal = await server.ssrLoadModule('/src/lib/terminal.js')
  ;({ api } = await server.ssrLoadModule('/src/lib/api.js'))
})
after(async () => { await server?.close() })

const session = (id, extra = {}) => ({ id, workspace_id: 'w', name: id, cli_type: 'claude', status: 'idle', pty_alive: true, ...extra })
const typed = (ws) => ws.sent.filter((m) => m.action === 'input').map((m) => m.data).join('')

beforeEach(() => {
  useStore.setState({ sessions: {}, sessionInputs: {}, notifications: [], pendingOptimisticMessages: {}, lastSentPrompts: {}, ws: null })
  api.sendSessionInput = async () => { throw new Error('Unexpected real input request in unit test') }
})

test('a prompt for a session that is not loaded goes back into the composer', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws })
  terminal.sendTerminalCommand('ghost', 'hello there', { restore: { sessionId: 'ghost', text: 'hello there' } })
  await sleep(20)
  assert.equal(typed(ws), '')
  assert.equal(useStore.getState().sessionInputs.ghost, 'hello there')
  assert.ok(useStore.getState().notifications.some((n) => /Not sent/.test(n.message)))
  // The next prompt is not preceded by the old one.
  useStore.getState().loadSessions([session('ghost', { cli_type: 'gemini' })])
  terminal.sendTerminalCommand('ghost', 'second')
  await sleep(1200)
  assert.ok(!typed(ws).includes('hello there'), typed(ws))
  assert.ok(typed(ws).includes('second'))
})

test('WS fallback: a prompt typed while disconnected is held and sent after the reconnect', async () => {
  useStore.getState().loadSessions([session('s1', { cli_type: 'gemini' })])
  const failed = []
  const onFail = (e) => failed.push(e.detail)
  window.addEventListener('cc-terminal-send-failed', onFail)
  terminal.sendTerminalCommand('s1', 'while offline')
  await sleep(50)
  const ws = new FakeWs()
  useStore.setState({ ws })
  window.dispatchEvent(new CustomEvent('cc-websocket-reconnected', { detail: { ws } }))
  await sleep(1200)
  window.removeEventListener('cc-terminal-send-failed', onFail)
  assert.ok(typed(ws).includes('while offline'), typed(ws))
  assert.deepEqual(failed, [])
})

test('WS fallback: the socket dropping mid-send puts the prompt back in the queue', async () => {
  useStore.getState().loadSessions([session('s2', { cli_type: 'gemini' })])
  const ws = new FakeWs()
  useStore.setState({ ws })
  terminal.sendTerminalCommand('s2', 'interrupted send')
  await sleep(100) // clear sequence sent, text not yet
  ws.readyState = 3
  await sleep(600)
  assert.ok(!typed(ws).includes('interrupted send'))
  const ws2 = new FakeWs()
  useStore.setState({ ws: ws2 })
  window.dispatchEvent(new CustomEvent('cc-websocket-reconnected', { detail: { ws: ws2 } }))
  await sleep(1200)
  assert.ok(typed(ws2).includes('interrupted send'), typed(ws2))
  assert.ok(typed(ws2).includes('\r'))
})

test('tag expansion is returned so the bubble can match the transcript', () => {
  useStore.getState().loadSessions([session('s3')])
  const out = terminal.sendTerminalCommand('s3', 'plain text')
  assert.equal(out.processed, 'plain text')
})

test('resyncSessions overwrites stale Working and pty state from the backend', () => {
  useStore.setState({
    sessions: {
      a: session('a', { status: 'running', agentState: 'working' }),
      b: session('b', { status: 'idle', agentState: 'idle', pty_alive: false }),
    },
    sessionStarted: { a: true }, sessionWorkStartedAt: { a: 1 }, sessionPtyStartedAt: { a: 1 },
  })
  useStore.getState().resyncSessions([
    { id: 'a', status: 'idle', agentState: 'idle', pty_alive: false },
    { id: 'b', status: 'idle', agentState: 'idle', pty_alive: true },
    { id: 'other', status: 'idle', pty_alive: true },
  ])
  const s = useStore.getState()
  assert.equal(s.sessions.a.status, 'idle')
  assert.equal(s.sessions.a.agentState, 'idle')
  assert.equal(s.sessions.a.pty_alive, false)
  assert.equal(s.sessionStarted.a, undefined)
  assert.equal(s.sessionWorkStartedAt.a, undefined)
  assert.equal(s.sessions.b.pty_alive, true)
  assert.equal(s.sessions.other, undefined, 'sessions the client never loaded stay out')
})

test('failed research never sends a false running message and restores the request', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws })
  useStore.getState().loadSessions([session('research-failed')])
  const original = api.startResearch
  api.startResearch = async () => { throw new Error('Provider unavailable') }
  try {
    terminal.sendTerminalCommand('research-failed', '@research explain this repository')
    await sleep(50)
    assert.equal(typed(ws), '')
    assert.equal(useStore.getState().sessionInputs['research-failed'], '@research explain this repository')
    assert.ok(useStore.getState().notifications.some((n) => /research could not start/.test(n.message)))
  } finally { api.startResearch = original }
})

test('research placeholder waits for acceptance and duplicate input starts one job', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws })
  useStore.getState().loadSessions([session('research-accepted', { cli_type: 'gemini' })])
  const original = api.startResearch
  let accept, calls = 0
  api.startResearch = () => { calls++; return new Promise((resolve) => { accept = resolve }) }
  try {
    terminal.sendTerminalCommand('research-accepted', '@research explain this repository')
    assert.equal(terminal.sendTerminalCommand('research-accepted', '@research explain this repository'), false)
    await sleep(20)
    assert.equal(typed(ws), '')
    assert.equal(calls, 1)
    accept({ job_id: 'accepted-job' })
    await sleep(1250)
    assert.match(typed(ws), /Deep research started/)
  } finally { api.startResearch = original }
})

test('Claude cold start waits for PTY startup then serializes prompts behind REST acknowledgement', async () => {
  const ws = new FakeWs()
  const originalEnsure = useStore.getState().ensureSessionRunning
  let finishStart, acknowledge
  const calls = []
  useStore.getState().loadSessions([session('claude-cold', { pty_alive: false })])
  useStore.setState({ ws, ensureSessionRunning: () => new Promise((resolve) => { finishStart = resolve }) })
  api.sendSessionInput = (id, message, options) => {
    calls.push({ id, message, options })
    return calls.length === 1 ? new Promise((resolve) => { acknowledge = resolve }) : Promise.resolve({ ok: true })
  }
  try {
    terminal.sendTerminalCommand('claude-cold', 'hello')
    terminal.sendTerminalCommand('claude-cold', 'follow-up')
    await sleep(20)
    assert.deepEqual(calls, [], 'a requested PTY start is not input readiness')
    finishStart(true)
    await sleep(20)
    assert.deepEqual(calls, [{ id: 'claude-cold', message: 'hello', options: { ready_timeout: 8 } }])
    assert.equal(typed(ws), '', 'no fire-and-forget WS text, clear, or Enter during trust setup')
    assert.equal(terminal.sendTerminalCommand('claude-cold', 'hello'), false, 'unacknowledged input remains in flight')
    acknowledge({ ok: true })
    await sleep(650)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].message, 'follow-up')
    assert.equal(typed(ws), '')
  } finally { useStore.setState({ ensureSessionRunning: originalEnsure }) }
})

test('Claude startup rejection restores the draft and removes false optimistic delivery', async () => {
  const ws = new FakeWs(), failures = []
  const onFail = (event) => failures.push(event.detail)
  useStore.getState().loadSessions([session('claude-blocked')])
  useStore.setState({
    ws,
    sessionInputs: { 'claude-blocked': 'new note' },
    pendingOptimisticMessages: { 'claude-blocked': [{ id: 'optimistic-test', role: 'user', content: 'hello' }] },
    lastSentPrompts: { 'claude-blocked': 'hello' },
  })
  api.sendSessionInput = async () => {
    throw Object.assign(new Error('session_startup_blocked'), {
      body: { startup_blocker: { type: 'trust_required', label: 'Workspace trust confirmation required' } },
    })
  }
  window.addEventListener('cc-terminal-send-failed', onFail)
  try {
    terminal.sendTerminalCommand('claude-blocked', 'hello', { restore: { sessionId: 'claude-blocked', text: 'hello' } })
    await sleep(30)
    assert.equal(typed(ws), '')
    assert.equal(useStore.getState().sessionInputs['claude-blocked'], 'hello\n\nnew note')
    assert.deepEqual(useStore.getState().pendingOptimisticMessages['claude-blocked'], [])
    assert.equal(useStore.getState().lastSentPrompts['claude-blocked'], '')
    assert.equal(failures[0].reason, 'Workspace trust confirmation required')
  } finally { window.removeEventListener('cc-terminal-send-failed', onFail) }
})

test('Claude busy follow-ups and explicit immediate delivery keep zero readiness wait', async () => {
  const ws = new FakeWs(), calls = []
  useStore.setState({ ws })
  api.sendSessionInput = async (id, message, options) => { calls.push({ id, message, options }); return { ok: true } }
  for (const [id, extra, options] of [
    ['claude-working', { status: 'working' }, {}],
    ['claude-agent-working', { agentState: 'running' }, {}],
    ['claude-immediate', {}, { delivery: 'immediate' }],
  ]) {
    useStore.getState().loadSessions([session(id, extra)])
    terminal.sendTerminalCommand(id, 'follow-up', options)
    await sleep(20)
  }
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.options.ready_timeout === 0))
  assert.equal(typed(ws), '')
})

test('Claude explicit wait-for-ready remains an opt-in queued delivery', async () => {
  const ws = new FakeWs(), calls = []
  useStore.setState({ ws })
  useStore.getState().loadSessions([session('claude-wait')])
  api.sendSessionInput = async (id, message, options) => { calls.push({ id, message, options }); return { ok: true } }
  terminal.sendTerminalCommand('claude-wait', 'after the current answer', { delivery: 'wait_for_ready' })
  await sleep(20)
  assert.equal(calls[0].options.ready_timeout, 30)
  assert.equal(typed(ws), '')
})

test('an absent, rejected or intercepted acknowledgement does not count as delivered', async () => {
  const ws = new FakeWs()
  useStore.setState({ ws })
  for (const [index, response] of [null, { ok: false }, { ok: true, intercepted: true }].entries()) {
    const id = `claude-unaccepted-${index}`
    useStore.getState().loadSessions([session(id)])
    api.sendSessionInput = async () => response
    terminal.sendTerminalCommand(id, 'preserve me')
    await sleep(20)
    assert.equal(useStore.getState().sessionInputs[id], 'preserve me')
  }
  assert.equal(typed(ws), '')
})
