// Shell navigation (BUILD-MAP A.12.3): sidebar entries with data-nav, the
// breadcrumb and address in the header, the Board badge, the URL hash read
// and written, and the level surviving a reload. Isolated Vite server,
// fully mocked API + WebSocket; no backend, PTY or session is touched.
//
//   node tests/breadcrumb-nav.mjs
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const testDir = await mkdtemp(join(tmpdir(), 'ive-breadcrumb-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5306), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()

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

const state = (page, key) => page.evaluate(async (key) => (await import('/src/state/store.js')).default.getState()[key], key)
const hash = (page) => page.evaluate(() => location.hash)
const current = (page) => page.evaluate(() => [...document.querySelectorAll('[data-nav][aria-current="page"]')].map((el) => el.dataset.nav).join(','))
const crumb = (page) => page.locator('[data-breadcrumb]').innerText()
const address = (page) => page.locator('[data-header-address]').innerText()

try {
  // ── Fresh start: Home ──
  const { context, page, errors } = await setup()
  check('fresh start lands on Home', (await current(page)) === 'home')
  check('breadcrumb says Home', /Home/.test(await crumb(page)))
  check('address is ive/home', (await address(page)) === 'ive/home')
  check('hash written as #home', (await hash(page)) === '#home', await hash(page))
  check('sidebar has the seven nav entries', await page.evaluate(() => ['home', 'board', 'review', 'knowledge', 'settings', 'connectors', 'phone'].every((id) => document.querySelector(`[data-nav="${id}"]`))))
  check('header is 44 px', await page.evaluate(() => Math.round(document.querySelector('.ive-header').getBoundingClientRect().height)) === 44)
  check('sidebar is 240 px', await page.evaluate(() => Math.round(document.querySelector('#ive-project-sidebar').getBoundingClientRect().width)) === 240)
  check('no app bar, attention bar, status bar, provider limits', await page.evaluate(() => ['.x-app-bar', '.ive-attention', '[data-status-bar]', '[data-provider-limits]', '.ive-terminal-toolbar'].every((s) => !document.querySelector(s))))
  const badge = await page.locator('[data-board-badge]').innerText()
  check('Board badge counts running · waiting without helper sessions', badge.replace(/\s+/g, ' ') === '1 · 1', badge)
  check('helper sessions are not in the project tree', await page.evaluate(() => !document.querySelector('[data-session-id="h1"], [data-session-id="h2"]')))
  check('project tree shows the three sessions', await page.evaluate(() => ['s0', 's1', 's2'].every((id) => document.querySelector(`.x-sidebar [data-session-id="${id}"] .x-session-card`))))
  const words = await page.evaluate(() => [...document.querySelectorAll('.x-sidebar [data-session-id] .x-session-status > span:first-child')].map((el) => el.textContent.trim()))
  check('status words are Running / Waiting / Done', words.join(',') === 'Running,Waiting,Done', words.join(','))
  check('foot says Connected', /Connected|Reconnecting/.test(await page.locator('[data-sidebar-foot]').innerText()))
  check('sidebar follows the theme (light background)', await page.evaluate(() => getComputedStyle(document.querySelector('#ive-project-sidebar')).backgroundColor) === 'rgb(255, 255, 255)')

  // ── Board via sidebar ──
  await page.locator('[data-nav="board"]').click()
  await page.waitForTimeout(400)
  check('Board entry is current', (await current(page)) === 'board')
  check('breadcrumb says Board', /Board/.test(await crumb(page)))
  check('address is ive/board', (await address(page)) === 'ive/board')
  check('hash is #board', (await hash(page)) === '#board', await hash(page))
  check('grid toolbar lives in the header actions slot', await page.locator('[data-header-slot="actions"] [data-grid-toolbar]').count() === 1)
  check('tiles carry data-grid-cell-session', await page.locator('[data-terminal-grid] [data-grid-cell-session]').count() >= 1)

  // ── Session via project tree ──
  await page.locator('.x-sidebar [data-session-id="s1"] .x-session-card').click()
  await page.waitForTimeout(500)
  check('clicking a session opens the Session level', (await state(page, 'sessionFocus')) === true && (await state(page, 'activeSessionId')) === 's1')
  check('session screen mounted', await page.locator('.ive-session-screen[data-session-view="s1"]').count() === 1)
  const sessionCrumb = await crumb(page)
  check('breadcrumb shows project › session', /Demo app/.test(sessionCrumb) && /Add rate limiting/.test(sessionCrumb), sessionCrumb)
  check('address is ive/demo-app/add-rate-limiting', (await address(page)) === 'ive/demo-app/add-rate-limiting', await address(page))
  check('hash is #session-s1', (await hash(page)) === '#session-s1', await hash(page))
  check('no nav entry current on the Session level', (await current(page)) === '', await current(page))
  check('session header hides the global new/search/settings buttons', await page.locator('[data-session-header] [data-new-session-button]').count() === 0 && await page.locator('[data-session-header] [aria-label="Chat with Claude"]').count() === 1)

  // ── Breadcrumb project click → Board ──
  await page.locator('[data-breadcrumb] .ive-crumb-parent').click()
  await page.waitForTimeout(400)
  check('project crumb goes to the Board', (await current(page)) === 'board' && (await hash(page)) === '#board')
  check('board filter remembers the project', (await state(page, 'boardFilters'))?.workspaceId === 'ws')

  // ── Browser back/forward follow the hash ──
  await page.goBack()
  await page.waitForTimeout(400)
  check('Back returns to the session', (await hash(page)) === '#session-s1' && (await state(page, 'sessionFocus')) === true, await hash(page))
  await page.goForward()
  await page.waitForTimeout(400)
  check('Forward returns to the Board', (await hash(page)) === '#board' && (await state(page, 'sessionFocus')) === false, await hash(page))

  // ── Setting the hash by hand (deep link while running) ──
  await page.evaluate(() => { location.hash = '#session-s2' })
  await page.waitForTimeout(500)
  check('location.hash opens that session', (await state(page, 'activeSessionId')) === 's2' && (await state(page, 'sessionFocus')) === true)

  // ── ⌘⇧H Home, ⌘⇧E Board ⇄ Session ──
  await page.keyboard.press('Meta+Shift+H')
  await page.waitForTimeout(300)
  check('⌘⇧H goes Home', (await current(page)) === 'home' && (await hash(page)) === '#home')
  await page.keyboard.press('Meta+Shift+E')
  await page.waitForTimeout(300)
  check('⌘⇧E from Home goes to the Board', (await current(page)) === 'board')
  await page.keyboard.press('Meta+Shift+E')
  await page.waitForTimeout(300)
  check('⌘⇧E from the Board opens the session', (await state(page, 'sessionFocus')) === true)
  // Escape inside a text field or the terminal belongs to it; chrome focus goes up a level.
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('Escape on the Session level goes to the Board', (await state(page, 'sessionFocus')) === false && (await current(page)) === 'board')

  // ── Reload keeps the level ──
  await page.locator('.x-sidebar [data-session-id="s0"] .x-session-card').click()
  await page.waitForTimeout(500)
  await page.reload()
  await page.locator('#ive-project-sidebar').waitFor()
  await page.waitForTimeout(900)
  check('reload keeps the Session level (operator desk + hash)', (await state(page, 'sessionFocus')) === true && (await state(page, 'activeSessionId')) === 's0', `${await hash(page)}`)
  check('reload keeps the breadcrumb', /Fix login redirect/.test(await crumb(page)))
  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()

  // ── Deep link in a fresh browser ──
  const deep = await setup({ hash: '#session-s2' })
  await deep.page.waitForTimeout(600)
  check('deep link #session-<id> opens the session in a fresh browser', (await state(deep.page, 'activeSessionId')) === 's2' && (await state(deep.page, 'sessionFocus')) === true)
  check('deep link: session screen mounted', await deep.page.locator('.ive-session-screen[data-session-view="s2"]').count() === 1)
  check('deep link: no page errors', deep.errors.length === 0, deep.errors.join(' | '))
  await deep.context.close()

  // ── Dark theme: the sidebar follows ──
  const dark = await setup({ theme: 'dark' })
  check('dark sidebar background follows the theme', await dark.page.evaluate(() => getComputedStyle(document.querySelector('#ive-project-sidebar')).backgroundColor) === 'rgb(14, 16, 20)')
  await dark.context.close()
} finally {
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) process.exitCode = 1
