import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/terminal-expand-20261015/', import.meta.url).pathname
await mkdir(out, { recursive: true })
try {
  for (const [width, theme] of [[1440, 'light'], [1024, 'dark']]) {
    const f = await createTourFixture(browser, {
      origin: 'https://ive-guide.test', width, height: 960, theme,
      settings: { product_tour_version: '2' },
      workspaces: [{ id: 'w', name: 'Website', path: '/isolated/website' }],
      sessions: ['s', 't'].map(id => ({ id, workspace_id: 'w', name: `Task ${id}`, cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true, session_type: 'worker', tags: [] })),
      storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 't'], showHome: false, activeNavGroup: 'work' } },
    })
    const p = f.page
    await p.goto('https://ive-guide.test/#session-s')
    const input = p.locator('.ive-session-composer textarea')
    await input.fill('Keep this unsent task draft')
    await p.getByTitle('Toggle PTY Terminal Drawer', { exact: true }).click()
    const surface = p.locator('[data-terminal-session="s"] .xterm-screen')
    await surface.waitFor()
    for (let i = 0; i < 100 && f.data.pty.filter(item => item.action === 'start_pty').length < 2; i++) await delay(50)
    const before = f.data.pty.length
    const node = await surface.elementHandle()
    const small = await surface.boundingBox()
    await p.getByRole('button', { name: 'Expand terminal', exact: true }).click()
    await p.locator('[data-session-terminal-drawer="full"]').waitFor()
    assert.equal(await input.count(), 0, 'Full terminal replaces chat')
    await p.waitForFunction(height => document.querySelector('[data-terminal-session="s"] .xterm-screen')?.getBoundingClientRect().height > height + 200, small.height)
    assert(await node.evaluate(el => el === document.querySelector('[data-terminal-session="s"] .xterm-screen')), 'Expansion preserves xterm')
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow')
    await p.screenshot({ path: `${out}full-${engine}-${theme}.png` })
    await p.getByRole('button', { name: 'Restore small terminal', exact: true }).click()
    await p.locator('[data-session-terminal-drawer="open"]').waitFor()
    assert.equal(await input.inputValue(), 'Keep this unsent task draft')
    await p.screenshot({ path: `${out}split-${engine}-${theme}.png` })
    await p.getByRole('button', { name: 'Hide terminal — show overview', exact: true }).click()
    assert.equal(await p.locator('[data-session-terminal-drawer]').count(), 0)
    assert.equal(await input.inputValue(), 'Keep this unsent task draft')
    await p.getByTitle('Toggle PTY Terminal Drawer', { exact: true }).click()
    await p.getByRole('button', { name: 'Expand terminal', exact: true }).click()
    await p.getByRole('button', { name: 'Hide terminal — show overview', exact: true }).click()
    assert.equal(await input.inputValue(), 'Keep this unsent task draft', 'Close from full restores draft')
    assert(!f.data.pty.slice(before).some(item => /input|stop|start|resume/.test(item.action || '')), JSON.stringify(f.data.pty.slice(before)))
    await p.getByTitle('Toggle PTY Terminal Drawer', { exact: true }).click()
    await p.getByRole('button', { name: 'Expand terminal', exact: true }).click()
    await p.reload()
    await p.locator('[data-session-terminal-drawer="full"]').waitFor()
    await p.evaluate(() => { location.hash = '#session-t' })
    await p.locator('.ive-session-screen[data-session-view="t"]').waitFor()
    assert.equal(await p.locator('[data-session-terminal-drawer]').count(), 0, 'View choice belongs to its session')
    await p.evaluate(() => { location.hash = '#session-s' })
    await p.locator('[data-session-terminal-drawer="full"]').waitFor()
    await surface.click({ position: { x: 40, y: 25 } })
    await p.keyboard.press('Escape')
    await p.locator('[data-board-screen]').waitFor()
    assert(!f.errors.length, JSON.stringify(f.errors))
    await f.context.close()
  }
  console.log(JSON.stringify({ engine, scenarios: 2, passed: true }))
} finally { await browser.close() }
