import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/btw-20261015/', import.meta.url).pathname
await mkdir(out, { recursive: true })
let checks = 0
try {
  for (const width of [1440, 390]) {
    const f = await createTourFixture(browser, {
      origin: 'https://ive-guide.test', width, height: 960, settings: { product_tour_version: '2' },
      workspaces: [{ id: 'w', name: 'Customer website', path: '/isolated/website' }],
      sessions: ['s', 't'].map(id => ({ id, workspace_id: 'w', name: id === 's' ? 'Checkout task' : 'Search task', cli_type: 'claude', model: 'sonnet', permission_mode: 'default', status: 'working', agentState: 'working', pty_alive: true, session_type: 'worker', tags: [] })),
      storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, activeNavGroup: 'work' }, 'ive.grid-session-views': { s: 'chat', t: 'chat' }, 'cc-gridColumns': '1' },
      messages: { s: [{ id: 'u', role: 'user', content: 'Implement the checkout.', created_at: '2026-10-15T10:00:00Z' }, { id: 'a', role: 'assistant', content: 'I am checking the existing payment flow.', created_at: '2026-10-15T10:00:01Z' }] },
    })
    const questions = [], jobs = new Map()
    await f.context.route('**/api/sidechat/**', async route => {
      const path = new URL(route.request().url()).pathname
      let value
      if (path.endsWith('/options')) value = { providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [{ id: 'sonnet', label: 'Sonnet' }] }], accounts: [] }
      else if (path.endsWith('/ask')) {
        const data = route.request().postDataJSON()
        if (!jobs.has(data.request_id)) {
          questions.push(data)
          jobs.set(data.request_id, { id: data.request_id, status: 'running', answer: '', cli_type: data.cli_type, model: data.model })
        }
        value = jobs.get(data.request_id)
      } else {
        value = jobs.get(path.split('/').at(-1))
        if (route.request().method() === 'DELETE') value.status = 'cancelled'
      }
      return route.fulfill({ json: value })
    })
    const p = f.page
    await p.goto('https://ive-guide.test/#board')
    const input = p.locator('.ive-session-composer textarea').first()
    await input.waitFor()
    f.controls.setSessionStatus('s', 'running', { pty_alive: true })
    await p.getByTitle('Cancel output for claude', { exact: true }).waitFor()
    await input.fill('/btw Why this payment flow?')
    const firstAsk = p.waitForResponse(response => response.url().endsWith('/api/sidechat/ask') && response.request().method() === 'POST')
    await input.press('Enter')
    const panel = p.getByRole('complementary', { name: 'Side chat' })
    await panel.getByText('Checkout task', { exact: true }).waitFor().catch(async error => { await p.screenshot({path: `${out}failure.png`}); console.log((await p.locator('body').innerText()).slice(-12000)); console.log('questions',questions,'errors',f.errors,'writes',f.writes); throw error })
    await panel.getByRole('status').waitFor()
    await firstAsk
    assert.equal(questions.length, 1)
    assert.equal(questions[0].session_id, 's')
    assert.equal(questions[0].messages.at(-1).content, 'Why this payment flow?')
    assert.equal(await input.inputValue(), '')
    assert(!f.data.pty.some(item => /input|interrupt|send/.test(item.action || '')), 'No main-agent PTY input')
    assert(!f.writes.some(w => /\/input|\/interrupt|\/queue/.test(w.path || '')), 'No main-session mutation')
    checks += 5
    jobs.get(questions[0].request_id).status = 'completed'
    jobs.get(questions[0].request_id).answer = 'The current flow keeps payment confirmation on the server.'
    await panel.getByText('The current flow keeps payment confirmation on the server.').waitFor()
    await panel.getByLabel('Ask a side question').fill('Unsent follow-up')
    await panel.getByRole('button', { name: 'Close side chat' }).click()
    await input.fill('Keep this main-task draft')
    await p.getByRole('button', { name: 'Ask on the side /btw', exact: true }).first().click()
    assert.equal(await input.inputValue(), 'Keep this main-task draft')
    assert.equal(await panel.getByLabel('Ask a side question').inputValue(), 'Unsent follow-up')
    await panel.getByRole('button', { name: 'Open general chat' }).click()
    assert.equal(await panel.getByText('The current flow keeps payment confirmation on the server.').count(), 0)
    await panel.getByRole('button', { name: 'Close side chat' }).click()
    await input.fill('/btw')
    await input.press('Enter')
    await panel.getByText('Checkout task', { exact: true }).waitFor()
    assert.equal(await panel.getByLabel('Ask a side question').inputValue(), 'Unsent follow-up')
    assert.equal(questions.length, 1, 'Bare /btw opens, does not send')
    if (width === 1440) {
    await panel.getByRole('button', { name: 'Close side chat' }).click()
    await p.getByText('Search task', { exact: true }).first().click()
    await p.getByRole('button', { name: 'Ask on the side /btw', exact: true }).first().click()
    await panel.getByText('Search task', { exact: true }).waitFor()
    assert.equal(await panel.getByText('The current flow keeps payment confirmation on the server.').count(), 0)
    await panel.getByLabel('Ask a side question').fill('Which search approach?')
    const nextAsk = p.waitForResponse(response => response.url().endsWith('/api/sidechat/ask') && response.request().method() === 'POST')
    await panel.getByLabel('Ask a side question').press('Enter')
    await panel.getByRole('status').waitFor()
    await nextAsk
    assert.equal(questions.at(-1).session_id, 't')
    assert.equal(questions.at(-1).messages.length, 1, 'No conversation from another task')
    await panel.getByRole('button', { name: 'Stop side chat answer' }).click()
    await panel.getByText('Answer stopped. You can retry or ask a new question.').waitFor()
    assert.equal(f.data.sessions.find(s => s.id === 's').status, 'running', 'Main task state unchanged')
    checks += 4
    }

    await p.screenshot({ path: `${out}btw-${engine}-${width}.png`, fullPage: true })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(f.errors, [])
    checks += 7
    await f.context.close()
  }
  console.log(JSON.stringify({ engine, checks }))
} finally { await browser.close() }
