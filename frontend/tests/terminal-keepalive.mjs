// Terminal keep-alive (BUILD-MAP A.1.6): one TerminalView per session that
// moves between the session drawer, the board tile and the parking container
// without remounting. Isolated Vite server, fully mocked API + WebSocket.
//
// Checks
//   1. Opening a session and toggling the drawer 3× sends start_pty once and
//      changes the PTY size at most once.
//   2. Board ⇄ Session 5× (drawer closed): no second start_pty, the PTY size
//      changes at most once, the scrollback written before survives.
//   3. The same session never has two terminal nodes; the portal node keeps
//      its identity across the moves; a closed tab releases it.
//
//   node tests/terminal-keepalive.mjs
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const testDir = await mkdtemp(join(tmpdir(), 'ive-keepalive-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5305), strictPort: true, open: false },
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

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const sessions = [0, 1].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))

function frame(cols, rows, lines) {
  return '\x1b[H\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\r\n') + '\r\n> '
}

async function setup() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'KeepAlive QA')
    localStorage.setItem('cc-soundEnabled', '0')
    // Tiles show terminals, so the board really places a terminal slot.
    localStorage.setItem('cc-terminalBoardMode', '1')
    localStorage.setItem('ive.overview-mode', 'grid')
    localStorage.removeItem('ive.terminal-drawer')
  })
  const pty = []
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      pty.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      const lines = [`${msg.session_id} mocked agent`, ...Array.from({ length: 60 }, (_, i) => `history line ${i}`)]
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: frame(msg.cols || 80, msg.rows || 24, lines) })), 30)
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
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.waitForTimeout(500)
  await page.evaluate(async (sessions) => {
    const store = (await import('/src/state/store.js')).default
    store.setState({
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), openTabs: sessions.map((s) => s.id),
      activeSessionId: 's0', activeWorkspaceId: 'ws', showHome: false, gridLayout: 'equal', activeGridTemplateId: null,
    })
    store.getState().goSession('s0')
  }, sessions)
  await page.waitForTimeout(1500)
  return { context, page, pty, errors }
}

const store = (page, fn) => page.evaluate(async (src) => {
  const s = (await import('/src/state/store.js')).default
  // eslint-disable-next-line no-new-func
  return new Function('store', `return (${src})(store)`)(s)
}, fn.toString())
const sizeChanges = (pty, id, from = 0) => {
  let last = null, changes = 0
  for (const m of pty.slice(from)) {
    if (m.id !== id || !m.cols || !m.rows) continue
    if (last && (last.cols !== m.cols || last.rows !== m.rows)) changes++
    last = { cols: m.cols, rows: m.rows }
  }
  return changes
}
const startCount = (pty, id) => pty.filter((m) => m.id === id && m.action === 'start_pty').length
const termCount = (page, id) => page.evaluate((id) => document.querySelectorAll(`[data-terminal-session="${id}"] .xterm`).length, id)
const portalIdentity = (page, id) => page.evaluate((id) => {
  const node = document.querySelector(`.ive-terminal-portal[data-terminal-session="${id}"]`)
  if (!node) return null
  if (!node.__keepAliveMark) node.__keepAliveMark = `${id}-${Math.random().toString(36).slice(2)}`
  return { mark: node.__keepAliveMark, parent: node.parentElement?.getAttribute('data-terminal-slot') || (node.closest('[data-terminal-parked]') ? 'parked' : node.parentElement?.tagName) }
}, id)
// Lines above the live screen (xterm buffer baseY): the history the mock wrote.
const scrollbackLines = (page, id) => page.evaluate(async (id) => {
  const { terminalControls } = await import('/src/lib/terminalWriters.js')
  return terminalControls.get(id)?.getViewport?.().baseY ?? -1
}, id)

