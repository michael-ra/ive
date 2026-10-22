import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkspaceContextSaver, emptyWorkspaceContext, mergeWorkspaceAutofill } from '../src/lib/workspaceContext.js'

test('retry after a partial save does not duplicate already confirmed project context', async () => {
  const writes = [], progress = []
  let failConstraints = true
  const saver = createWorkspaceContextSaver({ createMemoryEntry: async (entry) => {
    writes.push(entry)
    if (entry.name === 'Project constraints' && failConstraints) { failConstraints = false; throw new Error('Unavailable') }
    return { id: `entry-${writes.length}`, ...entry }
  } }, 'workspace-a')
  const answers = { ...emptyWorkspaceContext(), vision: 'Booking repairs', constraints: 'Preserve existing bookings', audience: 'Local riders' }
  await assert.rejects(saver.save(answers, (keys) => progress.push(keys)), /Unavailable/)
  assert.deepEqual(saver.getSavedKeys(), ['vision'])
  await saver.save(answers, (keys) => progress.push(keys))
  assert.deepEqual(writes.map((entry) => entry.name), ['Product vision', 'Project constraints', 'Project constraints', 'Target audience'])
  assert(writes.every((entry) => entry.workspace_id === 'workspace-a'))
  assert.deepEqual(progress.at(-1), ['vision', 'constraints', 'audience'])
})

test('two rapid save calls share the same in-flight writes', async () => {
  let resolve
  const pending = new Promise((done) => { resolve = done })
  let count = 0
  const saver = createWorkspaceContextSaver({ createMemoryEntry: async () => { count++; await pending; return { id: 'one' } } }, 'workspace-a')
  const first = saver.save({ vision: 'One project' })
  const second = saver.save({ vision: 'One project' })
  assert.equal(first, second)
  resolve()
  await Promise.all([first, second])
  assert.equal(count, 1)
})

test('empty optional answers cause no writes and successful repeat save is a no-op', async () => {
  const writes = []
  const saver = createWorkspaceContextSaver({ createMemoryEntry: async (entry) => { writes.push(entry); return { id: 'one' } } }, 'workspace-a')
  await saver.save(emptyWorkspaceContext())
  assert.equal(writes.length, 0)
  await saver.save({ vision: '  A repair website  ', audience: '  ' })
  await saver.save({ vision: '  A repair website  ' })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].content, 'A repair website')
})

test('voice autofill preserves typed or saved answers and only fills known empty fields', () => {
  const current = { ...emptyWorkspaceContext(), vision: 'My typed purpose', constraints: 'Keep my colors' }
  const next = mergeWorkspaceAutofill(current, { vision: 'Replacement', constraints: 'Different rules', audience: 'Cyclists', competitors: 'Saved field', extra: 'Ignore' }, ['competitors'])
  assert.equal(next.vision, 'My typed purpose')
  assert.equal(next.constraints, 'Keep my colors')
  assert.equal(next.audience, 'Cyclists')
  assert.equal(next.competitors, '')
  assert.equal(next.extra, undefined)
  assert.equal(current.audience, '')
})

test('malformed autofill and save responses do not claim successful changes', async () => {
  const current = { ...emptyWorkspaceContext(), vision: 'Existing answer' }
  assert.deepEqual(mergeWorkspaceAutofill(current, null), current)
  assert.deepEqual(mergeWorkspaceAutofill(current, { audience: {} }), current)
  const saver = createWorkspaceContextSaver({ createMemoryEntry: async () => null }, 'workspace-a')
  await assert.rejects(saver.save(current), /did not confirm/)
  assert.deepEqual(saver.getSavedKeys(), [])
})
