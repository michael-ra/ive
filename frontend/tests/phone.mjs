// IVE on the iPhone: real backend in the e2e sandbox (fake HOME, fake
// claude CLI, own port), real PTYs, Playwright WebKit with iPhone emulation.
// Nothing touches the real ~/.claude, the live IVE or port 5111.
//
//   node --test tests/phone.mjs
//   IVE_E2E_PORT=5270 IVE_E2E_SKIP_BUILD=1 IVE_SHOT_DIR=/tmp/ive-phone node --test tests/phone.mjs
//
// Covers: the phone Overview (cards, "Waiting" first, live status), opening
// a session full screen, Chat ⇄ Terminal, typing in the chat composer with
// the soft keyboard up, the touch pickers, the terminal key bar (bytes reach
// the fake CLI: Esc, Tab, ⌃C, ⌃D, ⌃R, ⇧Tab, arrows recall history, sticky ⌃),
// Stop, one-finger scrolling through scrollback, pinch / A− A+ font size,
// long-press Paste and the width-fitted PTY.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { webkit } from 'playwright'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'
import {
  ROOT, createSandbox, portFree, removeSandbox, runIsolationCheck, startBackend, stopAll, waitForHealth,
} from '../../e2e/sandbox.mjs'

const PORT = Number(process.env.IVE_E2E_PORT || 5270)
const BASE = `http://127.0.0.1:${PORT}`
const shotDir = resolve(process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-phone'))
const W = 393, H = 852 // iPhone 15/16 as a home-screen web app (no Safari bars)
const KEYBOARD = 336 // iOS keyboard + suggestion bar, portrait
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function poll(fn, { timeout = 15000, interval = 200 } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last } catch { last = undefined }
    await sleep(interval)
  }
  return last
}

