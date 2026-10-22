// Real rendering + clicks for links and fresh-session actions; no live services.
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
const temp = await mkdtemp(join(tmpdir(), 'ive-context-browser-'))
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(temp, '.vite'), server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5313), strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
const context = await browser.newContext({ viewport: { width: 1094, height: 800 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
const requests = []
await context.routeWebSocket('**/ws', () => {})
await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname
  if (route.request().method() === 'POST') requests.push({ path, body: route.request().postDataJSON() })
  await route.fulfill({ json: path.endsWith('/clone') ? { id: 'fresh', workspace_id: 'w', name: 'Fresh', cli_type: 'claude' } : {} })
})
await context.route('https://example.org/**', route => route.fulfill({ body: '<h1>External link target</h1>', contentType: 'text/html' }))
try {
  await page.goto(server.resolvedUrls.local[0])
  await page.evaluate(() => import('/tests/session-context-fixture.jsx'))
  await page.getByRole('link', { name: 'Jens Rusitschka' }).waitFor()
  assert.equal(await page.locator('#links a[href^="https:"]').count(), 5)
  assert.equal(await page.locator('#links code').count(), 0)
  assert.equal(await page.locator('#links a[href^="javascript:"]').count(), 0)
  assert.equal(await page.locator('#links').evaluate(e => e.textContent.includes('[Jens')), false)
  assert.equal(await page.getByRole('link', { name: 'Sam Dumont' }).getAttribute('href'), 'https://example.org/posts/canary_(demo)')
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Jens Rusitschka' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  assert.equal(popup.url(), 'https://example.org/jens')
  await popup.close()
  await page.getByRole('link', { name: 'Local file' }).click()
  assert.ok(requests.some(r => r.path.endsWith('/open-in-ide')))
  await page.getByRole('button', { name: 'Continue in fresh session', exact: true }).click()
  assert.ok(requests.some(r => r.path.endsWith('/clone') && r.body.context_mode === 'handoff'))
  await page.getByRole('button', { name: 'New topic', exact: true }).click()
  assert.ok(requests.some(r => r.path.endsWith('/clone') && r.body.context_mode === 'empty'))
  const state = await page.evaluate(async () => {
    const s = (await import('/src/state/store.js')).default.getState()
    return { original: s.sessions.source.name, active: s.activeSessionId }
  })
  assert.equal(state.original, 'Original'); assert.equal(state.active, 'fresh')
  const out = process.env.IVE_SHOT_DIR || join(temp, 'screenshots'); await mkdir(out, { recursive: true })
  await page.screenshot({ path: join(out, 'overview-links-context.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: nested links, plain URLs, no blue path chips, external window, file links, fresh handoff, new topic, original session preserved')
} finally { await context.close(); await browser.close(); await server.close(); await rm(temp, { recursive: true, force: true }) }
