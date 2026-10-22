// ⌘F "Find in session": browser regression with an isolated Vite server and
// a fully mocked API + WebSocket (no backend, no PTY, no real agent).
//
// Chat: ⌘F opens a find bar over the transcript (not the cross-session
// search), counts and highlights matches, Enter / ⇧Enter / ⌘G / ⇧⌘G step,
// "No matches" for nothing, Esc closes and gives the focus back to the
// message field, a session switch closes it. Terminal: ⌘F searches the xterm
// buffer, is not typed into the PTY, Esc returns to the terminal. ⌘⇧F and
// ⌘F on Home open the search across all sessions.
//
//   node tests/find-in-session.mjs      (IVE_TEST_PORT, IVE_SHOTS=<dir> for screenshots)
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
const SHOTS = process.env.IVE_SHOTS || ''
if (SHOTS) await mkdir(SHOTS, { recursive: true })

const testDir = await mkdtemp(join(tmpdir(), 'ive-find-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port: Number(process.env.IVE_TEST_PORT || 5204), strictPort: true, open: false },
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
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const sessions = [0, 1].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: i === 1 ? 'codex' : 'claude', model: 'sonnet',
  status: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))
// Simulated transcript: 4 × "deploy" in s0 (one in a user message), none in s1.
const t0 = Date.parse('2026-10-12T09:00:00Z')
const msg = (sid, n, role, content) => ({ id: `${sid}-m${n}`, session_id: sid, role, content, created_at: new Date(t0 + n * 60000).toISOString() })
const transcripts = {
  s0: [
    msg('s0', 1, 'user', 'Please prepare the deploy script for staging.'),
    msg('s0', 2, 'assistant', 'I looked at the repository. The Deploy step currently runs after the tests.'),
    msg('s0', 3, 'user', 'Good. Keep the database migration separate.'),
    msg('s0', 4, 'assistant', 'Done. The migration now runs first, then deploy, then a smoke test.'),
    ...Array.from({ length: 8 }, (_, i) => msg('s0', 5 + i, i % 2 ? 'assistant' : 'user', `Filler message ${i + 1} about logging and retries.`)),
    msg('s0', 13, 'assistant', 'Summary: staging deploy is ready for review.'),
  ],
  s1: [
    msg('s1', 1, 'user', 'Rename the settings page.'),
    msg('s1', 2, 'assistant', 'Renamed it to Preferences and updated the links.'),
  ],
}

async function setup({ width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Find QA')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('cc-terminalBoardMode', '0')
  })
  const inputs = []
  const sockets = []
  await context.routeWebSocket('**/ws', (socket) => {
    sockets.push(socket)
    socket.onMessage((raw) => {
      let m
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m.action === 'input') inputs.push({ id: m.session_id, data: m.data })
      if (['start_pty', 'resize', 'resume_pty'].includes(m.action)) {
        setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: m.session_id, data: '\x1b[2J\x1b[H> ' })), 20)
      }
    })
  })
  const searchCalls = []
  await context.route('**/api/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.slice(4), method = req.method()
    let value = []
    const msgs = /^\/sessions\/([^/]+)\/messages$/.exec(p)
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? '99' : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces') value = [ws]
    else if (p === '/sessions' && method === 'GET') value = sessions
    else if (msgs) value = transcripts[msgs[1]] || []
    else if (p === '/search') { searchCalls.push(u.searchParams.get('q')); value = [] }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true, codex: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
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
      activeSessionId: 's0', activeWorkspaceId: 'ws', showHome: false, viewMode: 'tabs', activeGridTemplateId: null,
    })
    store.getState().goSession('s0')
  }, sessions)
  await page.waitForTimeout(1200)
  const output = (sid, data) => sockets.forEach((s) => s.send(JSON.stringify({ type: 'output', session_id: sid, data })))
  return { context, page, inputs, errors, output, searchCalls }
}