try {
  const { context, page, pty, errors } = await setup()
  const view = () => store(page, (s) => (s.getState().showHome ? 'home' : s.getState().sessionFocus ? 'session' : 'board'))
  check('session opens at Session level', (await view()) === 'session')
  check('session screen root carries data-session-view', await page.locator('[data-session-view="s0"].ive-session-screen').count() === 1)
  const startsBefore = startCount(pty, 's0')
  check('start_pty sent once while parked', startsBefore === 1, `${startsBefore}`)
  const first = await portalIdentity(page, 's0')
  check('terminal node exists and is parked while the drawer is closed', first?.parent === 'parked', JSON.stringify(first))

  // 1. Drawer open/close 3×
  const phase1From = pty.length
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Meta+j')
    await page.waitForTimeout(700)
    if (i === 0) {
      check('⌘J opens the drawer', await page.locator('[data-session-terminal-drawer="open"]').count() === 1)
      const ident = await portalIdentity(page, 's0')
      check('the drawer slot adopted the same node', ident?.mark === first.mark && ident?.parent === 's0', JSON.stringify(ident))
      check('one xterm for the session in the drawer', (await termCount(page, 's0')) === 1)
      const drawerMode = await page.locator('[data-terminal-slot="s0"]').getAttribute('data-terminal-mode')
      check('drawer slot mode', drawerMode === 'drawer', drawerMode)
    }
    await page.keyboard.press('Meta+j')
    await page.waitForTimeout(500)
  }
  check('drawer closed again', await page.locator('[data-session-terminal-drawer="open"]').count() === 0)
  const drawerChanges = sizeChanges(pty, 's0', phase1From)
  check('drawer 3×: PTY size changes at most once', drawerChanges <= 1, `${drawerChanges} changes`)
  check('drawer 3×: no second start_pty', startCount(pty, 's0') === 1, `${startCount(pty, 's0')}`)
  const parkedAgain = await portalIdentity(page, 's0')
  check('node is parked after the drawer closed, same identity', parkedAgain?.parent === 'parked' && parkedAgain.mark === first.mark, JSON.stringify(parkedAgain))
  const linesBefore = await scrollbackLines(page, 's0')

  // 2. Board ⇄ Session 5× (drawer closed)
  const phase2From = pty.length
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Meta+Shift+E')
    await page.waitForTimeout(700)
    if (i === 0) {
      check('⌘⇧E goes to the Board', (await view()) === 'board')
      check('board tile shows the session', await page.locator('[data-terminal-grid] [data-session-view="s0"]').count() === 1)
      const ident = await portalIdentity(page, 's0')
      check('the tile slot adopted the same node', ident?.mark === first.mark && ident?.parent === 's0', JSON.stringify(ident))
      const tileMode = await page.locator('[data-terminal-slot="s0"]').getAttribute('data-terminal-mode')
      check('tile slot mode', tileMode === 'tile', tileMode)
      check('exactly one terminal node per session', (await termCount(page, 's0')) === 1 && (await termCount(page, 's1')) === 1)
    }
    await page.keyboard.press('Meta+Shift+E')
    await page.waitForTimeout(700)
  }
  check('back at Session level', (await view()) === 'session')
  const toggleChanges = sizeChanges(pty, 's0', phase2From)
  const otherChanges = sizeChanges(pty, 's1', phase2From)
  console.log(`     pty messages: ${pty.length}; size changes s0=${toggleChanges} (toggle), s1=${otherChanges}`)
  check('toggle 5×: focused PTY changes size at most once', toggleChanges <= 1, `${toggleChanges}`)
  check('toggle 5×: the other PTY changes size at most once', otherChanges <= 1, `${otherChanges}`)
  check('toggle 5×: no second start_pty', startCount(pty, 's0') === 1 && startCount(pty, 's1') === 1, `${startCount(pty, 's0')}/${startCount(pty, 's1')}`)
  const ident = await portalIdentity(page, 's0')
  check('node identity survived every move', ident?.mark === first.mark, JSON.stringify(ident))
  await page.keyboard.press('Meta+j')
  await page.waitForTimeout(700)
  const linesAfter = await scrollbackLines(page, 's0')
  check('scrollback survived the moves', linesAfter >= Math.min(linesBefore, 10), `${linesBefore} → ${linesAfter}`)
  check('drawer terminal has size', await page.evaluate(() => { const r = document.querySelector('[data-terminal-slot="s0"] .xterm-screen')?.getBoundingClientRect(); return !!r && r.width > 200 && r.height > 100 }))

  // 3. Closing the tab releases the node.
  await store(page, (s) => s.getState().closeTab?.('s1') ?? s.setState({ openTabs: ['s0'] }))
  await page.waitForTimeout(500)
  check('closed tab releases its terminal node', await page.evaluate(() => document.querySelectorAll('.ive-terminal-portal[data-terminal-session="s1"]').length) === 0)
  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()
} finally {
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) process.exitCode = 1
