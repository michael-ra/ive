import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EFFORT_LEVELS, effortOptions, effortDefaultLabel, effortDisplay, headerModelInfo } from '../src/lib/effort.js'

const claude = {
  effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  effort_default: { value: 'xhigh', source: 'your Claude settings', label: 'Default (xhigh, your Claude settings)', by_model: { 'claude-opus-5': 'low' } },
}

test('fallback levels match claude --effort', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('options start with the real default, then every level', () => {
  const opts = effortOptions(claude.effort_levels, claude)
  assert.deepEqual(opts.map((o) => o.value), ['', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opts[0].label, 'Default (xhigh, your Claude settings)')
  assert.ok(!opts[0].label.startsWith('Default (high'), 'never pretends high')
})

test('per-model default from modelSettings', () => {
  assert.equal(effortDefaultLabel(claude, 'claude-opus-5'), 'Default (low, your Claude settings for claude-opus-5)')
  assert.equal(effortDisplay('', claude, 'claude-opus-5'), 'low (default)')
})

test('no effort levels -> no picker; unknown default is honest', () => {
  assert.deepEqual(effortOptions([], claude), [])
  assert.equal(effortDefaultLabel({}), 'Default (CLI setting)')
  assert.equal(effortDefaultLabel({ effort_default: { value: null, label: 'Default (Claude picks per model)' } }), 'Default (Claude picks per model)')
  assert.equal(effortDisplay('', {}), 'default')
  assert.equal(effortDisplay('max', claude), 'max')
})

test('header prefers what the transcript says the CLI used', () => {
  const session = { model: 'sonnet', effort: '' }
  const launch = headerModelInfo(session, null, claude)
  assert.deepEqual([launch.model, launch.effort, launch.observed], ['sonnet', 'xhigh', false])
  const seen = headerModelInfo(session, { model: 'claude-opus-5-5', effort: 'max' }, claude)
  assert.deepEqual([seen.model, seen.effort, seen.observed], ['claude-opus-5-5', 'max', true])
  assert.match(seen.title, /last recorded turn differs/)
  const same = headerModelInfo({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high' }, claude)
  assert.doesNotMatch(same.title, /switched/)
})
