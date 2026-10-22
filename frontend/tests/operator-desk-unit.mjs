// Restoring the operator desk: no stale "finished" toasts after a reload, and
// running sessions become the open tabs in a fresh browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOperatorDesk, restorableNotifications, runningSessionTabs, persistOperatorDesk, operatorDeskChanged, OPERATOR_DESK_STORAGE_KEY } from '../src/lib/operatorDesk.js'

test('finished toasts and old toasts are not restored', () => {
  const now = 1_000_000
  const kept = restorableNotifications([
    { id: 1, type: 'session_done', timestamp: now - 1000 },
    { id: 2, type: 'auth_failed', timestamp: now - 3600_000 },
    { id: 3, type: 'warning', timestamp: now - 5000 },
    { id: 4, type: 'warning', timestamp: now - 60_000 },
    { id: 5, type: 'error' },
  ], now)
  assert.deepEqual(kept.map((n) => n.id), [2, 3])
})

test('readOperatorDesk filters stored notifications', () => {
  const storage = { getItem: () => JSON.stringify({ openTabs: ['a'], notifications: [{ id: 1, type: 'session_done', timestamp: Date.now() }] }) }
  assert.deepEqual(readOperatorDesk(storage).notifications, [])
  assert.equal(OPERATOR_DESK_STORAGE_KEY, 'ive.operator-desk')
})

test('the level survives a reload: sessionFocus is stored and read back', () => {
  const written = {}
  const storage = { getItem: (key) => written[key] ?? null, setItem: (key, value) => { written[key] = value } }
  const state = { activeWorkspaceId: 'w', activeSessionId: 'a', openTabs: ['a'], notifications: [], planWaiting: {}, showHome: false, sessionFocus: true, activeNavGroup: 'work' }
  assert.equal(persistOperatorDesk(state, storage).sessionFocus, true)
  assert.equal(readOperatorDesk(storage).sessionFocus, true)
  assert.equal(readOperatorDesk({ getItem: () => JSON.stringify({ openTabs: ['a'], sessionFocus: 'yes' }) }).sessionFocus, undefined, 'only booleans are trusted')
  assert.ok(operatorDeskChanged({ ...state, sessionFocus: false }, state))
  assert.ok(!operatorDeskChanged(state, { ...state }))
})

test('running sessions become tabs, helper sessions and dead PTYs do not', () => {
  const ids = runningSessionTabs({
    a: { id: 'a', pty_alive: true, last_active_at: '2026-10-10T10:00:00' },
    b: { id: 'b', pty_alive: true, last_active_at: '2026-10-10T11:00:00' },
    c: { id: 'c', pty_alive: false },
    d: { id: 'd', pty_alive: true, session_type: 'commander' },
    e: { id: 'e', pty_alive: true, session_type: 'brainstormer' },
    f: { id: 'f', pty_alive: true, session_type: 'planner', last_active_at: '2026-10-10T09:00:00' },
    g: { id: 'g', pty_alive: true, read_only: true },
  })
  assert.deepEqual(ids, ['b', 'a', 'f'], 'planner is real work; read-only rows are other users')
})
