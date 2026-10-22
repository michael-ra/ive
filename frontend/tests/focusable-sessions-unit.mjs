import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getFocusableSessionIds, getSessionLevelTarget } from '../src/lib/focusableSessions.js'

const sessions = { a: { workspace_id: 'w1' }, b: { workspace_id: 'w1' }, c: { workspace_id: 'w2' } }
const base = { openTabs: ['a', 'b', 'c'], sessions, tabScope: 'all', activeWorkspaceId: 'w1', gridTemplates: [{ id: 't', cell_assignments: { 0: 'c', 1: 'b', 2: 'b' } }] }

test('without a template every open tab in scope can be focused', () => {
  assert.deepEqual(getFocusableSessionIds(base), ['a', 'b', 'c'])
  assert.deepEqual(getFocusableSessionIds({ ...base, tabScope: 'workspace' }), ['a', 'b'])
})

test('a custom template limits the Session level to its assigned sessions', () => {
  const state = { ...base, activeGridTemplateId: 't', activeSessionId: 'a' }
  assert.deepEqual(getFocusableSessionIds(state), ['c', 'b'])
  // The active session is not in the template: target the first assigned one,
  // not the active one App would immediately un-focus.
  assert.equal(getSessionLevelTarget(state), 'c')
  assert.equal(getSessionLevelTarget({ ...state, activeSessionId: 'b' }), 'b')
  // Mobile has no templates.
  assert.equal(getSessionLevelTarget(state, { isMobile: true }), 'a')
})
