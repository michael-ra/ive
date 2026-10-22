// Live permission-mode switch against the sandboxed backend.
//
// Changing "Perms" on a running session must restart the (fake) CLI with the
// new mode AND resume the same native conversation; a busy session must wait
// until it is idle (or "apply now"). Runs against `node e2e/serve.mjs`:
//
//   IVE_E2E_PORT=5197 IVE_E2E_KEEP=1 node e2e/serve.mjs     # prints {url, sandbox}
//   node e2e/perms-live.mjs http://127.0.0.1:5197 <sandbox>  # this script
//
// IVE_E2E_UI=0 skips the Chromium part (header feedback, Apply now).
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { E2E_DIR, ROOT } from './sandbox.mjs'

const [BASE_ARG, SANDBOX] = process.argv.slice(2)
if (!BASE_ARG || !SANDBOX) {
  console.error('usage: node e2e/perms-live.mjs <base-url> <sandbox-root>')
  process.exit(2)
}
const BASE = BASE_ARG.replace(/\/$/, '')
for (const forbidden of ['5111', '5173', '5183']) {
  if (BASE.endsWith(`:${forbidden}`)) throw new Error(`refusing to run against port ${forbidden}`)
}
const HOME = join(SANDBOX, 'home')
const WORKSPACE = join(HOME, 'projects', 'demo-app')
const LOG = join(HOME, 'fake-cli.log')
const NATIVE_ID = '11111111-2222-4333-8444-555555555555'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}`)
  return !!ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch {}
  return { status: res.status, body }
}
async function poll(fn, { timeout = 15000, interval = 200 } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last } catch { last = undefined }
    await sleep(interval)
  }
  return last
}
const starts = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
  .split('\n').filter((l) => l.includes('claude[') && l.includes('start argv='))
// fake_cli.py logs argv as a Python list repr: ['--flag', 'value', ...]
const flagAfter = (line, flag) => {
  const esc = flag.replace(/[-]/g, '\\-')
  const m = line.match(new RegExp(`'${esc}', '([^']*)'`))
  return m ? m[1] : null
}
// First CLI start after index `before` that carries the expected mode.
const startedWith = (before, mode) => poll(() => starts().slice(before).find((l) => flagAfter(l, '--permission-mode') === mode))
// First CLI start after index `before` whose `flag` has `value`.
const startedWithFlag = (before, flag, value) => poll(() => starts().slice(before).find((l) => flagAfter(l, flag) === value))
// The fake's startup SessionStart stores its own native id; setting ours
// before that lands gets overwritten. Wait for it first.
const startupRecorded = (sid) => poll(async () => (await api('/sessions')).body.find((x) => x.id === sid)?.native_session_id, { timeout: 8000 })
const setLaunch = (sid, fields) => api(`/sessions/${sid}`, {
  method: 'PUT', body: JSON.stringify({ ...fields, apply_live: true }),
})
const launchPending = async (sid) => (await api(`/sessions/${sid}/launch/apply`)).body.fields || {}
// The backend issues a per-session proof at spawn (backend/session_proofs.py)
// and rejects hook events that claim the session without it. The real relay
// gets it from the CLI env; this script reads it from the sandbox state dir.
const sessionProof = (sid) => {
  try { return JSON.parse(readFileSync(join(SANDBOX, 'state', 'session_proofs.json'), 'utf8'))[sid] || '' } catch { return '' }
}
const hook = (sid, event, extra = {}) => fetch(`${BASE}/api/hooks/event`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Commander-Session-Id': sid, 'X-Commander-Session-Proof': sessionProof(sid) },
  body: JSON.stringify({ hook_event_name: event, session_id: NATIVE_ID, cwd: WORKSPACE, transcript_path: '', ...extra }),
})
const setPerms = (sid, mode) => api(`/sessions/${sid}`, {
  method: 'PUT', body: JSON.stringify({ permission_mode: mode, apply_live: true }),
})

