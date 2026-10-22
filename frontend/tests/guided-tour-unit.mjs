import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOUR_STEPS, newTour, tourProgressKey, readTour, writeTour, advanceTour, pauseTour, resumeTour, restartTour, reduceTourEvent, emitTourEvent } from '../src/lib/guidedTour.js'

const at = (step, extra = {}) => ({ ...newTour(), step, workspaceId: 'workspace-1', sessionId: 'session-1', ...extra })
const task = (extra = {}) => ({ type: 'task-state', workspaceId: 'workspace-1', taskId: 'task-1', runId: 'run-1', runStatus: 'running', approval: false, ...extra })
const loop = (step) => at(step, { cyclesChosen: true, taskId: 'task-1', runId: 'run-1' })
const storage = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } }

test('initial shape, owner isolation and ordered explicit progress', () => {
  assert.deepEqual(newTour(), { version: 2, step: 'welcome', completed: [], skipped: [], workspaceId: null, sessionId: null, secondSessionId: null, taskId: null, runId: null, paused: false })
  assert.equal(tourProgressKey(true), 'ive.interactive-tour.v2.owner')
  assert.equal(tourProgressKey(false), 'ive.interactive-tour.v2.guest')
  let state = advanceTour(newTour())
  for (const step of TOUR_STEPS) { assert.equal(state.step, step); state = advanceTour(state) }
  assert.equal(state.step, 'done')
  assert.deepEqual(state.completed, TOUR_STEPS)
  assert.equal(advanceTour(state), state)
  assert.deepEqual(restartTour(state), newTour())
})

test('skipping is distinct from completing and preserves session identities', () => {
  const state = advanceTour(at('context', { skipped: ['session'], completed: ['project'] }), { skip: true })
  assert.deepEqual(state.skipped, ['session', 'context'])
  assert.deepEqual(state.completed, ['project'])
  assert.equal(state.sessionId, 'session-1')
  const revisited = advanceTour({ ...state, step: 'context' })
  assert.deepEqual(revisited.skipped, ['session'])
  assert.deepEqual(revisited.completed, ['project', 'context'])
})

test('malformed, incompatible and unavailable storage never throws', () => {
  const bad = [null, 'oops', '[]', '{}', JSON.stringify({ ...newTour(), version: 1 }), JSON.stringify({ ...newTour(), step: 'unknown' }), JSON.stringify({ ...newTour(), paused: 'false' }), JSON.stringify({ ...newTour(), workspaceId: 'a'.repeat(301) }), JSON.stringify({ ...newTour(), sessionId: 'contains\ncontent' }), JSON.stringify({ ...newTour(), completed: ['context'], skipped: ['context'] }), JSON.stringify({ ...newTour(), replyBaselineIds: Array(201).fill('id') })]
  for (const raw of bad) assert.deepEqual(readTour({ getItem: () => raw }, true), newTour())
  assert.deepEqual(readTour({ getItem() { throw Error('blocked') } }, true), newTour())
  assert.equal(writeTour({ setItem() { throw Error('full') } }, true, newTour()), false)
  assert.equal(writeTour(null, true, newTour()), false)
  assert.equal(writeTour(storage(), true, { ...newTour(), step: 'bad' }), false)
})

test('persistence whitelists progress, not content, and reload preserves pause and reply baseline', () => {
  const store = storage()
  const state = pauseTour(at('answer', { replyBaselineIds: ['old-message'], replyAfter: 123, contextSending: false, cyclesChosen: true, maxIterations: 3, inspected: true }))
  assert.equal(writeTour(store, true, { ...state, message: 'secret prompt', arbitrary: { repository: 'contents' } }), true)
  assert.deepEqual(readTour(store, true), state)
  assert(!store.getItem(tourProgressKey(true)).includes('secret'))
  assert.deepEqual(readTour(store, false), newTour())
  const event = { type: 'assistant-reply', sessionId: 'session-1', messageId: 'new-message' }
  assert.equal(reduceTourEvent(readTour(store, true), event).step, 'answer')
  assert.equal(reduceTourEvent(resumeTour(readTour(store, true)), event).step, 'overview')
})

test('project and first AI session require actual successful matching events', () => {
  let state = advanceTour(newTour())
  assert.equal(reduceTourEvent(state, { type: 'project-connected', workspaceId: '' }), state)
  state = reduceTourEvent(state, { type: 'project-connected', workspaceId: 'workspace-1' })
  assert.equal(state.step, 'session')
  for (const event of [{ workspaceId: 'wrong', sessionId: 's', cliType: 'claude' }, { workspaceId: 'workspace-1', sessionId: 's', cliType: 'shell' }, { workspaceId: 'workspace-1', sessionId: 's' }]) assert.equal(reduceTourEvent(state, { type: 'session-created', ...event }), state)
  state = reduceTourEvent(state, { type: 'session-created', workspaceId: 'workspace-1', sessionId: 'session-1', cliType: 'claude' })
  assert.equal(state.step, 'context')
  assert.equal(state.sessionId, 'session-1')
})

