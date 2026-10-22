// Overview grid: browser regression with an isolated Vite server and fully
// mocked API + WebSocket (same mocks as terminal-open.mjs). No real backend,
// PTY or session is touched.
//
// Checks
//   1. At 1440x900, 1920x1080 and 1280x800 every overview tile is readable:
//      font >= 9px, >= 80 visible columns, no scrollbars, the latest row
//      (bottom-anchored) visible, a cropped right edge only with the "wider"
//      hint, and no per-tile status line / prompt box (Session level has it).
//   2. Toggling Overview <-> Session 5x does not resize the PTY back and forth.
//   3. Custom grid template: a new or newly opened session always lands
//      somewhere visible (first free cell, else Session level + notice).
//   4. Overview <-> Session with a Claude-like TUI (normal buffer, long
//      scrollback, spinner redrawing every 100 ms): the new level is on
//      screen in the first frame (no 9px preview pinned to the bottom of the
//      Session box, no top-cropped 13px screen in a tile), the live bottom is
//      shown, xterm and PTY keep the same size and the TUI frame is intact.
//
//   node tests/overview-grid.mjs
//   IVE_SHOT_DIR=../review-grid/after node tests/overview-grid.mjs
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const shotDir = resolve(process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-overview-grid'))
const strict = process.env.IVE_STRICT !== '0'
const port = Number(process.env.IVE_TEST_PORT || 5186)
await mkdir(shotDir, { recursive: true })

const testDir = await mkdtemp(join(tmpdir(), 'ive-grid-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port, strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()

const results = []
const failures = []
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

function tuiFrame(name, cols, rows) {
  const inner = Math.max(0, cols - 2)
  const title = ` ${name} · PTY ${cols}x${rows} `.slice(0, inner)
  const top = '╭' + title + '─'.repeat(Math.max(0, inner - title.length)) + '╮'
  const bottom = '╰' + '─'.repeat(inner) + '╯'
  const line = (text = '') => '│' + text.slice(0, inner).padEnd(inner, ' ') + '│'
  const body = []
  for (let r = 0; r < rows - 3; r++) body.push(line(r === 0 ? ' Welcome to the mocked agent.' : r === rows - 4 ? ' last body row' : ''))
  const prompt = '> '.padEnd(cols, ' ').slice(0, cols)
  return '\x1b[?1049h\x1b[H\x1b[2J' + [top, ...body, bottom].join('\r\n') + '\r\n' + prompt + `\x1b[${rows};3H`
}

// Claude Code-like output: no alternate screen, so history lands in xterm's
// scrollback; the prompt box at the bottom is redrawn in place (Ink erases
// its last frame line by line, then writes the new one).
function inkFrame(cols, status) {
  const w = cols - 1
  return '╭' + '─'.repeat(w - 2) + '╮\r\n│ > ' + ' '.repeat(w - 5) + '│\r\n╰' + '─'.repeat(w - 2) + '╯\r\n  ' + status
}
const INK_ERASE_FRAME = '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\r'

async function setup(viewport, { sessions, openTabs = [], theme = 'light', templates = [], activeTemplateId = null, ink = false }) {
  // The Ink case runs without reduced motion: its global 0.01ms transitions
  // delay every size change by a frame or two, which is not what users see.
  const context = await browser.newContext({ viewport, reducedMotion: ink ? 'no-preference' : 'reduce', deviceScaleFactor: Number(process.env.IVE_DPR || 1) })
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Grid QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', '1')
    localStorage.setItem('ive-theme.v2', theme)
    localStorage.removeItem('cc-gridColumns')
    localStorage.removeItem('cc-activeGridTemplateIds')
  }, { theme })
  const ptyMsgs = []
  const state = { sessions: [...sessions], created: 0, templates: JSON.parse(JSON.stringify(templates)) }
  const ptySize = {}
  const timers = []
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      ptyMsgs.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      const s = state.sessions.find((x) => x.id === msg.session_id)
      if (!ink) {
        setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: tuiFrame(s?.name || msg.session_id, msg.cols, msg.rows) })), 30)
        return
      }
      // Like the backend: same size is a no-op (no SIGWINCH, no redraw).
      const id = msg.session_id
      const prev = ptySize[id]
      const changed = !prev || prev.cols !== msg.cols || prev.rows !== msg.rows
      ptySize[id] = { cols: msg.cols, rows: msg.rows }
      socket.send(JSON.stringify({ type: 'terminal_geometry', session_id: id, authoritative: true, changed, cols: msg.cols, rows: msg.rows }))
      const out = (data) => socket.send(JSON.stringify({ type: 'output', session_id: id, data }))
      if (!prev) {
        let history = ` ${s?.name} · Claude-like TUI\r\n`
        for (let i = 0; i < 400; i++) history += `history line ${i} ${'·'.repeat((i % 7) * 15)}\r\n`
        setTimeout(() => out(history + inkFrame(msg.cols, '? for shortcuts')), 30)
        let tick = 0
        timers.push(setInterval(() => {
          tick++
          out(INK_ERASE_FRAME + (tick % 10 === 0 ? `output line ${tick}\r\n` : '') + inkFrame(ptySize[id].cols, `✻ Working ${tick}`))
        }, 100))
      } else if (changed) {
        setTimeout(() => out(INK_ERASE_FRAME + inkFrame(msg.cols, '? for shortcuts')), 30)
      }
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
    else if (p === '/grid-templates' && method === 'GET') value = state.templates
    else if (p.startsWith('/grid-templates/') && method === 'PUT') {
      const id = p.split('/')[2]
      const t = state.templates.find((x) => x.id === id)
      if (t) Object.assign(t, req.postDataJSON() || {})
      value = t || {}
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
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.IVE_DEBUG) console.log(e.stack) })
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.waitForTimeout(600)
  if (openTabs.length) {
    await page.evaluate(async ({ sessions, openTabs, templates, activeTemplateId }) => {
      const store = (await import('/src/state/store.js')).default
      const { startedSessions } = await import('/src/lib/terminalWriters.js')
      openTabs.forEach((id) => startedSessions.add(id))
      store.setState({
        sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), openTabs,
        activeSessionId: openTabs[0], activeWorkspaceId: 'ws', showHome: false, sessionFocus: false,
        gridLayout: 'equal', gridTemplates: templates, activeGridTemplateId: activeTemplateId,
      })
    }, { sessions, openTabs, templates, activeTemplateId })
    await page.waitForTimeout(1500)
  }
  return { context, page, ptyMsgs, errors, state, stopOutput: () => timers.forEach(clearInterval) }
}

