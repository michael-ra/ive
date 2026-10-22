import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
try {
  const f = await createTourFixture(browser, {
    origin: 'https://ive-guide.test', width: 1440, height: 960,
    settings: { product_tour_version: '2' },
    workspaces: [{ id: 'w', name: 'Example', path: '/isolated/example' }],
    sessions: ['s', 't'].map(id => ({ id, workspace_id: 'w', name: `Session ${id}`, cli_type: id === 't' ? 'shell' : 'claude', model: 'sonnet', status: 'idle', pty_alive: true, session_type: 'worker', tags: [] })),
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 't'], showHome: false, activeNavGroup: 'work' }, 'ive.grid-session-views': { s: 'terminal', t: 'terminal' }, 'cc-gridColumns': '2' },
  })
  const p = f.page
  await p.goto('https://ive-guide.test/#board')
  const terminal = id => p.locator(`[data-terminal-session="${id}"] .xterm-screen`)
  await terminal('t').waitFor()
  // Preserve the same xterm DOM node across board -> session -> board.
  const original = await terminal('t').elementHandle()
  await terminal('t').click({ position: { x: 40, y: 25 } })
  assert.equal(await p.locator('[data-board-screen]').count(), 1, 'Single click stays in Overview')
  for (let i = 0; i < 100 && f.data.pty.filter(item => item.action === 'start_pty').length < 2; i++) await delay(50)
  assert.equal(f.data.pty.filter(item => item.action === 'start_pty').length, 2)
  const before = f.data.pty.length
  await terminal('t').dblclick({ position: { x: 40, y: 25 } })
  await p.locator('.ive-session-screen[data-session-view="t"]').waitFor()
  assert.equal(await p.locator('[data-terminal-mode="full"] .xterm-screen').count(), 1)
  assert(await original.evaluate(el => el === document.querySelector('[data-terminal-session="t"] .xterm-screen')), 'Terminal stays mounted')
  await terminal('t').dblclick({ position: { x: 40, y: 25 } })
  assert.equal(await p.locator('.ive-session-screen[data-session-view="t"]').count(), 1, 'Full view remains open')
  await p.keyboard.press('Escape')
  await p.locator('[data-board-screen]').waitFor()
  assert(await original.evaluate(el => el === document.querySelector('[data-terminal-session="t"] .xterm-screen')), 'Escape preserves the terminal')
  // A menu owns the first Escape; only the next one returns to the Board.
  await terminal('t').dblclick({ position: { x: 40, y: 25 } })
  await p.locator('.ive-session-screen[data-session-view="t"]').waitFor()
  await terminal('t').click({ button: 'right', position: { x: 40, y: 25 } })
  await p.locator('[data-ive-popover]').waitFor()
  await p.keyboard.press('Escape')
  await p.locator('[data-ive-popover]').waitFor({ state: 'hidden' })
  assert.equal(await p.locator('.ive-session-screen[data-session-view="t"]').count(), 1)
  await p.keyboard.press('Escape')
  await p.locator('[data-board-screen]').waitFor()
  await terminal('s').dblclick({ position: { x: 40, y: 25 } })
  await p.locator('.ive-session-screen[data-session-view="s"]').waitFor()
  assert(!f.data.pty.slice(before).some(item => /input|stop|start|resume/.test(item.action || '')), JSON.stringify(f.data.pty.slice(before)))
  assert(!f.errors.length, JSON.stringify(f.errors))
  console.log(JSON.stringify({ engine, passed: 10 }))
  await f.context.close()
} finally { await browser.close() }
