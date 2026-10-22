// Frame-level regression for parked/drawer/full/grid terminal transitions.
// Uses an isolated Vite server and fake PTY; never touches real sessions.
// Run with IVE_QA_BROWSER=webkit to cover the macOS WebView engine.
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { TOUR_VERSION } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const testDir = await mkdtemp(join(tmpdir(), 'ive-keepalive-vite-'))
const server = await createServer({
  root: process.env.IVE_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5306), strictPort: true, open: false },
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
const sessions = [0, 1].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))

function frame(cols, rows, lines) {
  return '\x1b[H\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\r\n') + '\r\n> '
}

async function setup() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
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
  const sockets = []
  const geometry = new Map()
  await context.routeWebSocket('**/ws', (socket) => {
    sockets.push(socket)
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      pty.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      const key = `${msg.cols}x${msg.rows}`
      if (msg.action === 'resize' && geometry.get(msg.session_id) === key) return
      geometry.set(msg.session_id, key)
      if (msg.action === 'resize') return // no new output during a layout-only change
      const lines = [`${msg.session_id} mocked agent`, ...Array.from({ length: 60 }, (_, i) => `history line ${i}`)]
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: frame(msg.cols || 80, msg.rows || 24, lines) })), 30)
    })
  })
  await context.route('**/api/**', async (route) => {
    const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'qa' }
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
  return { context, page, pty, errors, write: (data) => sockets.forEach(socket => socket.send(JSON.stringify({ type: 'output', session_id: 's0', data }))) }
}

