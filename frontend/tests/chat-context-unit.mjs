import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextKey, contextLabel, contextReference, deliveryHint, formatContextBlock, queuedContextItems, splitDroppedFiles } from '../src/lib/chatContext.js'

const file = { source: 'project', kind: 'file', path: 'src/app.js', status: 'ok' }
const dir = { source: 'project', kind: 'dir', path: 'docs', status: 'ok' }
const spaced = { source: 'project', kind: 'file', path: 'docs/setup guide.md', status: 'ok' }
const upload = { source: 'upload', kind: 'file', name: 'notes.md', sha256: 'abc', absPath: '/data/attachments/sessions/s/context/abc-notes.md', path: '/data/attachments/sessions/s/context/abc-notes.md', status: 'ok' }

test('Claude gets @-mentions and the block ends outside an @ token', () => {
  const block = formatContextBlock([file, dir, spaced, upload], 'claude')
  assert.equal(block, [
    'Attached context:',
    '@src/app.js',
    '@docs/',
    '@"docs/setup guide.md"',
    '@/data/attachments/sessions/s/context/abc-notes.md',
    'Use the files and folders above as context for this message.',
  ].join('\n'))
})

test('Gemini escapes spaces the way its @ command expects', () => {
  assert.equal(contextReference(spaced, 'gemini'), '@docs/setup\\ guide.md')
})

test('Codex and other CLIs get plain paths with a note, never @', () => {
  for (const cli of ['codex', 'antigravity']) {
    const block = formatContextBlock([file, dir, upload], cli)
    assert.ok(!block.includes('@'), block)
    assert.match(block, /^Attached context \(paths are relative/)
    assert.ok(block.includes('\n- src/app.js'))
    assert.ok(block.includes('\n- docs/ (folder)'))
    assert.ok(block.includes('\n- /data/attachments/sessions/s/context/abc-notes.md (file the user attached, outside the project)'))
  }
})

test('nothing usable gives no block; failed or uploading chips are left out', () => {
  assert.equal(formatContextBlock([], 'claude'), '')
  assert.equal(formatContextBlock([{ ...file, status: 'error' }, { source: 'upload', name: 'x', status: 'uploading' }], 'claude'), '')
})

test('dedupe keys: project by path (trailing slash ignored), uploads by content hash', () => {
  assert.equal(contextKey({ source: 'project', path: 'docs/' }), contextKey(dir))
  assert.equal(contextKey(upload), contextKey({ ...upload, name: 'renamed.md' }))
  assert.notEqual(contextKey(upload), contextKey({ ...upload, sha256: 'def' }))
})

test('delivery hint names the provider and the mechanism', () => {
  assert.match(deliveryHint('claude'), /Claude gets these as @-mentions/)
  assert.match(deliveryHint('codex'), /Codex gets these paths/)
})

test('drops: images to the image flow, folders reported, the rest to context', () => {
  const mk = (name, type) => ({ name, type, size: 1 })
  const entry = (f, isDirectory = false) => ({ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory, name: f.name }) })
  const dt = { items: [entry(mk('a.png', 'image/png')), entry(mk('notes.md', 'text/markdown')), entry(mk('src', ''), true), { kind: 'string' }] }
  const out = splitDroppedFiles(dt)
  assert.deepEqual(out.images.map((f) => f.name), ['a.png'])
  assert.deepEqual(out.files.map((f) => f.name), ['notes.md'])
  assert.deepEqual(out.folders, ['src'])
  const list = splitDroppedFiles([mk('b.jpg', 'image/jpeg'), mk('log.txt', 'text/plain')])
  assert.deepEqual([list.images.length, list.files.length, list.folders.length], [1, 1, 0])
})

test('queued messages keep a small copy of their chips (no preview text, only finished ones)', () => {
  const big = { ...file, key: 'p:src/app.js', preview: 'x'.repeat(5000), children: ['a'] }
  const loading = { source: 'upload', kind: 'file', name: 'wait.md', status: 'uploading' }
  const kept = queuedContextItems([big, { ...upload, key: 'u:abc' }, loading])
  assert.equal(kept.length, 2)
  assert.ok(kept.every((c) => !('preview' in c) && !('children' in c) && c.status === 'ok'))
  assert.deepEqual(kept.map(contextLabel), ['src/app.js', 'notes.md'])
  assert.equal(contextLabel(dir), 'docs/')
})
