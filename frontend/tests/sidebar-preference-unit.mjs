import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from 'zustand/vanilla'
import { SIDEBAR_VISIBILITY_KEY, readSidebarVisibility, persistSidebarVisibility } from '../src/lib/sidebarPreference.js'

test('only a saved hidden preference collapses navigation on startup', () => {
  for (const value of [null, '', 'true', 'null', 'corrupted']) {
    assert.equal(readSidebarVisibility({ getItem: () => value }), true)
  }
  assert.equal(readSidebarVisibility({ getItem: () => 'false' }), false)
  assert.equal(readSidebarVisibility({ getItem() { throw new Error('Blocked') } }), true)
})

test('store changes from any entry point persist and survive recreation', () => {
  const data = new Map(), writes = []
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); data.set(key, value) } }
  const store = createStore(() => ({ sidebarVisible: readSidebarVisibility(storage), sessionCount: 0 }))
  const stop = persistSidebarVisibility(store, () => storage)
  store.setState({ sidebarVisible: false })
  assert.equal(readSidebarVisibility(storage), false)
  store.setState({ sessionCount: 3 })
  store.setState({ sidebarVisible: false })
  assert.deepEqual(writes, [[SIDEBAR_VISIBILITY_KEY, 'false']])
  store.setState({ sidebarVisible: true })
  assert.equal(readSidebarVisibility(storage), true)
  assert.equal(writes.length, 2)
  stop()
  store.setState({ sidebarVisible: false })
  assert.equal(writes.length, 2)
})

test('unavailable or full browser storage does not break toggling', () => {
  for (const getStorage of [() => null, () => { throw new Error('Unavailable') }, () => ({ setItem() { throw new Error('Full') } })]) {
    const store = createStore(() => ({ sidebarVisible: true }))
    const stop = persistSidebarVisibility(store, getStorage)
    assert.doesNotThrow(() => store.setState({ sidebarVisible: false }))
    assert.equal(store.getState().sidebarVisible, false)
    assert.doesNotThrow(() => store.setState({ sidebarVisible: true }))
    assert.equal(store.getState().sidebarVisible, true)
    stop()
  }
})
