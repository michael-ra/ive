// Opening a terminal: browser regression with an isolated Vite server and
// fully mocked API + WebSocket. No real backend, PTY, or session is touched.
//
// The mocked PTY behaves like a full-screen TUI (Claude Code): on start_pty /
// resize / resume_pty it repaints a box exactly cols x rows big, with a prompt
// on the last row. If the PTY size disagrees with what is visible, the box is
// visibly cut off or wraps, which is what the screenshots are for.
//
//   node tests/terminal-open.mjs            # checks + screenshots
//   IVE_SHOT_DIR=../review-terminal/after node tests/terminal-open.mjs
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const shotDir = resolve(process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-terminal-open'))
const strict = process.env.IVE_STRICT !== '0'
await mkdir(shotDir, { recursive: true })

const testDir = await mkdtemp(join(tmpdir(), 'ive-terminal-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5182), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()

const results = []
const failures = []
// Known limitation outside this test's scope (overview density): logged, not failed.
const note = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail, note: true })
  console.log(`${ok ? 'PASS' : 'NOTE'} ${name}${detail ? ` (${detail})` : ''}`)
}
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const mkSession = (i, extra = {}) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [], ...extra,
})

// Full-screen TUI frame for a given size.
function tuiFrame(name, cols, rows) {
  const inner = Math.max(0, cols - 2)
  const title = ` ${name} · PTY ${cols}x${rows} `.slice(0, inner)
  const top = '╭' + title + '─'.repeat(Math.max(0, inner - title.length)) + '╮'
  const bottom = '╰' + '─'.repeat(inner) + '╯'
  const line = (text = '') => '│' + text.slice(0, inner).padEnd(inner, ' ') + '│'
  const body = []
  for (let r = 0; r < rows - 3; r++) body.push(line(r === 0 ? ' Welcome to the mocked agent.' : r === rows - 4 ? ' last body row' : ''))
  const prompt = ('> ' + '').padEnd(cols, ' ').slice(0, cols)
  // Alt screen, home, draw everything, park cursor after the prompt.
  return '\x1b[?1049h\x1b[H\x1b[2J' + [top, ...body, bottom].join('\r\n') + '\r\n' + prompt + `\x1b[${rows};3H`
}

async function setup(viewport, { sessions, openTabs = [], board = true, activeSessionId = null }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  await context.addInitScript((board) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Terminal QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', board ? '1' : '0')
    localStorage.removeItem('cc-gridColumns')
  }, board)
  const ptyMsgs = []
  const state = { sessions: [...sessions], created: 0 }
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.action === 'input') { ptyMsgs.push({ action: 'input', id: msg.session_id, data: msg.data, t: Date.now() }); return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      ptyMsgs.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      const s = state.sessions.find((x) => x.id === msg.session_id)
      // Real PTYs answer SIGWINCH after a short delay.
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: tuiFrame(s?.name || msg.session_id, msg.cols, msg.rows) })), 30)
    })
  })
  await context.route('**/api/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.slice(4), method = req.method()
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces') value = [ws]
    else if (p === '/sessions' && method === 'GET') value = state.sessions
    else if (p === '/sessions' && method === 'POST') {
      const body = req.postDataJSON() || {}
      const s = mkSession(100 + state.created++, { name: body.name || `New agent ${state.created}`, status: 'idle', pty_alive: false })
      state.sessions.push(s); value = s
    }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true, codex: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (p === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [{ ...ws, sessions: { total: state.sessions.length, by_status: {} }, blocked_sessions: { total: 0, items: [] }, test_queue: { depth: 0, running_total: 0, running: null }, open_tasks: { total: 0, items: [] }, active_research: { total: 0, items: [] } }] }
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
  if (openTabs.length) {
    await page.evaluate(async ({ sessions, openTabs, activeSessionId }) => {
      const store = (await import('/src/state/store.js')).default
      const { startedSessions } = await import('/src/lib/terminalWriters.js')
      // Restored tabs whose PTY is already running in the backend.
      openTabs.forEach((id) => startedSessions.add(id))
      store.setState({
        sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), openTabs,
        activeSessionId: activeSessionId || openTabs[0], activeWorkspaceId: 'ws', showHome: false,
        gridLayout: 'equal', activeGridTemplateId: null,
      })
    }, { sessions, openTabs, activeSessionId })
    await page.waitForTimeout(1200)
  }
  return { context, page, ptyMsgs, errors, state }
}