const findBar = (page, kind) => page.locator(`[data-find-bar="${kind}"]:visible`)
const status = async (page, kind = 'chat') => (await findBar(page, kind).locator('[data-find-status]').textContent())?.trim()
const globalSearch = (page) => page.getByPlaceholder(/search across all sessions/i)
const focusInfo = (page) => page.evaluate(() => {
  const ae = document.activeElement
  if (ae?.classList?.contains('xterm-helper-textarea')) return 'xterm'
  return `${ae?.tagName}${ae?.getAttribute('aria-label') ? `[${ae.getAttribute('aria-label')}]` : ''}${ae?.getAttribute('placeholder') ? `{${ae.getAttribute('placeholder')}}` : ''}`
})
// Where the focus is right after the ⌘F keydown was handled, before any
// animation frame: that is where a key typed immediately would go.
const armFocusProbe = (page) => page.evaluate(() => {
  window.__focusAfterCmdF = null
  const onKey = (e) => {
    if (!(e.metaKey && e.key.toLowerCase() === 'f')) return
    window.removeEventListener('keydown', onKey)
    queueMicrotask(() => {
      const ae = document.activeElement
      window.__focusAfterCmdF = ae?.closest?.('[data-find-bar]') ? 'find' : ae?.classList?.contains('xterm-helper-textarea') ? 'xterm' : ae?.tagName || 'none'
    })
  }
  window.addEventListener('keydown', onKey)
})
const focusProbe = (page) => page.evaluate(() => window.__focusAfterCmdF)
const highlights = (page) => page.evaluate(() => ({
  all: globalThis.CSS?.highlights?.get('ive-find')?.size || 0,
  current: [...(globalThis.CSS?.highlights?.get('ive-find-current') || [])].map((r) => r.toString()).join('|'),
}))
const settle = (page, ms = 350) => page.waitForTimeout(ms)
const composer = (page) => page.locator('[data-session-view="s0"] .x-canvas textarea:visible').first()

