// Helper sessions (Commander, Brainstormer) never count; archived and
// read-only sessions only on request.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HELPER_SESSION_TYPES, isHelperSession, isVisibleSession, visibleSessions, visibleSessionsOf,
  recentSessions, countByState,
} from '../src/lib/visibleSessions.js'

const sessions = {
  a: { id: 'a', name: 'Fix login', workspace_id: 'w1', status: 'running', pty_alive: true, last_active_at: '2026-10-12 10:00:00' },
  b: { id: 'b', name: 'Add limiter', workspace_id: 'w1', status: 'waiting', pty_alive: true, attention: { kind: 'permission' }, last_active_at: '2026-10-12 11:00:00' },
  c: { id: 'c', name: 'Explain', workspace_id: 'w2', status: 'idle', pty_alive: true, created_at: '2026-10-12 09:00:00' },
  d: { id: 'd', name: 'Docker', workspace_id: 'w2', status: 'error', pty_alive: false, last_active_at: '2026-10-11 10:00:00' },
  e: { id: 'e', name: 'TOML', workspace_id: 'w2', status: 'stopped', pty_alive: false },
  commander: { id: 'commander', name: 'Commander (Claude Code) — demo', session_type: 'commander', workspace_id: 'w1', status: 'idle', pty_alive: true },
  brainstormer: { id: 'brainstormer', name: 'Brainstormer', session_type: 'brainstormer', workspace_id: 'w1', status: 'running', pty_alive: true },
  archived: { id: 'archived', name: 'Old', workspace_id: 'w1', archived: 1, status: 'idle' },
  foreign: { id: 'foreign', name: 'Their brainstorm', workspace_id: 'w1', read_only: true, status: 'idle' },
  planner: { id: 'planner', name: 'Planner', session_type: 'planner', workspace_id: 'w2', status: 'idle', pty_alive: true },
}

test('helper detection is by session_type only', () => {
  assert.deepEqual([...HELPER_SESSION_TYPES].sort(), ['brainstormer', 'commander'])
  assert.equal(isHelperSession(sessions.commander), true)
  assert.equal(isHelperSession({ session_type: 'Brainstormer' }), true)
  assert.equal(isHelperSession(sessions.planner), false)
  assert.equal(isHelperSession({ name: 'Commander (Claude Code) — demo' }), false, 'a name is not a type')
  assert.equal(isHelperSession(null), false)
})

test('visibility filters helpers always, archived and read-only unless asked', () => {
  assert.deepEqual(visibleSessions(sessions).map((s) => s.id), ['a', 'b', 'c', 'd', 'e', 'planner'])
  assert.deepEqual(visibleSessions(sessions, { includeArchived: true }).map((s) => s.id), ['a', 'b', 'c', 'd', 'e', 'archived', 'planner'])
  assert.deepEqual(visibleSessions(sessions, { includeReadOnly: true }).map((s) => s.id), ['a', 'b', 'c', 'd', 'e', 'foreign', 'planner'])
  assert.equal(isVisibleSession(sessions.brainstormer, { includeArchived: true, includeReadOnly: true }), false)
  assert.deepEqual(visibleSessionsOf(sessions, 'w2').map((s) => s.id), ['c', 'd', 'e', 'planner'])
  assert.deepEqual(visibleSessionsOf(sessions, null).length, 6)
  assert.deepEqual(visibleSessions(null), [])
})

test('recent sessions sort by last activity, then creation', () => {
  assert.deepEqual(recentSessions(sessions, { limit: 3 }).map((s) => s.id), ['b', 'a', 'c'])
  assert.deepEqual(recentSessions(sessions, { limit: 2, workspaceId: 'w2' }).map((s) => s.id), ['c', 'd'])
  assert.equal(recentSessions(sessions).length, 6)
})

test('counts by state never include helpers', () => {
  assert.deepEqual(countByState(visibleSessions(sessions)), { running: 1, waiting: 1, done: 2, failed: 1, stopped: 1, total: 6 })
  assert.deepEqual(countByState([]), { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0, total: 0 })
})
