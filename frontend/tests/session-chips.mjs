// Mid-size desktop (768–1679 px) without the tab strip: session chips and
// overview cell headers must still reorder sessions and offer the tab context
// menu; Escape typed in a terminal must reach the agent while a side panel is
// open; a lazy dialog whose chunk fails must not take down the UI.
// Isolated Vite server (port 5188) with mocked API + WebSocket.
//
//   node tests/session-chips.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
const testDir = await mkdtemp(join(tmpdir(), 'ive-chips-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5188), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const mkSession = (i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
})
const sessions = [0, 1, 2].map(mkSession)

async function setup({ blockChunk = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Chips QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', '1')
  })
  const wsMsgs = []
  const deleted = []
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      try { wsMsgs.push(JSON.parse(String(raw))) } catch { /* ignore */ }
    })
  })
  if (blockChunk) await context.route(blockChunk, (route) => route.abort())
  await context.route('**/api/**', async (route) => {
    const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces') value = [ws]
    else if (p === '/sessions' && method === 'GET') value = sessions
    else if (p.startsWith('/sessions/') && method === 'DELETE') { deleted.push(p); value = {} }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (method !== 'GET') value = {}
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.waitForTimeout(600)
  await page.evaluate(async (sessions) => {
    const store = (await import('/src/state/store.js')).default
    const { startedSessions } = await import('/src/lib/terminalWriters.js')
    sessions.forEach((s) => startedSessions.add(s.id))
    store.setState({
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), openTabs: sessions.map((s) => s.id),
      activeSessionId: 's0', activeWorkspaceId: 'ws', showHome: false, sessionFocus: false,
      gridLayout: 'equal', activeGridTemplateId: null,
    })
  }, sessions)
  await page.waitForTimeout(1200)
  return { context, page, wsMsgs, deleted, errors }
}

const storeState = (page, expr) => page.evaluate(async (expr) => {
  const s = (await import('/src/state/store.js')).default.getState()
  return new Function('s', `return ${expr}`)(s)
}, expr)
const cellOrder = (page) => page.evaluate(() => [...document.querySelectorAll('[data-session-view]')]
  .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 50)
  .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.top - rb.top || ra.left - rb.left })
  .map((el) => el.dataset.sessionView))

try {
  // 1. Overview: reorder by dragging a cell header, context menu via "…".
  {
    const { context, page, deleted, errors } = await setup()
    check('tab strip stays hidden at 1280 px', !(await page.locator('.ive-tabstrip').first().isVisible().catch(() => false)))
    // Grab the header by its name, where people pick it up.
    await page.dragAndDrop('[data-session-view="s1"] [data-reorder-session="s1"]', '[data-session-view="s0"] [data-reorder-session="s0"]', { sourcePosition: { x: 24, y: 8 }, targetPosition: { x: 24, y: 8 } })
    await page.waitForTimeout(300)
    const tabs = await storeState(page, 's.openTabs')
    check('overview: dragging a cell header reorders the tabs', JSON.stringify(tabs) === JSON.stringify(['s1', 's0', 's2']), tabs.join(','))
    const order = await cellOrder(page)
    check('overview: grid order follows the new tab order', JSON.stringify(order) === JSON.stringify(['s1', 's0', 's2']), order.join(','))

    await page.locator('[data-session-view="s1"] .ive-session-menu-button').click()
    const menu = page.locator('[data-session-menu]')
    const items = await menu.getByRole('menuitem').allInnerTexts()
    check('"…" opens the tab context menu', ['Rename', 'Learn from this', 'Close session', 'Delete'].every((l) => items.includes(l)), items.join(','))
    // Deletion asks in the app's own dialog; window.confirm must not be used.
    let nativeDialog = null
    page.once('dialog', (d) => { nativeDialog = d.message(); d.dismiss() })
    await menu.getByRole('menuitem', { name: 'Delete' }).click()
    const confirm = page.getByRole('dialog', { name: /^Delete session/i })
    const asked = await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)
    check('delete from the menu asks first', asked && (await confirm.innerText()).includes('Agent 2'), asked ? '' : 'no dialog')
    if (asked) {
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await confirm.waitFor({ state: 'detached' })
    }
    check('no native confirm() is used', nativeDialog === null, nativeDialog || '')
    check('dismissing the confirm keeps the session', asked && deleted.length === 0 && (await storeState(page, 's.openTabs.includes("s1")')))
    check('no page errors (overview)', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 2. Session view: chips reorder by drag and open the menu on right-click.
  {
    const { context, page, errors } = await setup()
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goSession('s0'))
    await page.waitForTimeout(600)
    const chip = (name) => page.locator('.ive-terminal-switcher button', { hasText: name })
    await chip('Agent 3').dragTo(chip('Agent 1'))
    await page.waitForTimeout(300)
    const tabs = await storeState(page, 's.openTabs')
    check('session view: dragging a chip reorders the tabs', JSON.stringify(tabs) === JSON.stringify(['s2', 's0', 's1']), tabs.join(','))
    const chips = await page.locator('.ive-terminal-switcher button').allInnerTexts()
    check('session view: chips follow the new order', chips.join('|') === 'Agent 3|Agent 1|Agent 2', chips.join('|'))
    await chip('Agent 2').click({ button: 'right' })
    check('session view: right-click on a chip opens the menu', await page.locator('[data-session-menu]').isVisible())
    await page.locator('[data-session-menu]').getByRole('menuitem', { name: 'Close' }).click()
    await page.waitForTimeout(300)
    check('menu "Close" closes that tab', !(await storeState(page, 's.openTabs.includes("s1")')))
    check('no page errors (session view)', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 3. Escape typed into the terminal while non-modal panels are open.
  {
    const { context, page, wsMsgs, errors } = await setup()
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goSession('s0'))
    await page.waitForTimeout(600)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'files' })))
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().setGridAdjustMode(true))
    await page.waitForTimeout(400)
    const sidebarOpen = () => page.getByRole('button', { name: 'Scratchpad', exact: true }).isVisible().catch(() => false)
    const before = await sidebarOpen()
    await page.locator('[data-session-view="s0"] .xterm-helper-textarea').focus()
    const inputsBefore = wsMsgs.filter((m) => m.action === 'input' && m.data === '\x1b').length
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const escSent = wsMsgs.filter((m) => m.action === 'input' && m.data === '\x1b').length > inputsBefore
    check('Escape in the terminal reaches the agent', escSent)
    check('Escape in the terminal keeps grid adjust mode open', await storeState(page, 's.gridAdjustMode === true'))
    check('Escape in the terminal keeps the session sidebar open', before && await sidebarOpen(), `before=${before}`)
    check('Escape in the terminal keeps the Session view', await storeState(page, 's.sessionFocus === true'))
    // Outside the terminal Escape still closes the panel.
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus() })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    check('Escape outside the terminal still goes up a level', await storeState(page, '!(s.gridAdjustMode && s.sessionFocus)'))
    check('no page errors (escape)', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 4. A lazy dialog whose chunk cannot load shows "Reload IVE"; the app lives.
  {
    const { context, page } = await setup({ blockChunk: '**/src/components/command/TemplateManager.jsx*' })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'templates' })))
    await page.waitForTimeout(800)
    const shown = await page.locator('[data-ive-chunk-error]').isVisible().catch(() => false)
    check('failed lazy chunk shows "Reload IVE"', shown && await page.getByRole('button', { name: 'Reload IVE' }).isVisible())
    check('app shell survives a failed lazy chunk', await page.locator('[data-session-view="s0"]').count() > 0)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
assert.equal(failures.length, 0, failures.join('\n'))