// Geometry of a session's visible terminal: cell box, wrapper, xterm grid,
// whether it is on screen, whether the last row is cut, and what the PTY got.
async function inspect(page, id) {
  return page.evaluate(async (id) => {
    const { terminalControls } = await import('/src/lib/terminalWriters.js')
    const store = (await import('/src/state/store.js')).default.getState()
    const cell = document.querySelector(`[data-session-view="${id}"]`)
    if (!cell) return { mounted: false }
    const r = cell.getBoundingClientRect()
    const xterm = cell.querySelector('.xterm')
    const screen = cell.querySelector('.xterm-screen')
    const wrapper = xterm?.parentElement?.parentElement
    const size = terminalControls.get(id)?.getSize?.()
    const wr = wrapper?.getBoundingClientRect()
    const sr = screen?.getBoundingClientRect()
    const ae = document.activeElement
    return {
      mounted: true,
      visible: r.width > 50 && r.height > 50 && getComputedStyle(cell).display !== 'none',
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      cell: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      size,
      // A scrollbar only exists when overflow is not hidden (overview tiles crop on purpose, with a hint).
      hScroll: wrapper ? wrapper.scrollWidth > wrapper.clientWidth + 2 && getComputedStyle(wrapper).overflowX !== 'hidden' : null,
      cropHinted: wrapper ? wrapper.scrollWidth <= wrapper.clientWidth + 2 || !!cell.querySelector('[data-preview-wider]') : null,
      vScroll: wrapper ? wrapper.scrollHeight > wrapper.clientHeight + 2 : null,
      lastRowCut: wr && sr ? sr.bottom > wr.bottom + 1 : null,
      unusedRows: wr && sr && size ? Math.floor((wr.bottom - sr.bottom) / (sr.height / size.rows)) : null,
      unusedCols: wr && sr && size ? Math.floor((wr.right - sr.right) / (sr.width / size.cols)) : null,
      focused: !!(ae && cell.contains(ae) && ae.classList.contains('xterm-helper-textarea')),
      active: store.activeSessionId === id,
    }
  }, id)
}

const sizeMsgs = (msgs, id) => msgs.filter((m) => m.id === id && m.action !== 'input')
const lastPty = (msgs, id) => sizeMsgs(msgs, id).at(-1)
const firstPty = (msgs, id) => sizeMsgs(msgs, id)[0]
const shot = (page, name) => page.screenshot({ path: join(shotDir, `${name}.png`) })

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '900x700', width: 900, height: 700 },
]
const four = [0, 1, 2, 3].map((i) => mkSession(i))

