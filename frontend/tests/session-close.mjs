/**
 * Session-close regressions using the actual built UI and isolated transports.
 * Import into the user-requested Playwright plugin; NEVER launches a browser.
 *
 * await runSessionCloseChecks(browser, createTourFixture, {
 *   cases: ['built-in-close'], keepOpen: true, fixtures: {}, reporter,
 * })
 * Every case owns an independent fixture and can run in a separate tool call.
 */
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const CLOSE_ALPHA = 'close-alpha'
const CLOSE_BETA = 'close-beta'
const CLOSE_WORKSPACE = 'close-workspace'
const CLOSE_ALPHA_NAME = 'Alpha keep history'
const CLOSE_BETA_NAME = 'Beta still active'
const CLOSE_TRANSCRIPT = 'Preserved assistant history: CLOSE-HISTORY-731.'
const closeAssert = (value, message) => { if (!value) throw new Error(message) }
const closeEqual = (actual, expected, message) => closeAssert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
async function closeUntil(read, message, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out: ${message}`)
}
function closeSeed(custom = false) {
  const workspaces = [{ id: CLOSE_WORKSPACE, name: 'Session close practice', path: '/isolated/ive-close/practice', default_worktree: 0 }]
  const sessions = [
    { id: CLOSE_ALPHA, name: CLOSE_ALPHA_NAME },
    { id: CLOSE_BETA, name: CLOSE_BETA_NAME },
  ].map((item) => ({ ...item, workspace_id: CLOSE_WORKSPACE, cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], attention: null }))
  const storage = {
    'ive.operator-desk': { activeWorkspaceId: CLOSE_WORKSPACE, activeSessionId: CLOSE_ALPHA, openTabs: [CLOSE_ALPHA, CLOSE_BETA], showHome: false, activeNavGroup: 'work', notifications: [], planWaiting: {} },
    'ive.grid-session-views': { [CLOSE_ALPHA]: 'chat', [CLOSE_BETA]: 'chat' },
    'cc-gridColumns': '2',
  }
  const gridTemplates = custom ? [{ id: 'close-grid', workspace_id: CLOSE_WORKSPACE, name: 'Close pair', cols: 2, cells: [
    { id: 'a', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    { id: 'b', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
  ], cell_assignments: { a: CLOSE_ALPHA, b: CLOSE_BETA } }] : []
  if (custom) storage['cc-activeGridTemplateIds'] = { [CLOSE_WORKSPACE]: 'close-grid' }
  return { width: 1800, height: 1000, settings: { product_tour_version: '2', owner_name: 'Close test' }, workspaces, sessions, storage, gridTemplates, messages: {
    [CLOSE_ALPHA]: [{ id: 'close-saved-message', session_id: CLOSE_ALPHA, role: 'assistant', content: CLOSE_TRANSCRIPT, created_at: '2026-01-01T00:00:00Z' }],
    [CLOSE_BETA]: [],
  } }
}
const closeCard = (f, id) => f.page.locator(`[data-session-view="${id}"], [data-grid-cell-session="${id}"]`).filter({ visible: true }).first()
const closeSidebarRow = (f, id) => f.page.locator(`.x-sidebar [data-session-id="${id}"]`)
const closeWrites = (f, id = CLOSE_ALPHA) => f.writes.filter((item) => item.method === 'PUT' && item.path === `/sessions/${id}` && item.body?.archived === 1)
const closeButton = (f, id = CLOSE_ALPHA, name = CLOSE_ALPHA_NAME) => closeCard(f, id).getByRole('button', { name: `Close ${name}`, exact: true })
async function closeFixture(env, name, options = {}) {
  const f = await env.createFixture(env.browser, { ...env.options.fixtureOptions, ...closeSeed(Boolean(options.custom)), ...options })
  env.fixtures[name] = f
  await closeCard(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
  await closeSidebarRow(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
  await closeSidebarRow(f, CLOSE_BETA).waitFor({ state: 'visible' })
  await closeCard(f, CLOSE_ALPHA).getByText(CLOSE_TRANSCRIPT, { exact: true }).waitFor()
  return f
}
async function closeScreenshot(env, f, name) {
  if (env.options.screenshotDir) await f.page.screenshot({ path: `${env.options.screenshotDir.replace(/\/$/, '')}/${name}.png`, animations: 'disabled' })
}
async function clickCloseX(f) {
  await closeCard(f, CLOSE_ALPHA).hover()
  await closeButton(f).click()
}
async function closedAndKept(f, expectedWrites = 1) {
  await closeUntil(() => f.data.sessions.find((item) => item.id === CLOSE_ALPHA)?.archived === 1, 'The archive request is confirmed')
  await closeSidebarRow(f, CLOSE_ALPHA).waitFor({ state: 'detached' })
  await closeUntil(async () => await closeCard(f, CLOSE_ALPHA).count() === 0, 'The closed session no longer occupies a visible tile')
  await closeSidebarRow(f, CLOSE_BETA).waitFor({ state: 'visible' })
  await closeCard(f, CLOSE_BETA).waitFor({ state: 'visible' })
  closeEqual(closeWrites(f).length, expectedWrites, 'One successful action sends one archive request')
  closeEqual(f.data.sessions.length, 2, 'The session row is archived, not deleted')
  closeEqual(f.data.messages[CLOSE_ALPHA][0].content, CLOSE_TRANSCRIPT, 'Archive preserves the transcript')
  closeAssert(!f.writes.some((item) => item.method === 'DELETE'), 'Closing never deletes a session')
  await closeUntil(async () => f.page.evaluate((id) => {
    const desk = JSON.parse(localStorage.getItem('ive.operator-desk') || '{}')
    return !desk.openTabs?.includes(id) && desk.activeSessionId !== id
  }, CLOSE_ALPHA), 'Persisted tabs and active focus no longer point at the closed session')
  closeEqual(f.errors.length, 0, `No browser exceptions: ${f.errors.join('; ')}`)
}
async function closeReload(f) {
  const snapshot = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && response.status() === 200)
  await f.page.reload()
  await snapshot
  await closeSidebarRow(f, CLOSE_BETA).waitFor({ state: 'visible' })
  await closeCard(f, CLOSE_BETA).waitFor({ state: 'visible' })
  closeEqual(await closeSidebarRow(f, CLOSE_ALPHA).count(), 0, 'Reload keeps the closed session out of the active sidebar')
  closeEqual(await closeCard(f, CLOSE_ALPHA).count(), 0, 'Reload does not revive its tile')
}
async function assertArchiveHistory(f) {
  const startsBefore = f.data.pty.filter((item) => item.session_id === CLOSE_ALPHA && item.action === 'start_pty').length
  const sidebar = f.page.locator('.x-sidebar')
  await sidebar.getByRole('button', { name: /^Archive\b/ }).click()
  await sidebar.getByRole('button', { name: new RegExp(`^${CLOSE_ALPHA_NAME}`) }).click()
  const history = closeCard(f, CLOSE_ALPHA)
  await history.getByText(CLOSE_TRANSCRIPT, { exact: true }).waitFor()
  closeEqual(f.data.sessions.find((item) => item.id === CLOSE_ALPHA).archived, 1, 'Reading history does not silently restore the session')
  closeEqual(await closeSidebarRow(f, CLOSE_ALPHA).count(), 0, 'History remains outside the active session list')
  // Two frames allow any openSession auto-start callback to run. The cached
  // transcript can otherwise render before an incorrect start_pty is sent.
  await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  closeEqual(f.data.pty.filter((item) => item.session_id === CLOSE_ALPHA && item.action === 'start_pty').length, startsBefore, 'Opening archived history does not start an agent')
}
async function closeShortcut(f) {
  // Follow the actual platform default: macOS browser uses Control+W because
  // Command+W belongs to the browser; non-Mac defaults retain Meta+W.
  const mac = await f.page.evaluate(() => /Mac/.test(navigator.platform || navigator.userAgent || ''))
  await f.page.keyboard.press(mac ? 'Control+w' : 'Meta+w')
}

const sessionCloseCases = {
  async 'built-in-close'(env) {
    const f = await closeFixture(env, 'built-in-close')
    await clickCloseX(f)
    await closedAndKept(f)
    await closeReload(f)
    await assertArchiveHistory(f)
    await closeScreenshot(env, f, 'closed-session-history')
  },
  async 'archive-failure'(env) {
    const f = await closeFixture(env, 'archive-failure', { failArchive: true })
    await clickCloseX(f)
    await f.page.getByText(/Could not close.*archive unavailable/).filter({ visible: true }).first().waitFor()
    closeEqual(f.data.sessions.find((item) => item.id === CLOSE_ALPHA).archived, 0, 'A rejected API write does not archive the session')
    await closeCard(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
    await closeSidebarRow(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
    closeEqual(closeWrites(f).length, 1, 'Failed action sends a single request')
    await closeScreenshot(env, f, 'close-api-failure-visible')
    f.controls.failArchive = false
    await clickCloseX(f)
    await closedAndKept(f, 2)
  },
  async 'duplicate-close'(env) {
    const f = await closeFixture(env, 'duplicate-close', { holdArchive: true })
    try {
      await closeCard(f, CLOSE_ALPHA).hover()
      await closeButton(f).dblclick()
      await closeUntil(() => closeWrites(f).length > 0, 'The archive request is in flight')
      await closeShortcut(f)
      // Keyboard handling is synchronous; querying the DOM gives its handler
      // a turn without delaying a successful server response artificially.
      await f.page.locator('.x-app-shell').getAttribute('class')
      closeEqual(closeWrites(f).length, 1, 'Double-click plus shortcut deduplicate the in-flight archive')
      closeEqual(f.data.sessions.find((item) => item.id === CLOSE_ALPHA).archived, 0, 'The view is not optimistically archived')
      await closeCard(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
      await closeSidebarRow(f, CLOSE_ALPHA).waitFor({ state: 'visible' })
      f.controls.releaseArchives()
      await closedAndKept(f)
    } finally { f.controls.releaseArchives() }
  },
  async 'custom-grid-close'(env) {
    const f = await closeFixture(env, 'custom-grid-close', { custom: true })
    await f.page.locator(`[data-grid-cell-session="${CLOSE_ALPHA}"]`).waitFor({ state: 'visible' })
    await clickCloseX(f)
    await closedAndKept(f)
    await closeReload(f)
    closeEqual(await f.page.locator(`[data-grid-cell-session="${CLOSE_ALPHA}"]`).count(), 0, 'Custom layout retains no closed-session assignment after reload')
    await f.page.locator(`[data-grid-cell-session="${CLOSE_BETA}"]`).waitFor({ state: 'visible' })
    await closeScreenshot(env, f, 'custom-grid-after-close')
  },
  async 'shortcut-close'(env) {
    const f = await closeFixture(env, 'shortcut-close')
    await closeCard(f, CLOSE_ALPHA).locator('.ive-session-title').first().click()
    await closeShortcut(f)
    await closedAndKept(f)
  },
  async 'context-menu-close'(env) {
    const f = await closeFixture(env, 'context-menu-close')
    await closeCard(f, CLOSE_ALPHA).locator('.ive-session-heading').click({ button: 'right' })
    await f.page.getByRole('menuitem', { name: /^Close(?: session)?$/i }).click()
    await closedAndKept(f)
  },
  async 'sidebar-context-close'(env) {
    const f = await closeFixture(env, 'sidebar-context-close')
    await closeSidebarRow(f, CLOSE_ALPHA).locator('.x-session-card').click({ button: 'right' })
    await f.page.getByRole('button', { name: 'Close session', exact: true }).click()
    await closedAndKept(f)
  },
}

export const sessionCloseCheckNames = Object.freeze(Object.keys(sessionCloseCases))
export async function runSessionCloseChecks(browser, createFixture = createTourFixture, options = {}) {
  const fixtures = options.fixtures || {}, results = []
  const env = { browser, createFixture, options, fixtures }
  try {
    for (const name of options.cases || sessionCloseCheckNames) {
      closeAssert(typeof sessionCloseCases[name] === 'function', `Unknown session-close check: ${name}`)
      const started = Date.now()
      await options.reporter?.({ name, status: 'running' })
      try {
        await sessionCloseCases[name](env)
        const result = { name, status: 'passed', elapsedMs: Date.now() - started }
        results.push(result); await options.reporter?.(result)
      } catch (error) {
        const result = { name, status: 'failed', elapsedMs: Date.now() - started, error: error.message }
        results.push(result); await options.reporter?.(result)
        if (!options.continueOnError) { error.results = results; throw error }
      }
    }
    return { results, fixtures, metadata: Object.fromEntries(Object.entries(fixtures).map(([key, f]) => [key, {
      sessions: f.data.sessions.map(({ id, archived }) => ({ id, archived })), writes: f.writes,
      errors: [...f.errors], unexpected: [...f.unexpected],
    }])) }
  } finally {
    if (!options.keepOpen) await Promise.all(Object.values(fixtures).map((f) => f.context.close()))
  }
}
