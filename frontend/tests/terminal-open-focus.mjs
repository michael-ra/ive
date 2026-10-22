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
    sessions: ['s', 't'].map(id => ({ id, workspace_id: 'w', name: `Task ${id}`, cli_type: 'claude', model: 'sonnet', status: 'waiting', agentState: 'waiting', pty_alive: true, session_type: 'worker', tags: [], attention: { kind: 'permission', title: 'Permission needed' } })),
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 't'], showHome: false, activeNavGroup: 'work' }, 'ive.grid-session-views': { s: 'chat', t: 'chat' } },
  })
  await f.context.route('**/api/sessions/*/output**', route => route.fulfill({ json: { screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel', text: '' } }))
  const p = f.page
  await p.goto('https://ive-guide.test/#session-s')
  for (let i = 0; i < 100 && f.data.pty.filter(item => item.action === 'start_pty').length < 2; i++) await delay(50)
  f.controls.setSessionStatus('s', 'waiting', { pty_alive: true, attention: { kind: 'permission', title: 'Permission needed' } })
  const review = p.getByRole('button', { name: 'Open terminal to review', exact: true })
  await p.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 12000 })
  await p.getByText('Request details', { exact: true }).click()
  await review.waitFor()
  const input = p.locator('.ive-session-composer textarea')
  await input.fill('Keep this draft')
  const checkEnter = async (sid, trigger) => {
    const before = f.data.pty.filter(item => item.action === 'input').length
    await trigger.click()
    await p.keyboard.press('Enter') // No click/focus in the terminal and no delay.
    for (let i = 0; i < 50 && f.data.pty.filter(item => item.action === 'input').length === before; i++) await delay(20)
    const sent = f.data.pty.filter(item => item.action === 'input').slice(before)
    assert.deepEqual(sent, [{ action: 'input', session_id: sid, data: '\r' }])
  }
  await checkEnter('s', review)
  assert.equal(await input.inputValue(), 'Keep this draft')
  await input.click()
  await checkEnter('s', review)
  assert.equal(await p.locator('[data-session-terminal-drawer="open"]').count(), 1, 'Review keeps an open terminal open')
  await checkEnter('s', p.getByRole('button', { name: 'Expand terminal', exact: true }))
  await checkEnter('s', p.getByRole('button', { name: 'Restore small terminal', exact: true }))
  await p.getByRole('button', { name: 'Hide terminal — show overview', exact: true }).click()
  await checkEnter('s', p.getByTitle('Toggle PTY Terminal Drawer', { exact: true }))
  await p.evaluate(() => { location.hash = '#board' })
  await p.locator('[data-board-screen]').waitFor()
  await checkEnter('t', p.locator('[data-grid-cell-session="t"]').getByTitle('Switch to Terminal View', { exact: true }))
  assert(!f.errors.length, JSON.stringify(f.errors))
  assert(!f.writes.some(item => /\/input|\/queue/.test(item.path)), 'Enter is not submitted through the chat composer')
  console.log(JSON.stringify({ engine, passed: 6 }))
  await f.context.close()
} finally { await browser.close() }
