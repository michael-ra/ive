import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiscoveryReader } from '../src/lib/discoveryReads.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a failed refresh reports the error without replacing last successful findings', async () => {
  const states = [], data = []
  const reader = createDiscoveryReader((key, state) => states.push({ key, ...state }))
  await reader.run('inbox', async () => ['saved finding'], (rows) => data.push(rows))
  await reader.run('inbox', async () => { throw new Error('Connection unavailable') }, (rows) => data.push(rows))
  assert.deepEqual(data, [['saved finding']])
  assert.deepEqual(states.at(-1), { key: 'inbox', loading: false, error: 'Connection unavailable' })
})

test('a slow older filter request cannot overwrite newer findings or its loading state', async () => {
  const older = deferred(), newer = deferred(), states = [], data = []
  const reader = createDiscoveryReader((key, state) => states.push({ key, ...state }))
  const oldRead = reader.run('inbox', () => older.promise, (rows) => data.push(rows))
  const newRead = reader.run('inbox', () => newer.promise, (rows) => data.push(rows))
  newer.resolve(['new filter']); await newRead
  const count = states.length
  older.resolve(['old filter']); await oldRead
  assert.deepEqual(data, [['new filter']])
  assert.equal(states.length, count)
})

test('switching projects or closing Discovery invalidates all old pending tabs', async () => {
  const oldInbox = deferred(), oldSetup = deferred(), data = [], states = []
  const reader = createDiscoveryReader((key, state) => states.push({ key, ...state }))
  const inbox = reader.run('inbox', () => oldInbox.promise, (rows) => data.push(rows))
  const setup = reader.run('setup', () => oldSetup.promise, (rows) => data.push(rows))
  reader.invalidate()
  await reader.run('inbox', async () => ['new project'], (rows) => data.push(rows))
  const count = states.length
  oldInbox.resolve(['previous project']); oldSetup.reject(new Error('Old project failed'))
  await Promise.all([inbox, setup])
  assert.deepEqual(data, [['new project']])
  assert.equal(states.length, count)
})

test('independent tabs load together and malformed setup is reported as an error', async () => {
  const inbox = deferred(), states = [], data = []
  const reader = createDiscoveryReader((key, state) => states.push({ key, ...state }))
  const pending = reader.run('inbox', () => inbox.promise, (rows) => data.push(rows))
  await reader.run('setup', async () => null, () => { throw new Error('Incomplete setup data') })
  inbox.resolve(['finding']); await pending
  assert.deepEqual(data, [['finding']])
  assert(states.some((state) => state.key === 'setup' && state.error === 'Incomplete setup data'))
  assert.deepEqual(states.at(-1), { key: 'inbox', loading: false, error: '' })
})
