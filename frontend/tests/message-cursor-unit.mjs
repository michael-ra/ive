import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMessageDelta, coalesce, prependOlderRows, cursorGeneration } from '../src/lib/messageCursor.js'

const row = (id, content = id) => ({ id, role: 'assistant', content })

test('plain array (DB fallback) replaces everything and drops the cursor', () => {
  const out = applyMessageDelta([row('a')], [row('x')])
  assert.deepEqual(out, { rows: [row('x')], cursor: null, changed: true, base: 0, before: null })
})

test('reset response is the full list', () => {
  const out = applyMessageDelta([row('a')], { rows: [row('b')], start: 0, updates: [], cursor: '2:1', reset: true })
  assert.deepEqual(out.rows, [row('b')])
  assert.equal(out.cursor, '2:1')
})

test('delta appends at start and applies in-place updates by position', () => {
  const prev = [row('a'), row('dup'), row('dup')]
  const out = applyMessageDelta(prev, {
    rows: [row('dup', 'new')], start: 3, updates: [[1, row('dup', 'live')]], cursor: '1:4', reset: false,
  })
  assert.equal(out.changed, true)
  assert.deepEqual(out.rows.map((r) => r.content), ['a', 'live', 'dup', 'new'])
  assert.equal(prev[1].content, 'dup', 'previous list is not mutated')
})

test('empty delta keeps the same array so the store is not touched', () => {
  const prev = [row('a')]
  const out = applyMessageDelta(prev, { rows: [], start: 1, updates: [[0, row('a')]], cursor: '1:1', reset: false })
  assert.equal(out.changed, false)
  assert.equal(out.rows, prev)
})

test('a start past what the client holds asks for a full refetch', () => {
  assert.deepEqual(applyMessageDelta([row('a')], { rows: [], start: 5, updates: [], cursor: '1:5' }), { refetch: true })
  assert.equal(applyMessageDelta([], { nope: 1 }).invalid, true)
})

test('coalesce keeps one run in flight and collapses bursts into one follow-up', async () => {
  let runs = 0
  let release
  const task = coalesce(async () => {
    runs += 1
    if (runs === 1) await new Promise((r) => { release = r })
  })
  const first = task()
  task(); task(); task()
  assert.equal(runs, 1)
  release()
  await first
  assert.equal(runs, 2)
  await task()
  assert.equal(runs, 3)
})

test('tail reset keeps base and the summary of the rows left out', () => {
  const out = applyMessageDelta(null, { rows: [row('c'), row('d')], start: 2, updates: [], cursor: '3:4', reset: true, base: 2, total: 4, before: { rows: 2, user_turns: 1 } })
  assert.equal(out.base, 2)
  assert.deepEqual(out.before, { rows: 2, user_turns: 1 })
  assert.deepEqual(out.rows.map((r) => r.id), ['c', 'd'])
})

test('delta with a base uses absolute positions', () => {
  const prev = [row('c'), row('d')]
  const out = applyMessageDelta(prev, { rows: [row('e')], start: 4, updates: [[3, row('d', 'live')], [0, row('a', 'ignored')]], cursor: '3:5', reset: false }, 2, { rows: 2 })
  assert.deepEqual(out.rows.map((r) => r.content), ['c', 'live', 'e'])
  assert.equal(out.base, 2)
  assert.deepEqual(out.before, { rows: 2 })
  assert.deepEqual(applyMessageDelta(prev, { rows: [], start: 1, updates: [], cursor: '3:1' }, 2), { refetch: true })
})

test('older pages go in front and move the base', () => {
  const out = prependOlderRows([row('c')], 2, { rows: [row('a'), row('b')], start: 0, stale: false, before: null })
  assert.deepEqual(out.rows.map((r) => r.id), ['a', 'b', 'c'])
  assert.equal(out.base, 0)
  assert.equal(prependOlderRows([row('c')], 2, { rows: [row('b')], start: 0 }).stale, true)
  assert.equal(prependOlderRows([row('c')], 2, { stale: true, rows: [] }).stale, true)
  assert.equal(cursorGeneration('7:120'), '7')
})
