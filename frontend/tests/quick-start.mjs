// Quick start: browser test with an isolated Vite server and fully mocked
// API + WebSocket (same pattern as terminal-open.mjs). No real backend, PTY or
// session is touched.
//
//   node tests/quick-start.mjs                      # checks + screenshots
//   IVE_SHOT_DIR=/tmp/qs node tests/quick-start.mjs
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

// Quick start is ⌘N, but Mac browsers reserve ⌘N, so the Mac browser default
// is ⌃N (keybindings.js BROWSER_CONTROL_BINDINGS). Chromium here is a Mac browser on darwin.
const MOD = process.platform === 'darwin' ? 'Control' : 'Meta'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
const shotDir = resolve(process.env.IVE_SHOT_DIR || fileURLToPath(new URL('../../review-quickstart', import.meta.url)))
await mkdir(shotDir, { recursive: true })

const testDir = await mkdtemp(join(tmpdir(), 'ive-quickstart-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_QS_PORT || 5185), strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()

const results = []
const failures = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ROOT = '/Users/qa/Projekte'
const QUICK_WS = { id: 'wq', name: 'Quick sessions', path: ROOT, color: '#6b7280', is_quick: true }
const GUIDELINES = [
  { id: 'g1', name: 'Testing rules', content: 'Always run npm test before you say you are done.' },
  { id: 'g2', name: 'German copy', content: 'All UI copy in German, informal.' },
]

function tuiFrame(cols, rows) {
  const inner = Math.max(0, cols - 2)
  const title = ` Claude Code (mock) · ${cols}x${rows} `.slice(0, inner)
  const top = '╭' + title + '─'.repeat(Math.max(0, inner - title.length)) + '╮'
  const bottom = '╰' + '─'.repeat(inner) + '╯'
  const line = (t = '') => '│' + t.slice(0, inner).padEnd(inner, ' ') + '│'
  const body = []
  for (let r = 0; r < rows - 3; r++) body.push(line(r === 0 ? ' Welcome to the mocked agent.' : ''))
  return '\x1b[?1049h\x1b[H\x1b[2J' + [top, ...body, bottom].join('\r\n') + '\r\n' + '> '.padEnd(cols, ' ') + `\x1b[${rows};3H`
}

async function setup(viewport, { theme = 'light', workspaces = [] } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  await context.addInitScript((theme) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Quick QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', '1')
    localStorage.setItem('ive-theme.v2', theme)
  }, theme)
  const state = {
    workspaces: [...workspaces], sessions: [], quickStart: { root: ROOT, workspace_id: null, workspace_name: 'Quick sessions' },
    calls: [], pty: [], socket: null, created: 0,
  }
  await context.routeWebSocket('**/ws', (socket) => {
    state.socket = socket
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.action === 'input') { state.pty.push({ action: 'input', id: msg.session_id, data: msg.data, t: Date.now() }); return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      state.pty.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: tuiFrame(msg.cols, msg.rows) })), 40)
    })
  })
  await context.route('**/api/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.slice(4), method = req.method()
    let body = null
    try { body = req.postDataJSON() } catch { body = null }
    if (!['/settings', '/whoami', '/extensions'].includes(p) && !p.startsWith('/settings/')) state.calls.push({ method, path: p, body })
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces' && method === 'GET') value = state.workspaces
    else if (p === '/quick-start' && method === 'GET') value = state.quickStart
    else if (p === '/quick-start' && method === 'PUT' && body?.root === '/does/not/exist') {
      await route.fulfill({ status: 400, json: { error: 'Folder does not exist: /does/not/exist' } }); return
    }
    else if (p === '/quick-start' && method === 'PUT') {
      state.quickStart = { ...state.quickStart, root: body.root }
      state.workspaces = state.workspaces.map((w) => (w.id === 'wq' ? { ...w, path: body.root } : w))
      value = state.quickStart
    }
    else if (p === '/sessions/quick' && method === 'POST' && body?.workspace_id && body.workspace_id !== 'wq') {
      // Project start (sidebar "New session", ⌘N with a project, Home Enter).
      const n = ++state.created
      const s = {
        id: `p${n}`, workspace_id: body.workspace_id, name: body?.name || 'New session', cli_type: body?.cli_type || 'claude',
        model: body?.model || 'sonnet', status: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], quick: false,
      }
      state.sessions.push(s); value = s
    }
    else if (p === '/quick-start/workspace' && method === 'POST') {
      if (!state.workspaces.some((w) => w.id === 'wq')) state.workspaces.push({ ...QUICK_WS, path: state.quickStart.root })
      state.quickStart = { ...state.quickStart, workspace_id: 'wq' }
      value = state.workspaces.find((w) => w.id === 'wq')
    }
    else if (p === '/sessions/quick' && method === 'POST') {
      if (!state.workspaces.some((w) => w.id === 'wq')) state.workspaces.push({ ...QUICK_WS, path: state.quickStart.root })
      state.quickStart = { ...state.quickStart, workspace_id: 'wq' }
      const n = ++state.created
      const s = {
        id: `q${n}`, workspace_id: 'wq', name: body?.name || 'Quick session', cli_type: body?.cli_type || 'claude',
        model: body?.model || 'sonnet', status: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], quick: true,
      }
      state.sessions.push(s); value = s
    }
    else if (/^\/sessions\/[^/]+\/attach$/.test(p) && method === 'POST') {
      const id = p.split('/')[2]
      const ws = { id: 'wm', name: 'acme', path: body?.path || `${ROOT}/acme`, color: '#1647ff' }
      if (!state.workspaces.some((w) => w.id === 'wm')) state.workspaces.push(ws)
      const s = state.sessions.find((x) => x.id === id)
      Object.assign(s, { workspace_id: 'wm', quick: false })
      state.socket?.send(JSON.stringify({ type: 'session_update', session_id: id, session: s }))
      value = { session: s, workspace: { ...ws, is_quick: false } }
    }
    else if (/^\/sessions\/[^/]+\/project-hint$/.test(p)) value = {}
    else if (/^\/sessions\/[^/]+\/input$/.test(p) && method === 'POST') {
      // Claude prompts go through the acknowledged input endpoint; the
      // backend types the text into the PTY and submits it with Enter.
      const id = p.split('/')[2], t = Date.now()
      state.pty.push({ action: 'input', id, data: String(body?.message || ''), t, via: 'endpoint' })
      state.pty.push({ action: 'input', id, data: '\r', t: t + 1, via: 'endpoint' })
      value = { ok: true, state: 'sent' }
    }
    else if (p === '/sessions' && method === 'GET') {
      const ws = u.searchParams.get('workspace')
      value = state.sessions.filter((s) => !ws || s.workspace_id === ws)
    }
    else if (p === '/sessions' && method === 'POST') {
      const n = ++state.created
      const s = { id: `s${n}`, workspace_id: body?.workspace_id, name: body?.name || `Session ${n}`, cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [] }
      state.sessions.push(s); value = s
    }
    else if (p === '/guidelines') value = GUIDELINES
    else if (p === '/project-search') value = { matches: [{ name: 'acme', path: `${ROOT}/acme`, kind: 'git repository', description: 'Demo online shop.' }] }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true, codex: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (p === '/overview') value = { workspace_total: state.workspaces.length, detail_limit: 5, workspaces: [] }
    else if (method !== 'GET') value = {}
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.waitForTimeout(700)
  // The guided tour's welcome card covers the app on a fresh profile; pause it.
  const later = page.locator('.ive-tour-welcome').getByRole('button', { name: 'Später' })
  if (await later.isVisible().catch(() => false)) { await later.click(); await page.waitForTimeout(200) }
  return { context, page, errors, state }
}

