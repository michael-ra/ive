// Phone layout regression: isolated Vite server, fully mocked API + WebSocket.
// No real backend, PTY or session is touched.
//
//   node --test tests/mobile.mjs
//   IVE_SHOT_DIR=../review-mobile/test node --test tests/mobile.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
const shotDir = resolve(process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-mobile'))
const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const sessions = [0, 1].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: i === 1 ? 'waiting' : 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))

test('phone layout', async (t) => {
  await mkdir(shotDir, { recursive: true })
  const cache = await mkdtemp(join(tmpdir(), 'ive-mobile-vite-'))
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'),
    server: { host: '127.0.0.1', port: 5187, strictPort: false, open: false }, logLevel: 'error',
  })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())

  async function setup(viewport, theme) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: process.env.IVE_QA_BROWSER !== 'firefox', reducedMotion: 'reduce' })
    t.after(() => context.close())
    await context.addInitScript((theme) => {
      localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
      localStorage.setItem('ive_client_name', 'Mobile test')
      localStorage.setItem('cc-soundEnabled', '0')
      localStorage.setItem('ive-theme.v2', theme)
    }, theme)
    const pty = []
    await context.routeWebSocket('**/ws', (socket) => socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty', 'claim_geometry'].includes(msg.action)) return
      pty.push(msg)
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: '\x1b[H\x1b[2J' + 'mocked agent\r\n> ' })), 30)
    }))
    await context.route('**/api/**', async (route) => {
      const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
      let value = []
      if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Mobile test' }
      else if (p === '/sidechat/options') value = { providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [] }], accounts: [] }
      else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : null }
      else if (p === '/settings' || p.endsWith('/brainstormer')) value = {}
      else if (p === '/workspaces') value = [ws]
      else if (p === '/sessions') value = sessions
      else if (p === '/cli-info/features') value = cliFeatures
      else if (p === '/cli-info') value = { available_clis: { claude: true }, version: 'test' }
      else if (p.endsWith('/files')) value = { items: [] }
      else if (p.endsWith('/output')) value = { output: '' }
      else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
      else if (p === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [] }
      else if (method !== 'GET') value = {}
      await route.fulfill({ json: value })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    // Phone home is the session list (components/mobile/PhoneOverview.jsx).
    await page.locator('[data-phone-overview]').waitFor()
    return { page, errors, pty }
  }

  const noHorizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)
  // Visible, inside the viewport, at least 40px in both directions.
  async function assertTappable(locator, label, width) {
    await locator.waitFor({ state: 'visible' })
    const box = await locator.boundingBox()
    assert(box, `${label}: no box`)
    assert(box.x >= 0 && box.x + box.width <= width + 1, `${label}: off screen (${JSON.stringify(box)})`)
    assert(box.width >= 40 && box.height >= 40, `${label}: ${Math.round(box.width)}x${Math.round(box.height)} < 40px`)
  }

  for (const [width, height] of [[390, 844], [320, 640]]) for (const theme of ['light', 'dark']) {
    await t.test(`${width}x${height} ${theme}`, async () => {
      const { page, errors, pty } = await setup({ width, height }, theme)
      const tag = `${width}-${theme}`
      assert(await noHorizontalOverflow(page), 'home: horizontal page overflow')
      for (const name of ['Open sidebar', 'Search tools, sessions and projects', 'Quick help and keyboard shortcuts', 'Create a new session'])
        await assertTappable(page.getByRole('button', { name, exact: true }), `home: ${name}`, width)
      await assertTappable(page.locator('.ive-phone-overview-foot').getByRole('button', { name: /New session/ }), 'home: New session', width)
      await assertTappable(page.locator('[data-phone-session="s1"]'), 'home: session card', width)
      // "Waiting" (Agent 2 is waiting) sorts before the running Agent 1.
      const order = await page.locator('[data-phone-session]').evaluateAll((els) => els.map((e) => e.dataset.phoneSession))
      assert.deepEqual(order, ['s1', 's0'], 'Waiting first')
      assert.equal(await page.locator('[data-phone-session="s1"] [data-status]').getAttribute('data-status'), 'Waiting', 'phone card uses the new status word')
      assert.equal(await page.getByRole('button', { name: 'Open command palette' }).count(), 0, 'no floating button over the content')
      await page.screenshot({ path: join(shotDir, `${tag}-home.png`) })

      // Open a session from the sidebar drawer.
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
      await page.getByRole('dialog', { name: 'Sidebar' }).getByText('Agent 1', { exact: true }).first().tap()
      const view = page.locator('[data-session-view="s0"]')
      await page.waitForFunction(() => { const el = document.querySelector('[data-session-view="s0"]'); return el && getComputedStyle(el).opacity === '1' })
      const cell = await view.boundingBox()
      assert(cell.width >= width - 2 && cell.height >= (width === 320 ? 250 : 400), `session view too small: ${JSON.stringify(cell)}`)
      assert(await noHorizontalOverflow(page), 'session: horizontal page overflow')
      await assertTappable(page.getByRole('button', { name: 'Terminal view' }), 'session: Terminal view', width)
      await assertTappable(page.getByRole('button', { name: 'Back to sessions' }), 'session: Back to sessions', width)

      // The terminal view opens over the whole session area and the xterm fits in it.
      await page.getByRole('button', { name: 'Terminal view' }).tap()
      await page.waitForTimeout(800)
      const term = await page.evaluate(() => {
        const drawer = document.querySelector('.ive-terminal-drawer').getBoundingClientRect()
        const body = document.querySelector('.ive-terminal-drawer > div:first-child').getBoundingClientRect()
        const screen = document.querySelector('.ive-terminal-drawer .xterm-screen')?.getBoundingClientRect()
        return { drawerTop: drawer.top, drawerBottom: drawer.bottom, bodyH: body.height, screenH: screen?.height, vh: innerHeight }
      })
      assert(term.screenH > 0, 'terminal not rendered')
      assert(term.drawerBottom <= term.vh + 1, `terminal below the fold: ${JSON.stringify(term)}`)
      assert(term.bodyH >= (width === 320 ? 200 : 400), `terminal area too small: ${JSON.stringify(term)}`)
      // The PTY follows the drawer height (above the 16-row floor, it must fit).
      const rows = pty.filter((m) => m.session_id === 's0').at(-1)?.rows
      assert(rows && (rows === 16 || term.screenH <= term.bodyH + 1), `PTY not fitted to the drawer: ${rows} rows, ${JSON.stringify(term)}`)
      await page.screenshot({ path: join(shotDir, `${tag}-terminal.png`) })

      // Soft keyboard: the visual viewport shrinks by 300px; the terminal stays visible.
      await page.setViewportSize({ width, height: height - 300 })
      await page.waitForTimeout(700)
      const kb = await page.evaluate(() => {
        const drawer = document.querySelector('.ive-terminal-drawer').getBoundingClientRect()
        return { top: drawer.top, bottom: drawer.bottom, vh: innerHeight, keyboard: document.querySelector('[data-keyboard-open]') !== null }
      })
      assert(kb.keyboard, 'keyboard state not detected')
      assert(kb.bottom <= kb.vh + 1 && kb.bottom - kb.top >= 150, `keyboard covers the terminal: ${JSON.stringify(kb)}`)
      assert(await noHorizontalOverflow(page), 'keyboard: horizontal page overflow')
      await page.screenshot({ path: join(shotDir, `${tag}-keyboard.png`) })
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(400)

      // Command palette and quick help open from the header of the session list.
      await page.getByRole('button', { name: 'Back to sessions' }).tap()
      await page.locator('[data-phone-overview]').waitFor()
      await page.getByRole('button', { name: 'Search tools, sessions and projects', exact: true }).tap()
      await page.getByPlaceholder(/Search tools/).waitFor()
      assert(await noHorizontalOverflow(page), 'palette: horizontal page overflow')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Quick help and keyboard shortcuts', exact: true }).tap()
      const help = page.getByRole('dialog', { name: 'Quick help' })
      await help.waitFor()
      assert(await noHorizontalOverflow(page), 'quick help: horizontal page overflow')
      await assertTappable(help.getByRole('button', { name: 'Interaktive Einführung' }), 'quick help: Interaktive Einführung', width)
      await page.keyboard.press('Escape')
      await help.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    })
  }
})
