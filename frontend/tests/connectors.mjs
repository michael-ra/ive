import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

test('Connectors centralizes navigation, preserves failed setup and manages existing connections', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'ive-connectors-qa-'))
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'),
    server: { host: '127.0.0.1', port: 5196, strictPort: false, open: false }, logLevel: 'error' })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Connector test')
    localStorage.setItem('cc-soundEnabled', '0')
  })
  await context.routeWebSocket('**/ws', socket => socket.onMessage(() => {}))
  const writes = [], errors = [], added = []
  let failCreate = true, failKeys = false, failSaveKey = true
  const keys = {
    github: { label: 'GitHub Token', description: 'Repository search.', configured: false, used_by: ['deep_research'] },
    brave: { label: 'Brave Search API Key', description: 'Web research.', configured: true, source: 'db', used_by: ['deep_research'] },
  }
  const servers = [{ id: 'builtin-docs', name: 'IVE docs', server_name: 'ive-docs', description: 'Bundled documentation search.', command: 'ive-docs', server_type: 'stdio', args: [], env: {}, is_builtin: 1, default_enabled: 0 },
    { id: 'notes', name: 'Team notes', server_name: 'team-notes', description: 'Search shared notes.', command: 'https://example.com/mcp', server_type: 'http', args: [], env: {}, default_enabled: 0 }]
  await context.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.slice(4)
    let value = []
    if (path === '/mcp-servers' && req.method() === 'POST') {
      const body = req.postDataJSON()
      added.push(body)
      if (failCreate) { failCreate = false; return route.fulfill({ status: 503, json: { error: 'Service unavailable. Try again.' } }) }
      value = { id: 'new-connector', ...body }
      servers.push(value)
    } else if (path === '/api-keys' && req.method() === 'PUT' && req.postDataJSON().name === 'github') {
      if (failSaveKey) { failSaveKey = false; return route.fulfill({ status: 503, json: { error: 'Key could not be saved.' } }) }
      keys.github.configured = true
      keys.github.source = 'db'
      value = keys
    } else if (req.method() !== 'GET') {
      writes.push(path)
      return route.fulfill({ status: 409, json: { error: 'Unexpected write in isolated test' } })
    } else if (path === '/accounts') value = [{ id: 'claude-login', name: 'Work account', cli_type: 'claude', type: 'oauth', status: 'auth_failed' }]
    else if (path === '/mcp-servers') value = servers
    else if (path === '/api-keys') {
      if (failKeys) return route.fulfill({ status: 503, json: { error: 'Temporary outage' } })
      value = keys
    } else if (path === '/browser/detect') value = { browsers: [] }
    else if (path.includes('/auth-status')) value = { credentials_verified: false, account_status: 'auth_failed' }
    else if (path === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Connector test' }
    else if (path.startsWith('/settings/')) value = { value: path.endsWith('/product_tour_version') ? '2' : '' }
    else if (path === '/cli-info') value = { available_clis: { claude: true, codex: false, antigravity: true } }
    else if (path === '/settings' || path === '/cli-info/features') value = {}
    else if (path === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (path === '/overview') value = { workspace_total: 0, detail_limit: 5, workspaces: [] }
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  const shell = page.locator('[data-settings-shell]')
  const hub = page.getByRole('region', { name: 'Connectors', exact: true })
  await hub.getByRole('button', { name: 'Reconnect Claude' }).waitFor()
  assert.equal(await shell.getAttribute('data-settings-section'), 'connectors')
  assert.equal(await hub.getByText('1 saved account needs sign-in').count(), 1, 'A saved-account failure does not claim the local login has failed')
  // An installed CLI with no saved account runs on Local login: Manage, not Connect.
  const gemini = hub.locator('.ive-connector-row').filter({ hasText: 'Gemini' })
  await gemini.getByText('Local login · this computer').waitFor()
  assert.equal(await gemini.getByRole('button', { name: 'Manage Gemini', exact: true }).count(), 1, 'Local login is shown as connected')
  await page.screenshot({ path: '/tmp/ive-connectors-local.png' })
  await hub.getByRole('button', { name: 'Local login', exact: true }).click()
  await shell.getByText(/Local login uses the selected agent's own sign-in/).waitFor()
  assert.equal(await shell.getByRole('button', { name: /log in account/ }).count(), 0, 'Local login does not start a separate account login')
  await shell.getByRole('button', { name: 'All connectors' }).click()
  await hub.getByRole('button', { name: 'Reconnect Claude' }).click()
  await shell.getByText('Work account', { exact: true }).first().waitFor()
  await shell.getByRole('button', { name: 'All connectors' }).click()

  await hub.getByRole('tab', { name: 'Browse', exact: true }).click()
  await hub.getByLabel('Search connectors').fill('IVE docs')
  await hub.getByRole('button', { name: 'Manage IVE docs', exact: true }).waitFor()
  assert.equal(await hub.locator('.ive-connector-row').count(), 1, 'Built-in MCP servers show under All')
  await hub.getByLabel('Search connectors').fill('GitHub')
  assert.equal(await hub.locator('.ive-connector-row').count(), 1)
  await hub.getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  await shell.getByPlaceholder('Paste key…').fill('isolated-test-placeholder')
  await shell.getByRole('button', { name: 'Save', exact: true }).click()
  await shell.getByRole('alert').getByText('Key could not be saved.').waitFor()
  assert.equal(await shell.getByPlaceholder('Paste key…').inputValue(), 'isolated-test-placeholder')
  await shell.getByRole('button', { name: 'Save', exact: true }).click()
  await shell.getByText('Saved', { exact: true }).waitFor()
  await shell.getByRole('button', { name: 'All connectors' }).click()
  await hub.getByRole('button', { name: 'Manage GitHub', exact: true }).waitFor()
  await hub.getByLabel('Search connectors').fill('Codex')
  await hub.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  const accountKind = shell.locator('select').filter({ has: page.locator('option[value="oauth:codex"]') })
  assert.equal(await accountKind.inputValue(), 'oauth:codex', 'Connect selects the correct subscription login')
  assert.equal(await shell.getByPlaceholder('API key (required for API key / gateway accounts)').count(), 0)
  await shell.getByRole('button', { name: 'All connectors' }).click()

  await hub.getByRole('button', { name: 'Add connector', exact: true }).click()
  await shell.getByLabel('Name', { exact: true }).fill('Design tools')
  await shell.getByLabel('Server URL').fill('https://example.com/design/mcp')
  await shell.getByRole('button', { name: 'Add connector', exact: true }).click()
  await shell.getByRole('alert').getByText('Service unavailable. Try again.').waitFor()
  assert.equal(await shell.getByLabel('Name', { exact: true }).inputValue(), 'Design tools')
  assert.equal(await shell.getByLabel('Server URL').inputValue(), 'https://example.com/design/mcp')
  await shell.getByRole('button', { name: 'Add connector', exact: true }).click()
  await hub.getByRole('button', { name: 'Manage Design tools', exact: true }).waitFor()
  assert.equal(added.at(-1).auto_approve, false)
  assert.equal(added.at(-1).default_enabled, false)
  assert.equal(added.at(-1).server_type, 'http')
  await hub.getByRole('button', { name: 'Manage Design tools', exact: true }).click()
  assert.equal(await shell.getByPlaceholder('display name (e.g. Web Search)').inputValue(), 'Design tools')
  assert.equal(await shell.getByPlaceholder('command or URL (e.g. npx, python3, https://...)').inputValue(), 'https://example.com/design/mcp')
  await shell.getByRole('button', { name: 'All connectors' }).click()

  await page.evaluate(async () => {
    const { default: store } = await import('/src/state/store.js')
    store.getState().addNotification({ type: 'auth_failed', sessionId: 'other', cli: 'claude', message: 'An unrelated session needs login.' })
  })
  await shell.getByRole('button', { name: 'Close settings' }).click({ trial: true })
  await hub.getByRole('button', { name: 'Add connector', exact: true }).click({ trial: true })
  await page.screenshot({ path: '/tmp/ive-connectors-desktop.png' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: '/tmp/ive-connectors-dark.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  const box = await hub.boundingBox()
  assert(box.x >= 0 && box.x + box.width <= 390)
  assert(box.y + box.height <= 844)
  await hub.getByRole('button', { name: 'Add connector', exact: true }).click()
  await shell.getByLabel('Name', { exact: true }).fill('Mobile example')
  await shell.getByLabel('Server URL').fill('https://example.com/mcp')
  await shell.getByRole('button', { name: 'Add connector', exact: true }).click({ trial: true })
  await page.screenshot({ path: '/tmp/ive-connectors-mobile.png' })
  await shell.getByRole('button', { name: 'All connectors' }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })

  failKeys = true
  await shell.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await hub.getByRole('alert').waitFor()
  await hub.getByRole('button', { name: 'Reconnect Claude' }).waitFor()
  failKeys = false
  await hub.getByRole('button', { name: 'Try again' }).click()
  await hub.getByRole('button', { name: 'Manage GitHub' }).waitFor()
  assert.equal(await hub.getByRole('alert').count(), 0)

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'mcp-servers' })))
  await shell.getByRole('heading', { name: 'MCP servers', exact: true }).waitFor()
  await shell.getByText('Team notes').first().waitFor()
  await page.screenshot({ path: '/tmp/ive-connectors-mcp.png' })
  await shell.getByRole('button', { name: 'Close settings' }).click()

  for (const alias of ['mcp-servers', 'api-keys', 'accounts', 'apis-integrations']) {
    await page.evaluate(panel => window.dispatchEvent(new CustomEvent('open-panel', { detail: panel })), alias)
    await shell.locator('[data-settings-nav="connectors"][aria-current="page"]').waitFor()
    assert.equal(await shell.count(), 1, `${alias} opens the same settings hub`)
    await shell.getByRole('button', { name: 'Close settings' }).click()
  }
  assert.deepEqual(writes, [], 'No real account login or session changes happen during browsing')
  assert.deepEqual(errors, [])
})