test('phone remote', { timeout: 300000 }, async (t) => {
  await mkdir(shotDir, { recursive: true })
  if (process.env.IVE_E2E_SKIP_BUILD !== '1' || !existsSync(join(ROOT, 'frontend/dist/index.html'))) {
    const r = spawnSync(process.execPath, [join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'warn'],
      { cwd: join(ROOT, 'frontend'), encoding: 'utf8' })
    assert.equal(r.status, 0, `frontend build failed: ${r.stderr}`)
  }
  assert(await portFree(PORT), `port ${PORT} is busy; set IVE_E2E_PORT`)
  const sb = await createSandbox({ port: PORT })
  const iso = runIsolationCheck(sb)
  if (!iso.isolated) { await removeSandbox(sb); assert.fail(`isolation preflight failed: ${iso.problems?.join('; ')}`) }
  const backend = startBackend(sb, openSync(join(shotDir, 'backend.log'), 'w'))
  t.after(async () => {
    await stopAll(sb, backend)
    if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb)
  })
  await waitForHealth(PORT, backend)

  const api = async (path, init = {}) => {
    const res = await fetch(`${BASE}/api${path}`, { headers: { 'content-type': 'application/json' }, ...init })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return text }
  }
  const fakeLog = () => { try { return readFileSync(join(sb.home, 'fake-cli.log'), 'utf8') } catch { return '' } }
  const mark = (name) => appendFileSync(join(sb.home, 'fake-cli.log'), `--- step: ${name}\n`)
  const since = (name) => { const text = fakeLog(); const i = text.lastIndexOf(`--- step: ${name}`); return i < 0 ? '' : text.slice(i) }
  const sawInLog = (name, needle, timeout = 8000) => poll(() => since(name).includes(needle), { timeout })

  // Sandbox state: first run done, one project, two fake Claude sessions.
  for (const [key, value] of [['owner_name', 'Phone Tester'], ['owner_intro_completed_at', new Date().toISOString()], ['product_tour_version', String(TOUR_VERSION)]])
    await api(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) })
  await api('/workspaces', { method: 'POST', body: JSON.stringify({ path: sb.workspace, name: 'demo-app' }) })
  const ws = await poll(async () => (await api('/workspaces')).find?.((w) => w.path === sb.workspace))
  assert(ws, 'workspace created')
  for (const name of ['Phone Agent', 'Helper Agent'])
    await api('/sessions', { method: 'POST', body: JSON.stringify({ workspace_id: ws.id, name, cli_type: 'claude' }) })
  const byName = async (name) => (await api('/sessions')).find?.((s) => s.name === name)
  const phoneAgent = await poll(() => byName('Phone Agent'))
  const helper = await poll(() => byName('Helper Agent'))
  assert(phoneAgent && helper, 'sessions created')

  const browser = await webkit.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({
    viewport: { width: W, height: H }, screen: { width: W, height: H }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    reducedMotion: 'reduce',
  })
  await context.addInitScript((onboardingKey) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem(onboardingKey, 'done')
    localStorage.setItem('ive_client_name', 'iPhone test')
    // WebKit in Playwright has no clipboard permission: stand in for iOS.
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'pasted-text', writeText: async () => {} } })
    } catch { /* keep the real one */ }
  }, tourStorageKey(true))
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const frames = []
  page.on('websocket', (sock) => sock.on('framesent', (f) => {
    try { const m = JSON.parse(String(f.payload)); if (m?.action) frames.push(m) } catch { /* binary */ }
  }))
  const shot = (name) => page.screenshot({ path: join(shotDir, `${name}.png`) })
  const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)
  const lastSize = (id) => frames.filter((f) => f.session_id === id && ['start_pty', 'resize', 'resume_pty', 'claim_geometry'].includes(f.action)).at(-1)
  const ptySize = () => { const m = [...fakeLog().matchAll(/\] (?:size|resize) (\d+)x(\d+)/g)].at(-1); return m ? { cols: +m[1], rows: +m[2] } : null }
  const key = (id) => page.locator(`[data-phone-keybar] [data-key="${id}"]`)
  const touchTarget = async (locator, label) => {
    const box = await locator.boundingBox()
    assert(box && box.width >= 40 && box.height >= 40, `${label}: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'hidden'} < 40px`)
    assert(box.x >= 0 && box.x + box.width <= W + 1, `${label}: off screen`)
  }
  // Synthetic touch pointers (what iOS Safari dispatches for a finger).
  const touch = (steps) => page.evaluate(async (steps) => {
    const host = document.querySelector('.ive-phone-terminal')
    const fire = (type, id, x, y) => host.dispatchEvent(new PointerEvent(type, { pointerId: 100 + id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }))
    for (const s of steps) {
      if (s.wait) await new Promise((r) => setTimeout(r, s.wait))
      else fire(s.type, s.id, s.x, s.y)
    }
  }, steps)
  // Lines between what the phone terminal shows and the live bottom.
  const viewportScroll = () => page.evaluate(() => Number(document.querySelector('.ive-phone-terminal').dataset.linesBehind || 0))

  await t.test('overview lists the sessions as cards', async () => {
    await page.goto(`${BASE}/`)
    await page.locator('[data-phone-overview]').waitFor()
    await page.locator(`[data-phone-session="${helper.id}"]`).waitFor()
    await page.locator(`[data-phone-session="${phoneAgent.id}"]`).waitFor()
    assert(await noHorizontalOverflow(), 'overview: horizontal overflow')
    for (const name of ['Open sidebar', 'Search tools, sessions and projects', 'Create a new session'])
      await touchTarget(page.getByRole('button', { name, exact: true }), name)
    const card = await page.locator(`[data-phone-session="${phoneAgent.id}"]`).boundingBox()
    assert(card.width >= W - 30 && card.height >= 64, `card too small: ${JSON.stringify(card)}`)
    assert.equal(await page.locator('.x-app-bar').count(), 0, 'no desktop app bar on the phone overview')
    await shot('01-overview')
  })

  await t.test('a permission request puts the session on top as "Waiting"', async () => {
    await page.locator(`[data-phone-session="${helper.id}"]`).tap()
    await page.locator('[data-phone-session-head]').waitFor()
    await page.getByRole('button', { name: 'Terminal view' }).tap()
    await page.locator('[data-phone-terminal] .xterm').waitFor({ timeout: 20000 })
    await poll(() => /\] size \d+x\d+/.test(fakeLog()), { timeout: 20000 })
    await sleep(800)
    await page.locator('[data-phone-terminal]').tap()
    mark('ask')
    await page.keyboard.type('ask rm -rf build')
    await page.keyboard.press('Enter')
    assert(await sawInLog('ask', "input 'ask rm -rf build'"), 'typing reached the fake CLI')
    await page.getByRole('button', { name: 'Back to sessions' }).tap()
    await page.locator('[data-phone-overview]').waitFor()
    const first = await poll(async () => {
      const ids = await page.locator('[data-phone-session]').evaluateAll((els) => els.map((e) => e.dataset.phoneSession))
      const status = await page.locator(`[data-phone-session="${helper.id}"] [data-status]`).getAttribute('data-status')
      return ids[0] === helper.id && status === 'Waiting' ? { ids, status } : null
    }, { timeout: 15000 })
    assert(first, 'Helper Agent is first and says "Waiting"')
    assert(/waiting/i.test(await page.locator('.ive-phone-group').first().innerText()), 'first group is "Waiting"')
    const activity = await poll(async () => (await page.locator(`[data-phone-session="${helper.id}"] [data-phone-activity]`).innerText()).match(/Permission|Bash|proceed/i), { timeout: 10000 })
    assert(activity, 'card shows what the session is waiting for')
    await shot('02-overview-needs-you')
    // Approve from the phone: open, type 1 in the terminal.
    await page.locator(`[data-phone-session="${helper.id}"]`).tap()
    await page.locator('[data-phone-terminal] .xterm').waitFor()
    await page.locator('[data-phone-terminal]').tap()
    await page.keyboard.type('1')
    await page.keyboard.press('Enter')
    await poll(async () => (await page.locator('[data-phone-status]').innerText()) === 'Done', { timeout: 15000 })
    await page.getByRole('button', { name: 'Back to sessions' }).tap()
  })

  await t.test('chat view: composer above the keyboard, touch pickers', async () => {
    await page.locator(`[data-phone-session="${phoneAgent.id}"]`).tap()
    await page.locator('[data-phone-session-head]').waitFor()
    await page.getByRole('button', { name: 'Chat view' }).tap()
    const view = page.locator(`[data-session-view="${phoneAgent.id}"]`)
    const textarea = view.locator('form.x-composer textarea')
    await textarea.waitFor()
    assert(await noHorizontalOverflow(), 'chat: horizontal overflow')
    await poll(async () => (await api('/sessions')).find?.((s) => s.id === phoneAgent.id)?.pty_alive, { timeout: 20000 })
    await sleep(1500)
    await shot('03-chat')
    // Soft keyboard up: the visual viewport shrinks, the composer stays visible.
    await page.setViewportSize({ width: W, height: H - KEYBOARD })
    await textarea.tap()
    await sleep(500)
    const box = await textarea.boundingBox()
    assert(box && box.y + box.height <= H - KEYBOARD + 1 && box.y > 60, `composer hidden by the keyboard: ${JSON.stringify(box)}`)
    const fontSize = await textarea.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    assert(fontSize >= 16, `composer font ${fontSize}px makes iOS zoom in`)
    mark('chat')
    await textarea.fill('hello from the phone')
    await page.keyboard.press('Enter')
    assert(await sawInLog('chat', "input 'hello from the phone'", 12000), 'chat message reached the fake CLI')
    await shot('04-chat-keyboard')
    await page.setViewportSize({ width: W, height: H })
    await sleep(400)

    // Perms / Model pickers: a tap opens the menu (and it stays open), on screen.
    for (const testId of ['perms', 'chat-header-model']) {
      const picker = view.locator(`[data-testid="${testId}"] > button`)
      await picker.scrollIntoViewIfNeeded()
      await touchTarget(picker, testId)
      await picker.tap()
      const menu = page.locator(`[data-testid="${testId}-menu"][data-session-id="${phoneAgent.id}"]`)
      await menu.waitFor()
      await sleep(300)
      assert(await menu.isVisible(), `${testId}: menu closed again right after the tap`)
      const m = await menu.boundingBox()
      assert(m.x >= 0 && m.x + m.width <= W + 1 && m.y >= 0 && m.y + m.height <= H + 1, `${testId}: menu off screen ${JSON.stringify(m)}`)
      const option = await menu.locator('button').first().boundingBox()
      assert(option.height >= 40, `${testId}: option rows ${option.height}px`)
      if (testId === 'perms') await shot('05-perms-menu')
      await page.touchscreen.tap(W / 2, H / 2)
      await menu.waitFor({ state: 'detached' })
    }
  })

  await t.test('terminal view: fits the width, key bar sends the right bytes', async () => {
    await page.getByRole('button', { name: 'Terminal view' }).tap()
    const term = page.locator(`[data-phone-terminal="${phoneAgent.id}"]`)
    await term.locator('.xterm-screen').waitFor()
    await sleep(1200)
    const sent = lastSize(phoneAgent.id)
    assert(sent && sent.cols >= 30 && sent.cols < 80, `PTY cols from the phone width: ${JSON.stringify(sent)}`)
    const pty = await poll(() => { const p = ptySize(); return p && p.cols === sent.cols ? p : null }, { timeout: 8000 })
    assert(pty, `PTY has the size the phone shows: client ${JSON.stringify(sent)} pty ${JSON.stringify(ptySize())}`)
    const fit = await term.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, screen: el.querySelector('.xterm-screen').getBoundingClientRect().right }))
    assert(fit.sw <= fit.cw + 2 && fit.screen <= W + 1, `terminal wider than the phone: ${JSON.stringify(fit)}`)
    for (const id of ['esc', 'ctrl', 'tab', 'ctrl-c', 'up', 'down']) await touchTarget(key(id), `key ${id}`)
    await shot('06-terminal')

    await term.tap()
    // ⌃C clears the typed line (Claude Code behaviour of the fake CLI).
    mark('ctrl-c')
    await page.keyboard.type('draft text')
    await key('ctrl-c').tap()
    assert(await sawInLog('ctrl-c', 'key ctrl-c'), '⌃C reached the CLI')
    // Arrows recall history.
    mark('history')
    for (const text of ['first', 'second']) {
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
      await poll(() => since('history').includes(`input '${text}'`))
      await sleep(1500) // the fake answer
    }
    mark('recall')
    await key('up').tap()
    await key('up').tap()
    await page.keyboard.press('Enter')
    assert(await sawInLog('recall', "input 'first'"), `↑↑ recalled "first": ${since('recall')}`)
    assert.equal((since('recall').match(/key up/g) || []).length, 2, 'two ↑ presses')
    await sleep(1500)
    // Sticky ⌃: the next typed key goes out as a control byte.
    mark('sticky')
    await key('ctrl').tap()
    assert.equal(await key('ctrl').getAttribute('aria-pressed'), 'true')
    await page.keyboard.type('r')
    assert(await sawInLog('sticky', 'key ctrl-r'), '⌃ then r sent Ctrl-R')
    assert.equal(await key('ctrl').getAttribute('aria-pressed'), 'false', 'modifier released after one key')
    // The other keys.
    mark('keys')
    for (const [id, logged] of [['tab', 'key tab'], ['ctrl-d', 'key ctrl-d'], ['ctrl-r', 'key ctrl-r'], ['shift-tab', 'key shift-tab'], ['left', 'key left'], ['right', 'key right'], ['down', 'key down'], ['esc', 'key esc']]) {
      await key(id).scrollIntoViewIfNeeded()
      await key(id).tap()
      assert(await sawInLog('keys', logged), `${id} → ${logged}`)
    }
    // The key bar keeps the terminal focused (the iOS keyboard stays up).
    assert(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 'terminal lost focus to the key bar')
  })

  await t.test('Mac and phone: the shown phone owns the PTY size, the Mac gets it back', async () => {
    // Phone in chat view: it holds no size.
    await page.getByRole('button', { name: 'Chat view' }).tap()
    await sleep(800)
    const mac = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await mac.addInitScript((onboardingKey) => {
      localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
      localStorage.setItem('cc-soundEnabled', '0')
      localStorage.setItem(onboardingKey, 'done')
      localStorage.setItem('cc-terminalBoardMode', '1')
    }, tourStorageKey(true))
    const desk = await mac.newPage()
    try {
      await desk.goto(`${BASE}/#session-${encodeURIComponent(phoneAgent.id)}`)
      // A single open session lands at Session level; otherwise open it full size.
      const openFull = desk.getByRole('button', { name: /^Open Phone Agent/ })
      if (await openFull.waitFor({ timeout: 4000 }).then(() => true, () => false)) await openFull.click()
      const wide = await poll(() => { const p = ptySize(); return p && p.cols >= 80 ? p : null }, { timeout: 15000 })
      assert(wide, `Mac session level sizes the PTY (>= 80 cols): ${JSON.stringify(ptySize())}`)
      await page.getByRole('button', { name: 'Terminal view' }).tap()
      const narrow = await poll(() => { const p = ptySize(); return p && p.cols < 80 && p.cols === lastSize(phoneAgent.id)?.cols ? p : null }, { timeout: 15000 })
      assert(narrow, `phone took the PTY to its width: ${JSON.stringify(ptySize())}`)
      const macCols = await poll(() => desk.evaluate((id) => {
        const s = document.querySelector(`[data-session-view="${id}"] .xterm-screen`)
        return s ? s.getBoundingClientRect().width : 0
      }, phoneAgent.id), { timeout: 5000 })
      assert(macCols > 0, 'Mac still renders the terminal')
      await desk.screenshot({ path: join(shotDir, '06b-mac-follows-phone.png') })
      await page.getByRole('button', { name: 'Chat view' }).tap()
      const back = await poll(() => { const p = ptySize(); return p && p.cols >= 80 ? p : null }, { timeout: 15000 })
      assert(back, `Mac took its size back after the phone left the terminal: ${JSON.stringify(ptySize())}`)
    } catch (err) {
      await desk.screenshot({ path: join(shotDir, '06x-mac-failure.png') }).catch(() => {})
      throw err
    } finally {
      await mac.close()
      await page.getByRole('button', { name: 'Terminal view' }).tap()
      await poll(() => { const p = ptySize(); return p && p.cols < 80 ? p : null }, { timeout: 15000 })
      await page.locator('[data-phone-terminal]').tap()
    }
  })

  await t.test('Stop interrupts a working session', async () => {
    mark('stop')
    await page.keyboard.type('slow task')
    await page.keyboard.press('Enter')
    const stop = page.getByRole('button', { name: 'Stop the current answer' })
    await stop.waitFor({ timeout: 10000 })
    await touchTarget(stop, 'Stop')
    await shot('07-working-stop')
    await stop.tap()
    assert(await sawInLog('stop', 'interrupted by esc'), `Stop interrupted the CLI: ${since('stop')}`)
    await poll(async () => (await page.locator('[data-phone-status]').innerText()) === 'Done', { timeout: 10000 })
  })

  await t.test('soft keyboard: key bar right above it, terminal visible', async () => {
    await page.setViewportSize({ width: W, height: H - KEYBOARD })
    await sleep(800)
    const g = await page.evaluate(() => {
      const bar = document.querySelector('[data-phone-keybar]').getBoundingClientRect()
      const term = document.querySelector('.ive-phone-terminal').getBoundingClientRect()
      return { barBottom: bar.bottom, termTop: term.top, termH: term.height, vh: innerHeight }
    })
    assert(g.barBottom <= g.vh + 1 && g.barBottom >= g.vh - 2, `key bar not on the keyboard: ${JSON.stringify(g)}`)
    assert(g.termH >= 200, `terminal too small with the keyboard up: ${JSON.stringify(g)}`)
    await sleep(600)
    const rows = lastSize(phoneAgent.id)?.rows
    assert(rows >= 6, `PTY rows follow the smaller screen: ${rows}`)
    await shot('08-terminal-keyboard')
    await page.setViewportSize({ width: W, height: H })
    await sleep(800)
  })

  await t.test('one-finger swipe scrolls the scrollback', async () => {
    await page.locator('[data-phone-terminal]').tap()
    mark('lines')
    await page.keyboard.type('lines 200')
    await page.keyboard.press('Enter')
    assert(await sawInLog('lines', "input 'lines 200'"), 'lines command reached the CLI')
    await sleep(1200)
    const before = await viewportScroll()
    assert.equal(before, 0, 'at the live bottom after output')
    const box = await page.locator('.ive-phone-terminal').boundingBox()
    const x = box.x + box.width / 2
    const steps = [{ type: 'pointerdown', id: 1, x, y: box.y + 80 }]
    for (let i = 1; i <= 10; i++) steps.push({ wait: 16 }, { type: 'pointermove', id: 1, x, y: box.y + 80 + i * 35 })
    steps.push({ wait: 200 }, { type: 'pointerup', id: 1, x, y: box.y + 430 })
    await touch(steps)
    await sleep(300)
    const up = await viewportScroll()
    assert(up >= 15, `swipe down did not scroll back into the scrollback: ${up} lines`)
    const live = page.getByRole('button', { name: 'Back to the live output' })
    await live.waitFor()
    await shot('09-scrolled-back')
    const back = [{ type: 'pointerdown', id: 1, x, y: box.y + 400 }]
    for (let i = 1; i <= 5; i++) back.push({ wait: 16 }, { type: 'pointermove', id: 1, x, y: box.y + 400 - i * 35 })
    back.push({ wait: 200 }, { type: 'pointerup', id: 1, x, y: box.y + 225 })
    await touch(back)
    await sleep(300)
    const down = await viewportScroll()
    assert(down < up - 5, `swipe up did not scroll forward: ${JSON.stringify({ up, down })}`)
    await live.tap()
    assert.equal(await poll(async () => (await viewportScroll()) === 0 ? 0 : null, { timeout: 3000 }), 0, '"Live" returns to the bottom')
    await live.waitFor({ state: 'detached' })
  })

  await t.test('pinch and A− / A+ change the font, remembered, PTY refits', async () => {
    const colsBefore = lastSize(phoneAgent.id).cols
    const fontBefore = await page.evaluate(() => Number(localStorage.getItem('ive-phone-terminal-font') || 12))
    const box = await page.locator('.ive-phone-terminal').boundingBox()
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    const steps = [{ type: 'pointerdown', id: 1, x: cx - 40, y: cy }, { type: 'pointerdown', id: 2, x: cx + 40, y: cy }]
    for (let i = 1; i <= 8; i++) steps.push({ wait: 16 }, { type: 'pointermove', id: 1, x: cx - 40 - i * 8, y: cy }, { type: 'pointermove', id: 2, x: cx + 40 + i * 8, y: cy })
    steps.push({ type: 'pointerup', id: 2, x: cx + 104, y: cy }, { type: 'pointerup', id: 1, x: cx - 104, y: cy })
    await touch(steps)
    const fontAfter = await poll(async () => { const f = await page.evaluate(() => Number(localStorage.getItem('ive-phone-terminal-font'))); return f > fontBefore ? f : null })
    assert(fontAfter, `pinch out did not enlarge the font (was ${fontBefore})`)
    const colsAfter = await poll(() => { const c = lastSize(phoneAgent.id).cols; return c < colsBefore ? c : null })
    assert(colsAfter, `PTY did not refit to fewer columns (${colsBefore})`)
    await shot('10-pinched')
    await key('font-down').scrollIntoViewIfNeeded()
    await key('font-down').tap()
    await key('font-down').tap()
    const stepped = await page.evaluate(() => Number(localStorage.getItem('ive-phone-terminal-font')))
    assert.equal(stepped, fontAfter - 2, 'A− steps the font down by 1px')
    await key('font-up').tap()
    await key('font-up').tap()
    await key('font-down').tap()
    await key('font-down').tap()
    await key('font-down').tap()
  })

  await t.test('long-press offers Paste', async () => {
    mark('paste')
    const box = await page.locator('.ive-phone-terminal').boundingBox()
    await touch([{ type: 'pointerdown', id: 1, x: box.x + 120, y: box.y + 200 }, { wait: 800 }, { type: 'pointerup', id: 1, x: box.x + 120, y: box.y + 200 }])
    const bubble = page.locator('.ive-phone-paste')
    await bubble.waitFor({ timeout: 3000 })
    await shot('11-long-press-paste')
    await bubble.tap()
    await page.locator('[data-phone-terminal]').tap()
    await page.keyboard.press('Enter')
    assert(await sawInLog('paste', "input 'pasted-text'"), `pasted text reached the CLI: ${since('paste')}`)
  })

  await t.test('back to chat and to the overview', async () => {
    await page.getByRole('button', { name: 'Chat view' }).tap()
    await page.waitForFunction(() => document.querySelector('.ive-terminal-drawer')?.getBoundingClientRect().height < 2)
    await page.locator(`[data-session-view="${phoneAgent.id}"] form.x-composer textarea`).waitFor()
    await page.getByRole('button', { name: 'Back to sessions' }).tap()
    await page.locator('[data-phone-overview]').waitFor()
    // Opening the full Home page and coming back.
    await page.getByRole('button', { name: 'Open Home' }).tap()
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to sessions' }).tap()
    await page.locator('[data-phone-overview]').waitFor()
    await shot('12-overview-end')
    assert.deepEqual(errors, [])
  })
})