async function sampleSwitch(page, action) {
  return page.evaluate(async (action) => {
    const store = (await import('/src/state/store.js')).default
    const { terminalControls } = await import('/src/lib/terminalWriters.js')
    const samples = []
    new Function('store', `return (${action})(store)`)(store)
    const started = performance.now()
    await new Promise(resolve => {
      function sample() {
        const wrapper = document.querySelector('[data-terminal-slot="s0"] .xterm')?.parentElement?.parentElement
        const screen = wrapper?.querySelector('.xterm-screen')
        const viewport = wrapper?.querySelector('.xterm-viewport')
        if (wrapper && getComputedStyle(wrapper.firstElementChild).opacity !== '0') {
          const r = wrapper.getBoundingClientRect(), s = screen.getBoundingClientRect()
          samples.push({ ms: Math.round(performance.now() - started), h: r.height, screenH: s.height, hostH: wrapper.firstElementChild.getBoundingClientRect().height, minH: wrapper.firstElementChild.style.minHeight, wrapScrollH: wrapper.scrollHeight, xtermH: wrapper.querySelector('.xterm').offsetHeight, offset: s.top - r.top, scrollTop: wrapper.scrollTop,
            viewportTop: viewport.scrollTop, ...terminalControls.get('s0').getViewport(), ...terminalControls.get('s0').getSize(),
            rootScroll: document.scrollingElement.scrollTop, font: terminalControls.get('s0').getFontSize() })
        }
        if (performance.now() - started < 650) requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    return samples
  }, action.toString())
}
const artifacts = process.env.IVE_SHOT_DIR || join(tmpdir(), `ive-terminal-reveal-${process.env.IVE_QA_BROWSER || 'chromium'}`)
await mkdir(artifacts, { recursive: true })
const report = {}
try {
  const { context, page, pty, errors, write } = await setup()
  const transitions = [
    ['open drawer', s => s.getState().toggleTerminalDrawer('s0', true)],
    ['expand', s => s.getState().setTerminalExpanded('s0', true)],
    ['restore drawer', s => s.getState().setTerminalExpanded('s0', false)],
    ['close', s => s.getState().toggleTerminalDrawer('s0', false)],
    ['reopen', s => s.getState().toggleTerminalDrawer('s0', true)],
    ['board', s => s.getState().goBoard()],
    ['return to session', s => s.getState().goSession('s0')],
  ]
  for (const [name, action] of transitions) {
    const samples = await sampleSwitch(page, action)
    report[name] = samples
    if (name === 'close') continue
    const last = samples.at(-1)
    check(`${name}: renders promptly`, samples.length > 0 && samples[0].ms < 500, `${samples[0]?.ms}ms`)
    check(`${name}: geometry is stable from first visible frame`, samples.length > 0 && samples.every(s =>
      Math.abs(s.offset - last.offset) <= 1 && Math.abs(s.h - last.h) <= 1 &&
      s.screenH === last.screenH && s.cols === last.cols && s.rows === last.rows && s.font === last.font))
    check(`${name}: live output stays at the bottom`, samples.length > 0 && samples.every(s => s.viewportY === s.baseY))
    check(`${name}: native viewport matches the buffer`, samples.length > 0 && samples.every(s => Math.abs(s.viewportTop - s.viewportY * s.screenH / s.rows) <= 1))
    check(`${name}: input helper cannot add blank scroll space`, samples.length > 0 && samples.every(s => s.wrapScrollH <= Math.max(s.h, s.screenH + 8) + 1))
    check(`${name}: page does not scroll`, samples.every(s => s.rootScroll === 0))
  }
  // A reader's scrollback position survives closing and reopening at the
  // same size. The test scrolls the actual viewport, not an implementation hook.
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-terminal-slot="s0"] .xterm-viewport')
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 180)
  })
  await page.waitForTimeout(150)
  const history = await page.evaluate(async () => (await import('/src/lib/terminalWriters.js')).terminalControls.get('s0').getViewport())
  check('history: fixture is scrolled back', history.viewportY < history.baseY)
  await sampleSwitch(page, s => s.getState().toggleTerminalDrawer('s0', false))
  const reopened = await sampleSwitch(page, s => s.getState().toggleTerminalDrawer('s0', true))
  report.history = reopened
  check('history: reopening preserves every frame', reopened.length > 0 && reopened.every(s => s.viewportY === history.viewportY))
  check('history: scrollbar restored before reveal', reopened.every(s => Math.abs(s.viewportTop - history.viewportY * s.screenH / s.rows) <= 1))
  check('reopening gives keyboard focus to the terminal', await page.locator('[data-terminal-slot="s0"] .xterm-helper-textarea').evaluate(e => e === document.activeElement))
  // A preview of a wider/taller remote terminal must expose the full screen.
  await sampleSwitch(page, s => s.getState().goBoard())
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cc-terminal-geometry', {
    detail: { session_id: 's0', authoritative: false, cols: 300, rows: 100 },
  })))
  await page.waitForTimeout(300)
  write(frame(300, 100, Array.from({ length: 100 }, (_, i) =>
    `Message row ${i + 1}: ` + 'Full terminal output remains readable. '.repeat(7) + ' RIGHT EDGE')))
  await page.waitForTimeout(300)
  const reading = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-terminal-slot="s0"] .xterm').parentElement.parentElement
    const screen = wrapper.querySelector('.xterm-screen')
    const wider = wrapper.scrollWidth > wrapper.clientWidth + 20
    screen.dispatchEvent(new WheelEvent('wheel', { deltaX: 20000, bubbles: true, cancelable: true }))
    const right = wrapper.scrollLeft
    screen.dispatchEvent(new WheelEvent('wheel', { deltaY: -20000, bubbles: true, cancelable: true }))
    return { wider, right, top: wrapper.scrollTop, overflow: getComputedStyle(wrapper).overflowX,
      fade: !!document.querySelector('.ive-preview-fade-right') }
  })
  check('wide preview: overflowing content is scrollable', reading.wider && reading.overflow === 'auto')
  check('wide preview: right edge can be reached', reading.right > 20)
  check('tall preview: early rows can be reached', reading.top === 0)
  check('wide preview: text is not covered by a fade', !reading.fade)
  await page.waitForTimeout(1100)
  const preserved = await page.locator('[data-terminal-slot="s0"] .xterm').locator('..').locator('..').evaluate(e => ({ left: e.scrollLeft, top: e.scrollTop }))
  check('preview reading: refresh does not reset either scroll position', preserved.left === reading.right && preserved.top === reading.top)
  await page.screenshot({ path: join(artifacts, 'terminal-full-width.png') })
  check('no duplicate PTY starts', pty.filter(m => m.action === 'start_pty' && m.id === 's0').length === 1)
  check('no page errors', errors.length === 0, errors.join(' | '))
  await page.screenshot({ path: join(artifacts, 'terminal-history.png') })
  await writeFile(join(artifacts, 'frames.json'), JSON.stringify(report, null, 2))
  await context.close()
} finally {
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed; artifacts: ${artifacts}`)
if (failures.length) process.exitCode = 1
