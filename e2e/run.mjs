// IVE end-to-end run: real backend, real SQLite, real PTYs, real browser,
// fully isolated from the operator's machine state. See e2e/README.md.
//
//   node e2e/run.mjs                 # build frontend, run everything, clean up
//   IVE_E2E_SKIP_BUILD=1 node e2e/run.mjs
//   IVE_E2E_KEEP=1 node e2e/run.mjs  # keep the sandbox dir for inspection
//   IVE_E2E_HEADED=1 node e2e/run.mjs
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  E2E_DIR, ROOT, FORBIDDEN_PORTS, createSandbox, guardedRealPaths, portFree, removeSandbox,
  mentionsSandbox, runIsolationCheck, snapshot, startBackend, stopAll, waitForHealth,
} from './sandbox.mjs'

const require = createRequire(join(ROOT, 'frontend', 'package.json'))
const { chromium } = require('playwright')

const PORT = Number(process.env.IVE_E2E_PORT || 5191)
const OUT = join(E2E_DIR, 'out')
const BASE = `http://127.0.0.1:${PORT}`
const SESSION_NAME = 'E2E Fake Agent'

const results = []
const consoleErrors = []
const pageErrors = []
let sb = null
let backend = null
let browser = null
let shotNo = 0

function log(...args) { console.log(...args) }
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`)
  return !!ok
}
async function shot(page, name) {
  const file = join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  return file
}
async function api(path, init) {
  const res = await fetch(`${BASE}/api${path}`, init)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}
async function poll(fn, { timeout = 15000, interval = 250 } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last } catch (e) { last = undefined }
    await new Promise((r) => setTimeout(r, interval))
  }
  return last
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Steps never abort the whole run: a failure is recorded and the next step tries anyway.
async function step(name, fn) {
  log(`\n── ${name}`)
  try { await fn() } catch (err) { check(`${name}: no exception`, false, err?.message?.split('\n')[0]) }
}

async function sessionByName(name) {
  const list = await api('/sessions')
  return Array.isArray(list) ? list.find((s) => s.name === name) : null
}
async function ptyText(id) {
  const out = await api(`/sessions/${id}/output?lines=400`)
  return `${out?.text || ''}\n${out?.screen || ''}`
}
function fakeLog() {
  try { return readFileSync(join(sb.home, 'fake-cli.log'), 'utf8') } catch { return '' }
}

function mark(name) {
  try { appendFileSync(join(sb.home, 'fake-cli.log'), `--- step: ${name}\n`) } catch {}
}
function logSince(name) {
  const text = fakeLog()
  const i = text.lastIndexOf(`--- step: ${name}`)
  return i < 0 ? '' : text.slice(i)
}
// The PTY's real size as the fake CLI last saw it (start or SIGWINCH).
function ptySize() {
  const m = [...fakeLog().matchAll(/\] (?:size|resize) (\d+)x(\d+)/g)].at(-1)
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null
}

// Every place the UI names this session's state: leaf elements whose whole
// text is a status word, grouped by where they are. They must agree.
async function statusWords(page, id, name) {
  return page.evaluate(({ id, name }) => {
    const WORDS = new Set(['Running', 'Waiting', 'Done', 'Failed', 'Stopped'])
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== 'hidden' }
    const leaves = [...document.querySelectorAll('body *')].filter((el) => {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
      return WORDS.has(own) && visible(el)
    })
    const out = {}
    for (const el of leaves) {
      const word = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
      let where = null
      const cell = el.closest('[data-session-view]')
      if (cell) where = cell.getAttribute('data-session-view') === id ? 'terminalCell' : null
      else if (el.closest('aside') || el.getBoundingClientRect().right < 285) {
        // Sidebar: only the item that carries this session's name.
        let item = el
        for (let i = 0; i < 6 && item && !(item.innerText || '').includes(name); i++) item = item.parentElement
        where = item && (item.innerText || '').includes(name) && !(item.innerText || '').includes('Commander') ? 'sidebar' : null
      } else if (el.getBoundingClientRect().top < 120) where = 'sessionHeader'
      else if (el.closest('.x-context-bar, footer') || el.getBoundingClientRect().top > innerHeight - 140) where = 'composerBar'
      if (where) (out[where] ||= []).push(word)
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...new Set(v)].join('/')]))
  }, { id, name })
}
const agree = (w) => { const v = Object.values(w); return v.length > 0 && v.every((x) => x === v[0]) && !v[0].includes('/') }
const allSay = async (page, id, word) => { const w = await statusWords(page, id, SESSION_NAME); return w.sidebar === word && agree(w) ? w : null }

// Visible terminal geometry vs. what the client told the PTY and what the PTY has.
async function geometry(page, id, wsFrames) {
  const g = await page.evaluate((id) => {
    const cell = document.querySelector(`[data-session-view="${id}"]`)
    if (!cell) return { mounted: false }
    const r = cell.getBoundingClientRect()
    const xterm = cell.querySelector('.xterm')
    const screen = cell.querySelector('.xterm-screen')
    const wrapper = xterm?.parentElement?.parentElement
    const wr = wrapper?.getBoundingClientRect(), sr = screen?.getBoundingClientRect()
    const ae = document.activeElement
    return {
      mounted: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      focused: !!(ae && cell.contains(ae) && ae.classList.contains('xterm-helper-textarea')),
      screenH: sr?.height, screenW: sr?.width, spareH: wr && sr ? wr.bottom - sr.bottom : null, spareW: wr && sr ? wr.right - sr.right : null,
      lastRowCut: wr && sr ? sr.bottom > wr.bottom + 1 : null,
    }
  }, id)
  const sent = wsFrames.filter((f) => f.session_id === id && ['start_pty', 'resize', 'resume_pty'].includes(f.action)).at(-1)
  g.client = sent ? { cols: sent.cols, rows: sent.rows } : null
  g.pty = ptySize()
  if (g.client && g.screenH) {
    const cellH = g.screenH / g.client.rows
    g.unusedRows = Math.floor(g.spareH / cellH)
  }
  return g
}

async function main() {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  if (FORBIDDEN_PORTS.has(PORT)) throw new Error(`refusing port ${PORT}`)
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is busy; set IVE_E2E_PORT`)

  // 0. Build the frontend the backend serves (frontend/dist, gitignored).
  if (process.env.IVE_E2E_SKIP_BUILD !== '1' || !existsSync(join(ROOT, 'frontend/dist/index.html'))) {
    // configLoader=runner: no temp file in the (possibly shared) node_modules.
    log('building frontend …')
    const r = spawnSync(process.execPath, [join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'warn'],
      { cwd: join(ROOT, 'frontend'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(join(OUT, 'frontend-build.log'), `${r.stdout}\n${r.stderr}`)
    if (r.status !== 0) throw new Error('frontend build failed, see e2e/out/frontend-build.log')
  }

  // 1. Sandbox + isolation proof before anything starts.
  const guarded = guardedRealPaths()
  const before = snapshot(guarded)
  sb = await createSandbox({ port: PORT })
  log(`sandbox: ${sb.root}`)
  const iso = runIsolationCheck(sb)
  writeFileSync(join(OUT, 'isolation.json'), JSON.stringify(iso, null, 2))
  if (!check('isolation preflight: every home/state path is inside the sandbox', iso.isolated, iso.problems?.join('; '))) {
    throw new Error('isolation preflight failed; backend NOT started (see e2e/out/isolation.json)')
  }

  // 2. Real backend from this checkout, sandbox env, own process group.
  backend = startBackend(sb, openSync(join(OUT, 'backend.log'), 'w'))
  const who = await waitForHealth(PORT, backend)
  check('backend healthy on sandbox port', who && who.actor_kind, `${who?.actor_kind} ${who?.mode}`)

  browser = await chromium.launch({ headless: process.env.IVE_E2E_HEADED !== '1' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('cc-soundEnabled', '0')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location()?.url || ''}`) })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const wsFrames = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    try { const m = JSON.parse(String(f.payload)); if (m && m.action) wsFrames.push({ ...m, data: m.action === 'input' ? m.data : undefined, t: Date.now() }) } catch {}
  }))

  // First run: the interactive tour (German). Welcome → "Selbst ausprobieren"
  // → coach opens the real project picker; the workspace step picks the
  // project, then the remaining parts are skipped and the tour is completed
  // against the real sandbox DB.
  const coach = page.locator('[data-tour-step]')
  const tourStep = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ive.interactive-tour.v2.owner') || 'null')?.step || null } catch { return null } })
  await step('onboarding / first run', async () => {
    await page.goto(`${BASE}/`)
    const welcome = page.getByRole('dialog', { name: 'Dein Projekt. Dein erster Durchlauf.' })
    check('first run shows the onboarding welcome', await welcome.waitFor().then(() => true, () => false))
    check('welcome keeps the app inert', await page.locator('.x-app-shell').evaluate((el) => el.inert))
    await shot(page, 'onboarding')
    await welcome.getByRole('button', { name: 'Selbst ausprobieren', exact: true }).click()
    check('coach shows the project lesson', await page.locator('[data-tour-step="project"]').waitFor().then(() => true, () => false))
    await coach.getByRole('button', { name: 'Projekt auswählen', exact: true }).click()
    check('coach opens the project picker', await page.getByRole('heading', { name: 'Find your project' }).waitFor().then(() => true, () => false))
    const saved = await api('/settings/product_tour_version')
    check('starting the tour does not mark it completed', !(Number(saved?.value) >= 2), JSON.stringify(saved))
  })

  await step('add a workspace', async () => {
    await page.getByPlaceholder('e.g. I want to work on IVE').fill('demo-app')
    const hit = page.getByRole('button', { name: /demo-app/ }).filter({ hasText: sb.workspace }).first()
    check('project search finds the sandbox repo', await hit.waitFor().then(() => true, () => false))
    await shot(page, 'project-search')
    await hit.click()
    const ws = await poll(async () => (await api('/workspaces')).find?.((w) => w.path === sb.workspace))
    check('workspace stored with the sandbox path', ws, ws?.id)
    // Outside the tour, adding a workspace asks for optional project context.
    // While the tour runs it is suppressed (App.jsx: `!onboarding.open`) so
    // the coach stays the only guide on screen.
    check('tour advances to the session lesson', await poll(async () => (await tourStep()) === 'session', { timeout: 8000 }))
    await sleep(1500)
    check('project-context dialog stays closed while the tour runs', (await page.getByRole('dialog', { name: /Context for demo-app/ }).count()) === 0)
    check('workspace shows in the sidebar', await page.getByText('demo-app', { exact: false }).first().isVisible())
    await shot(page, 'workspace-added')
  })

  await step('onboarding: skip the remaining parts and finish', async () => {
    // session → loop-setup → tools → done, one "Diesen Teil auslassen" each.
    for (const next of ['loop-setup', 'tools', 'done']) {
      await coach.getByRole('button', { name: 'Diesen Teil auslassen', exact: true }).click()
      check(`skipping reaches "${next}"`, await poll(async () => (await tourStep()) === next, { timeout: 5000 }))
    }
    await shot(page, 'onboarding-done')
    await coach.getByRole('button', { name: 'Einführung abschließen', exact: true }).click()
    check('tour closes after finishing', await coach.waitFor({ state: 'detached' }).then(() => true, () => false))
    const saved = await poll(async () => { const v = await api('/settings/product_tour_version'); return Number(v?.value) >= 2 ? v : null })
    check('tour completion persisted in the sandbox DB', saved, JSON.stringify(saved))
    await page.reload()
    await page.locator('.x-app-shell').waitFor()
    await sleep(1000)
    check('completed tour stays closed after reload', (await page.locator('[data-ive-onboarding]').count()) === 0)
  })

  await step('enable terminal board mode in General Settings', async () => {
    await page.getByRole('button', { name: /^Configure/ }).first().click()
    await page.getByText('General Settings', { exact: true }).first().click()
    const row = page.locator('div').filter({ hasText: /^Terminal board mode/ }).last()
    const label = page.getByText('Terminal board mode', { exact: true })
    await label.waitFor()
    // The toggle sits in the same row as the label.
    const toggle = label.locator('xpath=ancestor::div[contains(@class,"justify-between")][1]').locator('button, [role="switch"]').first()
    await toggle.click()
    const on = await page.evaluate(() => localStorage.getItem('cc-terminalBoardMode'))
    check('terminal board mode switched on', on === '1', on)
    await shot(page, 'general-settings')
    await page.keyboard.press('Escape')
    void row
  })

  let sid = null
  const geomChecks = async (label) => {
    const g = await geometry(page, sid, wsFrames)
    check(`${label}: terminal fully on screen`, g.mounted && g.inViewport, JSON.stringify({ x: g.x, y: g.y, w: g.w, h: g.h }))
    check(`${label}: last row not cut off`, g.lastRowCut === false, `spare ${g.spareH}px`)
    check(`${label}: no wasted rows (<=1)`, g.unusedRows <= 1, `unused ${g.unusedRows}`)
    check(`${label}: PTY size == size the terminal shows`, g.client && g.pty && g.client.cols === g.pty.cols && g.client.rows === g.pty.rows, `client ${JSON.stringify(g.client)} pty ${JSON.stringify(g.pty)}`)
    return g
  }

  await step('create a session from the UI', async () => {
    // "+" opens the quick start prompt; the full form is one link away.
    await page.getByRole('button', { name: 'Create a new session' }).click()
    const quick = page.getByRole('dialog', { name: 'Quick start' })
    check('"+" opens the quick start prompt', await quick.waitFor({ timeout: 5000 }).then(() => true, () => false))
    await quick.getByRole('button', { name: /Set up session/ }).click()
    const dlg = page.getByRole('dialog', { name: 'New AI session' })
    check('new-session form is an accessible dialog', await dlg.waitFor({ timeout: 5000 }).then(() => true, () => false))
    // Fields are labelled now: the name input is found by its label.
    await dlg.getByLabel(/^Session name/).fill(SESSION_NAME)
    check('new-session form labels the assistant choice and permissions',
      (await dlg.getByRole('group', { name: 'AI assistant' }).count()) === 1 && (await dlg.getByLabel('Permissions', { exact: true }).count()) === 1)
    await shot(page, 'new-session-dialog')
    await dlg.getByRole('button', { name: 'Create Session' }).click()
    const s = await poll(() => sessionByName(SESSION_NAME))
    sid = s?.id
    check('session row created in the sandbox DB', sid, sid)
    const alive = await poll(async () => (await sessionByName(SESSION_NAME))?.pty_alive, { timeout: 20000 })
    check('real PTY is alive', alive)
    const started = await poll(() => /\] size \d+x\d+/.test(fakeLog()), { timeout: 20000 })
    check('the fake claude CLI runs in a real PTY (not the real claude)', started, ptySize() && JSON.stringify(ptySize()))
    check('terminal mounts', await page.locator(`[data-session-view="${sid}"] .xterm`).waitFor({ timeout: 20000 }).then(() => true, () => false))
    await sleep(1500)
    const g = await geomChecks('new session')
    await shot(page, 'terminal-open')
    check('terminal is large (>=60% of the content width, >=50% height)', g.w >= (g.vw - 300) * 0.6 && g.h >= g.vh * 0.5, `${g.w}x${g.h}`)
    check('terminal has keyboard focus', g.focused)
    const banner = await poll(async () => (await ptyText(sid)).includes('FAKE CLAUDE'), { timeout: 10000 })
    check('fake CLI banner reached the PTY output buffer', banner)
  })

  await step('typing reaches the CLI and output renders', async () => {
    if (!sid) throw new Error('no session')
    mark('typing')
    // No click: the terminal must already have focus.
    await page.keyboard.type('hello from e2e')
    await page.keyboard.press('Enter')
    const got = await poll(() => logSince('typing').includes("input 'hello from e2e'"))
    check('keystrokes reached the fake CLI over WebSocket + PTY', got)
    const sawWorking = await poll(() => allSay(page, sid, 'Working'), { timeout: 4000, interval: 100 })
    check('every status word says Working while the CLI thinks', sawWorking, JSON.stringify(sawWorking || await statusWords(page, sid, SESSION_NAME)))
    const reply = await poll(async () => (await ptyText(sid)).includes('FAKE-REPLY: hello from e2e'))
    check('CLI reply is in the PTY buffer', reply)
    const rendered = await page.evaluate((id) => {
      const cell = document.querySelector(`[data-session-view="${id}"]`)
      const rows = cell?.querySelector('.xterm-rows')?.innerText || ''
      return rows.includes('FAKE-REPLY') ? 'dom' : cell?.querySelector('canvas') ? 'canvas' : ''
    }, sid)
    check('terminal renders output (DOM rows or GPU canvas)', rendered, rendered)
    const ready = await poll(() => allSay(page, sid, 'Ready'), { timeout: 10000 })
    check('every status word returns to Ready after the turn (Stop hook)', ready, JSON.stringify(ready || await statusWords(page, sid, SESSION_NAME)))
    await shot(page, 'typed-and-replied')
  })

  await step('attention: permission request shows "Needs you" everywhere', async () => {
    if (!sid) throw new Error('no session')
    mark('attention')
    await page.keyboard.type('ask rm -rf build')
    await page.keyboard.press('Enter')
    const needs = await poll(() => allSay(page, sid, 'Needs you'), { timeout: 15000 })
    await shot(page, 'needs-you')
    check('every status word says "Needs you" after PermissionRequest', needs, JSON.stringify(needs || await statusWords(page, sid, SESSION_NAME)))
    const bar = page.getByText('Permission needed', { exact: true }).first()
    check('attention bar names the permission', await bar.isVisible().catch(() => false))
    const hooks = /hook PermissionRequest -> [1-9]/.test(logSince('attention'))
    check('hook relay scripts in the fake ~/.claude were used', hooks)
    // Terminal still focused after the attention bar appeared?
    check('terminal keeps focus when the attention bar appears', (await geometry(page, sid, wsFrames)).focused)
    await page.keyboard.type('1')
    await page.keyboard.press('Enter')
    const ready = await poll(() => allSay(page, sid, 'Ready'), { timeout: 15000 })
    check('approving clears "Needs you" back to Ready', ready, JSON.stringify(ready || await statusWords(page, sid, SESSION_NAME)))
    await sleep(2500)
    const still = await allSay(page, sid, 'Ready')
    check('…and it stays Ready (no stale re-detection)', still, JSON.stringify(still || await statusWords(page, sid, SESSION_NAME)))
    await geomChecks('after attention bar')
  })

  await step('⌘⇧E to Overview and back', async () => {
    mark('overview')
    await page.keyboard.press('Meta+Shift+E')
    await sleep(1000)
    await shot(page, 'overview')
    const overview = await page.evaluate(() => !!document.querySelector('.ive-terminal-toolbar[data-view-level="overview"]'))
    check('⌘⇧E switches the session view to the Overview', overview)
    await geomChecks('overview')
    const ready = await allSay(page, sid, 'Ready')
    check('Overview shows the same status (Ready)', ready, JSON.stringify(ready || await statusWords(page, sid, SESSION_NAME)))
    await page.keyboard.press('Meta+Shift+E')
    await sleep(1000)
    const back = await page.evaluate(() => !!document.querySelector('.ive-terminal-toolbar[data-view-level="overview"]'))
    check('⌘⇧E again returns to the session', !back)
    const g = await geomChecks('back in session')
    check('back in session: terminal has keyboard focus', g.focused)
    check('Overview round trip sends no keystrokes to the CLI', !/input '/.test(logSince('overview')), logSince('overview').split('\n').filter((l) => l.includes('input')).join(' | '))
    await shot(page, 'back-in-session')
  })

  await step('Home', async () => {
    await page.getByRole('button', { name: /^Home/ }).first().click()
    await sleep(600)
    const top = await page.evaluate(() => {
      const el = [...document.querySelectorAll('h1, h2')].find((h) => h.innerText.trim() === 'Home')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), visible: r.top >= 0 && r.bottom <= innerHeight }
    })
    await shot(page, 'home')
    check('Home opens at the top (Home heading on screen)', top?.visible, JSON.stringify(top))
    const recent = page.locator(`button[title="Open ${SESSION_NAME}"]`).first()
    check('Home lists the running session', await recent.isVisible().catch(() => false))
  })

  await step('quick help (?)', async () => {
    await page.evaluate(() => document.activeElement?.blur?.())
    await page.keyboard.press('?')
    const help = page.locator('[data-cheat-sheet]')
    check('? opens quick help', await help.waitFor({ timeout: 5000 }).then(() => true, () => false))
    await shot(page, 'quick-help')
    await page.keyboard.press('Escape')
    check('Escape closes quick help', await help.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false))
  })

  await step('⌘K finds the session', async () => {
    mark('palette')
    await page.keyboard.press('Meta+k')
    await page.locator('input:focus').waitFor()
    await page.keyboard.type('E2E Fake')
    await sleep(600)
    await shot(page, 'command-palette')
    const hit = page.getByText(SESSION_NAME, { exact: false }).filter({ visible: true })
    check('palette lists the session', (await hit.count()) > 0)
    await page.keyboard.press('Enter')
    await sleep(1500)
    const g = await geometry(page, sid, wsFrames)
    check('Enter opens the session with the terminal focused', g.mounted && g.focused)
    const leaked = logSince('palette').split('\n').filter((l) => l.includes(' input '))
    check('the palette Enter does not leak into the agent terminal', leaked.length === 0, leaked.join(' | '))
    await shot(page, 'palette-opened')
  })

  await step('quick start against the real backend', async () => {
    const TEXT = 'look at demo-app please'
    mark('quick')
    await page.keyboard.press('Escape').catch(() => {})
    await page.getByRole('button', { name: 'Create a new session' }).click()
    const quick = page.getByRole('dialog', { name: 'Quick start' })
    await quick.waitFor({ timeout: 5000 })
    const info = await api('/quick-start')
    check('quick start root is inside the sandbox', typeof info?.root === 'string' && info.root.startsWith(sb.home), info?.root)
    // "New session" preselects the current project; the projectless quick
    // start is the explicit "No project (start folder)" choice.
    const project = quick.getByRole('combobox', { name: 'Project' })
    check('new session preselects the current project', await project.evaluate((el) => el.options[el.selectedIndex]?.text) === 'demo-app')
    await project.selectOption({ label: 'No project (start folder)' })
    await quick.getByRole('textbox', { name: 'What do you want to work on?' }).fill(TEXT)
    await page.keyboard.press('Enter')
    const s = await poll(async () => (await api('/sessions')).find?.((x) => x.quick && x.name?.startsWith('look at demo-app')), { timeout: 20000 })
    check('quick session created without choosing a workspace', s, s?.name)
    const ws = (await api('/workspaces')).find?.((w) => w.is_quick)
    check('it lives in the "Quick sessions" workspace at the start folder', ws && s && ws.id === s.workspace_id && ws.path === (await api('/quick-start')).root, ws?.path)
    check('no files written into the start folder (memory sync off)', !existsSync(join((await api('/quick-start')).root, 'CLAUDE.md')))
    const sent = await poll(() => logSince('quick').includes(`input '${TEXT}'`), { timeout: 25000 })
    check('the typed request reaches the agent as its first message', sent, logSince('quick').split('\n').filter((l) => l.includes(' input ')).slice(0, 4).join(' | '))
    await shot(page, 'quick-session')
    if (s) {
      const res = await api(`/sessions/${s.id}/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sb.workspace }) })
      const demo = (await api('/workspaces')).find?.((w) => w.path === sb.workspace)
      check('attach moves the session into the project workspace', res?.session?.workspace_id === demo?.id && res?.session?.quick === false, JSON.stringify(res).slice(0, 160))
      const pty = await api(`/sessions`).then((l) => l.find?.((x) => x.id === s.id))
      check('the agent keeps running after attach', !!pty?.pty_alive)
    }
  })

  await step('delete session asks for confirmation', async () => {
    // Deletion uses the app's own confirmation dialog (never window.confirm).
    const item = page.locator(`.x-sidebar [data-session-id="${sid}"]`)
    const native = []
    const onNative = async (d) => { native.push(d.message()); await d.dismiss() }
    page.on('dialog', onNative)
    await item.hover()
    await item.getByRole('button', { name: 'Delete session', exact: true }).click()
    const dlg = page.getByRole('dialog', { name: /^Delete session/i })
    check('delete shows a confirmation', await dlg.waitFor({ timeout: 5000 }).then(() => true, () => false))
    check('the confirmation names the session', (await dlg.innerText()).includes(SESSION_NAME))
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    check('cancel keeps the session', !!(await sessionByName(SESSION_NAME)))
    mark('delete')
    await item.hover()
    await item.getByRole('button', { name: 'Delete session', exact: true }).click()
    await dlg.getByRole('button', { name: 'Delete session', exact: true }).click()
    const gone = await poll(async () => !(await sessionByName(SESSION_NAME)))
    check('confirm deletes the session', gone)
    const exited = await poll(() => logSince('delete').includes(' exit'), { timeout: 10000 })
    check('deleting stops the CLI process', exited)
    await sleep(800)
    await shot(page, 'deleted')
    check('session gone from the sidebar', (await page.getByText(SESSION_NAME, { exact: true }).filter({ visible: true }).count()) === 0)
    page.off('dialog', onNative)
    check('no native confirm() was used', native.length === 0, native.join(' | '))
  })

  await step('Codex session: chat view shows user and assistant after the first turn', async () => {
    const CODEX_NAME = 'E2E Codex'
    const PROMPT = 'spawn hello codex e2e'
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const demo = (await api('/workspaces')).find?.((w) => w.path === sb.workspace)
    if (!demo) throw new Error('demo workspace missing')
    const bad = await api('/sessions', json('POST', { workspace_id: demo.id, name: 'E2E Codex bad', cli_type: 'codex', permission_mode: 'untrusted' }))
    check('Codex: a permission mode codex 0.162 rejects is refused on create (400)', bad?.code === 'invalid_permission_mode', JSON.stringify(bad).slice(0, 200))
    mark('codex')
    const created = await api('/sessions', json('POST', { workspace_id: demo.id, name: CODEX_NAME, cli_type: 'codex', permission_mode: 'plan' }))
    const cid = created?.id
    check('Codex session created with permission_mode plan', cid && created.cli_type === 'codex', JSON.stringify(created).slice(0, 200))
    if (!cid) return
    await page.keyboard.press('Escape').catch(() => {})
    await page.getByText(CODEX_NAME, { exact: true }).first().click()
    const alive = await poll(async () => (await api('/sessions')).find?.((x) => x.id === cid)?.pty_alive, { timeout: 20000 })
    check('Codex PTY is alive', alive)
    // IVE also runs `codex mcp add/remove`; the TUI start is the call without a subcommand.
    const TUI_START = /codex\[\d+\] start argv=\[(?!'(?:mcp|login|exec|features|e)')/
    const started = await poll(() => TUI_START.test(logSince('codex')), { timeout: 20000 })
    const startLine = logSince('codex').split('\n').find((l) => TUI_START.test(l)) || ''
    check('the fake codex runs (not the real one)', started, startLine.slice(0, 240))
    check('plan maps to flags codex 0.162 accepts (--sandbox read-only, no argv error)',
      startLine.includes("'--sandbox', 'read-only'") && !/argv error/.test(logSince('codex')), startLine.slice(0, 240))
    check('no rollout before the first prompt (lazy like codex 0.16x)', !/ rollout /.test(logSince('codex')))
    // MCP servers ride on this process's argv (-c mcp_servers.*), so there is
    // no `codex mcp add/remove` rewriting the shared config.toml.
    check('Codex start ran no `codex mcp add/remove`', !/subcommand mcp /.test(logSince('codex')), (logSince('codex').match(/.*subcommand mcp .*/) || [''])[0].slice(0, 200))
    check('per-session MCP env is passed as -c overrides with this session id',
      /mcp_servers\.[\w-]+\.env=/.test(startLine) && startLine.includes(cid), startLine.slice(0, 400))
    const banner = await poll(async () => (await ptyText(cid)).includes('FAKE CODEX'), { timeout: 15000 })
    check('fake codex banner reached the PTY output buffer', banner)
    // Fresh workspace: codex 0.16x first asks "Trust this folder?" and its
    // menu cursor is the same "›" as the composer. IVE must answer it and
    // must not send the queued prompt into the menu.
    const trusted = await poll(() => /trust accepted /.test(logSince('codex')), { timeout: 15000 })
    check('Codex workspace-trust menu shown and answered by IVE', /trust menu shown/.test(logSince('codex')) && trusted)
    // codex 0.16x skips config.toml hooks without persisted trust; IVE must
    // write trusted_hash for its own hooks (the fake checks the real hash).
    check('Codex shows no "hooks need review" warning', banner && !(await ptyText(cid)).includes('need review'))
    const startHooks = await poll(() => logSince('codex').match(/hook SessionStart -> (\d+) command\(s\), (\d+) untrusted/), { timeout: 10000 })
    check('Codex SessionStart hook ran IVE\'s relay (trusted, nothing untrusted)', startHooks && Number(startHooks[1]) >= 1 && startHooks[2] === '0', startHooks?.[0])
    await sleep(800)
    const codexSays = async (word) => { const w = await statusWords(page, cid, CODEX_NAME); return w.sidebar === word && agree(w) ? w : null }
    const sent = await api(`/sessions/${cid}/input`, json('POST', { message: PROMPT }))
    check('prompt sent to the Codex PTY', sent?.ok !== false && !sent?.error, JSON.stringify(sent).slice(0, 200))
    const codexWorking = await poll(() => codexSays('Working'), { timeout: 6000, interval: 100 })
    check('Codex status says Working from the UserPromptSubmit hook', codexWorking, JSON.stringify(codexWorking || await statusWords(page, cid, CODEX_NAME)))
    const codexReady = await poll(() => codexSays('Ready'), { timeout: 15000 })
    check('Codex status returns to Ready from the Stop hook', codexReady, JSON.stringify(codexReady || await statusWords(page, cid, CODEX_NAME)))
    const got = await poll(() => logSince('codex').includes(`input '${PROMPT}'`), { timeout: 15000 })
    check('the prompt reached the fake codex', got)
    check('no keystroke landed in the trust menu', !/trust menu dropped/.test(logSince('codex')))
    const parentId = (await poll(() => logSince('codex').match(/ rollout \S+ id=(\S+)/)?.[1], { timeout: 15000 })) || null
    const childId = (await poll(() => logSince('codex').match(/subagent rollout \S+ id=(\S+)/)?.[1], { timeout: 10000 })) || null
    check('codex wrote the user rollout and a subagent rollout in the same cwd', parentId && childId, `${parentId} / ${childId}`)
    const native = await poll(async () => (await api('/sessions')).find?.((x) => x.id === cid)?.native_session_id, { timeout: 30000 })
    check('detection binds the user thread, not the subagent rollout', native === parentId, `native=${native} parent=${parentId} child=${childId}`)
    const textOf = (m) => { try { const c = typeof m.content === 'string' && m.content.startsWith('[') ? JSON.parse(m.content) : m.content; return typeof c === 'string' ? c : (c || []).map((b) => b.text || '').join(' ') } catch { return String(m.content || '') } }
    const msgs = await poll(async () => {
      const list = await api(`/sessions/${cid}/messages`)
      if (!Array.isArray(list)) return null
      const users = list.filter((m) => m.role === 'user' && textOf(m).includes(PROMPT))
      const replies = list.filter((m) => m.role === 'assistant' && textOf(m).includes(`FAKE-CODEX-REPLY: ${PROMPT}`))
      return users.length && replies.length ? { list, users, replies } : null
    }, { timeout: 30000, interval: 500 })
    check('messages API returns the user turn AND the Codex reply from the rollout', msgs, msgs ? `${msgs.list.length} rows` : 'missing user or assistant row')
    check('the user turn appears exactly once (no double user bubble)', msgs?.users.length === 1, `users=${msgs?.users.length}`)
    check('subagent transcript is not shown', msgs && !msgs.list.some((m) => textOf(m).includes('FAKE-SUBAGENT-REPLY')))
    const toggled = await page.evaluate((name) => {
      const btn = [...document.querySelectorAll('button[title="Switch to Chat View"]')].find((b) => (b.parentElement?.innerText || '').includes(name))
      if (!btn) return false
      btn.click()
      return true
    }, CODEX_NAME)
    check('Codex cell switches to the chat view', toggled)
    const chat = await poll(async () => {
      const text = await page.evaluate((reply) => {
        const el = [...document.querySelectorAll('div')].filter((d) => (d.innerText || '').includes(reply)).at(-1)
        let box = el
        for (let i = 0; i < 12 && box && !(box.querySelector?.('textarea')); i++) box = box.parentElement
        return (box || el)?.innerText || ''
      }, `FAKE-CODEX-REPLY: ${PROMPT}`)
      return text.includes(PROMPT) && text.includes(`FAKE-CODEX-REPLY: ${PROMPT}`) ? text : null
    }, { timeout: 15000, interval: 500 })
    await shot(page, 'codex-chat-view')
    check('chat view shows the user message and the Codex reply', chat)
    const userBubbles = chat ? chat.split(PROMPT).length - 1 : 0
    check('chat view shows the user prompt once plus once inside the reply (no duplicate bubble)', userBubbles === 2, `occurrences=${userBubbles}`)
    mark('codex-restart')
    const restarted = await api(`/sessions/${cid}/restart`, json('POST', {}))
    const resumed = await poll(() => logSince('codex-restart').match(/codex\[\d+\] (resume \S+|resume miss \S+)/)?.[1], { timeout: 20000 })
    check('restart resumes the user thread with `codex resume <id>`', resumed === `resume ${parentId}`, `${resumed} ${JSON.stringify(restarted).slice(0, 120)}`)
    check('trusted workspace: no second trust menu after restart', !/trust menu shown/.test(logSince('codex-restart')))

    // /new inside the Codex TUI: new thread id (SessionStart source=clear),
    // same tab, no phantom "(branch)" sibling.
    await poll(async () => (await api('/sessions')).find?.((x) => x.id === cid)?.pty_alive, { timeout: 20000 })
    await poll(async () => /hook SessionStart/.test(logSince('codex-restart')), { timeout: 15000 })
    const before = (await api('/sessions')).filter?.((x) => x.cli_type === 'codex').length
    mark('codex-new')
    await api(`/sessions/${cid}/input`, json('POST', { message: '/new' }))
    const newId = await poll(() => logSince('codex-new').match(/new thread (\S+)/)?.[1], { timeout: 15000 })
    check('fake codex started a new thread on /new', newId, logSince('codex-new').slice(0, 300))
    await sleep(800)
    await api(`/sessions/${cid}/input`, json('POST', { message: 'after new thread' }))
    const rolledNew = await poll(() => logSince('codex-new').includes(`id=${newId}`), { timeout: 15000 })
    check('the next prompt wrote the new thread rollout', rolledNew)
    const nativeNew = await poll(async () => {
      const row = (await api('/sessions')).find?.((x) => x.id === cid)
      return row?.native_session_id === newId ? row : null
    }, { timeout: 15000 })
    check('/new moves the tab to the new thread id', nativeNew, `want ${newId}`)
    const after = await api('/sessions')
    const codexRows = after.filter?.((x) => x.cli_type === 'codex') || []
    check('/new opens no phantom branch tab', codexRows.length === before && !codexRows.some((x) => /\(branch\)/i.test(x.name || '')),
      codexRows.map((x) => x.name).join(', '))
  })

  await step('Terminal session: plain login shell, echo hello, exit shows Exited', async () => {
    const TERM_NAME = 'E2E Terminal'
    // The sandbox HOME has its own (empty) rc files; mark it so the run proves
    // the shell read the sandbox ~/.zshrc and not the operator's real one.
    appendFileSync(join(sb.home, '.zshrc'), 'echo E2E_SANDBOX_ZSHRC\n')
    mark('terminal')
    await page.keyboard.press('Escape').catch(() => {})
    await page.getByRole('button', { name: 'Create a new session' }).click()
    const quick = page.getByRole('dialog', { name: 'Quick start' })
    await quick.waitFor({ timeout: 5000 })
    check('quick start offers a Terminal choice', await quick.locator('[data-cli-choice="shell"]').isVisible())
    await quick.getByRole('button', { name: /Set up session/ }).click()
    const dlg = page.getByRole('dialog', { name: 'New AI session' })
    await dlg.waitFor({ timeout: 5000 })
    await dlg.locator('[data-cli-choice="shell"]').click()
    const tdlg = page.getByRole('dialog', { name: 'New terminal' })
    check('new-session dialog has a Terminal option (title becomes "New terminal")', await tdlg.waitFor({ timeout: 3000 }).then(() => true, () => false))
    check('Terminal hides model, permissions and capabilities',
      !(await tdlg.getByLabel('Permissions', { exact: true }).isVisible()) && !(await tdlg.getByLabel('AI model').isVisible()) && !(await tdlg.getByText('3. Capabilities').isVisible()))
    await tdlg.getByLabel(/^Session name/).fill(TERM_NAME)
    await shot(page, 'new-terminal-dialog')
    await tdlg.getByRole('button', { name: 'Open Terminal' }).click()
    const row = await poll(async () => (await api('/sessions')).find?.((x) => x.name === TERM_NAME))
    const tid = row?.id
    check('terminal session row: cli_type shell, no model/permission/effort', tid && row.cli_type === 'shell' && row.session_type === 'shell' && !row.model && row.permission_mode === 'default' && !row.effort, JSON.stringify(row || {}).slice(0, 240))
    if (!tid) return
    const alive = await poll(async () => (await api('/sessions')).find?.((x) => x.id === tid)?.pty_alive, { timeout: 20000 })
    check('the login shell runs in a real PTY', alive)
    const rc = await poll(async () => (await ptyText(tid)).includes('E2E_SANDBOX_ZSHRC'), { timeout: 15000 })
    check('the shell read the sandbox ~/.zshrc (login interactive zsh, not the real home)', rc)
    check('no agent CLI was started for the terminal', !/\[\d+\] (start|size)/.test(logSince('terminal')), logSince('terminal').slice(0, 200))
    const cell = page.locator(`[data-session-view="${tid}"]`)
    check('terminal tile mounts xterm', await cell.locator('.xterm').waitFor({ timeout: 15000 }).then(() => true, () => false))
    await cell.locator('.xterm').click()
    await page.keyboard.type('echo hello')
    await page.keyboard.press('Enter')
    const hello = await poll(async () => /^hello\s*$/m.test(await ptyText(tid)), { timeout: 10000 })
    check('`echo hello` prints hello in the shell', hello)
    const rendered = await poll(() => page.evaluate((id) => {
      const el = document.querySelector(`[data-session-view="${id}"]`)
      const rows = el?.querySelector('.xterm-rows')?.innerText || ''
      return /(^|\n)hello\s*(\n|$)/.test(rows) ? 'dom' : el?.querySelector('canvas') ? 'canvas' : ''
    }, tid), { timeout: 5000 })
    check('the terminal renders hello (DOM rows or GPU canvas)', rendered, rendered)
    await page.keyboard.type('echo "cc=${CLAUDECODE:-none} ccs=${CLAUDE_CODE_SESSION_ID:-none} cmd=${COMMANDER_SESSION_ID:-none} term=$TERM lang=${LANG:-none}"; pwd')
    await page.keyboard.press('Enter')
    const envLine = await poll(async () => (await ptyText(tid)).match(/^cc=\S+ ccs=\S+ cmd=\S+ term=\S+ lang=\S+\s*$/m)?.[0], { timeout: 10000 })
    check('clean env: no CLAUDECODE / CLAUDE_CODE_* / COMMANDER_*, TERM=xterm-256color, LANG set',
      envLine && /cc=none ccs=none cmd=none term=xterm-256color lang=(?!none)/.test(envLine), envLine)
    check('the shell starts in the project folder', (await ptyText(tid)).split('\n').some((l) => l.trim() === sb.workspace))
    const words = async () => page.evaluate((id) => ({
      sidebar: document.querySelector(`[data-session-id="${id}"] .x-session-status`)?.innerText?.replace(/[◉●]/g, '').trim() || '',
      tile: document.querySelector(`[data-session-view="${id}"] .ive-cell-status`)?.innerText?.trim() || '',
    }), tid)
    const running = await poll(async () => { const w = await words(); return w.sidebar === 'Running' ? w : null }, { timeout: 5000 })
    check('status says Running', running, JSON.stringify(running || await words()))
    const agentChrome = await page.evaluate((id) => {
      const el = document.querySelector(`[data-session-view="${id}"]`)
      return {
        chatToggle: !!el?.querySelector('button[title="Switch to Chat View"], button[title="Switch to Terminal View"]'),
        composer: !!el?.querySelector('[data-terminal-composer] form'),
        perms: !!el?.querySelector('[data-terminal-composer] button[title^="Cycle permission"]'),
      }
    }, tid)
    check('no chat toggle, prompt composer or permission picker on a terminal', !agentChrome.chatToggle && !agentChrome.composer && !agentChrome.perms, JSON.stringify(agentChrome))
    await shot(page, 'terminal-running')
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')
    const dead = await poll(async () => (await api('/sessions')).find?.((x) => x.id === tid)?.pty_alive === false, { timeout: 10000 })
    check('`exit` ends the shell', dead)
    const exited = await poll(async () => { const w = await words(); return w.sidebar === 'Exited' ? w : null }, { timeout: 8000 })
    check('status says Exited after exit', exited, JSON.stringify(exited || await words()))
    await sleep(1500)
    const still = (await api('/sessions')).find?.((x) => x.id === tid)
    check('an exited shell is not auto-restarted', still && !still.pty_alive && still.status !== 'error', JSON.stringify(still || {}).slice(0, 160))
    await shot(page, 'terminal-exited')

    // ⌘K → "New terminal" opens another shell in the current project.
    await page.keyboard.press('Meta+k')
    await page.locator('input:focus').waitFor()
    await page.keyboard.type('New terminal')
    await sleep(400)
    check('palette lists "New terminal"', (await page.getByText('New terminal', { exact: true }).filter({ visible: true }).count()) > 0)
    const before = ((await api('/sessions')).filter?.((x) => x.cli_type === 'shell') || []).length
    await page.keyboard.press('Enter')
    const second = await poll(async () => {
      const list = (await api('/sessions')).filter?.((x) => x.cli_type === 'shell') || []
      return list.length > before ? list.find((x) => x.id !== tid && x.pty_alive) : null
    }, { timeout: 20000 })
    check('"New terminal" from the palette starts a shell', second, second?.name)
    await shot(page, 'palette-new-terminal')
  })

  // Isolation evidence after the run.
  const after = snapshot(guarded)
  const changed = Object.keys(before).filter((k) => before[k] !== after[k])
  check('real ~/.claude ~/.codex ~/.gemini ~/.ive and every .ive-team-state hook file untouched (stat before == after)', changed.length === 0, changed.join(', '))
  const mentions = mentionsSandbox(guarded, sb)
  check('no real config file mentions the sandbox path or port', mentions.length === 0, mentions.join(', '))
  writeFileSync(join(OUT, 'guarded-paths.json'), JSON.stringify({ before, after }, null, 2))
  await context.close()
}