try {
  for (const vp of viewports) {
    // 1. "+" in the top bar -> dialog -> Create Session, with 4 terminals already open.
    {
      const { context, page, ptyMsgs, errors } = await setup(vp, { sessions: four, openTabs: four.map((s) => s.id) })
      await shot(page, `${vp.name}-0-grid-before`)
      await page.getByRole('button', { name: 'Create a new session' }).click()
      // "+" opens the quick start prompt; the full dialog is one link away.
      await page.locator('[data-quick-start]').getByRole('button', { name: /Set up session/ }).click()
      await page.getByRole('button', { name: 'Create Session' }).click()
      const id = 's100'
      await page.waitForFunction((id) => document.querySelector(`[data-session-view="${id}"] .xterm`), id)
      await page.waitForTimeout(1500)
      const g = await inspect(page, id)
      const first = firstPty(ptyMsgs, id), last = lastPty(ptyMsgs, id)
      await shot(page, `${vp.name}-1-new-session`)
      check(`${vp.name} new: terminal fully on screen`, g.visible && g.inViewport, JSON.stringify(g.cell))
      check(`${vp.name} new: terminal gets keyboard focus`, g.focused && g.active)
      check(`${vp.name} new: uses most of the window (>=60% width)`, g.cell.w >= (vp.width - 300) * 0.6, `${g.cell.w}px`)
      check(`${vp.name} new: PTY started with fitted size`, first && first.action === 'start_pty' && g.size && first.cols === g.size.cols && first.rows === g.size.rows, `start ${first?.cols}x${first?.rows}, shown ${g.size?.cols}x${g.size?.rows}`)
      check(`${vp.name} new: PTY size matches xterm`, last && last.cols === g.size.cols && last.rows === g.size.rows, `pty ${last?.cols}x${last?.rows}`)
      check(`${vp.name} new: no horizontal scrollbar`, g.hScroll === false)
      check(`${vp.name} new: last row not cut off`, g.lastRowCut === false && g.vScroll === false)
      check(`${vp.name} new: no wasted rows/cols`, g.unusedRows <= 1 && g.unusedCols <= 2, `rows ${g.unusedRows} cols ${g.unusedCols}`)
      // The backend ignores same-size resizes, so only distinct sizes cause a
      // TUI redraw (SIGWINCH). A freshly opened agent should never get one.
      const sizes = new Set(sizeMsgs(ptyMsgs, id).map((m) => `${m.cols}x${m.rows}`))
      check(`${vp.name} new: PTY never resized after start (no TUI redraw)`, sizes.size === 1, [...sizes].join(' -> '))
      // Way back to the overview must be obvious and work.
      const back = page.getByRole('button', { name: 'Back to overview', exact: true }).first()
      check(`${vp.name} new: "Back to overview" visible`, await back.isVisible().catch(() => false))
      if (await back.isVisible().catch(() => false)) {
        await back.click(); await page.waitForTimeout(900)
        await shot(page, `${vp.name}-2-back-to-overview`)
        check(`${vp.name} overview: the session just used stays on screen`, (await inspect(page, id)).inViewport)
        const ids = ['s0', 's1', 's2', 's3', id]
        const after = await Promise.all(ids.map((x) => inspect(page, x)))
        const mism = ids.filter((x, i) => { const l = lastPty(ptyMsgs, x); return after[i].visible && l && (l.cols !== after[i].size.cols || l.rows !== after[i].size.rows) })
        check(`${vp.name} overview: every visible PTY matches its cell`, mism.length === 0, mism.join(','))
        check(`${vp.name} overview: no scrollbars, any crop is hinted`, after.every((a) => !a.visible || (a.hScroll === false && a.cropHinted)), after.map((a) => `${a.hScroll}/${a.cropHinted}`).join(','))
      }
      check(`${vp.name} no page errors`, errors.length === 0, errors.join(' | '))
      await context.close()
    }
    // 2. Clicking an existing session in the sidebar while 4 are open.
    {
      const sessions = [...four, mkSession(4)]
      const { context, page, errors } = await setup(vp, { sessions, openTabs: four.map((s) => s.id) })
      const item = page.getByText('Agent 5', { exact: true }).first()
      if (await item.isVisible().catch(() => false)) {
        await item.click()
        await page.waitForFunction(() => document.querySelector('[data-session-view="s4"] .xterm'))
        await page.waitForTimeout(1200)
        const g = await inspect(page, 's4')
        await shot(page, `${vp.name}-3-open-existing`)
        check(`${vp.name} existing: on screen, focused`, g.visible && g.inViewport && g.focused, JSON.stringify(g.cell))
        check(`${vp.name} existing: no horizontal scrollbar`, g.hScroll === false)
      } else {
        check(`${vp.name} existing: sidebar entry visible`, false)
      }
      check(`${vp.name} existing: no page errors`, errors.length === 0, errors.join(' | '))
      await context.close()
    }
  }
  // 4. Overview scrolled down, expand the last cell: it must start on screen.
  {
    const ctx = await setup({ width: 1280, height: 800 }, { sessions: four, openTabs: four.map((s) => s.id) })
    const { context, page } = ctx
    await page.evaluate(() => { const g = document.querySelector('[data-terminal-grid]') || document.querySelector('[data-session-view]').parentElement; g.scrollTop = g.scrollHeight })
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Expand Agent 4', exact: true }).click()
    await page.waitForTimeout(900)
    const g = await inspect(page, 's3')
    await shot(page, 'scrolled-overview-expand')
    check('expand from scrolled overview: focused terminal fully on screen', g.visible && g.inViewport && g.cell.y < 250, JSON.stringify(g.cell))
    check('expand from scrolled overview: keyboard focus in terminal', g.focused)
    // 5. Escape typed in the terminal goes to the agent (interrupt), it
    //    must not throw the user out of the focus view.
    const { ptyMsgs } = ctx
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape inside the terminal stays in focus view', await page.getByRole('button', { name: 'Back to overview', exact: true }).first().isVisible())
    check('Escape inside the terminal reaches the agent', ptyMsgs.some((m) => m.action === 'input' && m.id === 's3' && m.data === '\x1b'))
    // Escape outside the terminal still returns to the overview.
    if (!await page.getByRole('button', { name: 'Back to overview', exact: true }).first().isVisible()) await page.locator('.ive-terminal-toolbar[data-view-level="overview"]').getByRole('button').last().click()
    await page.locator('.ive-terminal-switcher').getByRole('button', { name: 'Agent 2', exact: true }).click()
    // Selecting a session hands the keyboard to its terminal (focus restore),
    // so move focus back to the chrome before testing chrome Escape.
    await page.waitForTimeout(300)
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Escape')
    await page.locator('.ive-terminal-toolbar[data-view-level="overview"]').getByRole('button').last().waitFor()
    check('Escape outside the terminal returns to overview', true)
    await context.close()
  }
  // 6. Default chat view (terminal board mode off): the new session is shown
  //    large as well, not appended below the fold.
  {
    const { context, page, errors } = await setup({ width: 1440, height: 900 }, { sessions: four, openTabs: four.map((s) => s.id), board: false })
    await page.getByRole('button', { name: 'Create a new session' }).click()
    await page.locator('[data-quick-start]').getByRole('button', { name: /Set up session/ }).click()
    await page.getByRole('button', { name: 'Create Session' }).click()
    await page.waitForFunction(() => document.querySelector('[data-session-view="s100"]'))
    await page.waitForTimeout(1200)
    const g = await inspect(page, 's100')
    await shot(page, 'chat-view-new-session')
    check('chat view: new session fully on screen and large', g.visible && g.inViewport && g.cell.w > 900, JSON.stringify(g.cell))
    check('chat view: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
  // 3. Reload with 4 restored terminals: focus must stay on the active one.
  {
    const { context, page } = await setup({ width: 1440, height: 900 }, { sessions: four, openTabs: four.map((s) => s.id), activeSessionId: 's1' })
    await page.waitForTimeout(800)
    const active = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().activeSessionId)
    check('restore: active session not stolen by mounting terminals', active === 's1', active)
    await context.close()
  }
} finally {
  await writeFile(join(shotDir, 'results.json'), JSON.stringify(results, null, 2))
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
const checks = results.filter((r) => !r.note)
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed, ${results.filter((r) => r.note && !r.ok).length} notes. Screenshots: ${shotDir}`)
if (failures.length && strict) process.exitCode = 1