// ── setup ────────────────────────────────────────────────────────────────
let ws = (await api('/workspaces')).body.find?.((w) => w.path === WORKSPACE)
if (!ws) ws = (await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'demo-app', path: WORKSPACE }) })).body
const created = (await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ workspace_id: ws.id, name: 'Perms Live', cli_type: 'claude', permission_mode: 'default', auto_start: true }),
})).body
const sid = created.id
check('session created and auto-started', sid && await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive), sid)
const firstStarts = await poll(() => starts().length || 0)
check('fake claude is running in the PTY', firstStarts)
await startupRecorded(sid)
await sleep(300)

// A conversation exists: transcript on disk + native id stored.
const projectDir = join(HOME, '.claude', 'projects', WORKSPACE.replaceAll('/', '-'))
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, `${NATIVE_ID}.jsonl`), JSON.stringify({ type: 'user', sessionId: NATIVE_ID, message: { role: 'user', content: 'hi' } }) + '\n')
await api(`/sessions/${sid}`, { method: 'PUT', body: JSON.stringify({ native_session_id: NATIVE_ID }) })

// ── idle: applies right away, resumes the conversation ──────────────────
{
  const before = starts().length
  const res = await setPerms(sid, 'plan')
  check('PUT keeps the stored mode and reports a scheduled live apply', res.body.permission_mode === 'plan' && ['scheduled', 'applying'].includes(res.body.permission_apply?.state), JSON.stringify(res.body.permission_apply))
  const line = await startedWith(before, 'plan')
  check('idle session: CLI restarted with --permission-mode plan', line && flagAfter(line, '--permission-mode') === 'plan', line?.slice(0, 160))
  check('idle session: restart resumes the same conversation', line && flagAfter(line, '--resume') === NATIVE_ID)
  check('apply state settles', await poll(async () => (await api(`/sessions/${sid}/permission-mode/apply`)).body.state === 'none'))
}

// ── busy: waits for the current answer ───────────────────────────────────
{
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive)
  await sleep(500)
  await hook(sid, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: 'toolu_e2e_1' })
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.status === 'running', { timeout: 3000 })
  const before = starts().length
  const res = await setPerms(sid, 'acceptEdits')
  check('busy session: apply is pending', res.body.permission_apply?.state === 'pending', JSON.stringify(res.body.permission_apply))
  await sleep(2000)
  check('busy session: CLI is NOT restarted mid-answer', starts().length === before)
  check('pending state is queryable', (await api(`/sessions/${sid}/permission-mode/apply`)).body.state === 'pending')
  await hook(sid, 'Stop', { stop_hook_active: false })
  const line = await startedWith(before, 'acceptEdits')
  check('after the answer: restarted with acceptEdits + resume', line && flagAfter(line, '--permission-mode') === 'acceptEdits' && flagAfter(line, '--resume') === NATIVE_ID, line?.slice(0, 160))
}

// ── busy + apply now ─────────────────────────────────────────────────────
{
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive)
  await sleep(500)
  await hook(sid, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: 'toolu_e2e_2' })
  await sleep(300)
  const before = starts().length
  await setPerms(sid, 'bypassPermissions')
  const now = await api(`/sessions/${sid}/permission-mode/apply-now`, { method: 'POST' })
  check('apply now: applied', now.body.state === 'applied', JSON.stringify(now.body))
  check('apply now: interrupted a busy session', now.body.state === 'applied')
  const line = await startedWith(before, 'bypassPermissions')
  check('apply now: restarted with bypassPermissions + resume', line && flagAfter(line, '--permission-mode') === 'bypassPermissions' && flagAfter(line, '--resume') === NATIVE_ID)
}