function collectBackendProblems() {
  let text = ''
  try { text = readFileSync(join(OUT, 'backend.log'), 'utf8') } catch {}
  const lines = text.split('\n')
  const problems = []
  lines.forEach((line, i) => {
    if (/Traceback|\bERROR\b|\bCRITICAL\b|Exception in|SyntaxWarning/.test(line)) problems.push(lines.slice(i, i + 12).join('\n'))
  })
  return problems
}

// Ctrl-C: still kill the process groups and delete the sandbox.
process.once('SIGINT', async () => {
  console.error('\ninterrupted, cleaning up …')
  try { if (browser) await browser.close() } catch {}
  if (sb) { await stopAll(sb, backend); if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb) }
  process.exit(130)
})

let failed = false
try {
  await main()
} catch (err) {
  failed = true
  console.error(`\nRUN ABORTED: ${err.message}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (sb) {
    try { writeFileSync(join(OUT, 'fake-cli.log'), fakeLog()) } catch {}
    try { writeFileSync(join(OUT, 'shim-calls.log'), readFileSync(join(sb.home, 'shim-calls.log'), 'utf8')) } catch {}
    const left = await stopAll(sb, backend)
    check('all sandbox processes stopped', left.length === 0, left.join(','))
    if (process.env.IVE_E2E_KEEP === '1') log(`sandbox kept: ${sb.root}`)
    else {
      await removeSandbox(sb)
      check('sandbox directory deleted', !existsSync(sb.root), sb.root)
    }
  }
  const backendProblems = collectBackendProblems()
  writeFileSync(join(OUT, 'backend-problems.txt'), backendProblems.join('\n\n----\n\n'))
  writeFileSync(join(OUT, 'browser-errors.txt'), [...pageErrors.map((e) => `pageerror: ${e}`), ...consoleErrors.map((e) => `console: ${e}`)].join('\n'))
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
  check('no tracebacks / ERROR lines in the backend log', backendProblems.length === 0, backendProblems[0]?.split('\n')[0])
  log(`\nbackend log problems: ${backendProblems.length}   browser console errors: ${consoleErrors.length}`)
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const bad = results.filter((r) => !r.ok)
  log(`\n${results.length - bad.length}/${results.length} checks passed. Artifacts: ${OUT}`)
  if (bad.length || failed) process.exitCode = 1
}