// Everything that decides whether a tile shows the whole terminal.
async function tileGeometry(page, id) {
  return page.evaluate(async (id) => {
    const { terminalControls } = await import('/src/lib/terminalWriters.js')
    const cell = document.querySelector(`[data-session-view="${id}"], [data-grid-cell-session="${id}"]`)
    if (!cell) return { mounted: false }
    const r = cell.getBoundingClientRect()
    const screen = cell.querySelector('.xterm-screen')
    const xterm = cell.querySelector('.xterm')
    const wrapper = xterm?.parentElement?.parentElement
    const grid = cell.parentElement
    const size = terminalControls.get(id)?.getSize?.()
    const wr = wrapper?.getBoundingClientRect()
    const sr = screen?.getBoundingClientRect()
    const gr = grid.getBoundingClientRect()
    const cellW = sr && size ? sr.width / size.cols : 0
    const visibleCols = sr && wr && cellW ? Math.floor((Math.min(sr.right, wr.right, gr.right, innerWidth) - Math.max(sr.left, wr.left)) / cellW + 0.01) : 0
    const rowH = sr && size ? sr.height / size.rows : 0
    const visibleRows = sr && wr && rowH ? Math.floor((Math.min(sr.bottom, wr.bottom) - Math.max(sr.top, wr.top)) / rowH + 0.01) : 0
    return {
      mounted: true,
      visible: r.width > 50 && r.height > 50 && getComputedStyle(cell).display !== 'none',
      cell: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      size,
      fontSize: terminalControls.get(id)?.getFontSize?.() ?? null,
      visibleCols,
      visibleRows,
      hClip: !!(sr && wr && (sr.right > wr.right + 1 || sr.left < wr.left - 1 || sr.right > gr.right + 1)),
      vClip: !!(sr && wr && (sr.bottom > wr.bottom + 1 || sr.top < wr.top - 1)),
      leftEdgeVisible: !!(sr && wr && sr.left >= wr.left - 1),
      lastRowVisible: !!(sr && wr && rowH && sr.bottom <= wr.bottom + 1 && sr.bottom - rowH >= wr.top - 1),
      widerHint: (() => { const h = cell.querySelector('[data-preview-wider]'); return !!h && h.getBoundingClientRect().width > 0 })(),
      composerShown: (() => { const c = cell.querySelector('[data-terminal-composer]'); return !!c && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0 })(),
      vScroll: wrapper ? wrapper.scrollHeight > wrapper.clientHeight + 2 && getComputedStyle(wrapper).overflowY !== 'hidden' : null,
      hScroll: wrapper ? wrapper.scrollWidth > wrapper.clientWidth + 2 && getComputedStyle(wrapper).overflowX !== 'hidden' : null,
      gridHScroll: grid.scrollWidth > grid.clientWidth + 2,
    }
  }, id)
}

