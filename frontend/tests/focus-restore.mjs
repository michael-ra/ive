// Keyboard focus after navigation and dialogs: browser regression with an
// isolated Vite server and fully mocked API + WebSocket (no backend, no PTY).
//
// Whatever took the keyboard away (a sidebar click, a tab shortcut, a level
// switch, a modal, a menu), typing must end up in the selected session's
// terminal again, and Escape on a menu only closes that menu.
//
//   node tests/focus-restore.mjs
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const testDir = await mkdtemp(join(tmpdir(), 'ive-focus-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5184), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()

const failures = []
let total = 0
const check = (name, ok, detail = '') => {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const sessions = [0, 1, 2].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))

async function setup({ boardMode = '1', viewport = { width: 1440, height: 900 }, touch = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(touch ? { hasTouch: true, isMobile: true } : {}) })
  await context.addInitScript((boardMode) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Focus QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', boardMode)
    // Terminal board mode: the Session level shows the terminal drawer, so
    // the keyboard lands in the terminal as it did in the old full-size view.
    if (boardMode === '1') localStorage.setItem('ive.terminal-drawer', JSON.stringify({ drawer: { s0: true, s1: true, s2: true }, height: 320 }))
    localStorage.setItem('ive.overview-mode', 'grid')
  }, boardMode)
  const inputs = []
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.action === 'input') inputs.push({ id: msg.session_id, data: msg.data })
      if (['start_pty', 'resize', 'resume_pty'].includes(msg.action)) {
        setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: '\x1b[2J\x1b[H> ' })), 20)
      }
    })
  })
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
    else if (p === '/cli-info') value = { available_clis: { claude: true, codex: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (p === '/quick-actions' || p === '/prompts') value = [{ id: 'qa1', name: 'Run tests', content: 'run the tests', quickaction: 1, is_quickaction: 1, pinned: 1 }]
    else if (method !== 'GET') value = {}
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
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
      activeSessionId: 's0', activeWorkspaceId: 'ws', showHome: false, gridLayout: 'equal', activeGridTemplateId: null,
    })
    store.getState().goSession('s0')
  }, sessions)
  await page.waitForTimeout(1200)
  return { context, page, inputs, errors }
}

// Session id whose xterm owns the keyboard, or a short description of what does.
const focusOwner = (page) => page.evaluate(() => {
  const ae = document.activeElement
  if (ae?.classList?.contains('xterm-helper-textarea')) return ae.closest('[data-session-view]')?.getAttribute('data-session-view') || 'xterm?'
  return ae ? `${ae.tagName}${ae.getAttribute('aria-label') ? `[${ae.getAttribute('aria-label')}]` : ''}` : 'none'
})
const store = (page, expr) => page.evaluate(async (expr) => {
  const s = (await import('/src/state/store.js')).default.getState()
  return expr.split('.').reduce((o, k) => o?.[k], s)
}, expr)
const level = async (page) => (await store(page, 'sessionFocus')) ? 'session' : 'overview'
const settle = (page) => page.waitForTimeout(350)
const tabCombo = await (async () => {
  const p = await browser.newPage(); const mac = await p.evaluate(() => /Mac/.test(navigator.platform)); await p.close()
  return mac ? 'Control' : 'Meta'
})()