// ── agent cannot widen, and never restarts ──────────────────────────────
{
  await setPerms(sid, 'plan')
  await poll(async () => (await api(`/sessions/${sid}/permission-mode/apply`)).body.state === 'none')
  await sleep(500)
  const before = starts().length
  const res = await api(`/sessions/${sid}`, {
    method: 'PUT', headers: { 'X-IVE-Session-Type': 'worker' },
    body: JSON.stringify({ permission_mode: 'bypassPermissions', apply_live: true }),
  })
  check('agent widening is still rejected (ceiling)', res.status === 403, res.status)
  await sleep(1500)
  check('rejected change does not restart the CLI', starts().length === before)
}

// ── model + effort: same live apply as Perms ────────────────────────────
{
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive)
  await sleep(500)
  // A turn on the old model is on record; after the switch it is stale.
  // Claude encodes the cwd with `/` and `_` as `-`; append to every copy.
  const projectsRoot = join(HOME, '.claude', 'projects')
  const oldTurn = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), effort: 'high', message: { role: 'assistant', model: 'claude-old-model', content: [] } }) + '\n'
  for (const dir of readdirSync(projectsRoot)) {
    const transcript = join(projectsRoot, dir, `${NATIVE_ID}.jsonl`)
    if (existsSync(transcript)) writeFileSync(transcript, readFileSync(transcript, 'utf8') + oldTurn)
  }
  check('runtime model reads the last turn before a switch', (await api(`/sessions/${sid}/runtime-model`)).body.observed?.model === 'claude-old-model')
  await sleep(200)

  let before = starts().length
  let res = await setLaunch(sid, { model: 'opus' })
  check('model PUT reports a scheduled live apply', ['scheduled', 'applying'].includes(res.body.launch_apply?.model?.state), JSON.stringify(res.body.launch_apply))
  let line = await startedWithFlag(before, '--model', 'opus')
  check('idle: CLI restarted with --model opus + resume', line && flagAfter(line, '--resume') === NATIVE_ID, line?.slice(0, 200))
  check('model switch keeps the permission mode', line && flagAfter(line, '--permission-mode') === 'plan')
  check('model apply settles', await poll(async () => Object.keys(await launchPending(sid)).length === 0))
  const rt = (await api(`/sessions/${sid}/runtime-model`)).body
  check('header source: stale pre-switch turn is ignored, configured model shows', rt.observed === null && rt.configured?.model === 'opus', JSON.stringify(rt))

  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive)
  await sleep(500)
  before = starts().length
  res = await setLaunch(sid, { effort: 'max' })
  line = await startedWithFlag(before, '--effort', 'max')
  check('idle: CLI restarted with --effort max, model kept', line && flagAfter(line, '--model') === 'opus' && flagAfter(line, '--resume') === NATIVE_ID, line?.slice(0, 200))
  check('invalid effort is rejected', (await setLaunch(sid, { effort: 'turbo' })).status === 400)
  await poll(async () => Object.keys(await launchPending(sid)).length === 0)

  // Busy: model + effort wait for the answer and go into ONE restart.
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.pty_alive)
  await sleep(500)
  await hook(sid, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: 'toolu_e2e_m1' })
  await poll(async () => (await api('/sessions')).body.find((s) => s.id === sid)?.status === 'running', { timeout: 3000 })
  before = starts().length
  res = await setLaunch(sid, { model: 'haiku' })
  check('busy: model apply is pending', res.body.launch_apply?.model?.state === 'pending', JSON.stringify(res.body.launch_apply))
  await setLaunch(sid, { effort: 'low' })
  await setLaunch(sid, { effort: 'xhigh' })
  await sleep(1500)
  check('busy: CLI is NOT restarted mid-answer', starts().length === before)
  const pend = await launchPending(sid)
  check('busy: both fields are pending', pend.model?.state === 'pending' && pend.effort?.value === 'xhigh', JSON.stringify(pend))
  await setLaunch(sid, { effort: 'max' })
  check('busy: reverting effort cancels only effort', !(await launchPending(sid)).effort && (await launchPending(sid)).model)
  await hook(sid, 'Stop', { stop_hook_active: false })
  line = await startedWithFlag(before, '--model', 'haiku')
  check('after the answer: one restart with --model haiku, effort still max', line && flagAfter(line, '--effort') === 'max' && flagAfter(line, '--resume') === NATIVE_ID, line?.slice(0, 200))
  await sleep(1500)
  check('after the answer: exactly one restart', starts().length === before + 1, starts().length - before)
}