try {
  const { context, page, inputs, errors, output, searchCalls } = await setup()
  await page.getByText('Summary: staging deploy is ready').first().waitFor()

  // ── Chat ──
  await composer(page).click()
  await page.keyboard.press('Meta+f')
  await settle(page)
  check('⌘F in a chat opens the chat find bar', await findBar(page, 'chat').count() === 1)
  check('⌘F in a chat does not open the search across all sessions', !(await globalSearch(page).isVisible().catch(() => false)))
  check('find field has the focus', (await focusInfo(page)).includes('Find in this chat'), await focusInfo(page))
  check('scope is named ("This chat")', /This chat/.test(await findBar(page, 'chat').locator('[data-find-scope]').textContent()))
  await page.keyboard.type('deploy')
  await settle(page)
  // Starts at the first match on screen (the chat sits at its newest message).
  check('counts every visible match, starts at the one on screen ("4 of 4")', (await status(page)) === '4 of 4', await status(page))
  let hl = await highlights(page)
  check('all matches highlighted, current one marked', hl.all === 4 && /deploy/i.test(hl.current), JSON.stringify(hl))
  await shot(page, 'chat-find-1-of-4')
  await page.keyboard.press('Enter')
  check('Enter → next match (wraps to the first)', (await status(page)) === '1 of 4', await status(page))
  await page.keyboard.press('Shift+Enter')
  check('⇧Enter → previous match (wraps to the last)', (await status(page)) === '4 of 4', await status(page))
  await page.keyboard.press('Shift+Enter')
  check('⇧Enter again → older match', (await status(page)) === '3 of 4', await status(page))
  await page.keyboard.press('Meta+g')
  await settle(page, 150)
  check('⌘G → next', (await status(page)) === '4 of 4', await status(page))
  await page.keyboard.press('Meta+Shift+g')
  await settle(page, 150)
  check('⇧⌘G → previous', (await status(page)) === '3 of 4', await status(page))
  check('⌘G in the find bar does not open Guidelines', !(await page.getByRole('dialog').filter({ hasText: /Guidelines/ }).isVisible().catch(() => false)))
  const box = await page.evaluate(() => {
    const scroll = document.querySelector('[data-session-scroll="s0"]')
    const r = [...(CSS.highlights.get('ive-find-current') || [])][0]?.getBoundingClientRect()
    const b = scroll.getBoundingClientRect()
    return r ? { inView: r.top >= b.top && r.bottom <= b.bottom } : null
  })
  check('the current match is scrolled into view', box?.inView, JSON.stringify(box))
  await findBar(page, 'chat').getByRole('button', { name: /Next match/ }).click()
  check('next button steps too', (await status(page)) === '4 of 4', await status(page))

  await findBar(page, 'chat').getByRole('textbox').fill('kubernetes')
  await settle(page)
  check('no match reads "No matches"', (await status(page)) === 'No matches', await status(page))
  check('no match: step buttons disabled', await findBar(page, 'chat').getByRole('button', { name: /Next match/ }).isDisabled())
  check('no match: no highlights left', (await highlights(page)).all === 0)
  await shot(page, 'chat-find-no-matches')

  await findBar(page, 'chat').getByRole('textbox').fill('DEPLOY')
  await settle(page)
  check('matching ignores case', /^\d of 4$/.test(await status(page)), await status(page))

  await page.keyboard.press('Escape')
  await settle(page)
  check('Esc closes the find bar', await findBar(page, 'chat').count() === 0)
  check('Esc gives the focus back to the message field', (await focusInfo(page)).startsWith('TEXTAREA'), await focusInfo(page))
  check('Esc leaves the session open (no level change)', await page.evaluate(async () => !!(await import('/src/state/store.js')).default.getState().sessionFocus))
  check('closing clears the highlights', (await highlights(page)).all === 0)

  await page.keyboard.press('Meta+f')
  await settle(page)
  check('⌘F again reopens with the last query selected', await findBar(page, 'chat').getByRole('textbox').inputValue() === 'DEPLOY'
    && await page.evaluate(() => { const a = document.activeElement; return a.selectionStart === 0 && a.selectionEnd === a.value.length }))

  // Session switch closes the bar; the other session searches its own chat.
  await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().setActiveSession('s1'))
  await settle(page, 800)
  check('switching session closes the find bar', await findBar(page, 'chat').count() === 0)
  await page.locator('[data-session-view="s1"] .x-canvas textarea:visible').first().click()
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('deploy')
  await settle(page)
  check('the other session searches only its own chat', (await status(page)) === 'No matches', await status(page))
  await page.keyboard.type(' ')
  await findBar(page, 'chat').getByRole('textbox').fill('renamed')
  await settle(page)
  check('…and finds its own text', (await status(page)) === '1 of 1', await status(page))
  await page.keyboard.press('Escape')
  await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().setActiveSession('s0'))
  await settle(page, 800)

  // Regression (acceptance 12.10.): the field got the focus a frame after ⌘F,
  // so a character typed right away landed in the draft. No wait in between.
  await composer(page).click()
  const draftBefore = await composer(page).inputValue()
  await armFocusProbe(page)
  await page.keyboard.press('Meta+f')
  await page.keyboard.press('q')
  await settle(page, 150)
  check('⌘F focuses the find field in the same task (before the next frame)', (await focusProbe(page)) === 'find', await focusProbe(page))
  const typedFast = { find: await findBar(page, 'chat').getByRole('textbox').inputValue().catch(() => null), draft: await composer(page).inputValue() }
  check('⌘F then an immediate key: the key lands in the find field, not in the draft', typedFast.find === 'q' && typedFast.draft === draftBefore, JSON.stringify(typedFast))
  await page.keyboard.press('Escape')
  await settle(page)

  // ⌘⇧F: search across all sessions, also from inside a chat.
  await composer(page).click()
  await page.keyboard.press('Meta+Shift+f')
  await settle(page)
  check('⌘⇧F opens the search across all sessions', await globalSearch(page).isVisible())
  check('⌘⇧F does not open Quick Feature', !(await page.getByText(/Capture Feature|Quick Feature/).first().isVisible().catch(() => false)))
  await shot(page, 'global-search-cmd-shift-f')
  await page.keyboard.press('Escape')
  await settle(page)
  check('Esc closes the search across all sessions', !(await globalSearch(page).isVisible().catch(() => false)))

  // "All sessions" in the find bar hands over to the global search.
  await composer(page).click()
  await page.keyboard.press('Meta+f')
  await findBar(page, 'chat').getByRole('button', { name: /All sessions/ }).click()
  await settle(page)
  check('"All sessions" in the find bar opens the global search', await globalSearch(page).isVisible() && await findBar(page, 'chat').count() === 0)
  await page.keyboard.press('Escape')
  await settle(page)

  // ── Terminal view of the session (⌘` switches chat ⇄ terminal) ──
  await page.locator('[data-session-view="s0"]').getByTitle('Switch to Terminal View').first().click()
  await settle(page, 900)
  const xterm = page.locator('[data-session-view="s0"] .xterm-screen').first()
  await xterm.waitFor()
  output('s0', '\r\nnpm run build\r\nerror: missing module foo\r\nretrying...\r\nERROR again in step two\r\nlast line: error\r\n> ')
  await settle(page, 400)
  await xterm.click()
  await settle(page)
  const before = inputs.length
  await page.keyboard.press('Meta+f')
  await settle(page)
  check('⌘F in the terminal opens the terminal find bar', await findBar(page, 'terminal').count() === 1)
  check('⌘F in the terminal does not open the chat find bar', await findBar(page, 'chat').count() === 0)
  await page.keyboard.type('error')
  await settle(page)
  check('terminal: counts matches in the buffer ("3 of 3")', (await status(page, 'terminal')) === '3 of 3', await status(page, 'terminal'))
  const decos = await page.evaluate(() => document.querySelectorAll('[data-session-view="s0"] .xterm-decoration').length)
  check('terminal: every match is marked in the terminal', decos === 3, `decorations ${decos}`)
  await page.keyboard.press('Shift+Enter')
  check('terminal: ⇧Enter steps back', (await status(page, 'terminal')) === '2 of 3', await status(page, 'terminal'))
  await shot(page, 'terminal-find')
  check('⌘F and the query never reached the PTY', inputs.slice(before).length === 0, JSON.stringify(inputs.slice(before)))
  await findBar(page, 'terminal').getByRole('textbox').fill('nothing-like-this')
  await settle(page)
  check('terminal: "No matches"', (await status(page, 'terminal')) === 'No matches')
  await page.keyboard.press('Escape')
  await settle(page)
  check('terminal: Esc closes the find bar', await findBar(page, 'terminal').count() === 0)
  check('terminal: Esc gives the focus back to the terminal', (await focusInfo(page)) === 'xterm', await focusInfo(page))
  check('terminal: Esc was not sent to the agent', inputs.slice(before).length === 0, JSON.stringify(inputs.slice(before)))
  // Same race in the terminal: an immediate key after ⌘F must not reach the PTY.
  const beforeFast = inputs.length
  await armFocusProbe(page)
  await page.keyboard.press('Meta+f')
  await page.keyboard.press('z')
  await settle(page, 150)
  check('terminal: ⌘F focuses the find field in the same task (before the next frame)', (await focusProbe(page)) === 'find', await focusProbe(page))
  const termFast = await findBar(page, 'terminal').getByRole('textbox').inputValue().catch(() => null)
  check('terminal: ⌘F then an immediate key lands in the find field, nothing reaches the PTY', termFast === 'z' && inputs.slice(beforeFast).length === 0, `${termFast} ${JSON.stringify(inputs.slice(beforeFast))}`)
  await page.keyboard.press('Escape')
  await settle(page)
  // Right-click menu offers the same search (reachable without ⌘F, e.g. on
  // Windows/Linux where Ctrl+F stays readline "forward char" in the terminal).
  await xterm.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Find in Terminal/ }).click()
  await settle(page)
  check('terminal context menu "Find in Terminal" opens the find bar', await findBar(page, 'terminal').count() === 1)
  await page.keyboard.press('Escape')
  await page.locator('[data-session-view="s0"]').getByTitle('Switch to Chat View').first().click()
  await settle(page, 600)

  // ── Home: ⌘F keeps the search across all sessions ──
  await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goHome())
  await settle(page, 600)
  await page.keyboard.press('Meta+f')
  await settle(page)
  check('⌘F on Home opens the search across all sessions', await globalSearch(page).isVisible())
  await page.keyboard.press('Escape')
  void searchCalls

  check('no page errors', errors.length === 0, errors.join(' | '))
  await context.close()

  // ── Phone width ──
  const narrow = await setup({ width: 390, height: 844 })
  await narrow.page.getByText('Summary: staging deploy is ready').first().waitFor().catch(() => {})
  await narrow.page.locator('textarea:visible').first().click()
  await narrow.page.keyboard.press('Meta+f')
  await narrow.page.keyboard.type('deploy')
  await settle(narrow.page)
  const fit = await narrow.page.evaluate(() => {
    const r = document.querySelector('[data-find-bar="chat"]')?.getBoundingClientRect()
    return r ? { left: r.left, right: r.right, vw: innerWidth, scroll: document.documentElement.scrollWidth } : null
  })
  check('390 px: find bar fits the screen', fit && fit.left >= 0 && fit.right <= fit.vw && fit.scroll <= fit.vw, JSON.stringify(fit))
  check('390 px: count visible', /of 4/.test(await status(narrow.page) || ''), await status(narrow.page))
  await shot(narrow.page, 'chat-find-390')
  check('390 px: no page errors', narrow.errors.length === 0, narrow.errors.join(' | '))
  await narrow.context.close()
} finally {
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\n${total - failures.length}/${total} checks passed`)
if (failures.length) process.exitCode = 1