test('context errors, wrong sessions and old or incomplete assistant replies cannot advance', () => {
  let state = at('context')
  assert.equal(reduceTourEvent(state, { type: 'context-sent', sessionId: 'wrong' }), state)
  state = reduceTourEvent(state, { type: 'context-started', sessionId: 'session-1', baselineIds: ['old'], replyAfter: 100 })
  assert.equal(state.step, 'context')
  assert.equal(state.contextSending, true)
  assert.equal(reduceTourEvent(state, { type: 'context-error', sessionId: 'session-1' }), state)
  state = reduceTourEvent(state, { type: 'context-sent', sessionId: 'session-1' })
  assert.equal(state.step, 'answer')
  assert.equal(state.contextSending, false)
  for (const event of [{ sessionId: 'wrong', messageId: 'new' }, { sessionId: 'session-1' }, { sessionId: 'session-1', messageId: '' }, { sessionId: 'session-1', messageId: 'old' }]) assert.equal(reduceTourEvent(state, { type: 'assistant-reply', ...event }), state)
  assert.equal(reduceTourEvent(state, { type: 'assistant-reply', sessionId: 'session-1', messageId: 'new' }).step, 'overview')
})

test('Overview requires another AI session in the same workspace and focus back on first', () => {
  let state = at('overview')
  assert.equal(reduceTourEvent(state, { type: 'session-focused', sessionId: 'session-1' }), state)
  for (const event of [{ workspaceId: 'other', sessionId: 'second' }, { workspaceId: 'workspace-1', sessionId: 'session-1' }]) assert.equal(reduceTourEvent(state, { type: 'session-created', cliType: 'codex', ...event }), state)
  state = reduceTourEvent(state, { type: 'session-created', workspaceId: 'workspace-1', sessionId: 'second', cliType: 'codex' })
  assert.equal(state.step, 'overview')
  assert.equal(reduceTourEvent(state, { type: 'session-focused', sessionId: 'second' }), state)
  state = reduceTourEvent(state, { type: 'session-focused', sessionId: 'session-1' })
  assert.equal(state.step, 'loop-setup')
  assert.equal(state.sessionId, 'session-1')
  assert.equal(state.secondSessionId, 'second')
})

test('loop settings alone never start a run and task binding requires matching IDs', () => {
  let state = at('loop-setup')
  assert.equal(reduceTourEvent(state, task()), state)
  assert.equal(reduceTourEvent(state, { type: 'loop-settings', chosen: true, maxIterations: 0 }), state)
  state = reduceTourEvent(state, { type: 'loop-settings', chosen: true, maxIterations: 3 })
  assert.equal(state.step, 'loop-setup')
  for (const extra of [{ workspaceId: 'wrong' }, { runId: null }, { taskId: null }, { runStatus: 'failed' }]) assert.equal(reduceTourEvent(state, task(extra)), state)
  state = reduceTourEvent(state, task())
  assert.equal(state.step, 'loop-plan')
  assert.equal(state.runId, 'run-1')
  assert.equal(state.taskId, 'task-1')
  for (const extra of [{ taskId: 'wrong' }, { runId: 'wrong' }, { workspaceId: 'wrong' }]) assert.equal(reduceTourEvent(state, task({ currentStages: ['implement'], ...extra })), state)
})

test('plan approval and server stage gates never autoapprove or treat failure as progress', () => {
  const state = loop('loop-plan')
  for (const extra of [{ approval: true, currentStages: ['implement'] }, { approval: null, currentStages: ['implement'] }, { runStatus: 'paused', currentStages: ['implement'] }, { currentStages: ['plan'] }, { runStatus: 'completed', verified: false }, ...['failed', 'cancelled', 'max_iterations'].map((runStatus) => ({ runStatus, verified: true, currentStages: ['implement'] }))]) assert.equal(reduceTourEvent(state, task(extra)), state)
  assert.equal(reduceTourEvent(state, task({ currentStages: ['implement'] })).step, 'loop-run')
  assert.equal(reduceTourEvent(state, task({ currentStages: [{ id: 'fix' }] })).step, 'loop-run')
  assert.equal(reduceTourEvent(state, task({ runStatus: 'completed', verified: true })).step, 'loop-run')
})

