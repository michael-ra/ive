import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeClasses } from '../src/components/ui/mergeClasses.js'

const has = (out, cls) => out.split(' ').includes(cls)

test('caller background and text colour replace the default variant', () => {
  // Docs Hub "Generate Full Documentation": was white-on-white because
  // bg-x-surface won by stylesheet order over the caller's bg-x-accent.
  const out = mergeClasses(
    'border-x-line-strong bg-x-surface text-x-ink hover:bg-x-hover px-3 py-1.5 text-xs',
    'px-4 py-2 bg-x-accent text-x-on-accent text-sm hover:bg-x-accent-ink',
  )
  for (const gone of ['bg-x-surface', 'text-x-ink', 'hover:bg-x-hover', 'px-3', 'py-1.5', 'text-xs']) {
    assert.ok(!has(out, gone), `${gone} should be dropped: ${out}`)
  }
  for (const kept of ['bg-x-accent', 'text-x-on-accent', 'text-sm', 'hover:bg-x-accent-ink', 'border-x-line-strong']) {
    assert.ok(has(out, kept), `${kept} should stay: ${out}`)
  }
})

test('text size and text colour are separate groups', () => {
  const out = mergeClasses('text-xs text-x-ink', 'text-[11px]')
  assert.equal(out, 'text-x-ink text-[11px]')
  assert.equal(mergeClasses('text-xs text-x-ink', 'text-x-accent'), 'text-xs text-x-accent')
})

test('variant prefixes only conflict with the same prefix', () => {
  const out = mergeClasses('disabled:opacity-100 opacity-90 hover:bg-x-hover', 'disabled:opacity-40 bg-x-tint')
  assert.equal(out, 'opacity-90 hover:bg-x-hover disabled:opacity-40 bg-x-tint')
})

test('padding shorthand overrides axis padding, not the other way round', () => {
  assert.equal(mergeClasses('px-3 py-1.5', 'p-1'), 'p-1')
  assert.equal(mergeClasses('p-2', 'px-1'), 'p-2 px-1')
})

test('explicit height drops the size floor so small buttons keep their size', () => {
  // StatusBar Multiplayer Share (w-6 h-6): min-h-[30px] + px-3 squeezed the icon to 0px.
  const out = mergeClasses('min-h-[30px] px-3 py-1.5', 'w-6 h-6 p-0')
  assert.equal(out, 'w-6 h-6 p-0')
})

test('border width, style and colour are independent; x-* tokens are colours', () => {
  const out = mergeClasses('border border-x-line-strong disabled:border-dashed', 'border-transparent')
  assert.equal(out, 'border disabled:border-dashed border-transparent')
  assert.equal(mergeClasses('border-x-line-strong', 'border-x-accent/30'), 'border-x-accent/30')
})

test('unknown classes and arbitrary variants are kept untouched', () => {
  const out = mergeClasses('group flex-1 [&>svg]:w-3 animate-spin', 'ive-home-btn flex-1')
  assert.equal(out, 'group flex-1 [&>svg]:w-3 animate-spin ive-home-btn')
})
