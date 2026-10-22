// /model opens the IVE model picker without sending a CLI command.
// Isolated fixture; no real provider calls or user data.
// node tests/model-command.mjs (IVE_QA_BROWSER=webkit, IVE_QA_CLI=codex)
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const testDir = await mkdtemp(join(tmpdir(), 'ive-model-command-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5316), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()

const updates = []
const sent = []
const failures = []
let total = 0
const check = (name, ok, detail = '') => {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ws = { id: 'ws', name: 'Demo app', path: '/isolated/demo-app', color: '#1647ff' }
const sessions = [
  { id: 's0', workspace_id: 'ws', name: 'Fix login redirect', cli_type: 'claude', model: 'sonnet', status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [] },
  { id: 's1', workspace_id: 'ws', name: 'Add rate limiting', cli_type: 'claude', model: 'sonnet', status: 'waiting', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
    attention: { kind: 'permission', title: 'Permission needed', message: 'Claude wants to run npm test', source: 'hook' } },
  { id: 's2', workspace_id: 'ws', name: 'Explain architecture', cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [] },
  // Helper sessions never count and never show in the tree.
  { id: 'h1', workspace_id: 'ws', name: 'Commander (Claude Code) — Demo app', cli_type: 'claude', model: 'opus', status: 'running', pty_alive: true, session_type: 'commander', archived: 0, tags: [] },
  { id: 'h2', workspace_id: 'ws', name: 'Brainstormer', cli_type: 'claude', model: 'sonnet', status: 'waiting', pty_alive: true, session_type: 'brainstormer', archived: 0, tags: [] },
]

const testedModel = process.env.IVE_QA_CLI === 'codex' ? 'gpt-5.5' : 'opus'
if (process.env.IVE_QA_CLI === 'codex') Object.assign(sessions[2], { cli_type: 'codex', model: 'gpt-6-astra' })

async function setup({ hash = '', theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript((theme) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Nav QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('ive-theme.v2', theme)
    localStorage.setItem('cc-terminalBoardMode', '0')
  }, theme)
  await context.routeWebSocket('**/ws', (socket) => socket.onMessage((raw) => {
    sent.push(String(raw))
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (['start_pty', 'resize', 'resume_pty'].includes(msg.action)) {
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: '\x1b[2J\x1b[H> ' })), 20)
    }
  }))
  await context.route('**/api/**', async (route) => {
    const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? '2' : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces') value = [ws]
    else if (p === '/sessions' && method === 'GET') value = sessions
    else if (p.startsWith('/sessions/') && method === 'PUT') {
      const patch = req.postDataJSON(); updates.push({ path: p, patch });
      value = { ...sessions.find(s => s.id === p.split('/')[2]), ...patch }
    }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (p === '/cost') value = []
    else if (method !== 'GET') value = {}
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url + hash)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.locator('#ive-project-sidebar').waitFor()
  await page.waitForTimeout(600)
  return { context, page, errors }
}

try {
  const { context, page, errors } = await setup({ hash: '#session-s2' })
  const input = page.locator('.ive-session-screen textarea').last()
  const menu = page.locator('[data-testid="chat-header-model-menu"][data-session-id="s2"]')
  const fill = async text => { await input.fill(text); await input.press('End') }
  await fill('/model')
  await input.press('Enter')
  await menu.waitFor()
  check('Enter opens model choices immediately', await menu.locator('button').count() > 1)
  check('opening the picker does not switch a model', updates.length === 0)
  check('command leaves no message draft', await input.inputValue() === '')
  check('keyboard focus moves to a model choice', await menu.evaluate(el => el.contains(document.activeElement)))
  const prior = await page.evaluate(() => document.activeElement.textContent)
  await page.keyboard.press('ArrowDown')
  check('ArrowDown navigates choices', await page.evaluate(() => document.activeElement.textContent) !== prior)
  await page.keyboard.press('Escape')
  check('Escape closes model choices', await menu.count() === 0)
  await fill('/mo')
  await page.getByRole('option').filter({ hasText: '/model' }).click()
  await menu.waitFor()
  check('clicking partial command opens model choices', await input.inputValue() === '')
  await menu.getByRole('button', { name: new RegExp(testedModel) }).first().click()
  await page.waitForFunction(model => document.querySelector('[data-testid="chat-header-model-value"]')?.textContent.includes(model), testedModel)
  check('selection uses existing live model API', updates.some(x => x.path === '/sessions/s2' && x.patch.model === testedModel && x.patch.apply_live === true))
  await page.keyboard.press('Escape')
  await fill('/model ')
  await input.press('Enter')
  await menu.waitFor()
  check('direct submit also opens the model picker', await input.inputValue() === '')
  await page.keyboard.press('Escape')
  await fill('/model')
  await input.press('Tab')
  await menu.waitFor()
  check('Tab accepts the model command', await input.inputValue() === '')
  await page.keyboard.press('Escape')
  check('model command never reaches CLI input', !sent.some(raw => /\/model/.test(raw)))
  await fill('Explain /mo')
  await input.press('Tab')
  check('embedded slash text remains ordinary text', await input.inputValue() === 'Explain /model ')
  check('embedded command does not open model choices', await menu.count() === 0)
  await fill('/help')
  await input.press('Tab')
  check('other slash commands retain autocomplete', await input.inputValue() === '/help ')
  await page.locator('[data-nav="board"]').click()
  const tile = page.locator('[data-grid-cell-session="s2"]')
  const tileInput = tile.locator('textarea').last()
  await tileInput.fill('/model'); await tileInput.press('End'); await tileInput.press('Enter')
  await menu.waitFor()
  check('model picker works inside Board tiles', await menu.locator('button').count() > 1)
  check('no page errors', errors.length === 0, errors.join('; '))
  if (process.env.IVE_QA_SCREENSHOT) await page.screenshot({ path: process.env.IVE_QA_SCREENSHOT })
  await context.close()
} finally {
  await browser.close(); await server.close(); await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) process.exitCode = 1