const calls = (state, method, path) => state.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)))
const inputs = (state, id) => state.pty.filter((m) => m.id === id && m.action === 'input')
const typed = (state, id) => inputs(state, id).map((m) => m.data).join('')
const shot = (page, name) => page.screenshot({ path: join(shotDir, `${name}.png`) })
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) } return false }

async function inspectSession(page, id) {
  return page.evaluate(async (id) => {
    const store = (await import('/src/state/store.js')).default.getState()
    const cell = document.querySelector(`[data-session-view="${id}"]`)
    if (!cell) return { mounted: false }
    const r = cell.getBoundingClientRect()
    const ae = document.activeElement
    return {
      mounted: true,
      w: Math.round(r.width), h: Math.round(r.height),
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      focused: !!(ae && cell.contains(ae) && ae.classList.contains('xterm-helper-textarea')),
      active: store.activeSessionId === id,
      sessionFocus: !!store.sessionFocus,
    }
  }, id)
}

const sendHint = (state, sessionId) => state.socket.send(JSON.stringify({
  type: 'session_project_hint', session_id: sessionId, path: `${ROOT}/acme`, name: 'acme', workspace_id: null,
}))

try {
  // ── Main flow: zero workspaces, ⌘N, text, Enter ──────────────────────────
  {
    const vp = { width: 1440, height: 900 }
    const { context, page, errors, state } = await setup(vp)
    await page.keyboard.press(`${MOD}+n`)
    const prompt = page.locator('[data-quick-start]')
    check('⌘N with zero workspaces opens the quick prompt', await prompt.isVisible().catch(() => false))
    check('prompt input is focused', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'What do you want to work on?'))
    check('footer shows the start folder', await prompt.getByText('~/Projekte').isVisible().catch(() => false))
    check('CLI chips default to Claude', await prompt.getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed') === 'true')

    // Esc closes.
    await page.keyboard.press('Escape')
    check('Esc closes the quick prompt', !(await prompt.isVisible().catch(() => false)))

    await page.keyboard.press(`${MOD}+n`)
    const text = 'Fix the login bug in acme, the reset mail never arrives'
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-session-view="q1"] .xterm'))
    const post = calls(state, 'POST', '/sessions/quick')[0]
    check('Enter calls POST /api/sessions/quick', !!post, JSON.stringify(post?.body))
    check('quick session name = first words', post?.body?.name === 'Fix the login bug in acme,', post?.body?.name)
    check('quick session uses the chosen CLI/model', post?.body?.cli_type === 'claude' && post?.body?.model === 'sonnet')
    check('prompt closes after start', !(await prompt.isVisible().catch(() => false)))
    await page.waitForTimeout(1200)
    const g = await inspectSession(page, 'q1')
    check('session opens large', g.mounted && g.inViewport && g.w >= (vp.width - 300) * 0.6, JSON.stringify(g))
    check('session opens focused (keyboard in terminal)', g.focused && g.active, JSON.stringify(g))
    const delivered = await waitFor(() => typed(state, 'q1').includes(text), 12000)
    const start = state.pty.find((m) => m.id === 'q1' && m.action === 'start_pty')
    const firstText = inputs(state, 'q1').find((m) => m.data.includes(text))
    check('typed text reaches the PTY as input', delivered)
    check('text arrives after start_pty + boot delay', start && firstText && firstText.t - start.t >= 1500, start && firstText ? `${firstText.t - start.t} ms after start_pty` : 'missing')
    await waitFor(() => inputs(state, 'q1').some((m) => m.data === '\r' && m.t > (firstText?.t || 0)), 3000)
    check('text is submitted with Enter', inputs(state, 'q1').some((m) => m.data === '\r' && m.t > (firstText?.t || 0)))
    const sideText = await page.locator('[data-quick-workspace]').first().textContent().catch(() => '')
    check('sidebar shows "Quick sessions" with the root', sideText.includes('Quick sessions') && sideText.includes('~/Projekte'), sideText)
    check('quick workspace hides the delete action', (await page.locator('.x-workspace-group').filter({ has: page.locator('[data-quick-workspace]') }).getByLabel('Delete workspace').count()) === 0)
    await shot(page, 'flow-1440x900-light-session-started')

    // ── Empty Enter also starts ─────────────────────────────────────────────
    await page.keyboard.press(`${MOD}+n`)
    await prompt.waitFor()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-session-view="q2"] .xterm'))
    const post2 = calls(state, 'POST', '/sessions/quick')[1]
    check('empty Enter starts a session', !!post2)
    check('empty Enter sends no name', post2 && post2.body?.name === undefined, JSON.stringify(post2?.body))
    await page.waitForTimeout(2600)
    check('empty Enter sends no first message', !typed(state, 'q2').includes('\r'), JSON.stringify(typed(state, 'q2')))

    // ── Add context: guidelines + note as one message ───────────────────────
    await page.locator('.x-context-bar').getByRole('button', { name: 'Add context' }).click()
    const panel = page.locator('[data-add-context]')
    await panel.getByText('Testing rules').waitFor()
    await panel.getByText('Testing rules').click()
    await panel.getByLabel('Note for the agent').fill('Use the staging database, never prod.')
    await shot(page, 'flow-1440x900-light-add-context')
    await panel.getByRole('button', { name: 'Send context' }).click()
    const ctxOk = await waitFor(() => { const t = typed(state, 'q2'); return t.includes('Always run npm test') && t.includes('Use the staging database') }, 6000)
    check('"Add context" sends guideline text + note into the PTY', ctxOk)
    // The acknowledged input endpoint takes the context as one message (the
    // backend pastes it); unselected guidelines never go along.
    const ctxCalls = calls(state, 'POST', '/sessions/q2/input')
    check('context goes in as one message', ctxCalls.length === 1 && ctxCalls[0].body?.message.includes('Always run npm test')
      && ctxCalls[0].body?.message.includes('Use the staging database') && !typed(state, 'q2').includes('German copy'), JSON.stringify(ctxCalls.map((c) => c.body)))

    // ── Project hint banner + Attach ────────────────────────────────────────
    sendHint(state, 'q2')
    const hint = page.locator('[data-project-hint]')
    await hint.waitFor().catch(() => {})
    check('project hint shows the banner', await hint.isVisible().catch(() => false))
    check('banner says "Looks like this is acme. Attach?"', (await hint.innerText().catch(() => '')).replace(/\s+/g, ' ').includes('Looks like this is acme. Attach?'))
    const bars = await page.evaluate(() => {
      const bar = document.querySelector('.x-context-bar'), h = document.querySelector('[data-project-hint]')
      return bar && h ? bar.contains(h) : false
    })
    check('banner sits in the session header row (no extra full-width row)', bars)
    await shot(page, 'flow-1440x900-light-project-hint')
    await hint.getByRole('button', { name: 'Attach' }).click()
    await waitFor(() => calls(state, 'POST', '/sessions/q2/attach').length > 0, 4000)
    const attach = calls(state, 'POST', '/sessions/q2/attach')[0]
    check('Attach calls POST /api/sessions/{id}/attach', !!attach && attach.body?.path === `${ROOT}/acme`, JSON.stringify(attach?.body))
    await page.waitForTimeout(300)
    check('banner disappears after attach', !(await hint.isVisible().catch(() => false)))
    check('"attach" button disappears once attached', (await page.locator('.x-context-bar').getByRole('button', { name: 'Attach to project' }).count()) === 0)
    check('session now belongs to the project', await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().sessions.q2?.workspace_id === 'wm'))

    // Dismiss path on the other quick session.
    await page.locator('.ive-terminal-switcher').getByRole('button', { name: /^Fix the login/ }).click().catch(() => {})
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().setActiveSession('q1'))
    sendHint(state, 'q1')
    await hint.waitFor().catch(() => {})
    await hint.getByRole('button', { name: 'Dismiss' }).click()
    sendHint(state, 'q1')
    await page.waitForTimeout(300)
    check('Dismiss hides the hint and it does not come back for the same path', !(await hint.isVisible().catch(() => false)))

    // ── "Attach to project" from the header (project search) ───────────────
    check('quick session header has "attach"', await page.locator('.x-context-bar').getByRole('button', { name: 'Attach to project' }).isVisible().catch(() => false))

    // ── WS session_update (backend broadcast after attach) ─────────────────
    state.workspaces.push({ id: 'wx', name: 'ive', path: `${ROOT}/ive`, color: '#0a7' })
    state.socket.send(JSON.stringify({ type: 'session_update', session_id: 'q1', session: { ...state.sessions.find((x) => x.id === 'q1'), workspace_id: 'wx', quick: false } }))
    const merged = await waitFor(() => page.evaluate(async () => {
      const st = (await import('/src/state/store.js')).default.getState()
      return st.sessions.q1?.workspace_id === 'wx' && st.sessions.q1?.quick === false && st.workspaces.some((w) => w.id === 'wx')
    }), 4000)
    check('WS session_update merges workspace_id/quick into the store (and loads the new workspace)', merged)
    await page.waitForTimeout(200)
    check('after session_update the header drops "attach"', (await page.locator('.x-context-bar').getByRole('button', { name: 'Attach to project' }).count()) === 0)

    // ── Invalid start folder: 400 {error} shown inline ─────────────────────
    await page.keyboard.press(`${MOD}+n`)
    await prompt.waitFor()
    // The session on screen now belongs to a project, so ⌘N preselects it;
    // the start folder belongs to "No project".
    check('⌘N inside a project session preselects that project', await prompt.getByLabel('Project').evaluate((el) => el.options[el.selectedIndex]?.text).then((t) => t === 'ive'))
    check('a project hides the start-folder "change" link', (await prompt.getByRole('button', { name: 'Change start folder' }).count()) === 0)
    await prompt.getByLabel('Project').selectOption('')
    await prompt.getByRole('button', { name: 'Change start folder' }).click()
    await prompt.getByLabel('Start folder').fill('/does/not/exist')
    await prompt.getByLabel('Start folder').press('Enter')
    check('invalid folder shows the backend error inline', await page.locator('[data-quick-start]').getByText('Folder does not exist').isVisible({ timeout: 3000 }).catch(() => false) || await page.getByText('Folder does not exist').first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false))
    await prompt.getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')

    // ── Change the start folder → PUT /api/quick-start ─────────────────────
    await page.keyboard.press(`${MOD}+n`)
    await prompt.waitFor()
    await prompt.getByLabel('Project').selectOption('')
    await prompt.getByRole('button', { name: 'Change start folder' }).click()
    const rootInput = prompt.getByLabel('Start folder')
    check('change opens an inline path field', await rootInput.isVisible())
    await rootInput.fill('/Users/qa/Code')
    await rootInput.press('Enter')
    await waitFor(() => calls(state, 'PUT', '/quick-start').some((c) => c.body?.root === '/Users/qa/Code'), 4000)
    const put = calls(state, 'PUT', '/quick-start').at(-1)
    check('changing the start folder calls PUT /api/quick-start', put?.body?.root === '/Users/qa/Code', JSON.stringify(put?.body))
    await page.waitForTimeout(200)
    check('footer shows the new folder', await prompt.getByText('~/Code').isVisible().catch(() => false))
    check('prompt stays open after saving the folder', await prompt.isVisible())

    // ── ⌘⇧N opens the full dialog ───────────────────────────────────────────
    await page.keyboard.press(`${MOD}+Shift+N`)
    const create = page.getByRole('button', { name: 'Create Session' })
    check('⌘⇧N opens the full NewSessionDialog', await create.waitFor({ timeout: 4000 }).then(() => true).catch(() => false))
    check('⌘⇧N closes the quick prompt', !(await prompt.isVisible().catch(() => false)))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    check('Esc closes the full dialog', !(await create.isVisible().catch(() => false)))
    // "Set up session…" link does the same.
    await page.keyboard.press(`${MOD}+n`)
    await prompt.getByRole('button', { name: /Set up session/ }).click()
    check('"Set up session…" opens the full dialog', await create.waitFor({ timeout: 4000 }).then(() => true).catch(() => false))
    await page.keyboard.press('Escape')

    // The "+ New session" button opens the prompt as well.
    await page.locator('[data-new-session-button]').click()
    check('"+ New session" opens the quick prompt', await prompt.isVisible().catch(() => false))
    await page.keyboard.press('Escape')

    check('keybindings: ⌘⇧N does not collide', await page.evaluate(async () => {
      const { KEYBINDING_DEFS, combosEqual } = await import('/src/lib/keybindings.js')
      const withKeys = KEYBINDING_DEFS.filter((d) => d.defaultKey)
      return withKeys.every((a) => withKeys.every((b) => a === b || !combosEqual(a.defaultKey, b.defaultKey)))
    }))
    check('no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ── Home "New session" with zero workspaces ──────────────────────────────
  {
    const { context, page, errors } = await setup({ width: 1440, height: 900 })
    const startBtn = page.getByRole('button', { name: /Start a session/ }).first()
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click()
      check('Home "Start a session" opens the quick prompt (no workspace)', await page.locator('[data-quick-start]').isVisible().catch(() => false))
    } else {
      check('Home "Start a session" visible with zero workspaces', false)
    }
    check('home: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ── Project context: every "New session" uses the shown project ─────────
  {
    const PROJECT = { id: 'wp', name: 'acme', path: `${ROOT}/acme`, color: '#1647ff' }
    const { context, page, errors, state } = await setup({ width: 1440, height: 900 }, { workspaces: [PROJECT] })
    const prompt = page.locator('[data-quick-start]')
    const chosen = () => prompt.getByLabel('Project').evaluate((el) => el.options[el.selectedIndex]?.text)
    await page.keyboard.press(`${MOD}+n`)
    await prompt.waitFor()
    check('⌘N preselects the selected project', await chosen() === 'acme')
    check('popover shows the project folder', await prompt.getByText('~/Projekte/acme').isVisible().catch(() => false))
    await shot(page, 'project-1-ctrl-n')
    await page.keyboard.type('Fix the reset mail')
    await page.keyboard.press('Enter')
    await waitFor(() => calls(state, 'POST', '/sessions/quick').length > 0, 5000)
    const post = calls(state, 'POST', '/sessions/quick')[0]
    check('popover start sends the project (workspace_id)', post?.body?.workspace_id === 'wp', JSON.stringify(post?.body))
    await page.waitForFunction(() => document.querySelector('[data-session-view="p1"] .xterm'))
    check('first message reaches the project session', await waitFor(() => typed(state, 'p1').includes('Fix the reset mail'), 12000))

    // Sidebar "New session" under the project → same prompt, project preselected.
    await page.locator('[data-sidebar-new-session="wp"]').click()
    await prompt.waitFor()
    check('sidebar "New session" opens the short prompt with its project', await chosen() === 'acme')
    check('sidebar "New session" no longer jumps to the full dialog', !(await page.getByRole('button', { name: 'Create Session' }).isVisible().catch(() => false)))
    await page.keyboard.press('Escape')

    // ⌘⇧N: full dialog in the project.
    await page.keyboard.press(`${MOD}+Shift+N`)
    await page.locator('[data-session-setup-where]').waitFor()
    check('⌘⇧N opens the full dialog in the project', (await page.locator('[data-session-setup-where]').innerText()).includes('Project: acme'))
    await page.keyboard.press('Escape')

    // Home composer: Enter = conversation, Plan task = explicit.
    await page.getByRole('button', { name: /^Home/ }).first().click()
    const composer = page.locator('[data-home-composer]')
    await composer.waitFor()
    check('Home names the project before the start', (await page.locator('[data-home-start-hint]').innerText()).includes('acme'))
    check('Home primary action is "Start session"', (await page.locator('[data-home-start]').innerText()).trim() === 'Start session')
    await composer.fill('Was macht dieses Projekt?')
    await shot(page, 'project-2-home-question')
    await composer.press('Enter')
    await waitFor(() => calls(state, 'POST', '/sessions/quick').length > 1, 5000)
    const ask = calls(state, 'POST', '/sessions/quick')[1]
    check('Home Enter starts a session in the project', ask?.body?.workspace_id === 'wp' && ask?.body?.name === 'Was macht dieses Projekt?', JSON.stringify(ask?.body))
    check('Home Enter opens no planning dialog', !(await page.getByText('Turn your request into a result').isVisible().catch(() => false)))
    check('Home question reaches the agent', await waitFor(() => typed(state, 'p2').includes('Was macht dieses Projekt?'), 12000))

    await page.getByRole('button', { name: /^Home/ }).first().click()
    await composer.fill('Add dark mode to the landing page')
    await composer.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`)
    check('⌘↵ opens the planning flow', await page.getByText('Turn your request into a result').waitFor({ timeout: 4000 }).then(() => true, () => false))
    check('⌘↵ starts no session', calls(state, 'POST', '/sessions/quick').length === 2)
    await shot(page, 'project-3-plan')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').getByRole('button', { name: /close/i }).first().click().catch(() => {})

    // No project: Home and ⌘⇧N say so, Enter starts in the start folder.
    await page.getByRole('button', { name: /^Home/ }).first().click()
    await page.locator('[data-home-composer]').locator('xpath=ancestor::form').locator('[data-project-target]').selectOption('')
    check('Home without project names the start folder', (await page.locator('[data-home-start-hint]').innerText()).includes('start folder'))
    await page.keyboard.press(`${MOD}+n`)
    await prompt.waitFor()
    check('⌘N without project shows "No project"', await chosen() === 'No project (start folder)')
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${MOD}+Shift+N`)
    await page.locator('[data-session-setup-where]').waitFor({ timeout: 4000 }).catch(() => {})
    check('⌘⇧N without project opens the dialog in the start folder', (await page.locator('[data-session-setup-where]').innerText().catch(() => '')).includes('No project'))
    await page.keyboard.press('Escape')
    await composer.fill('Welche Projekte liegen hier?')
    await composer.press('Enter')
    await waitFor(() => calls(state, 'POST', '/sessions/quick').length > 2, 5000)
    const none = calls(state, 'POST', '/sessions/quick')[2]
    check('Home Enter without project starts in the start folder', none && !none.body?.workspace_id, JSON.stringify(none?.body))
    check('project context: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // ── Screenshots: light + dark, 1440x900 + 1100x800 ───────────────────────
  for (const theme of ['light', 'dark']) {
    for (const vp of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
      const tag = `${vp.width}x${vp.height}-${theme}`
      const { context, page, state, errors } = await setup(vp, { theme })
      await shot(page, `${tag}-0-home`)
      await page.keyboard.press(`${MOD}+n`)
      await page.locator('[data-quick-start]').waitFor()
      await page.keyboard.type('Add dark mode to the acme landing page')
      await shot(page, `${tag}-1-quick-prompt`)
      await page.locator('[data-quick-start]').getByRole('button', { name: 'Change start folder' }).click()
      await shot(page, `${tag}-2-change-folder`)
      await page.locator('[data-quick-start]').getByRole('button', { name: 'Cancel' }).click()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-session-view="q1"] .xterm'))
      await waitFor(() => typed(state, 'q1').includes('\r'), 8000)
      await page.waitForTimeout(300)
      const barOverflow = () => page.evaluate(() => { const b = document.querySelector('.x-context-bar'); return b ? b.scrollWidth - b.clientWidth : null })
      const beforeHint = await barOverflow()
      const widths = await page.evaluate(() => [...document.querySelector('.x-context-bar').children].map((c) => `${c.className.split(' ')[0]}:${Math.round(c.getBoundingClientRect().width)}`).join(' '))
      console.log(`  ${tag} header overflow before hint: ${beforeHint}px; ${widths}`)
      sendHint(state, 'q1')
      await page.locator('[data-project-hint]').waitFor().catch(() => {})
      await page.waitForTimeout(300)
      await shot(page, `${tag}-3-session-with-hint`)
      const overflow = await page.evaluate(() => {
        const bar = document.querySelector('.x-context-bar')
        return { page: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollLeft > 0, bar: bar ? bar.scrollWidth > bar.clientWidth + 1 : null }
      })
      check(`${tag}: hint fits the header without horizontal scroll`, !overflow.page && overflow.bar === false, JSON.stringify(overflow))
      await page.locator('.x-context-bar').getByRole('button', { name: 'Add context' }).click()
      await page.locator('[data-add-context]').getByText('Testing rules').waitFor()
      await shot(page, `${tag}-4-add-context`)
      await page.keyboard.press('Escape')
      await page.locator('.x-context-bar').getByRole('button', { name: 'Attach to project' }).click()
      await page.getByText('Demo online shop').waitFor({ timeout: 4000 }).catch(() => {})
      await shot(page, `${tag}-5-attach-picker`)
      check(`${tag}: attach picker is prefilled with the hinted project`, await page.getByLabel('What would you like to work on?').inputValue().then((v) => v === 'acme').catch(() => false))
      check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '))
      await context.close()
    }
  }
} finally {
  await writeFile(join(shotDir, 'results.json'), JSON.stringify(results, null, 2))
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed. Screenshots: ${shotDir}`)
if (failures.length) process.exitCode = 1