const shot = (page, name) => page.screenshot({ path: join(shotDir, `${name}.png`) })
const sizeChanges = (msgs, id, from = 0) => {
  const all = msgs.filter((m) => m.id === id)
  let prev = null, changes = 0
  all.forEach((m, i) => {
    const key = `${m.cols}x${m.rows}`
    if (i >= from && prev && key !== prev) changes++
    prev = key
  })
  return changes
}

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1280x800', width: 1280, height: 800 },
]
const four = [0, 1, 2, 3].map((i) => mkSession(i))
const fonts = []

try {
  // 1. Overview tiles show the whole terminal.
  for (const vp of viewports) {
    for (const theme of ['light', 'dark']) {
      const { context, page, errors } = await setup(vp, { sessions: four, openTabs: four.map((s) => s.id), theme })
      await shot(page, `${vp.name}-overview-${theme}`)
      if (theme === 'light') {
        const tiles = await Promise.all(four.map((s) => tileGeometry(page, s.id)))
        tiles.forEach((g, i) => {
          const tag = `${vp.name} tile ${i + 1}`
          fonts.push(`${vp.name} ${g.fontSize}px`)
          check(`${tag}: font >= 9px`, g.fontSize >= 9, `${g.fontSize}px, PTY ${g.size?.cols}x${g.size?.rows}, tile ${g.cell?.w}x${g.cell?.h}`)
          check(`${tag}: >= 80 visible columns`, g.visible && g.visibleCols >= 80 && g.size.cols >= 80, `visible ${g.visibleCols}x${g.visibleRows} of ${g.size?.cols}x${g.size?.rows}`)
          check(`${tag}: no scrollbars, left edge visible`, g.leftEdgeVisible && !g.hScroll && !g.vScroll && !g.gridHScroll)
          check(`${tag}: cropped right edge only with "wider" hint`, (g.hClip && g.widerHint) || (!g.hClip && !g.widerHint), `cropped ${g.hClip}, hint ${g.widerHint}`)
          check(`${tag}: latest row visible (bottom-anchored)`, g.lastRowVisible)
          check(`${tag}: no status line / prompt box in the tile`, !g.composerShown)
        })
      }
      check(`${vp.name} ${theme}: no page errors`, errors.length === 0, errors.join(' | '))
      await context.close()
    }
  }

  // 2. Overview <-> Session toggling must not resize the PTY back and forth.
  {
    const { context, page, ptyMsgs, errors } = await setup({ width: 1440, height: 900 }, { sessions: four, openTabs: four.map((s) => s.id) })
    const startIdx = Object.fromEntries(four.map((s) => [s.id, ptyMsgs.filter((m) => m.id === s.id).length]))
    const before = ptyMsgs.length
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goSession('s1'))
      await page.waitForTimeout(900)
      if (i === 0) {
        await shot(page, 'toggle-session-level')
        const sg = await tileGeometry(page, 's1')
        check('Session level: status line + prompt box shown, base font', sg.composerShown && sg.fontSize === 13 && !sg.widerHint, `font ${sg.fontSize}px`)
      }
      await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goOverview())
      await page.waitForTimeout(900)
    }
    await shot(page, 'toggle-back-in-overview')
    const sent = ptyMsgs.length - before
    const focusedChanges = sizeChanges(ptyMsgs, 's1', startIdx.s1)
    const otherChanges = four.filter((s) => s.id !== 's1').map((s) => sizeChanges(ptyMsgs, s.id, startIdx[s.id]))
    console.log(`     resize messages during 5 toggles: ${sent}; size changes s1=${focusedChanges}, others=${otherChanges.join(',')}`)
    check('toggle 5x: focused PTY changes size at most once', focusedChanges <= 1, `${focusedChanges} changes`)
    check('toggle 5x: other PTYs never change size', otherChanges.every((n) => n === 0), otherChanges.join(','))
    const g = await tileGeometry(page, 's1')
    check('toggle 5x: tile still readable', g.fontSize >= 9 && g.visibleCols >= 80 && g.lastRowVisible && !g.composerShown, `font ${g.fontSize}px, visible ${g.visibleCols}x${g.visibleRows} of ${g.size?.cols}x${g.size?.rows}`)
    check('toggle: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 3. Custom grid template: new / newly opened sessions stay visible.
  {
    const templates = [{
      id: 't1', workspace_id: 'ws', name: 'Pair', cols: 2,
      cells: [
        { id: 'c1', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
        { id: 'c2', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
        { id: 'c3', col: 1, row: 2, colSpan: 2, rowSpan: 1 },
      ],
      cell_assignments: { c1: 's0', c2: 's1' },
    }]
    const sessions = [...four.slice(0, 2), mkSession(4)]
    const { context, page, errors, state } = await setup({ width: 1440, height: 900 }, { sessions, openTabs: ['s0', 's1'], templates, activeTemplateId: 't1' })
    await shot(page, 'template-before')
    const visibleCell = (id) => page.evaluate((id) => {
      const el = document.querySelector(`[data-grid-cell-session="${id}"]`)
      if (!el) return false
      const r = el.getBoundingClientRect()
      return getComputedStyle(el).display !== 'none' && r.width > 50 && r.height > 50 && !!el.querySelector('.xterm')
    }, id)
    // New session (what NewSessionDialog does after the API call).
    await page.evaluate(async () => {
      const store = (await import('/src/state/store.js')).default
      store.getState().addSession({ id: 's100', workspace_id: 'ws', name: 'New agent', cli_type: 'claude', model: 'sonnet', status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }, { autoStart: false })
    })
    await page.waitForTimeout(1200)
    await shot(page, 'template-new-session')
    check('template: new session visible', await visibleCell('s100'))
    const assigned = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().gridTemplates[0].cell_assignments)
    check('template: new session lands in the first free cell', assigned.c3 === 's100', JSON.stringify(assigned))
    check('template: assignment saved to the server', state.templates[0].cell_assignments?.c3 === 's100')
    // Back to the overview: all three cells filled, now open an existing session.
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goOverview())
    await page.waitForTimeout(600)
    await shot(page, 'template-overview-full')
    for (const id of ['s0', 's1', 's100']) {
      const g = await tileGeometry(page, id)
      check(`template overview: ${id} tile readable`, g.visible && g.fontSize >= 9 && g.visibleCols >= 80 && g.lastRowVisible && !g.composerShown && (!g.hClip || g.widerHint), `font ${g.fontSize}px, visible ${g.visibleCols}x${g.visibleRows} of ${g.size?.cols}x${g.size?.rows}`)
    }
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().openSession('s4', { autoStart: false }))
    await page.waitForTimeout(1200)
    await shot(page, 'template-full-open-existing')
    const level = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().sessionFocus)
    check('template full: opened session visible', await visibleCell('s4'))
    check('template full: shown at Session level', level === true)
    const notice = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().notifications.map((n) => n.message).join(' | '))
    check('template full: notice shown', /cell/i.test(notice) && /Agent 5/.test(notice), notice)
    // Back to the overview: the session must not vanish silently.
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goOverview())
    await page.waitForTimeout(600)
    await shot(page, 'template-full-back-to-overview')
    {
      const g = await tileGeometry(page, 's100')
      check('template overview after Session level: tile readable, bottom-anchored', g.visible && g.fontSize >= 9 && g.lastRowVisible && g.leftEdgeVisible && (!g.hClip || g.widerHint), `font ${g.fontSize}px, visible ${g.visibleCols}x${g.visibleRows} of ${g.size?.cols}x${g.size?.rows}`)
    }
    const pill = await page.locator('[data-template-overflow]').getByRole('button', { name: /Agent 5/ }).isVisible().catch(() => false)
    check('template full: overview lists the session that has no cell', pill)
    check('template: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
  // 4. Overview <-> Session with a Claude-like TUI: the new level is on screen
  //    in the first frame, at the live bottom, with an intact TUI frame.
  {
    const { context, page, ptyMsgs, errors, stopOutput } = await setup({ width: 1512, height: 945 }, { sessions: four, openTabs: four.map((s) => s.id), ink: true })
    await page.waitForTimeout(600)
    const startIdx = ptyMsgs.filter((m) => m.id === 's0').length
    // Switch inside the page and measure in the first two animation frames,
    // i.e. what the browser paints right after the click.
    const switchAndSample = (action) => page.evaluate(async (action) => {
      const store = (await import('/src/state/store.js')).default
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      const sample = () => {
        const cell = document.querySelector('[data-session-view="s0"]')
        const xterm = cell.querySelector('.xterm')
        const host = xterm.parentElement
        const wrapper = host.parentElement
        const sr = xterm.querySelector('.xterm-screen').getBoundingClientRect()
        const wr = wrapper.getBoundingClientRect()
        const c = terminalControls.get('s0')
        const v = c.getViewport()
        return {
          font: c.getFontSize(), size: c.getSize(), preview: host.classList.contains('is-overview-preview'),
          blankAbove: Math.round(sr.top - wr.top), blankBelow: Math.round(wr.bottom - sr.bottom),
          atBottom: v.viewportY === v.baseY,
        }
      }
      store.getState()[action]('s0')
      // Let React commit first: a frame is painted only after the commit.
      await new Promise((r) => setTimeout(r, 0))
      const frames = []
      for (let i = 0; i < 2; i++) { await new Promise((r) => requestAnimationFrame(r)); frames.push(sample()) }
      return frames
    }, action)
    // The visible TUI rows after the last line of history output.
    const tail = () => page.evaluate(async () => {
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      return terminalControls.get('s0').getBufferLines().map((l) => l.text.trimEnd()).filter(Boolean).slice(-6)
    })
    const liveBottom = () => page.evaluate(async () => {
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      const v = terminalControls.get('s0').getViewport()
      return { ok: v.viewportY === v.baseY, detail: `viewport row ${v.viewportY} of ${v.baseY}` }
    })
    const fmt = (f) => `font ${f.font}px, blank above ${f.blankAbove}px / below ${f.blankBelow}px, ${f.size.cols}x${f.size.rows}${f.preview ? ', preview' : ''}${f.atBottom ? '' : ', scrolled up'}`
    let sessionSize = null
    for (let i = 0; i < 3; i++) {
      const s = await switchAndSample('goSession')
      sessionSize ||= s[0].size
      s.forEach((f, n) => check(`ink round ${i + 1}: Session level in frame ${n + 1} (base font, top-aligned, filled, live bottom)`,
        f.font === 13 && !f.preview && f.blankAbove <= 8 && f.blankBelow <= 30 && f.atBottom, fmt(f)))
      await page.waitForTimeout(700)
      { const b = await liveBottom(); check(`ink round ${i + 1}: Session level still follows the live output`, b.ok, b.detail) }
      if (i === 0) await shot(page, 'ink-session-level')
      const o = await switchAndSample('goOverview')
      o.forEach((f, n) => check(`ink round ${i + 1}: Overview tile in frame ${n + 1} (scaled font, bottom-anchored, live bottom)`,
        f.font < 13 && f.font >= 8 && f.preview && f.blankBelow >= 0 && f.blankBelow <= 8 && f.atBottom, fmt(f)))
      check(`ink round ${i + 1}: xterm keeps the Session-level size`, [...s, ...o].every((f) => f.size.cols === sessionSize.cols && f.size.rows === sessionSize.rows), [...s, ...o].map((f) => `${f.size.cols}x${f.size.rows}`).join(' '))
      await page.waitForTimeout(700)
      { const b = await liveBottom(); check(`ink round ${i + 1}: Overview tile still follows the live output`, b.ok, b.detail) }
    }
    await shot(page, 'ink-overview')
    await switchAndSample('goSession')
    await page.waitForTimeout(700)
    const rows = await tail()
    const boxTops = rows.filter((r) => r.startsWith('╭')).length
    check('ink: TUI frame intact after 3 round trips (one prompt box, status line last)', boxTops === 1 && /✻ Working \d+$/.test(rows.at(-1)), rows.map((r) => r.slice(0, 40)).join(' | '))
    const changes = sizeChanges(ptyMsgs, 's0', startIdx)
    const last = ptyMsgs.filter((m) => m.id === 's0').at(-1)
    check('ink: PTY never resized by the switches, equals the xterm size', changes === 0 && last && last.cols === sessionSize.cols && last.rows === sessionSize.rows, `${changes} changes, PTY ${last?.cols}x${last?.rows}, xterm ${sessionSize.cols}x${sessionSize.rows}`)
    check('ink: no page errors', errors.length === 0, errors.join(' | '))
    stopOutput()
    await context.close()
  }
} finally {
  await writeFile(join(shotDir, 'results.json'), JSON.stringify(results, null, 2))
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\nOverview font sizes: ${[...new Set(fonts)].join(', ')}`)
console.log(`${results.length - failures.length}/${results.length} checks passed. Screenshots: ${shotDir}`)
if (failures.length && strict) process.exitCode = 1
