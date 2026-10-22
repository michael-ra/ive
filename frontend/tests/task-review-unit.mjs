import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// Exercise the actual pure state helpers without loading browser-only API/store
// dependencies. No browser or backend is started by these tests.
const source = (await readFile(new URL('../src/lib/taskFlow.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '')
const { canAcceptTaskResult, hasPassingVerification, taskNextStep } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const task = { status: 'review' }
const run = (verify, status = 'completed') => ({ status, stage_history: { implement: { status: 'completed' }, ...(verify ? { verify } : {}) } })
const passed = { status: 'completed', output_summary: '__pipeline_result:pass:Four tests passed.' }

test('an implementation-only result points to manual board review, not acceptance', () => {
  const current = taskNextStep(task, run())
  assert.equal(canAcceptTaskResult(task, run()), false)
  assert.equal(current.boardReview, true)
  assert.match(current.detail, /choose its status manually/)
})

test('a direct-session result without a pipeline has the same board review path', () => {
  assert.equal(canAcceptTaskResult(task, null), false)
  assert.equal(taskNextStep(task, null).boardReview, true)
})

test('a completed passing verification enables guided result acceptance', () => {
  assert.equal(canAcceptTaskResult(task, run(passed)), true)
  assert.equal(taskNextStep(task, run(passed)).label, 'Review the result')
  assert.equal(taskNextStep(task, run(passed)).boardReview, undefined)
})

test('failed, unfinished and unstructured verification reports do not enable acceptance', () => {
  for (const verify of [
    { ...passed, status: 'running' },
    { ...passed, output_summary: '__pipeline_result:fail:Test failed.' },
    { ...passed, output_summary: 'All tests pass' },
    { ...passed, output_summary: null },
  ]) {
    assert.equal(hasPassingVerification(run(verify)), false)
    assert.equal(canAcceptTaskResult(task, run(verify)), false)
    assert.equal(taskNextStep(task, run(verify)).boardReview, true)
  }
})

test('verification acceptance matches the exact backend marker, without trimming', () => {
  for (const output_summary of [' __pipeline_result:pass:Report', '\n__pipeline_result:pass:Report', '__pipeline_result:PASS:Report']) {
    assert.equal(canAcceptTaskResult(task, run({ ...passed, output_summary })), false)
  }
  assert.equal(canAcceptTaskResult(task, run({ ...passed, output_summary: '__pipeline_result:pass:\nReport' })), true)
})

test('an active, cancelled or failed run cannot be accepted based on an older passing stage', () => {
  for (const status of ['running', 'paused', 'cancelled', 'failed']) {
    const currentRun = run(passed, status)
    assert.equal(canAcceptTaskResult(task, currentRun), false)
    assert.equal(taskNextStep(task, currentRun).boardReview, undefined)
  }
})

test('already completed manual tasks stay completed without inventing a passing verification', () => {
  assert.equal(canAcceptTaskResult({ status: 'done' }, run(passed)), false)
  assert.equal(hasPassingVerification(run()), false)
  assert.equal(taskNextStep({ status: 'done' }, run()).label, 'Accepted')
})
