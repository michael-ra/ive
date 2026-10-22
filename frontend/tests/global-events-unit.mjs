import test from 'node:test'
import assert from 'node:assert/strict'
import { handleGlobalEvent } from '../src/lib/globalEvents.js'

function fixture(overrides = {}) {
  const calls = { dispatched: [], refreshed: 0 }
  const store = {
    sessions: { s1: { id: 's1', name: 'Quick', quick: true } },
    workspaces: [{ id: 'w1', preview_url: '' }, { id: 'w2', preview_url: 'http://old' }],
    notifications: [],
    hints: new Set(['s1']),
    addNotification(n) { this.notifications.push(n) },
    loadSessions(list) { for (const s of list) this.sessions[s.id] = s },
    clearProjectHint(id) { this.hints.delete(id) },
    setWorkspaces(list) { this.workspaces = list },
    ...overrides,
  }
  const ctx = {
    store,
    dispatch: (name, detail) => calls.dispatched.push([name, detail]),
    refreshWorkspaces: () => { calls.refreshed++ },
  }
  return { store, ctx, calls }
}

test('session_update without session_id merges the row and loads an unknown workspace', () => {
  const { store, ctx, calls } = fixture()
  const handled = handleGlobalEvent({ type: 'session_update', session: { id: 's1', workspace_id: 'w9', quick: false } }, ctx)
  assert.equal(handled, true)
  assert.deepEqual(store.sessions.s1, { id: 's1', name: 'Quick', quick: false, workspace_id: 'w9' })
  assert.equal(store.hints.has('s1'), false)
  assert.equal(calls.refreshed, 1)
})

test('session_update for a known workspace does not refetch, and a missing row is ignored', () => {
  const { ctx, calls } = fixture()
  handleGlobalEvent({ type: 'session_update', session_id: 's1', session: { id: 's1', workspace_id: 'w1' } }, ctx)
  assert.equal(calls.refreshed, 0)
  assert.equal(handleGlobalEvent({ type: 'session_update' }, ctx), true)
})

test('research events dispatch exactly one canonical DOM event', () => {
  const { store, ctx, calls } = fixture()
  for (const type of ['research_started', 'research_progress', 'research_done']) {
    assert.equal(handleGlobalEvent({ type, entry_id: 'e' }, ctx), true)
  }
  assert.deepEqual(calls.dispatched.map(([name]) => name), ['cc-research_started', 'cc-research_progress', 'cc-research_done'])
  assert.equal(store.notifications.length, 0)
})

test('research_error becomes one failed research_done plus one toast', () => {
  const { store, ctx, calls } = fixture()
  handleGlobalEvent({ type: 'research_error', error: 'boom' }, ctx)
  assert.equal(calls.dispatched.length, 1)
  assert.equal(calls.dispatched[0][0], 'cc-research_done')
  assert.equal(calls.dispatched[0][1].status, 'failed')
  assert.equal(store.notifications.length, 1)
  assert.match(store.notifications[0].message, /Research failed: boom/)
})

test('test_queue_update reaches the overview refresh event', () => {
  const { ctx, calls } = fixture()
  handleGlobalEvent({ type: 'test_queue_update', workspace_id: 'w1', removed: 'q1' }, ctx)
  assert.deepEqual(calls.dispatched.map(([name]) => name), ['test-queue-update'])
})

test('auto_exec_dispatch shows one toast per task', () => {
  const { store, ctx } = fixture()
  const event = { type: 'auto_exec_dispatch', workspace_id: 'w1', task_id: 't1', title: 'Add tests' }
  handleGlobalEvent(event, ctx)
  handleGlobalEvent(event, ctx)
  assert.equal(store.notifications.length, 1)
  assert.equal(store.notifications[0].type, 'info')
  assert.equal(store.notifications[0].workspaceId, 'w1')
  assert.match(store.notifications[0].message, /Add tests/)
})

test('workspace_preview_registered patches only that workspace preview_url', () => {
  const { store, ctx } = fixture()
  const before = store.workspaces
  handleGlobalEvent({ type: 'workspace_preview_registered', workspace_id: 'w1', preview_url: 'http://127.0.0.1:5173/' }, ctx)
  assert.equal(store.workspaces[0].preview_url, 'http://127.0.0.1:5173/')
  assert.equal(store.workspaces[1], before[1])
  const unchanged = store.workspaces
  handleGlobalEvent({ type: 'workspace_preview_registered', workspace_id: 'w1', preview_url: 'http://127.0.0.1:5173/' }, ctx)
  assert.equal(store.workspaces, unchanged, 'same URL must not replace the array')
})

test('phone_paired triggers the phone panel refresh event', () => {
  const { ctx, calls } = fixture()
  handleGlobalEvent({ type: 'phone_paired', device_id: 'd1', label: 'iPhone' }, ctx)
  assert.deepEqual(calls.dispatched, [['ive:phone-paired', { device_id: 'd1', label: 'iPhone' }]])
})

test('session-scoped types are left for the session switch', () => {
  const { ctx, calls } = fixture()
  assert.equal(handleGlobalEvent({ type: 'output', session_id: 's1', data: 'x' }, ctx), false)
  assert.equal(calls.dispatched.length, 0)
})