// ── UI: header feedback, pending + apply now, from the real Perms menu ──
async function uiCheck() {
  const require = createRequire(join(ROOT, 'frontend', 'package.json'))
  const { chromium } = require('playwright')
  const name = `Perms UI ${Date.now() % 100000}`
  const s = (await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: ws.id, name, cli_type: 'claude', permission_mode: 'acceptEdits', auto_start: true }),
  })).body
  await poll(async () => (await api('/sessions')).body.find((x) => x.id === s.id)?.pty_alive)
  await startupRecorded(s.id)
  await api(`/sessions/${s.id}`, { method: 'PUT', body: JSON.stringify({ native_session_id: NATIVE_ID }) })
  const browser = await chromium.launch({ headless: process.env.IVE_E2E_HEADED !== '1' })
  const shotDir = join(E2E_DIR, 'out')
  mkdirSync(shotDir, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/`)
    const guide = page.locator('[data-ive-onboarding]')
    if (await guide.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      await guide.getByPlaceholder('Dein Name').fill('E2E Tester')
      await guide.getByRole('navigation').getByRole('button', { name: /Loslegen/ }).click()
      await guide.getByRole('button', { name: 'Einführung abschließen' }).click()
      await guide.waitFor({ state: 'detached' }).catch(() => {})
    }
    await page.keyboard.press('Escape')
    await page.getByText(name, { exact: true }).first().click()
    const permsBtn = page.getByRole('button', { name: /Perms:/ }).first()
    const permsVisible = await permsBtn.waitFor({ timeout: 10000 }).then(() => true, () => false)
    if (!permsVisible) await page.screenshot({ path: join(shotDir, 'perms-ui-missing.png') }).catch(() => {})
    check('UI: Perms control visible', permsVisible)

    // Busy: the switch waits and says so; "Apply now" interrupts.
    await hook(s.id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: 'toolu_e2e_ui' })
    await sleep(300)
    const before = starts().length
    await permsBtn.hover()
    await page.getByRole('button', { name: /^dontAsk$/i }).first().click()
    const pending = await page.getByTestId('perms-pending').first().waitFor({ timeout: 8000 }).then(() => true, () => false)
    await page.screenshot({ path: join(shotDir, 'perms-pending.png') }).catch(() => {})
    check('UI: busy session shows "after this answer"', pending)
    check('UI: busy session not restarted yet', starts().length === before)
    await permsBtn.hover()
    const applyNow = page.getByRole('button', { name: 'Apply now' })
    check('UI: dropdown offers "Apply now"', await applyNow.waitFor({ timeout: 3000 }).then(() => true, () => false))
    await applyNow.click()
    const line = await startedWith(before, 'dontAsk')
    check('UI: Apply now restarts with dontAsk + resume', line && flagAfter(line, '--resume') === NATIVE_ID, line?.slice(0, 160))
    const settled = await poll(async () => {
      const txt = (await page.getByTestId('perms-value').first().innerText().catch(() => '')) || ''
      return /dontask/i.test(txt) && !(await page.getByTestId('perms-pending').count()) && txt
    }, { timeout: 8000 })
    check('UI: header shows the new value after applying', settled, settled)

    // Idle: "Switching to …" then the new value.
    await page.mouse.move(10, 10)
    await sleep(800)
    const before2 = starts().length
    await permsBtn.hover()
    await page.getByRole('button', { name: /^plan$/i }).first().click()
    const switching = await page.getByTestId('perms-applying').first().waitFor({ timeout: 3000 }).then(() => true, () => false)
    await page.screenshot({ path: join(shotDir, 'perms-switching.png') }).catch(() => {})
    check('UI: idle switch shows "Switching to PLAN"', switching)
    const line2 = await startedWith(before2, 'plan')
    check('UI: idle switch restarts with plan + resume', line2 && flagAfter(line2, '--resume') === NATIVE_ID)
    const done = await poll(async () => /plan/i.test(await page.getByTestId('perms-value').first().innerText().catch(() => '')), { timeout: 8000 })
    await page.screenshot({ path: join(shotDir, 'perms-applied.png') }).catch(() => {})
    check('UI: header shows PLAN when done', done)
  } finally {
    await browser.close()
  }
}

// ── UI: model + effort pickers in the chat header ───────────────────────
async function uiLaunchCheck() {
  const require = createRequire(join(ROOT, 'frontend', 'package.json'))
  const { chromium } = require('playwright')
  const name = `Launch UI ${Date.now() % 100000}`
  const s = (await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: ws.id, name, cli_type: 'claude', model: 'sonnet', permission_mode: 'acceptEdits', auto_start: true }),
  })).body
  await poll(async () => (await api('/sessions')).body.find((x) => x.id === s.id)?.pty_alive)
  // Own conversation id: sharing NATIVE_ID with the other live sessions makes
  // IVE's branch detection move this PTY to a "(branch)" row.
  const LAUNCH_NATIVE = '22222222-3333-4444-8555-666666666666'
  for (const dir of [projectDir, join(HOME, '.claude', 'projects', WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-'))]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${LAUNCH_NATIVE}.jsonl`), JSON.stringify({ type: 'user', sessionId: LAUNCH_NATIVE, message: { role: 'user', content: 'hi' } }) + '\n')
  }
  await startupRecorded(s.id)
  await api(`/sessions/${s.id}`, { method: 'PUT', body: JSON.stringify({ native_session_id: LAUNCH_NATIVE }) })
  const browser = await chromium.launch({ headless: process.env.IVE_E2E_HEADED !== '1' })
  const shotDir = join(E2E_DIR, 'out')
  mkdirSync(shotDir, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/`)
    const guide = page.locator('[data-ive-onboarding]')
    if (await guide.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      await guide.getByPlaceholder('Dein Name').fill('E2E Tester')
      await guide.getByRole('navigation').getByRole('button', { name: /Loslegen/ }).click()
      await guide.getByRole('button', { name: 'Einführung abschließen' }).click()
      await guide.waitFor({ state: 'detached' }).catch(() => {})
    }
    await page.keyboard.press('Escape')
    await page.getByText(name, { exact: true }).first().click()
    // Overview may show other sessions' tiles too: scope to this session.
    const modelPicker = page.locator(`[data-testid="chat-header-model"][data-session-id="${s.id}"]`).first()
    const effortPicker = page.locator(`[data-testid="chat-header-effort"][data-session-id="${s.id}"]`).first()
    // The option menus are portalled to <body> (the header strip clips).
    const modelMenu = page.locator(`[data-testid="chat-header-model-menu"][data-session-id="${s.id}"]`)
    const effortMenu = page.locator(`[data-testid="chat-header-effort-menu"][data-session-id="${s.id}"]`)
    check('UI: model picker visible', await modelPicker.waitFor({ timeout: 10000 }).then(() => true, () => false))
    check('UI: effort picker visible for Claude', await effortPicker.waitFor({ timeout: 3000 }).then(() => true, () => false))
    await sleep(800)

    // Idle: pick a model -> "Switching to opus" -> restart -> header shows it.
    let before = starts().length
    await modelPicker.locator('button').first().hover()
    await modelMenu.getByRole('button', { name: /^Opus · opus$/ }).first().click()
    const switching = await modelPicker.getByTestId('chat-header-model-applying').first().waitFor({ timeout: 3000 }).then(() => true, () => false)
    await page.screenshot({ path: join(shotDir, 'launch-model-switching.png') }).catch(() => {})
    check('UI: idle model switch shows "Switching to opus"', switching)
    let line = await startedWithFlag(before, '--model', 'opus')
    check('UI: model switch restarts with --model opus + resume', line && flagAfter(line, '--resume') === LAUNCH_NATIVE, line?.slice(0, 200))
    const shown = await poll(async () => (await modelPicker.getByTestId('chat-header-model-value').first().innerText().catch(() => '')) === 'opus', { timeout: 8000 })
    check('UI: header shows opus when done', shown)

    // Effort options: "Default (…)" first, then the CLI levels.
    await page.mouse.move(10, 10)
    await sleep(600)
    await effortPicker.locator('button').first().hover()
    await effortMenu.waitFor({ timeout: 3000 }).catch(() => {})
    const opts = await effortMenu.locator('button').allInnerTexts()
    check('UI: effort options are Default + low..max', /^Default/.test(opts[0] || '') && ['low', 'medium', 'high', 'xhigh', 'max'].every((l) => opts.includes(l)), opts.join(' | '))
    await sleep(400) // menu fade-in
    await page.screenshot({ path: join(shotDir, 'launch-effort-menu.png') }).catch(() => {})

    // Busy: effort waits, says so, Apply now interrupts.
    await poll(async () => (await api('/sessions')).body.find((x) => x.id === s.id)?.pty_alive)
    await sleep(1500) // let the fresh process report SessionStart first
    let busy = false
    for (let i = 0; i < 3 && !busy; i++) {
      await hook(s.id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: `toolu_e2e_ui_m${i}`, session_id: LAUNCH_NATIVE })
      busy = await poll(async () => (await api('/sessions')).body.find((x) => x.id === s.id)?.status === 'running', { timeout: 2000 })
    }
    check('UI: session is busy before the effort switch', busy)
    await effortPicker.locator('button').first().hover()
    before = starts().length
    await effortMenu.getByRole('button', { name: /^max$/ }).first().click()
    const pending = await effortPicker.getByTestId('chat-header-effort-pending').first().waitFor({ timeout: 8000 }).then(() => true, () => false)
    await page.mouse.move(10, 10)
    await sleep(300)
    await page.screenshot({ path: join(shotDir, 'launch-effort-pending.png') }).catch(() => {})
    check('UI: busy effort switch shows "after this answer"', pending)
    check('UI: busy session not restarted yet', starts().length === before)
    await effortPicker.locator('button').first().hover()
    const applyNow = effortMenu.getByRole('button', { name: 'Apply now' })
    check('UI: effort dropdown offers "Apply now"', await applyNow.waitFor({ timeout: 3000 }).then(() => true, () => false))
    await sleep(400) // menu fade-in
    await page.screenshot({ path: join(shotDir, 'launch-effort-apply-now.png') }).catch(() => {})
    await applyNow.click()
    line = await startedWithFlag(before, '--effort', 'max')
    check('UI: Apply now restarts with --effort max, --model opus, resume', line && flagAfter(line, '--model') === 'opus' && flagAfter(line, '--resume') === LAUNCH_NATIVE, line?.slice(0, 200))
    await page.mouse.move(10, 10)
    const done = await poll(async () => /max/i.test(await effortPicker.getByTestId('chat-header-effort-value').first().innerText().catch(() => '')) && !(await effortPicker.getByTestId('chat-header-effort-pending').count()), { timeout: 8000 })
    await page.screenshot({ path: join(shotDir, 'launch-applied.png') }).catch(() => {})
    check('UI: header shows MAX when done', done)
  } finally {
    await browser.close()
  }
}
if (process.env.IVE_E2E_UI !== '0') {
  await uiCheck()
  await uiLaunchCheck()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
