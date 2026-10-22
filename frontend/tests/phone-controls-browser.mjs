// Execute through the Playwright plugin browser_run_code_unsafe filename tool.
// Requires an isolated Vite server at http://127.0.0.1:5297; mocks every /api
// request and the app websocket in a NEW browser context. No user state/PTY.
async (page) => {
  const assert = {
    ok: (value, message = 'assertion failed') => { if (!value) throw new Error(message) },
    equal: (actual, expected) => { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) },
    deepEqual: (actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) },
  }
  const root = process.env.IVE_ROOT || process.cwd()
  const base = 'http://127.0.0.1:5297'
  const context = await page.context().browser().newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
  const evidence = []
  const state = { calls: [], failNext: false, sessions: [
    { id: 'phone-fixture-agent', workspace_id: 'phone-fixture-project', name: 'Phone fixture agent', cli_type: 'claude', model: 'sonnet', effort: '', permission_mode: 'default', status: 'running', agentState: 'working', pty_alive: true, session_type: 'worker', archived: 0, tags: [] },
    { id: 'phone-fixture-shell', workspace_id: 'phone-fixture-other', name: 'Phone fixture shell', cli_type: 'shell', status: 'running', pty_alive: true, session_type: 'shell', archived: 0, tags: [] },
  ], workspaces: [
    { id: 'phone-fixture-project', name: 'Phone fixture project', path: '/synthetic/phone-project' },
    { id: 'phone-fixture-other', name: 'Other fixture project', path: '/synthetic/phone-other' },
  ] }
  const errors = []
  try {
    await context.addInitScript(() => {
      localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
      localStorage.setItem('ive.onboarding.v2.owner', 'done')
      localStorage.setItem('ive.onboarding.v1.owner', 'done')
      localStorage.setItem('cc-soundEnabled', '0')
    })
    await context.routeWebSocket(`${base.replace('http:', 'ws:')}/ws`, ws => ws.onMessage(raw => {
      let message; try { message = JSON.parse(String(raw)) } catch { return }
      state.calls.push({ ws: message })
      if (['start_pty', 'resume_pty', 'resize', 'claim_geometry'].includes(message.action)) setTimeout(() => {
        try { ws.send(JSON.stringify({ type: 'output', session_id: message.session_id, data: '\x1b[H\x1b[2JSynthetic fixture terminal\r\n❯ ' })) } catch { /* context closed */ }
      }, 50)
    }))
    await context.route(`${base}/api/**`, async route => {
      const request = route.request(), path = new URL(request.url()).pathname.slice(4), method = request.method()
      let body = null; try { body = request.postDataJSON() } catch { /* GET */ }
      if (method !== 'GET') state.calls.push({ path, method, body })
      let result = []
      if (path === '/whoami') result = { actor_kind: 'owner_device', mode: 'full', label: 'Synthetic phone' }
      else if (path === '/cli-info/features') return route.fulfill({ path: `${root}/frontend/tests/fixtures/cli-profiles.json`, contentType: 'application/json' })
      else if (path === '/cli-info') result = { available_clis: { claude: true }, version: 'fixture' }
      else if (path === '/workspaces') result = state.workspaces
      else if (path === '/sessions' && method === 'POST') { result = { ...state.sessions[0], ...body, id: 'phone-fixture-created', name: body.name || 'New fixture', pty_alive: false, status: 'idle' }; state.sessions.push(result) }
      else if (path === '/sessions') result = state.sessions
      else if (path === '/quick-start') result = { root: '/synthetic/phone-project', workspace_id: 'phone-fixture-project' }
      else if (path.startsWith('/settings/')) result = { value: path.endsWith('/owner_name') ? 'Phone Tester' : path.endsWith('/owner_intro_completed_at') ? '2026-10-11' : path.endsWith('/product_tour_version') ? '2' : null }
      else if (path === '/settings') result = {}
      else if (path === '/sidechat/options') result = { providers: [{ id: 'claude', label: 'Claude', installed: true, models: [] }], accounts: [] }
      else if (path === '/runtime/status') result = { multiplayer: { enabled: false }, tunnel: { running: false } }
      else if (path === '/overview') result = { workspace_total: 2, detail_limit: 5, workspaces: [] }
      else if (path.endsWith('/files')) result = { items: [] }
      else if (path.endsWith('/output')) result = { screen: 'Synthetic fixture terminal\n❯ ', text: 'Synthetic fixture terminal\n❯ ' }
      else if (path.endsWith('/messages')) result = { messages: [], has_more: false }
      else if (path.endsWith('/launch/apply')) result = { fields: {} }
      else if (path.endsWith('/permission-mode/apply')) result = { state: 'none' }
      else if (method === 'POST' && path.endsWith('/input')) {
        if (state.failNext) { state.failNext = false; return route.fulfill({ status: 403, json: { error: 'Synthetic permission denied' } }) }
        result = { ok: true, session_id: path.split('/')[2] }
      } else if (method === 'PUT' && /^\/sessions\/[^/]+$/.test(path)) {
        if (state.failNext) { state.failNext = false; return route.fulfill({ status: 403, json: { error: 'Synthetic permission denied' } }) }
        const item = state.sessions.find(s => s.id === path.split('/')[2]); Object.assign(item, body)
        result = { ...item, launch_apply: Object.fromEntries(['model', 'effort', 'permission_mode'].filter(key => key in body).map(key => [key, { state: 'pending', value: body[key] }])) }
      }
      await route.fulfill({ json: result })
    })
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ status: 403, body: 'Synthetic phone fixture blocks external requests' }))
    const target = await context.newPage()
    target.setDefaultTimeout(10000)
    target.on('pageerror', error => errors.push(error.message))
    await target.goto(base)
    await target.waitForTimeout(700)
    await target.evaluate(async () => {
      // Import the exact Vite module URL already used by the app (including its
      // HMR timestamp); an unversioned import would create a second Zustand store.
      const url = performance.getEntriesByType('resource').map(entry => entry.name).findLast(name => new URL(name).pathname === '/src/state/store.js')
      if (!url) throw new Error('Fixture could not find the app store module')
      const { default: store } = await import(url)
      window.__phoneFixtureStore = store
      store.setState({ showHome: true, connected: true, currentAuth: { actor_kind: 'owner_device', mode: 'full' } })
    })
    await target.locator('[data-phone-overview]').waitFor()
    assert.equal(await target.locator('[data-phone-session]').count(), 2)
    evidence.push('two sessions available')
    await target.getByLabel('Sessions nach Projekt filtern').selectOption('phone-fixture-project')
    assert.equal(await target.locator('[data-phone-session]').count(), 1)
    await target.getByRole('button', { name: 'Neue Session in diesem Projekt' }).last().click()
    await target.locator('[data-tour="session-setup"]').waitFor()
    const setup = await target.evaluate(() => window.__phoneFixtureStore.getState().newSessionWorkspaceId)
    assert.equal(setup, 'phone-fixture-project')
    evidence.push('project-specific session setup')
    await target.locator('[data-tour="session-setup"]').getByRole('button', { name: 'Close', exact: true }).click()
    await target.locator('[data-phone-session="phone-fixture-agent"]').click()
    await target.getByRole('button', { name: 'Session steuern' }).click()
    const dialog = target.getByRole('dialog', { name: 'Session steuern', exact: true })
    await dialog.waitFor()
    await dialog.getByLabel('Name', { exact: true }).fill('Renamed phone fixture')
    const model = await dialog.getByLabel('Modell', { exact: true }).locator('option').evaluateAll(options => options.find(option => option.value && option.value !== 'sonnet')?.value)
    assert.ok(model, 'fixture offers an alternate model')
    await dialog.getByLabel('Modell', { exact: true }).selectOption(model)
    await dialog.getByLabel('Berechtigungen', { exact: true }).selectOption('plan')
    assert.equal(state.calls.filter(call => call.method === 'PUT' && call.path === '/sessions/phone-fixture-agent').length, 0)
    evidence.push('settings require explicit confirmation')
    await dialog.getByRole('button', { name: 'Änderungen und Neustart bestätigen' }).click()
    await dialog.getByText('Gespeichert. Wird nach der aktuellen Antwort oder Freigabe angewendet.').waitFor()
    const updates = state.calls.filter(call => call.method === 'PUT' && call.path === '/sessions/phone-fixture-agent')
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].body, { name: 'Renamed phone fixture', model, permission_mode: 'plan', apply_live: true })
    evidence.push('one acknowledged grouped update; pending is honest')
    await dialog.getByLabel('Name', { exact: true }).fill('Rejected name')
    state.failNext = true
    await dialog.getByRole('button', { name: 'Änderungen übernehmen' }).click()
    await dialog.getByText('Synthetic permission denied', { exact: true }).waitFor()
    evidence.push('setting permission rejection visible')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const controlBar = target.locator('[data-phone-control-status]')
    state.failNext = true
    await controlBar.getByRole('button', { name: 'Stop the current answer' }).click()
    await controlBar.getByText('Synthetic permission denied', { exact: true }).waitFor()
    await controlBar.getByRole('button', { name: 'Stop the current answer' }).click()
    await controlBar.getByText('Unterbrechung an den Mac gesendet. Der Status aktualisiert sich automatisch.').waitFor()
    const inputs = state.calls.filter(call => call.path === '/sessions/phone-fixture-agent/input')
    assert.ok(inputs.length >= 2)
    assert.deepEqual(inputs.at(-1).body, { message: '\x1b', raw: true })
    evidence.push('stop uses raw acknowledged API, failures visible')
    await target.setViewportSize({ width: 320, height: 700 })
    assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth))
    await target.getByRole('button', { name: 'Session steuern' }).click()
    await dialog.waitFor()
    assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await target.screenshot({ path: `${root}/test-results/mobile-controls-320.png` })
    evidence.push('controls fit 320px')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await target.getByRole('button', { name: 'Back to sessions' }).click()
    await target.getByLabel('Sessions nach Projekt filtern').selectOption('')
    await target.locator('[data-phone-session="phone-fixture-shell"]').click()
    assert.equal(await target.locator('[data-phone-session-head]').getByRole('button', { name: 'Chat view' }).count(), 0)
    await target.locator('[data-phone-keybar]').waitFor()
    await target.getByRole('button', { name: 'Session steuern' }).click()
    const shellDialog = target.getByRole('dialog', { name: 'Terminal steuern', exact: true })
    await shellDialog.waitFor()
    assert.equal(await shellDialog.getByRole('combobox').count(), 0)
    evidence.push('real shell has keybar and no agent/chat settings')
    await shellDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await target.evaluate(() => { window.__phoneFixtureStore.setState(state => ({ connected: false, sessions: { ...state.sessions, 'phone-fixture-shell': { ...state.sessions['phone-fixture-shell'], read_only: true } } })) })
    await target.getByRole('button', { name: 'Session steuern' }).click()
    await shellDialog.waitFor()
    assert.ok(await shellDialog.getByLabel('Name', { exact: true }).isDisabled())
    assert.ok(await shellDialog.getByRole('button', { name: 'Änderungen übernehmen' }).isDisabled())
    evidence.push('read-only and disconnected editing blocked')
    assert.deepEqual(errors, [])
    const result = { ok: true, checks: evidence, count: evidence.length, mocked_api_only: true, physical_iphone_tested: false }
    return result
  } finally { await context.close() }
}
