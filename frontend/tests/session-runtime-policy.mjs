import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await webkit.launch()
try {
  for (const width of [1440, 780]) {
    const f = await createTourFixture(browser, {
      width, settings: { product_tour_version: '2' },
      workspaces: [{ id: 'w', name: 'Test project', path: '/isolated/project' }],
      sessions: ['s', 'old'].map((id) => ({ id, name: id === 's' ? 'Large session' : 'Old worker', workspace_id: 'w', cli_type: 'claude', session_type: 'worker', model: 'opus', status: 'idle', pty_alive: false, archived: 0, tags: [], permission_mode: 'auto' })),
      messages: { s: [{ id: 'm', session_id: 's', role: 'assistant', content: 'Existing conversation stays here.', created_at: '2020-01-01T00:00:00Z' }] },
      storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 'old'], showHome: false } },
    })
    const p = f.page
    p.setDefaultTimeout(10000)
    await f.context.route('**/api/sessions/s/runtime-model', (route) => route.fulfill({ json: {
      configured: { model: 'opus' }, observed: { model: 'claude-fable-5-1' }, launched: 'opus',
      context: { input_tokens: 830000, warning: true, source: 'last_request' }, auto_compact_window: 200000,
    } }))
    await p.goto('http://ive-guide.test/#session-s')
    const notice = p.getByRole('complementary', { name: 'Session context' })
    await notice.waitFor()
    assert.match(await notice.innerText(), /830k tokens.*last request/s)
    assert.match(await notice.innerText(), /Selected: opus.*Last observed: claude-fable-5-1/s)
    assert.match(await notice.innerText(), /200k window/)
    assert.equal(await notice.getByRole('button', { name: 'Compact context' }).isDisabled(), true)
    // Restoring both tabs must not launch either saved transcript.
    await p.waitForTimeout(500)
    assert.equal(f.data.pty.filter((item) => item.action === 'start_pty').length, 0)
    assert.equal(f.writes.length, 0)
    f.controls.setSessionStatus('s', 'idle', { pty_alive: true })
    await p.waitForFunction(() => !document.querySelector('[aria-label="Session context"] button')?.disabled)
    await notice.getByRole('button', { name: 'Compact context' }).click()
    await p.waitForFunction(() => document.querySelector('[aria-label="Session context"] button')?.textContent === 'Compact context')
    const inputs = f.writes.filter((item) => item.path.endsWith('/input'))
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].body.message, '/compact')
    assert.equal(f.data.pty.some((item) => item.action === 'start_pty' && item.session_id === 'old'), false)
    assert.deepEqual(f.errors, [])
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: new URL(`../../packaging/artifacts/release-1.0.9/context-${width}.png`, import.meta.url).pathname })
    await f.context.close()
  }
  console.log(JSON.stringify({ passed: true, restoredTabsDoNotLaunch: true, contextWarning: true, explicitCompact: true, modelMismatchVisible: true, widths: [1440, 780] }))
} finally { await browser.close() }
