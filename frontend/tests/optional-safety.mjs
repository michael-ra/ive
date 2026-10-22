import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await webkit.launch()
try {
  for (const width of [1440, 780]) {
    const f = await createTourFixture(browser, { width, settings: { product_tour_version: '2' } })
    let enabled = false
    let configured = false
    let saves = 0
    const issue = 'Configure the API key for gemini_api before enabling the optional AI check.'
    await f.context.route('**/api/safety/rules*', r => r.fulfill({ json: [] }))
    await f.context.route('**/api/safety/status', r => r.fulfill({ json: {
      enabled, hard_deny_enabled: true, rule_count: 0, decision_count: 0,
      classifier_setup: { ready: configured, issue: configured ? null : issue },
    } }))
    await f.context.route('**/api/settings/experimental_safety_gate', async r => {
      saves++
      if (!configured) return r.fulfill({ status: 400, json: { error: issue, code: 'provider_not_configured' } })
      enabled = r.request().postDataJSON().value === 'on'
      return r.fulfill({ json: { ok: true } })
    })
    const p = f.page
    await p.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await p.locator('[data-settings-nav="safety"]').click()
    const panel = p.locator('[data-settings-content="safety"]')
    await panel.getByText('Agent permissions and IVE deny rules are active. The optional AI check is off.', { exact: true }).waitFor()
    const model = panel.getByRole('combobox', { name: 'Safety classifier model' })
    assert.equal(await model.isEnabled(), true, 'configure a model before opting in')
    await panel.getByRole('button', { name: 'Turn on optional AI check', exact: true }).click()
    await panel.getByText(issue, { exact: true }).last().waitFor()
    assert.equal(enabled, false)
    assert.equal(saves, 1, 'one activation request, no automatic retries')
    configured = true
    await panel.getByRole('button', { name: 'Turn on optional AI check', exact: true }).click()
    await panel.getByRole('button', { name: 'Turn off optional AI check', exact: true }).waitFor()
    assert.equal(enabled, true)
    await panel.getByRole('button', { name: 'Turn off optional AI check', exact: true }).click()
    await panel.getByRole('button', { name: 'Turn on optional AI check', exact: true }).waitFor()
    assert.equal(enabled, false)
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(f.errors, [])
    await f.context.close()
  }
  console.log(JSON.stringify({ passed: true, widths: [1440, 780], activationError: true, optInOut: true }))
} finally {
  await browser.close()
}
