import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = 'packaging/artifacts/provider-logos-20261014'
let checks = 0
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const f = await createTourFixture(browser, { width, height: 960, theme, settings: { product_tour_version: '2' }, workspaces: [{ id: 'w', name: 'Orbit', path: '/isolated/orbit' }] })
    const p = f.page
    await p.goto('http://ive-guide.test/#board')
    await p.getByRole('button', { name: 'Create a new session', exact: true }).click()
    await p.getByRole('button', { name: /Set up session/ }).click()
    await p.getByRole('heading', { name: 'New AI session', exact: true }).waitFor()
    const group = p.getByRole('group', { name: 'AI assistant', exact: true })
    for (const provider of ['claude', 'codex']) {
      const mark = group.locator(`[data-provider-logo="${provider}"]`)
      await mark.waitFor()
      const img = mark.locator('img:visible')
      await img.evaluate(el => el.decode())
      assert.equal(await img.count(), 1)
      assert.ok(await img.evaluate(el => el.naturalWidth > 0 && el.naturalHeight > 0))
      if (provider === 'codex') assert.ok((await img.getAttribute('class')).endsWith(theme))
      assert.ok(await img.evaluate(el => el.getBoundingClientRect().width >= 18))
    }
    // The full assistant name remains visible, including the selected checkmark.
    assert.equal(await group.getByText('Claude Code', { exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await group.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    assert.equal(await group.getByRole('button', { name: 'Codex CLI', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: `${out}/setup-${engine}-${theme}-${width}.png` })
    assert.deepEqual(f.errors, [])
    assert.equal(f.data.sessions.length, 0)
    checks++
    await f.context.close()
  }
  console.log(JSON.stringify({ engine, checks, passed: true }))
} finally { await browser.close() }
