import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOUR_VERSION, completeOnboarding, loadOnboarding, tourStorageKey } from '../src/lib/onboarding.js'

function fixture({ actor = 'localhost', settings = {}, fail = null, blockedStorage = false } = {}) {
  const data = new Map(Object.entries(settings)), local = new Map(), calls = []
  const storage = {
    getItem(key) { if (blockedStorage) throw new Error('Storage blocked'); return local.get(key) ?? null },
    setItem(key, value) { if (blockedStorage) throw new Error('Storage blocked'); local.set(key, value) },
  }
  const request = async (path, options = {}) => {
    calls.push({ path, ...options })
    if (fail?.(path, options)) throw new Error('Connection unavailable')
    if (path === '/whoami') return { actor_kind: actor }
    assert(path.startsWith('/settings/'), 'onboarding must never call task/session endpoints')
    const key = path.slice('/settings/'.length)
    if (options.method === 'PUT') { data.set(key, JSON.parse(options.body).value); return { ok: true } }
    return { value: data.get(key) ?? null }
  }
  return { data, local, calls, storage, request }
}

test('fresh and previously name-only onboarded owners receive the new guide', async () => {
  for (const settings of [{}, { owner_name: 'Max', owner_intro_completed_at: '2026-09-01' }]) {
    const f = fixture({ settings })
    const result = await loadOnboarding(f)
    assert.equal(result.shouldShow, true)
    assert.equal(result.profile.owner, true)
    assert.equal(result.profile.name, settings.owner_name || '')
    assert(f.calls.every((call) => !call.method), 'loading must be read-only')
  }
})

test('only current or newer server completion and current browser dismissal suppress replay', async () => {
  for (const version of [String(TOUR_VERSION), String(TOUR_VERSION + 1)]) {
    const f = fixture({ settings: { product_tour_version: version, owner_name: 'Max' } })
    const result = await loadOnboarding(f)
    assert.equal(result.shouldShow, false)
    assert.equal(result.profile.name, 'Max')
  }
  const local = fixture()
  local.storage.setItem(tourStorageKey(true), 'done')
  assert.equal((await loadOnboarding(local)).shouldShow, false)
})

test('version 1 server and browser completion still offer the new interactive guide', async () => {
  const f = fixture({ settings: { product_tour_version: '1', owner_name: 'Max' } })
  f.storage.setItem('ive.onboarding.v1.owner', 'done')
  assert.equal((await loadOnboarding(f)).shouldShow, true)
  assert.equal(f.storage.getItem(tourStorageKey(true)), null)
  const guest = fixture({ actor: 'joiner_session' })
  guest.storage.setItem('ive.onboarding.v1.guest', 'done')
  assert.equal((await loadOnboarding(guest)).shouldShow, true)
})

test('owner completion writes the name before the final version marker', async () => {
  const f = fixture(), names = []
  await completeOnboarding({ ...f, profile: { owner: true, name: '' }, name: '  Alex  ', onNameSaved: (name) => names.push(name) })
  assert.deepEqual(f.calls.map((call) => call.path), ['/settings/owner_name', '/settings/owner_intro_completed_at', '/settings/product_tour_version'])
  assert.deepEqual(names, ['Alex'])
  assert.equal(f.data.get('owner_name'), 'Alex')
  assert.equal(f.data.get('product_tour_version'), String(TOUR_VERSION))
  assert.equal(f.storage.getItem(tourStorageKey(true)), 'done')
  assert(f.calls.every((call) => call.signal instanceof AbortSignal), 'writes must time out')
})

test('skip, empty name and unchanged name never replace the existing identity', async () => {
  for (const options of [{ name: 'Unsaved', skip: true }, { name: '' }, { name: 'Max' }]) {
    const f = fixture({ settings: { owner_name: 'Max' } })
    await completeOnboarding({ ...f, profile: { owner: true, name: 'Max' }, ...options })
    assert.equal(f.data.get('owner_name'), 'Max')
    assert.equal(f.calls.some((call) => call.path === '/settings/owner_name'), false)
    assert.equal(f.data.get('product_tour_version'), String(TOUR_VERSION))
  }
})

test('a failed save does not mark completion; explicit local dismissal makes no further request', async () => {
  const f = fixture({ fail: (path, options) => options.method === 'PUT' })
  await assert.rejects(completeOnboarding({ ...f, profile: { owner: true, name: '' }, name: 'Alex' }), /Connection unavailable/)
  assert.equal(f.data.get('product_tour_version'), undefined)
  assert.equal(f.storage.getItem(tourStorageKey(true)), null)
  const previousCalls = f.calls.length
  await completeOnboarding({ ...f, profile: { owner: true, name: '' }, localOnly: true })
  assert.equal(f.calls.length, previousCalls)
  assert.equal(f.storage.getItem(tourStorageKey(true)), 'done')
})

test('partial save reports the saved name but preserves a retryable completion state', async () => {
  const f = fixture({ fail: (path, options) => path.endsWith('product_tour_version') && options.method === 'PUT' })
  const names = []
  await assert.rejects(completeOnboarding({ ...f, profile: { owner: true, name: '' }, name: 'Alex', onNameSaved: (name) => names.push(name) }))
  assert.deepEqual(names, ['Alex'])
  assert.equal(f.data.get('owner_name'), 'Alex')
  assert.equal(f.storage.getItem(tourStorageKey(true)), null)
})

test('joiners never read or write owner settings and use a separate browser preference', async () => {
  const f = fixture({ actor: 'joiner_session' })
  const result = await loadOnboarding(f)
  assert.equal(result.shouldShow, true)
  assert.equal(result.profile.owner, false)
  await completeOnboarding({ ...f, profile: result.profile, name: 'Ignored' })
  assert.deepEqual(f.calls.map((call) => call.path), ['/whoami'])
  assert.equal(f.storage.getItem(tourStorageKey(false)), 'done')
  assert.equal(f.storage.getItem(tourStorageKey(true)), null)
  assert.equal((await loadOnboarding(f)).shouldShow, false)
})

test('unavailable browser storage does not break loading or successful owner completion', async () => {
  const f = fixture({ blockedStorage: true })
  const result = await loadOnboarding(f)
  assert.equal(result.shouldShow, true)
  await completeOnboarding({ ...f, profile: result.profile, skip: true })
  assert.equal(f.data.get('product_tour_version'), String(TOUR_VERSION))
})

test('failed settings reads still offer the guide; missing authentication does not', async () => {
  const f = fixture({ fail: (path) => path.startsWith('/settings/') })
  assert.equal((await loadOnboarding(f)).shouldShow, true)
  assert.equal((await loadOnboarding(fixture({ actor: null }))).shouldShow, false)
  const unavailable = fixture({ fail: () => true })
  await assert.rejects(loadOnboarding(unavailable), /Connection unavailable/)
})
