// Files and folders as chat context, end to end: real backend in the e2e
// sandbox, fake claude + codex, real Chromium.
//
// Covers the composer's @ picker (files, folders and the @ticket: option in
// one list, fuzzy search, .gitignore), chips (preview, duplicates, remove by
// click and keyboard), drag and drop (text file, same file twice, PDF, too
// large), load errors (search and inspect), the text each CLI receives
// (Claude: @-mentions, Codex: plain paths) and the 390 px phone layout.
//
//   IVE_E2E_PORT=5202 node e2e/chat-context.mjs
//   IVE_E2E_SKIP_BUILD=1 IVE_E2E_PORT=5202 node e2e/chat-context.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  E2E_DIR, ROOT, createSandbox, portFree, removeSandbox, runIsolationCheck, startBackend, stopAll, waitForHealth,
} from './sandbox.mjs'

const require = createRequire(join(ROOT, 'frontend', 'package.json'))
const { chromium } = require('playwright')

const PORT = Number(process.env.IVE_E2E_PORT || 5193)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(E2E_DIR, 'out', 'chat-context')
const results = []
let shotNo = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 260)})` : ''}`)
  return !!ok
}
async function step(name, fn) {
  console.log(`\n── ${name}`)
  try { await fn() } catch (err) { check(`${name}: no exception`, false, err?.message?.split('\n')[0]) }
}
async function poll(fn, { timeout = 15000, interval = 200 } = {}) {
  const t0 = Date.now(); let last
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last } catch { last = undefined }
    await sleep(interval)
  }
  return last
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function api(path, init) {
  const res = await fetch(`${BASE}/api${path}`, init)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

if (!(await portFree(PORT))) throw new Error(`port ${PORT} busy`)
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
if (process.env.IVE_E2E_SKIP_BUILD !== '1' || !existsSync(join(ROOT, 'frontend/dist/index.html'))) {
  console.log('building frontend …')
  const r = spawnSync(process.execPath, [join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'warn'],
    { cwd: join(ROOT, 'frontend'), stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}

const sb = await createSandbox({ port: PORT })
const iso = runIsolationCheck(sb)
if (!iso.isolated) { console.error(JSON.stringify(iso, null, 2)); await removeSandbox(sb); process.exit(3) }

// Project fixtures (untracked files count: git ls-files --others).
const W = sb.workspace
mkdirSync(join(W, 'docs', 'guides'), { recursive: true })
mkdirSync(join(W, 'node_modules', 'leftpad'), { recursive: true })
writeFileSync(join(W, 'docs', 'architecture.md'), '# Architecture\n\nThe backend is aiohttp, the frontend React.\n')
writeFileSync(join(W, 'docs', 'guides', 'setup guide.md'), '# Setup\n\nRun ./start.sh\n')
writeFileSync(join(W, 'docs', 'old-plan.md'), '# Old plan\n\nDeleted before the reload step.\n')
writeFileSync(join(W, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1\n')
writeFileSync(join(W, 'archive.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))
writeFileSync(join(W, '.gitignore'), 'node_modules/\n')

const fakeLog = () => { try { return readFileSync(join(sb.home, 'fake-cli.log'), 'utf8') } catch { return '' } }
// The fake CLIs read a bracketed paste line by line (each line is logged as
// its own input); join the inputs after the mark to get the text IVE sent.
function received(mark, needle) {
  const log = fakeLog().slice(mark)
  if (!log.includes(needle)) return null
  const lines = [...log.matchAll(/ input (?:'(.*)'|"(.*)")$/gm)].map((m) => m[1] ?? m[2])
  const start = lines.findIndex((l) => l.includes(needle))
  return lines.slice(start).join('\n').replace(/\[20[01]~/g, '')
}

const backend = startBackend(sb, openSync(join(OUT, 'backend.log'), 'w'))
let browser
try {
  await waitForHealth(PORT, backend)
  const ws = await api('/workspaces', json('POST', { path: W, name: 'demo-app' }))
  await api('/settings/owner_name', json('PUT', { value: 'Context E2E' }))
  await api('/tasks', json('POST', { workspace_id: ws.id, title: 'Ship context chips' }))
  const claude = await api('/sessions', json('POST', { workspace_id: ws.id, name: 'Context Claude', cli_type: 'claude' }))
  const codex = await api('/sessions', json('POST', { workspace_id: ws.id, name: 'Context Codex', cli_type: 'codex', permission_mode: 'plan' }))
  check('sandbox workspace and sessions created', ws?.id && claude?.id && codex?.id)

  browser = await chromium.launch({ headless: process.env.IVE_E2E_HEADED !== '1' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('cc-soundEnabled', '0')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const shot = async (name) => { await page.screenshot({ path: join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`) }).catch(() => {}) }

  let scope = page
  const chips = () => scope.locator('[data-context-chip]')
  const chipLabels = async () => (await chips().allInnerTexts()).map((t) => t.trim())
  const menu = () => scope.getByRole('listbox', { name: /Mention files/ })
  const rows = async () => menu().getByRole('option').allInnerTexts()
  const notices = async () => (await scope.locator('[data-context-notice]').allInnerTexts()).join(' | ')
  const settled = () => poll(async () => (await chips().count()) >= 0 && (await scope.locator('[data-context-chip] .animate-spin').count()) === 0)
  async function openChat(name, id) {
    await page.getByText(name, { exact: true }).filter({ visible: true }).first().click()
    await sleep(800)
    scope = page.locator(`[data-session-view="${id}"]`)
    const toggle = scope.locator('button[title="Switch to Chat View"]').first()
    if (await toggle.isVisible().catch(() => false)) await toggle.click()
    const ta = scope.locator('form.x-composer textarea').filter({ visible: true }).last()
    await ta.waitFor()
    return ta
  }
  async function drop(files) {
    const dt = await page.evaluateHandle((specs) => {
      const d = new DataTransfer()
      for (const s of specs) {
        const body = s.binary ? new Uint8Array(s.binary) : s.repeat ? 'x'.repeat(s.repeat) : s.text
        d.items.add(new File([body], s.name, { type: s.type || '' }))
      }
      return d
    }, files)
    const target = scope.locator('form.x-composer').filter({ visible: true }).last()
    await target.dispatchEvent('dragover', { dataTransfer: dt })
    await target.dispatchEvent('drop', { dataTransfer: dt })
  }
  const note = { name: 'meeting notes.md', text: '# Meeting\n- ship context chips\n', type: 'text/markdown' }

  await step('first run', async () => {
    await page.goto(`${BASE}/`)
    const guide = page.locator('[data-ive-onboarding]')
    if (await guide.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      await guide.getByPlaceholder('Dein Name').fill('Context E2E').catch(() => {})
      await guide.getByRole('navigation').getByRole('button', { name: /Loslegen/ }).click().catch(() => {})
      await guide.getByRole('button', { name: 'Einführung abschließen' }).click().catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
    await page.keyboard.press('Escape').catch(() => {})
  })

  let ta
  await step('Claude: @ lists files, folders and the ticket option', async () => {
    ta = await openChat('Context Claude', claude.id)
    await ta.click()
    await ta.type('@')
    await menu().waitFor()
    await poll(async () => (await rows()).some((r) => r.includes('docs/')))
    const first = await rows()
    check('@ shows @ticket: first, then project folders and files', first[0]?.includes('@ticket:') && first.some((r) => r.startsWith('docs/')) && first.some((r) => r.startsWith('README.md')), first.join(' | '))
    await shot('at-menu')
    await ta.type('archit')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    const r = await rows()
    check('fuzzy query ranks docs/architecture.md first and hides the ticket option', r[0]?.includes('architecture.md') && !r.some((x) => x.includes('@ticket:')), r.join(' | '))
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await chips().first().waitFor()
    await settled()
    check('Enter turns the file into a chip and removes the typed @query', (await chipLabels())[0] === 'docs/architecture.md' && (await ta.inputValue()) === '', `${await chipLabels()} / "${await ta.inputValue()}"`)
  })

  await step('ignored and unsupported project files', async () => {
    await ta.type('@leftpad')
    check('.gitignore: node_modules is not offered', await menu().getByText(/No files or folders match/).waitFor({ timeout: 4000 }).then(() => true, () => false))
    await ta.fill('')
    await ta.type('@archive')
    await poll(async () => (await rows())[0]?.includes('archive.zip'))
    check('a binary project file is marked in the menu', /archive\.zip[\s\S]*binary/.test((await rows())[0] || ''), (await rows()).join(' | '))
    await page.keyboard.press('Enter')
    await scope.locator('[data-context-notice="error"]').first().waitFor()
    check('picking it adds no chip and explains why', (await chips().count()) === 1 && /archive\.zip can't be added: ZIP files are binary/.test(await notices()), await notices())
    await shot('binary-refused')
    await scope.locator('[data-context-notice] button[aria-label="Dismiss"]').first().click()
  })

  await step('folders and duplicates', async () => {
    await ta.fill('')
    await ta.type('@docs')
    await poll(async () => (await rows()).some((r) => r.startsWith('docs/')))
    await menu().getByRole('option').filter({ hasText: /^docs\// }).first().dispatchEvent('mousedown')
    await settled()
    await ta.type('@architecture')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    await page.keyboard.press('Enter')
    await sleep(300)
    const labels = await chipLabels()
    check('folder chip added', labels.includes('docs/'), labels.join(','))
    check('the same file twice stays one chip and the user is told', labels.filter((l) => l === 'docs/architecture.md').length === 1 && /already in the context/.test(await notices()), labels.join(','))
    await shot('duplicate')
  })

  await step('chip preview', async () => {
    await chips().filter({ hasText: 'architecture.md' }).locator('button').first().click()
    const preview = scope.locator('[data-context-preview]')
    await preview.waitFor()
    const t = await preview.innerText()
    check('preview shows the path, how Claude receives it and the first lines', t.includes('docs/architecture.md') && t.includes('sent as @docs/architecture.md') && t.includes('The backend is aiohttp'), t)
    await shot('preview')
    await page.keyboard.press('Escape')
    await sleep(250)
    check('Escape closes the preview, focus returns to the chip, the view stays', !(await preview.isVisible().catch(() => false)) &&
      await page.evaluate(() => !!document.activeElement?.closest('[data-context-chip]')) && await ta.isVisible())
  })

  await step('drag and drop', async () => {
    await drop([note])
    await poll(async () => (await chipLabels()).includes('meeting notes.md'))
    await settled()
    check('a dropped Markdown file becomes a chip (was silently ignored before)', (await chipLabels()).includes('meeting notes.md'))
    await drop([note])
    await sleep(800)
    check('dropping the same file again keeps one chip', (await chipLabels()).filter((l) => l === 'meeting notes.md').length === 1, (await chipLabels()).join(','))
    await drop([{ name: 'report.pdf', binary: [0x25, 0x50, 0x44, 0x46, 0, 1, 2], type: 'application/pdf' }, { name: 'huge.log', repeat: 1100 * 1024, type: 'text/plain' }])
    await poll(async () => /report\.pdf/.test(await notices()))
    check('a PDF is refused with a reason', /report\.pdf is not a text file/.test(await notices()), await notices())
    check('a too large file is refused with the limit', /huge\.log is 1\.1 MB; attached text files can be up to 1\.0 MB/.test(await notices()), await notices())
    await shot('drop-notices')
  })

  await step('remove by click and keyboard', async () => {
    const before = (await chipLabels()).length
    await scope.getByRole('button', { name: 'Remove docs/ from context' }).click()
    check('× removes the folder chip', (await chipLabels()).length === before - 1 && !(await chipLabels()).includes('docs/'))
    await chips().filter({ hasText: 'meeting notes.md' }).locator('button').first().focus()
    await page.keyboard.press('Delete')
    await sleep(250)
    check('Delete on a focused chip removes it and keeps the focus in the composer area', !(await chipLabels()).includes('meeting notes.md') &&
      await page.evaluate(() => !!document.activeElement?.closest('[data-context-chip]') || document.activeElement?.tagName === 'TEXTAREA'))
  })

  await step('Claude receives @-mentions', async () => {
    await drop([note])
    await poll(async () => (await chipLabels()).includes('meeting notes.md'))
    await settled()
    await ta.click()
    await ta.type('@setup')
    await poll(async () => (await rows())[0]?.includes('setup guide.md'))
    await page.keyboard.press('Enter')
    await settled()
    await shot('claude-before-send')
    const mark = fakeLog().length
    await ta.fill('Summarise the attached context')
    await page.keyboard.press('Enter')
    const text = await poll(() => { const t = received(mark, 'Summarise the attached context'); return t?.includes('context for this message.') ? t : null }, { timeout: 20000 }) || ''
    writeFileSync(join(OUT, 'claude-received.txt'), text + '\n')
    const lines = text.split('\n')
    check('Claude: relative @path for a project file', lines.includes('@docs/architecture.md'), text)
    check('Claude: quoted @"path" when it has a space', lines.includes('@"docs/guides/setup guide.md"'), text)
    check('Claude: absolute @path into the session attachment folder for a dropped file',
      lines.some((l) => l.startsWith(`@${sb.state}/attachments/sessions/${claude.id}/context/`) && l.endsWith('-meeting_notes.md')), text)
    check('Claude: the prompt ends with a sentence, not inside an @ token', lines.at(-1) === 'Use the files and folders above as context for this message.', lines.at(-1))
    check('chips are cleared after sending', (await chips().count()) === 0)
    const stored = readFileSync(lines.find((l) => l.includes('meeting_notes.md')).slice(1), 'utf8')
    check('the uploaded copy holds the dropped text', stored.includes('ship context chips'))
    await sleep(1200)
    await shot('claude-after-send')
  })

  await step('load errors', async () => {
    // The composer is disabled while the (fake) agent answers.
    await poll(async () => (await ta.isEditable()) && !(await ta.getAttribute('placeholder')).includes('working'), { timeout: 20000 })
    await page.route('**/context/search**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk read failed' }) }))
    await ta.type('@arch')
    check('a failing search says so in the menu and offers Retry', await menu().getByText("Couldn't load project files: disk read failed").waitFor({ timeout: 4000 }).then(() => true, () => false))
    await shot('search-error')
    await page.unroute('**/context/search**')
    await menu().getByRole('button', { name: 'Retry' }).dispatchEvent('mousedown')
    check('Retry recovers', await poll(async () => (await rows()).some((r) => r.includes('architecture.md')), { timeout: 5000 }))
    await ta.type('itecture')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    await page.route('**/context/inspect**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'docs/architecture.md no longer exists in the session folder' }) }))
    await page.keyboard.press('Enter')
    await poll(async () => /Couldn't add/.test(await notices()), { timeout: 5000 })
    check('a file that fails to load is dropped from the chips with the reason', (await chips().count()) === 0 && /Couldn't add docs\/architecture\.md: docs\/architecture\.md no longer exists/.test(await notices()), await notices())
    await shot('inspect-error')
    await page.unroute('**/context/inspect**')
    await ta.fill('')
  })

  await step('ticket mentions still work', async () => {
    await ta.type('@tic')
    await poll(async () => (await rows())[0]?.includes('@ticket:'))
    check('@tic offers @ticket: first', (await rows())[0]?.includes('@ticket:'), (await rows()).join(' | '))
    await page.keyboard.press('Enter')
    check('choosing it writes @ticket: as before', (await ta.inputValue()) === '@ticket:', await ta.inputValue())
    await ta.type('Ship')
    await poll(async () => (await rows()).some((r) => r.includes('Ship context chips')))
    check('typing after it lists the workspace tickets', (await rows()).some((r) => r.includes('Ship context chips')), (await rows()).join(' | '))
    await ta.fill('')
  })

  await step('context while Claude works: queued with its chips, Edit brings them back', async () => {
    await poll(async () => (await ta.isEditable()) && !(await ta.getAttribute('placeholder')).includes('working'), { timeout: 20000 })
    const mark = fakeLog().length
    await ta.fill('slow queue context turn')
    await page.keyboard.press('Enter')
    await poll(async () => /is working/.test(await ta.getAttribute('placeholder')), { timeout: 8000 })
    await ta.type('@architecture')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    await page.keyboard.press('Enter')
    await settled()
    await ta.type('queued with context')
    await page.keyboard.press('Enter')
    const row = scope.locator('[data-composer-queue] li').filter({ hasText: 'queued with context' })
    await row.waitFor()
    const ctxLine = await row.locator('[data-queue-context]').innerText().catch(() => '')
    check('queue row names the attached context instead of showing the raw block', /architecture\.md/.test(ctxLine) && !/Attached context/.test(await row.innerText()), `${ctxLine} | ${await row.innerText()}`)
    check('chips are empty once the message is queued', (await chips().count()) === 0)
    await shot('queued-with-context')
    await row.getByRole('button', { name: 'Edit queued message' }).click()
    await sleep(200)
    check('Edit: typed text back in the box, context back as chip', (await ta.inputValue()) === 'queued with context' && JSON.stringify(await chipLabels()) === '["docs/architecture.md"]', `${await ta.inputValue()} | ${await chipLabels()}`)
    check('Edit: focus in the message box', await ta.evaluate((el) => el === document.activeElement))
    await ta.fill('queued with context, edited')
    await page.keyboard.press('Enter')
    const text = await poll(() => { const t = received(mark, 'queued with context, edited'); return t?.includes('context for this message.') ? t : null }, { timeout: 30000 }) || ''
    check('delivered after the turn with the context block exactly once', (text.match(/@docs\/architecture\.md/g) || []).length === 1 && !fakeLog().slice(mark).includes("input 'queued with context'"), text)
    await poll(async () => (await ta.isEditable()) && !(await ta.getAttribute('placeholder')).includes('working'), { timeout: 20000 })
  })

  await step('Codex receives plain paths', async () => {
    ta = await openChat('Context Codex', codex.id)
    await poll(async () => (await api('/sessions')).find?.((s) => s.id === codex.id)?.pty_alive, { timeout: 20000 })
    await poll(() => /trust accepted /.test(fakeLog()), { timeout: 20000 })
    await sleep(1500)
    await ta.click()
    await ta.type('@architecture')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    await page.keyboard.press('Enter')
    await drop([note])
    await poll(async () => (await chipLabels()).length === 2)
    await settled()
    await chips().filter({ hasText: 'architecture.md' }).locator('button').first().click()
    const preview = scope.locator('[data-context-preview]')
    await preview.waitFor()
    check('Codex preview says the plain path is sent', (await preview.innerText()).includes('sent as docs/architecture.md'))
    await shot('codex-preview')
    await page.keyboard.press('Escape')
    const mark = fakeLog().length
    await ta.fill('review the attached context')
    await page.keyboard.press('Enter')
    const text = await poll(() => { const t = received(mark, 'review the attached context'); return t?.includes('meeting_notes.md') ? t : null }, { timeout: 30000 }) || ''
    writeFileSync(join(OUT, 'codex-received.txt'), text + '\n')
    check('Codex: no @ (its @ is only a composer picker), relative project path', text.includes('\n- docs/architecture.md') && !/@docs\//.test(text), text)
    check('Codex: dropped file as an absolute path into the session attachment folder',
      new RegExp(`\\n- ${sb.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/attachments/sessions/${codex.id}/context/\\w+-meeting_notes\\.md \\(file the user attached`).test(text), text)
    await sleep(1200)
    await shot('codex-after-send')
  })

  await step('chips survive a reload; a file that is gone is marked, not sent', async () => {
    ta = await openChat('Context Codex', codex.id)
    await ta.click()
    await ta.type('@architecture')
    await poll(async () => (await rows())[0]?.includes('architecture.md'))
    await page.keyboard.press('Enter')
    await settled()
    await ta.type('@old-plan')
    await poll(async () => (await rows())[0]?.includes('old-plan.md'))
    await page.keyboard.press('Enter')
    await drop([note])
    await poll(async () => (await chipLabels()).length === 3)
    await settled()
    await ta.fill('after the reload')
    await sleep(500) // the draft is saved debounced
    const before = await chipLabels()
    unlinkSync(join(W, 'docs', 'old-plan.md'))
    await page.reload()
    await sleep(1500)
    ta = await openChat('Context Codex', codex.id)
    await poll(async () => (await scope.locator('[data-context-chip-state="checking"]').count()) === 0)
    const after = await chipLabels()
    const states = await chips().evaluateAll((els) => els.map((e) => `${e.querySelector('bdi')?.textContent}:${e.dataset.contextChipState}`))
    check('reload: draft and all three chips are back', (await ta.inputValue()) === 'after the reload' && before.length === 3 && after.length === 3, `${before} -> ${after}`)
    check('reload: the files still there are ok, the deleted one is marked missing',
      JSON.stringify(states.sort()) === JSON.stringify(['docs/architecture.md:ok', 'docs/old-plan.md:missing', 'meeting notes.md:ok']), JSON.stringify(states))
    const gone = chips().filter({ hasText: 'old-plan.md' }).locator('button').first()
    check('the missing chip says why (label)', /missing, not sent: docs\/old-plan\.md no longer exists/.test(await gone.getAttribute('aria-label')), await gone.getAttribute('aria-label'))
    await shot('reload-missing-chip')
    let mark = fakeLog().length
    await ta.click()
    await page.keyboard.press('Enter')
    await sleep(1200)
    check('sending with a missing chip is refused with the reason, nothing typed into Codex',
      /old-plan\.md is no longer there\. Remove it/.test(await notices()) && received(mark, 'after the reload') === null, await notices())
    await shot('reload-missing-refused')
    await scope.getByRole('button', { name: 'Remove docs/old-plan.md from context' }).click()
    mark = fakeLog().length
    await ta.click()
    await page.keyboard.press('Enter')
    const text = await poll(() => { const t = received(mark, 'after the reload'); return t?.includes('meeting_notes.md') ? t : null }, { timeout: 30000 }) || ''
    check('after removing it: sent with the restored chips, without the missing file',
      text.includes('- docs/architecture.md') && text.includes('meeting_notes.md') && !text.includes('old-plan'), text)
    check('chips cleared after sending, also in storage', (await chips().count()) === 0
      && !(await page.evaluate((id) => (localStorage.getItem('ive-composer-context-v1') || '').includes(id), codex.id)))
    await sleep(1200)
  })

  await step('390 px phone layout', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/`)
    await sleep(1500)
    // The phone layout reopens the last session (Codex); its composer is the one under test.
    scope = page
    const toggle = page.locator('button[title="Switch to Chat View"]').filter({ visible: true }).first()
    if (await toggle.isVisible().catch(() => false)) await toggle.click()
    ta = page.locator('form.x-composer textarea').filter({ visible: true }).last()
    await ta.click()
    await ta.type('@docs')
    await poll(async () => (await rows()).some((r) => r.startsWith('docs/')))
    await page.keyboard.press('Enter')
    await drop([{ name: 'a-really-long-file-name-for-the-narrow-layout-check.md', text: 'x\n', type: 'text/markdown' }])
    await poll(async () => (await chips().count()) === 2)
    await settled()
    await shot('phone-chips')
    const geo = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      chips: [...document.querySelectorAll('[data-context-chip]')].map((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth }),
    }))
    check('390 px: chips stay on screen without horizontal scroll', !geo.overflow && geo.chips.every(Boolean), JSON.stringify(geo))
  })

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser?.close().catch(() => {})
  const left = await stopAll(sb, backend)
  if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb)
  console.log(`\nbackend stopped (leftover pids: ${left.join(',') || 'none'})`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