try {
  const { context, page, inputs, errors } = await setup()
  const expectTerminal = async (name, id) => {
    await settle(page)
    const owner = await focusOwner(page)
    check(name, owner === id, `focus: ${owner}`)
  }
  const typeReaches = async (name, id) => {
    const before = inputs.length
    await page.keyboard.type('x')
    await page.waitForTimeout(200)
    const got = inputs.slice(before)
    check(name, got.length > 0 && got.every((m) => m.id === id), JSON.stringify(got))
  }

  // ── Bug 1: focus returns to the selected session ──
  await page.locator('.x-session-card').filter({ hasText: 'Agent 2' }).first().click()
  await expectTerminal('sidebar card click focuses that terminal', 's1')
  await typeReaches('typing after sidebar click reaches the session', 's1')
  await page.locator('.x-session-card').filter({ hasText: 'Agent 3' }).first().click()
  await settle(page)
  await page.keyboard.press('Meta+Shift+E')
  await expectTerminal('⌘⇧E after sidebar click keeps the terminal focused', 's2')
  await page.keyboard.press('Meta+Shift+E')
  check('⌘⇧E back to session level', (await level(page)) === 'session')
  await expectTerminal('⌘⇧E to session level focuses the terminal', 's2')

  await page.keyboard.press(`${tabCombo}+2`)
  await expectTerminal('tab shortcut 2 focuses that terminal', 's1')
  await typeReaches('typing after tab shortcut reaches the session', 's1')

  await page.evaluate(async () => (await import('/src/lib/quickStart.js')).openQuickStart())
  await page.getByRole('dialog', { name: 'Quick start' }).waitFor()
  await page.keyboard.press('Escape')
  await expectTerminal('quick start closed with Esc returns focus', 's1')
  await page.evaluate(async () => (await import('/src/lib/quickStart.js')).openQuickStart())
  await page.getByRole('dialog', { name: 'Quick start' }).waitFor()
  await page.mouse.click(20, 880)
  await expectTerminal('quick start closed by clicking outside returns focus', 's1')

  // ⌘F in a terminal searches that terminal; ⌘⇧F searches all sessions.
  await page.keyboard.press('Meta+f')
  await page.getByPlaceholder('Find in this terminal').first().waitFor()
  await page.keyboard.press('Escape')
  await expectTerminal('⌘F terminal find closed with Esc returns focus', 's1')
  await page.keyboard.press('Meta+Shift+f')
  await page.getByPlaceholder(/search across all sessions/i).first().waitFor()
  await page.keyboard.press('Escape')
  await expectTerminal('⌘⇧F search closed with Esc returns focus', 's1')

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'grid-templates' })))
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await expectTerminal('Grid Layouts settings closed with Esc returns focus', 's1')
  check('still on session level after the modals', (await level(page)) === 'session')

  // ── Bug 2: Escape on a menu only closes the menu ──
  for (const [name, open, menu] of [
    ['actions', () => page.getByRole('button', { name: 'Quick Actions menu' }).click(), () => page.getByText('Custom command...')],
    ['switch', () => page.getByRole('button', { name: 'Switch CLI' }).click(), () => page.getByText('Switch to:')],
    ['⋯', () => page.getByRole('button', { name: 'More session panels' }).click(), () => page.getByRole('menu')],
  ]) {
    if (!(await page.getByRole('button', { name: name === 'actions' ? 'Quick Actions menu' : name === 'switch' ? 'Switch CLI' : 'More session panels' }).count())) {
      check(`${name} menu present`, false); continue
    }
    await open()
    await menu().first().waitFor()
    const before = inputs.length
    await page.keyboard.press('Escape')
    await settle(page)
    check(`Esc on ${name} menu closes it`, (await menu().count()) === 0)
    check(`Esc on ${name} menu stays on session level`, (await level(page)) === 'session')
    check(`Esc on ${name} menu is not sent to the CLI`, inputs.length === before)
  }
  for (const name of ['Open files & plans', 'Open code review']) {
    // These buttons move into the session header portal (session agent).
    if (!(await page.getByRole('button', { name }).count())) { check(`"${name}" button present`, false); continue }
    await page.getByRole('button', { name }).click()
    await settle(page)
    await page.keyboard.press('Escape')
    await settle(page)
    check(`Esc after "${name}" stays on session level`, (await level(page)) === 'session')
    if ((await level(page)) !== 'session') await page.keyboard.press('Meta+Shift+E')
  }

  // Terminal right-click menu: Escape closes it and is not typed into the CLI.
  await page.keyboard.press(`${tabCombo}+1`)
  await settle(page)
  const term = page.locator('[data-session-view="s0"] .xterm-screen')
  await term.click({ button: 'right' })
  const copy = page.getByRole('menuitem', { name: /Copy/ })
  await copy.waitFor()
  let before = inputs.length
  await page.keyboard.press('Escape')
  await settle(page)
  check('Esc closes the terminal context menu', (await copy.count()) === 0)
  check('Esc on the terminal context menu is not sent to the CLI', inputs.length === before, JSON.stringify(inputs.slice(before)))
  check('Esc on the terminal context menu stays on session level', (await level(page)) === 'session')
  await term.click({ button: 'right' })
  await copy.waitFor()
  before = inputs.length
  await page.keyboard.type('a')
  await settle(page)
  check('typing closes the terminal context menu', (await copy.count()) === 0)
  check('typing with the context menu open does not reach the CLI', inputs.length === before, JSON.stringify(inputs.slice(before)))
  await expectTerminal('focus back on the terminal after the context menu', 's0')

  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()

  // ── Chat view (acceptance 12.10.): starting or opening a session puts the
  // cursor into its chat composer, not into the hidden drawer terminal / body.
  {
    const chat = await setup({ boardMode: '0' })
    const p = chat.page
    const owner = () => p.evaluate(() => {
      const ae = document.activeElement
      const view = ae?.closest?.('[data-session-view]')?.getAttribute('data-session-view')
      if (ae?.classList?.contains('xterm-helper-textarea')) return `xterm:${ae.closest('[data-terminal-session]')?.getAttribute('data-terminal-session') || view || '?'}`
      if (ae?.tagName === 'TEXTAREA' && ae.closest('form.x-composer')) return `composer:${view || '?'}`
      return ae ? `${ae.tagName}${ae.getAttribute('aria-label') ? `[${ae.getAttribute('aria-label')}]` : ''}` : 'none'
    })
    const expectOwner = async (name, want) => { await settle(p); const got = await owner(); check(name, got === want, `focus: ${got}`) }
    await p.locator('.x-session-card').filter({ hasText: 'Agent 2' }).first().click()
    await expectOwner('chat view: sidebar card click puts the cursor in that chat composer', 'composer:s1')
    const before = chat.inputs.length
    await p.keyboard.type('hallo')
    await settle(p)
    check('chat view: typing after the sidebar click fills the draft, nothing reaches the PTY',
      (await p.locator('[data-session-view="s1"] form.x-composer textarea').first().inputValue()) === 'hallo' && chat.inputs.length === before,
      JSON.stringify(chat.inputs.slice(before)))
    await p.keyboard.press(`${tabCombo}+1`)
    await expectOwner('chat view: tab shortcut puts the cursor in that chat composer', 'composer:s0')
    // A new session (Home-Enter / quick start add it the same way).
    await p.evaluate(async () => {
      const store = (await import('/src/state/store.js')).default
      const { startedSessions } = await import('/src/lib/terminalWriters.js')
      startedSessions.add('s9')
      store.getState().addSession({ id: 's9', workspace_id: 'ws', name: 'Fresh one', cli_type: 'claude', model: 'sonnet', status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }, { autoStart: false })
    })
    await p.waitForTimeout(400)
    await expectOwner('chat view: a new session gets the cursor in its chat composer', 'composer:s9')
    // Terminal view of a session: its terminal on screen keeps the keyboard.
    await p.locator('.x-session-card').filter({ hasText: 'Agent 2' }).first().click()
    await settle(p)
    // Terminal on screen: the session's drawer (⌘J) instead of the old tile switch.
    await p.keyboard.press('Meta+j')
    await settle(p)
    check('⌘J opens the terminal drawer of Agent 2', (await p.locator('[data-session-view="s1"] [data-session-terminal-drawer="open"]').count()) === 1)
    await p.locator('.x-session-card').filter({ hasText: 'Agent 1' }).first().click()
    await expectOwner('chat view next to it: Agent 1 still gets its composer', 'composer:s0')
    await p.locator('.x-session-card').filter({ hasText: 'Agent 2' }).first().click()
    await expectOwner('terminal view: opening that session focuses its terminal', 'xterm:s1')
    check('chat view: no page errors', chat.errors.length === 0, chat.errors.join(' | '))
    await chat.context.close()
  }

  // ── Touch-only device: opening a session does not pop the soft keyboard,
  // starting one right after typing does (the keyboard is up anyway).
  {
    const phone = await setup({ boardMode: '0', viewport: { width: 390, height: 844 }, touch: true })
    const p = phone.page
    const textFocus = () => p.evaluate(() => {
      const ae = document.activeElement
      return ae?.tagName === 'TEXTAREA' || ae?.tagName === 'INPUT' ? (ae.classList.contains('xterm-helper-textarea') ? 'xterm' : 'composer') : 'none'
    })
    check('touch emulation is touch-only', await p.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches))
    await p.evaluate(async () => {
      document.activeElement?.blur?.()
      ;(await import('/src/state/store.js')).default.getState().openSession('s1')
    })
    await p.waitForTimeout(700)
    check('touch: opening a session from the list leaves the keyboard closed (no text field focused)', (await textFocus()) === 'none', await textFocus())
    await p.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const store = (await import('/src/state/store.js')).default
      const { startedSessions } = await import('/src/lib/terminalWriters.js')
      startedSessions.add('s8')
      store.getState().addSession({ id: 's8', workspace_id: 'ws', name: 'Typed start', cli_type: 'claude', model: 'sonnet', status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }, { autoStart: false })
    })
    await p.waitForTimeout(700)
    check('touch: a session started by typing (Home-Enter) keeps the keyboard in its composer', (await textFocus()) === 'composer', await textFocus())
    check('touch: no page errors', phone.errors.length === 0, phone.errors.join(' | '))
    await phone.context.close()
  }
} finally {
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) process.exitCode = 1