test('review requires verified complete result, explicit acceptance and inspection', () => {
  let state = loop('loop-run')
  for (const extra of [{ runStatus: 'completed', verified: true, canAccept: false }, { runStatus: 'completed', verified: false, canAccept: true }, { runStatus: 'running', verified: true, canAccept: true }, { runStatus: 'failed', verified: true, canAccept: true }]) assert.equal(reduceTourEvent(state, task(extra)), state)
  state = reduceTourEvent(state, task({ runStatus: 'completed', verified: true, canAccept: true }))
  assert.equal(state.step, 'review')
  assert.equal(reduceTourEvent(state, task({ taskStatus: 'done' })), state)
  state = reduceTourEvent(state, task({ taskStatus: 'review', inspected: true }))
  assert.equal(state.step, 'review')
  assert.equal(state.inspected, true)
  assert.equal(reduceTourEvent(state, task({ taskStatus: 'done', runStatus: 'cancelled' })), state)
  state = reduceTourEvent(state, task({ taskStatus: 'done' }))
  assert.equal(state.step, 'tools')
  assert.equal(reduceTourEvent(state, { type: 'tool-opened', toolId: 'invented' }), state)
  assert.equal(reduceTourEvent(state, { type: 'tool-opened', toolId: 'memory' }).step, 'done')
})

test('event emitter is safe without browser and keeps the requested event type', () => {
  emitTourEvent('tool-opened', { toolId: 'memory' })
  const previous = globalThis.window
  const events = []
  globalThis.window = { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } }, dispatchEvent(event) { events.push(event) } }
  try {
    emitTourEvent('tool-opened', { toolId: 'memory', type: 'wrong' })
    assert.equal(events[0].type, 'ive-tour-event')
    assert.deepEqual(events[0].detail, { type: 'tool-opened', toolId: 'memory' })
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous }
})

test('one completed snapshot can be replayed after reload, one genuine step at a time', () => {
  const snapshot = task({ runStatus: 'completed', taskStatus: 'review', verified: true, canAccept: true, inspected: false })
  const store = storage()
  writeTour(store, true, pauseTour(at('loop-setup', { cyclesChosen: true })))
  let state = readTour(store, true)
  assert.equal(reduceTourEvent(state, snapshot), state)
  state = resumeTour(state)
  for (const step of ['loop-plan', 'loop-run', 'review']) {
    state = reduceTourEvent(state, snapshot)
    assert.equal(state.step, step)
    assert.equal(writeTour(store, true, state), true)
    state = readTour(store, true)
  }
  assert.equal(reduceTourEvent(state, snapshot), state)
  assert.equal(reduceTourEvent(state, { ...snapshot, taskStatus: 'done' }), state)
  state = reduceTourEvent(state, { ...snapshot, taskStatus: 'done', inspected: true, canAccept: false })
  assert.equal(state.step, 'tools')
  assert.equal(reduceTourEvent(state, { ...snapshot, inspected: true }), state)
  assert.deepEqual(state.completed, ['loop-setup', 'loop-plan', 'loop-run', 'review'])
})

test('already accepted snapshots catch up without skipping inspection or verification', () => {
  const snapshot = task({ runStatus: 'completed', taskStatus: 'done', verified: true, canAccept: false })
  let state = loop('loop-plan')
  state = reduceTourEvent(state, snapshot)
  assert.equal(state.step, 'loop-run')
  assert.equal(reduceTourEvent(state, { ...snapshot, verified: false }), state)
  state = reduceTourEvent(state, snapshot)
  assert.equal(state.step, 'review')
  assert.equal(reduceTourEvent(state, snapshot), state)
  assert.equal(reduceTourEvent(state, { ...snapshot, inspected: true }).step, 'tools')
})

test('retry requires explicit setup binding reset and rejects stale runs afterwards', () => {
  const old = loop('loop-run')
  const retry = task({ runId: 'run-2', currentStages: ['implement'] })
  assert.equal(reduceTourEvent(old, retry), old)
  const unbound = { ...old, runId: null }
  assert.equal(reduceTourEvent(unbound, retry), unbound)
  const reset = { ...old, step: 'loop-setup', taskId: null, runId: null, inspected: false }
  const rebound = reduceTourEvent(reset, retry)
  assert.equal(rebound.step, 'loop-plan')
  assert.equal(rebound.runId, 'run-2')
  assert.equal(reduceTourEvent(rebound, task({ currentStages: ['implement'] })), rebound)
  assert.equal(reduceTourEvent(rebound, retry).step, 'loop-run')
})
