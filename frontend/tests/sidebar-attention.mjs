import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await webkit.launch()
try {
  for (const width of [1440, 780]) {
    const f = await createTourFixture(browser, {
      width, settings: { product_tour_version: '2' },
      workspaces: [{ id: 'w', name: 'Test project', path: '/isolated/project' }],
      tasks: [
        { id: 't1', workspace_id: 'w', title: 'Review sign-in', status: 'review' },
        { id: 't2', workspace_id: 'w', title: 'Review checkout', status: 'review' },
      ],
    })
    const p = f.page
    p.setDefaultTimeout(10000)
    const trigger = p.locator('.ive-needs-you')
    await trigger.waitFor()
    assert.match(await trigger.innerText(), /2 items need your attention/)
    // The reported case: no open sessions. Clicking must still open the tasks.
    await trigger.click()
    const panel = p.getByRole('dialog', { name: 'Needs your attention', exact: true })
    await panel.waitFor()
    assert.equal(await panel.locator('.ive-attention-item').count(), 2)
    await p.screenshot({path: new URL(`../../packaging/artifacts/release-1.0.8/attention-${width}.png`, import.meta.url).pathname})
    await panel.locator('.ive-attention-item').filter({ hasText: 'Review checkout' }).getByRole('button', { name: 'Review', exact: false }).click()
    await p.getByRole('dialog', { name: 'Review checkout', exact: true }).waitFor()
    assert.equal(await panel.count(), 0)
    await p.keyboard.press('Escape')
    // Reopen with the keyboard; the other item is reachable too.
    await trigger.focus(); await p.keyboard.press('Enter')
    await panel.locator('.ive-attention-item').filter({ hasText: 'Review sign-in' }).getByRole('button', { name: 'Review', exact: false }).click()
    await p.getByRole('dialog', { name: 'Review sign-in', exact: true }).waitFor()
    assert.equal(f.writes.length, 0, 'opening attention must not approve or mutate anything')
    assert.deepEqual(f.errors, [])
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await f.context.close()
  }
  const f = await createTourFixture(browser, {
    settings: { product_tour_version: '2' },
    workspaces: [{ id: 'w', name: 'Test project', path: '/isolated/project' }],
    sessions: [
      { id: 's', workspace_id: 'w', name: 'Waiting for answer', cli_type: 'claude', status: 'waiting', pty_alive: true, attention: { kind: 'question', title: 'Which file?' } },
      { id: 'hidden', workspace_id: 'w', name: 'Old waiting session', cli_type: 'claude', status: 'waiting', archived: 1 },
      { id: 'helper', workspace_id: 'w', name: 'Helper', cli_type: 'claude', session_type: 'commander', status: 'waiting' },
    ],
  })
  const p = f.page
  await p.locator('.ive-needs-you').waitFor()
  assert.match(await p.locator('.ive-needs-you').innerText(), /1 item needs your attention/)
  await p.locator('.ive-needs-you').click()
  const panel = p.getByRole('dialog', { name: 'Needs your attention', exact: true })
  await panel.getByRole('button', { name: 'Review', exact: false }).click()
  await p.locator('[data-session-view="s"] [data-session-terminal-drawer="open"]').waitFor()
  assert.equal(await panel.count(), 0)
  assert.deepEqual(f.errors, [])
  assert.equal(f.writes.filter(w => /\/input|\/approve|\/execute/.test(w.path)).length, 0)
  await f.context.close()
  console.log(JSON.stringify({ passed: true, tasksWithoutSessions: true, keyboard: true, waitingSessionTerminal: true, widths: [1440, 780] }))
} finally {
  await browser.close()
}
