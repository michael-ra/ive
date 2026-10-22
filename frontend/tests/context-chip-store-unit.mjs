// Context chips survive a reload (lib/contextChipStore.js) like the draft and
// the queue, and a restored chip whose file is gone is marked, never sent.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
const store = await import('../src/lib/contextChipStore.js')
const { formatContextBlock, queuedContextItems } = await import('../src/lib/chatContext.js')
const { CONTEXT_STORAGE_KEY, getChips, setChips, checkRestoredChips, missingContextMessage, parseStoredChips, __resetContextChips } = store

const proj = { key: 'p:docs/architecture.md', source: 'project', kind: 'file', path: 'docs/architecture.md', size: 60, status: 'ok', absPath: '/w/docs/architecture.md', preview: '# Architecture' }
const dir = { key: 'p:docs', source: 'project', kind: 'dir', path: 'docs', status: 'ok' }
const up = { key: 'u:abc', source: 'upload', kind: 'file', name: 'notes.md', size: 12, sha256: 'abc', absPath: '/data/att/s1/context/abc-notes.md', path: '/data/att/s1/context/abc-notes.md', status: 'ok', preview: 'secret text' }
const uploading = { key: 'pending:1', source: 'upload', kind: 'file', name: 'big.md', status: 'uploading' }

test('chips are stored per session like the draft, without previews or pending uploads', () => {
  __resetContextChips()
  setChips('s1', [proj, dir, up, uploading])
  setChips('s2', [dir])
  const saved = JSON.parse(localStorage.getItem(CONTEXT_STORAGE_KEY))
  assert.deepEqual(Object.keys(saved).sort(), ['s1', 's2'])
  assert.deepEqual(saved.s1.map((c) => c.key), ['p:docs/architecture.md', 'p:docs', 'u:abc'])
  assert.ok(!JSON.stringify(saved).includes('secret text'), 'no preview text in storage')
  assert.ok(!JSON.stringify(saved).includes('Architecture'), 'no preview text in storage')
  setChips('s2', [])
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem(CONTEXT_STORAGE_KEY))), ['s1'])
})

test('after a reload the chips come back as "checking" and are not sendable yet', () => {
  __resetContextChips()
  setChips('s1', [proj, up])
  __resetContextChips({ keepStorage: true }) // reload
  const back = getChips('s1')
  assert.deepEqual(back.map((c) => [c.key, c.status, c.restored]), [['p:docs/architecture.md', 'checking', true], ['u:abc', 'checking', true]])
  assert.equal(getChips('s2').length, 0)
})

test('the check keeps chips that are still there and marks a gone file as missing', async () => {
  __resetContextChips()
  setChips('s1', [proj, dir, up])
  __resetContextChips({ keepStorage: true })
  const asked = []
  await checkRestoredChips('s1', async (chip) => {
    asked.push(chip.source === 'upload' ? `upload:${chip.absPath}` : `path:${chip.path}`)
    if (chip.path === 'docs/architecture.md') { const e = new Error('x'); e.body = { error: 'docs/architecture.md no longer exists in the session folder' }; throw e }
    return chip.kind === 'dir' ? { status: 'ok', kind: 'dir', children: ['a.md'] } : { status: 'ok', size: 12, preview: 'hello' }
  })
  assert.deepEqual(asked.sort(), ['path:docs', 'path:docs/architecture.md', 'upload:/data/att/s1/context/abc-notes.md'])
  const by = Object.fromEntries(getChips('s1').map((c) => [c.key, c]))
  assert.equal(by['p:docs/architecture.md'].status, 'missing')
  assert.match(by['p:docs/architecture.md'].error, /no longer exists/)
  assert.equal(by['p:docs'].status, 'ok')
  assert.deepEqual(by['p:docs'].children, ['a.md'])
  assert.equal(by['u:abc'].status, 'ok')
  // Never sent, never queued, and sending says why.
  const block = formatContextBlock(getChips('s1'), 'claude')
  assert.ok(!block.includes('architecture.md'), block)
  assert.ok(block.includes('@docs/'), block)
  assert.ok(!queuedContextItems(getChips('s1')).some((c) => c.key === 'p:docs/architecture.md'))
  assert.match(missingContextMessage(getChips('s1')), /^docs\/architecture\.md is no longer there\. Remove it/)
  // Removing it clears the block reason; the missing chip also survives a reload until removed.
  __resetContextChips({ keepStorage: true })
  assert.equal(getChips('s1').length, 3)
  setChips('s1', (prev) => prev.filter((c) => c.key !== 'p:docs/architecture.md'))
  assert.equal(missingContextMessage(getChips('s1')), '')
})

test('a broken or foreign storage value is ignored', () => {
  assert.deepEqual(parseStoredChips('{not json'), {})
  assert.deepEqual(parseStoredChips('[1,2]'), {})
  assert.deepEqual(parseStoredChips(JSON.stringify({ s1: 'x', s2: [{ nope: 1 }, { key: 'p:a', path: 'a' }] })), { s2: [{ key: 'p:a', source: undefined, kind: undefined, path: 'a', absPath: undefined, name: undefined, size: undefined, sha256: undefined, status: 'checking', restored: true }] })
})
