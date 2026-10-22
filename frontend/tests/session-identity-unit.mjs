import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionIdentityRegistry, getSessionIdentity, sessionIdentityStyle, SESSION_IDENTITY_PALETTE, SESSION_IDENTITY_STORAGE_KEY } from '../src/lib/sessionIdentity.js'

function memoryStorage() {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('actual Overview UUID hash collision receives distinct persistent colors', () => {
  const storage = memoryStorage()
  const identity = createSessionIdentityRegistry(storage)
  const b = '9ad7e619-a390-4900-ad54-b3268ad8fc14'
  const d = '35e0bce8-6883-491c-98ba-75fe94aa398e'
  assert.equal(identity(b).name, 'olive')
  assert.notEqual(identity(d).name, identity(b).name)
  const before = new Map([b, d, 'session-a', 'session-c'].map((id) => [id, identity(id)]))
  const reloaded = createSessionIdentityRegistry(storage)
  for (const id of [...before.keys()].reverse()) assert.deepEqual(reloaded(id), before.get(id))
  assert.deepEqual(reloaded({ id: b, name: 'Renamed', status: 'error' }), before.get(b))
})

test('all twelve colors are used before balanced reuse without recoloring existing sessions', () => {
  const identity = createSessionIdentityRegistry(memoryStorage())
  const before = Array.from({ length: 12 }, (_, i) => identity(`first-${i}`))
  assert.equal(new Set(before.map((color) => color.name)).size, 12)
  const next = Array.from({ length: 12 }, (_, i) => identity(`later-${i}`))
  assert.equal(new Set(next.map((color) => color.name)).size, 12)
  for (let i = 11; i >= 0; i--) assert.deepEqual(identity(`first-${i}`), before[i])
})

test('invalid persisted indices and unavailable browser storage remain safe and stable', () => {
  const storage = memoryStorage()
  storage.setItem(SESSION_IDENTITY_STORAGE_KEY, JSON.stringify({ valid: 2, negative: -1, tooLarge: 12, string: '1', fractional: .5 }))
  const identity = createSessionIdentityRegistry(storage)
  assert.equal(identity('valid').name, 'teal')
  for (const id of ['negative', 'tooLarge', 'string', 'fractional']) assert.ok(SESSION_IDENTITY_PALETTE.includes(identity(id)))
  const unavailable = createSessionIdentityRegistry({ getItem() { throw Error('disabled') }, setItem() { throw Error('disabled') } })
  const color = unavailable('stable')
  unavailable('other')
  assert.deepEqual(unavailable('stable'), color)
})

test('session identity survives renaming, workspace/model changes and status changes', () => {
  const original = getSessionIdentity({ id: 's1', name: 'Quick session', workspace_id: 'one', status: 'idle' })
  const changed = getSessionIdentity({ id: 's1', name: 'Renamed', workspace_id: 'two', status: 'error', model: 'other' })
  assert.deepEqual(changed, original)
  assert.equal(original.name, 'plum', 'keep this persisted-ID mapping stable across refactors')
  assert.deepEqual(sessionIdentityStyle('s1'), sessionIdentityStyle({ id: 's1' }))
})

test('adjacent sessions get individual colors independent of ordering or open siblings', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const original = Object.fromEntries(ids.map((id) => [id, getSessionIdentity(id)]))
  assert.equal(new Set(Object.values(original).map((color) => color.name)).size, ids.length)
  for (const id of ids.toReversed().slice(1)) assert.deepEqual(getSessionIdentity(id), original[id])
})

const rgb = (hex) => hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
const luminance = (channels) => channels
  .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0)

test('all identity titles retain text contrast on the light and dark tinted header surfaces', () => {
  for (const color of SESSION_IDENTITY_PALETTE) {
    for (const theme of ['light', 'dark']) {
      const ink = rgb(color[theme])
      const surface = rgb(theme === 'light' ? '#EBEDEF' : '#0B0B0D')
      // The heading uses a 7% identity tint; test the actual blended surface.
      const background = surface.map((value, index) => .93 * value + .07 * ink[index])
      const a = luminance(ink), b = luminance(background)
      const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      assert.ok(contrast >= 4.5, `${color.name} ${theme}: ${contrast}`)
    }
  }
})

test('identity style exposes only theme colors, leaving status and geometry independent', () => {
  assert.deepEqual(Object.keys(sessionIdentityStyle('s1')), ['--ive-session-light', '--ive-session-dark'])
  for (const id of [null, '', 'Session-ä', '7de248a7-97e9-44ef-a6bc-91983ca2f20e']) {
    assert.match(getSessionIdentity(id).light, /^#[0-9A-F]{6}$/)
    assert.match(getSessionIdentity(id).dark, /^#[0-9A-F]{6}$/)
  }
})
