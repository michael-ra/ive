import test from 'node:test'
import assert from 'node:assert/strict'
import { apiBase, wsBase, appOrigin } from '../src/lib/platform.js'

function desktop(port = 5512) {
  globalThis.window = { __TAURI_INTERNALS__: {}, location: new URL(`http://127.0.0.1:${port}/`) }
  globalThis.localStorage = { getItem: () => 'http://127.0.0.1:5111' }
}
test.afterEach(() => { delete globalThis.window; delete globalThis.localStorage })
test('desktop uses its owned backend, even with a stale development URL in storage', () => {
  desktop()
  assert.equal(apiBase(), 'http://127.0.0.1:5512/api')
  assert.equal(wsBase(), 'ws://127.0.0.1:5512')
  assert.equal(appOrigin(), 'http://127.0.0.1:5512')
})
test('native bootstrap URL takes precedence', () => {
  desktop()
  window.__IVE_BACKEND__ = 'http://127.0.0.1:5513'
  assert.equal(apiBase(), 'http://127.0.0.1:5513/api')
})
test('normal browser retains same-origin relative requests', () => {
  globalThis.window = { location: new URL('https://ive.example/') }
  assert.equal(apiBase(), '/api')
  assert.equal(wsBase(), 'wss://ive.example')
})
test('the adapter does not trust arbitrary remote locations as desktop backend', () => {
  desktop()
  window.location = new URL('https://example.invalid/')
  delete globalThis.localStorage
  assert.equal(apiBase(), 'http://127.0.0.1:5111/api')
})
