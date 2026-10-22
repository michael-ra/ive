/**
 * Native-safe session deletion through real app dialogs and isolated APIs.
 * Browser is supplied by the Playwright plugin; this module never launches one.
 * Each named case is independent and can run in its own short plugin call.
 */
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const DELETE_ALPHA = 'delete-alpha'
const DELETE_BETA = 'delete-beta'
const DELETE_WORKSPACE = 'delete-workspace'
const DELETE_ALPHA_NAME = 'Alpha delete only this'
const DELETE_BETA_NAME = 'Beta preserve this'
const DELETE_ALPHA_HISTORY = 'Selected session history DELETE-ALPHA-572.'
const DELETE_BETA_HISTORY = 'Unrelated preserved history DELETE-BETA-824.'
const deleteAssert = (condition, message) => { if (!condition) throw new Error(message) }
const deleteEqual = (actual, expected, message) => deleteAssert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
async function deleteUntil(read, message, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out: ${message}`)
}
function deleteSeed({ single = false, custom = false } = {}) {
  const sessions = [{ id: DELETE_ALPHA, name: DELETE_ALPHA_NAME }, ...(!single ? [{ id: DELETE_BETA, name: DELETE_BETA_NAME }] : [])].map((item) => ({
    ...item, workspace_id: DELETE_WORKSPACE, cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], attention: null,
  }))
  const storage = {
    'ive.operator-desk': { activeWorkspaceId: DELETE_WORKSPACE, activeSessionId: DELETE_ALPHA, openTabs: sessions.map((item) => item.id), showHome: false, activeNavGroup: 'work', notifications: [], planWaiting: {} },
    'ive.grid-session-views': Object.fromEntries(sessions.map((item) => [item.id, 'chat'])),
    'cc-gridColumns': '2',
  }
  const gridTemplates = custom ? [{ id: 'delete-grid', workspace_id: DELETE_WORKSPACE, name: 'Delete pair', cols: 2, cells: [
    { id: 'a', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'b', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
  ], cell_assignments: { a: DELETE_ALPHA, b: DELETE_BETA } }] : []
  if (custom) storage['cc-activeGridTemplateIds'] = { [DELETE_WORKSPACE]: 'delete-grid' }
  return { width: 1800, height: 1000, blockNativeConfirm: true, settings: { product_tour_version: '2', owner_name: 'Delete test' },
    workspaces: [{ id: DELETE_WORKSPACE, name: 'Deletion practice', path: '/isolated/ive-delete/practice', default_worktree: 0 }],
    sessions, storage, gridTemplates, messages: Object.fromEntries(sessions.map((item) => [item.id, [{
      id: `message-${item.id}`, session_id: item.id, role: 'assistant', content: item.id === DELETE_ALPHA ? DELETE_ALPHA_HISTORY : DELETE_BETA_HISTORY, created_at: '2026-01-01T00:00:00Z',
    }]])),
  }
}
const deleteCard = (f, id = DELETE_ALPHA) => f.page.locator(`[data-session-view="${id}"], [data-grid-cell-session="${id}"]`).filter({ visible: true }).first()
const deleteSidebar = (f, id = DELETE_ALPHA) => f.page.locator(`.x-sidebar [data-session-id="${id}"]`)
const deleteDialog = (f) => f.page.getByRole('dialog', { name: /^Delete session/i })
const deleteConfirm = (f) => deleteDialog(f).getByRole('button', { name: 'Delete session', exact: true })
const deleteWrites = (f) => f.writes.filter((item) => item.method === 'DELETE')
async function deleteFixture(env, key, options = {}) {
  const f = await env.createFixture(env.browser, { ...env.options.fixtureOptions, ...deleteSeed(options), ...options })
  env.fixtures[key] = f
  await deleteSidebar(f).waitFor({ state: 'visible' })
  await deleteCard(f).getByText(DELETE_ALPHA_HISTORY, { exact: true }).waitFor()
  return f
}
async function deleteScreenshot(env, f, name) {
  if (env.options.screenshotDir) await f.page.screenshot({ path: `${env.options.screenshotDir.replace(/\/$/, '')}/${name}.png`, animations: 'disabled' })
}
async function deleteNativeUnused(f) {
  deleteEqual(await f.page.evaluate(() => window.__iveTestNativeConfirmCalls), 0, 'Native window.confirm is never called')
  deleteEqual(f.errors.length, 0, `No browser exceptions: ${f.errors.join('; ')}`)
  deleteAssert(!f.unexpected.some((item) => item.method !== 'GET'), `No unsupported writes: ${JSON.stringify(f.unexpected)}`)
}
async function openDeleteFromTrash(f) {
  await deleteSidebar(f).hover()
  await deleteSidebar(f).getByRole('button', { name: 'Delete session', exact: true }).click()
  await deleteDialog(f).waitFor({ state: 'visible' })
  deleteAssert((await deleteDialog(f).innerText()).includes(DELETE_ALPHA_NAME), 'The confirmation identifies the exact selected session')
  await deleteNativeUnused(f)
}
async function assertDeletePreserved(f, expectedWrites = 0) {
  deleteEqual(f.data.sessions.length, 2, 'Both sessions remain before confirmation or after rejection')
  deleteEqual(f.data.messages[DELETE_ALPHA][0].content, DELETE_ALPHA_HISTORY, 'Selected history remains intact')
  deleteEqual(f.data.messages[DELETE_BETA][0].content, DELETE_BETA_HISTORY, 'Unrelated history remains intact')
  await deleteSidebar(f).waitFor({ state: 'visible' })
  await deleteCard(f).waitFor({ state: 'visible' })
  deleteEqual(deleteWrites(f).length, expectedWrites, 'Only explicitly confirmed requests reach DELETE')
  await deleteNativeUnused(f)
}
async function assertDeleted(f, { single = false, attempts = 1 } = {}) {
  await deleteDialog(f).waitFor({ state: 'detached' })
  await deleteSidebar(f).waitFor({ state: 'detached' })
  await deleteUntil(async () => await deleteCard(f).count() === 0, 'The deleted session has no visible tile')
  deleteAssert(!f.data.sessions.some((item) => item.id === DELETE_ALPHA), 'The selected session row is gone')
  deleteAssert(!Object.hasOwn(f.data.messages, DELETE_ALPHA), 'Its app transcript is no longer addressable')
  deleteEqual(deleteWrites(f).length, attempts, 'Expected number of explicit deletion attempts')
  deleteAssert(deleteWrites(f).every((item) => item.path === `/sessions/${DELETE_ALPHA}`), 'Deletion targets only the selected session')
  deleteAssert(!f.writes.some((item) => item.body?.archived), 'Delete is not silently replaced by Archive')
  if (!single) {
    deleteEqual(f.data.sessions.length, 1, 'Unrelated session is retained')
    deleteEqual(f.data.messages[DELETE_BETA][0].content, DELETE_BETA_HISTORY, 'Unrelated transcript is retained')
    await deleteSidebar(f, DELETE_BETA).waitFor({ state: 'visible' })
    await deleteCard(f, DELETE_BETA).getByText(DELETE_BETA_HISTORY, { exact: true }).waitFor()
  }
  await deleteUntil(async () => f.page.evaluate((id) => {
    const desk = JSON.parse(localStorage.getItem('ive.operator-desk') || '{}')
    return !desk.openTabs?.includes(id) && desk.activeSessionId !== id
  }, DELETE_ALPHA), 'Persisted focus and tabs no longer contain the deleted session')
  await deleteNativeUnused(f)
}
async function reloadDeletedApp(f, single = false) {
  const loaded = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && response.status() === 200)
  await f.page.reload()
  await loaded
  if (single) await f.page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
  else await deleteSidebar(f, DELETE_BETA).waitFor({ state: 'visible' })
  deleteEqual(await deleteSidebar(f).count(), 0, 'Reload cannot revive the sidebar entry')
  deleteEqual(await deleteCard(f).count(), 0, 'Reload cannot revive the deleted tile')
  await deleteNativeUnused(f)
}

const sessionDeleteCases = {
  async 'sidebar-cancel-escape'(env) {
    const f = await deleteFixture(env, 'sidebar-cancel-escape')
    await openDeleteFromTrash(f)
    await assertDeletePreserved(f)
    await deleteDialog(f).getByRole('button', { name: 'Cancel', exact: true }).click()
    await deleteDialog(f).waitFor({ state: 'detached' })
    await assertDeletePreserved(f)
    await openDeleteFromTrash(f)
    await f.page.keyboard.press('Escape')
    await deleteDialog(f).waitFor({ state: 'detached' })
    await assertDeletePreserved(f)
  },
  async 'sidebar-delete-and-reload'(env) {
    const f = await deleteFixture(env, 'sidebar-delete-and-reload')
    await openDeleteFromTrash(f)
    await assertDeletePreserved(f)
    await deleteScreenshot(env, f, 'session-delete-confirmation')
    await deleteConfirm(f).click()
    await assertDeleted(f)
    await reloadDeletedApp(f)
    await deleteScreenshot(env, f, 'session-deleted-after-reload')
  },
  async 'delete-failure-retry'(env) {
    const f = await deleteFixture(env, 'delete-failure-retry', { failDelete: true })
    await openDeleteFromTrash(f)
    await deleteConfirm(f).click()
    await deleteDialog(f).getByRole('alert').filter({ hasText: 'Test: deletion unavailable' }).waitFor()
    await assertDeletePreserved(f, 1)
    deleteAssert(await deleteConfirm(f).isEnabled(), 'Failure restores the retry action')
    await deleteScreenshot(env, f, 'session-delete-error-retry')
    f.controls.failDelete = false
    await deleteConfirm(f).click()
    await assertDeleted(f, { attempts: 2 })
  },
  async 'delete-dedup'(env) {
    const f = await deleteFixture(env, 'delete-dedup', { holdDelete: true })
    try {
      await openDeleteFromTrash(f)
      await deleteConfirm(f).dblclick()
      await deleteUntil(() => deleteWrites(f).length > 0, 'The confirmed delete is in flight')
      await f.page.keyboard.press('Enter')
      await deleteDialog(f).getAttribute('role')
      deleteEqual(deleteWrites(f).length, 1, 'Repeated confirmation sends a single in-flight DELETE')
      await assertDeletePreserved(f, 1)
      f.controls.releaseDeletes()
      await assertDeleted(f)
    } finally { f.controls.releaseDeletes() }
  },
  async 'context-menu-delete'(env) {
    const f = await deleteFixture(env, 'context-menu-delete')
    await deleteCard(f).locator('.ive-session-heading').click({ button: 'right' })
    await f.page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await deleteDialog(f).waitFor({ state: 'visible' })
    deleteAssert((await deleteDialog(f).innerText()).includes(DELETE_ALPHA_NAME), 'Grid context menu confirms the selected session')
    await assertDeletePreserved(f)
    await deleteConfirm(f).click()
    await assertDeleted(f)
  },
  async 'sidebar-context-delete'(env) {
    const f = await deleteFixture(env, 'sidebar-context-delete')
    await deleteSidebar(f).locator('.x-session-card').click({ button: 'right' })
    await f.page.getByRole('button', { name: 'Delete', exact: true }).click()
    await deleteDialog(f).waitFor({ state: 'visible' })
    await assertDeletePreserved(f)
    await deleteConfirm(f).click()
    await assertDeleted(f)
  },
  async 'last-session-home'(env) {
    const f = await deleteFixture(env, 'last-session-home', { single: true })
    await openDeleteFromTrash(f)
    deleteEqual(deleteWrites(f).length, 0, 'The final session still requires explicit confirmation')
    await deleteConfirm(f).click()
    await assertDeleted(f, { single: true })
    await f.page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
    deleteEqual(f.data.sessions.length, 0, 'The final session is removed')
    await reloadDeletedApp(f, true)
    await deleteScreenshot(env, f, 'last-session-deleted-home')
  },
  async 'custom-grid-delete'(env) {
    const f = await deleteFixture(env, 'custom-grid-delete', { custom: true })
    await f.page.locator(`[data-grid-cell-session="${DELETE_ALPHA}"]`).waitFor({ state: 'visible' })
    await openDeleteFromTrash(f)
    await deleteConfirm(f).click()
    await assertDeleted(f)
    await reloadDeletedApp(f)
    deleteEqual(await f.page.locator(`[data-grid-cell-session="${DELETE_ALPHA}"]`).count(), 0, 'No stale custom-grid assignment revives the deleted session')
    await f.page.locator(`[data-grid-cell-session="${DELETE_BETA}"]`).waitFor({ state: 'visible' })
  },
}

export const sessionDeleteCheckNames = Object.freeze(Object.keys(sessionDeleteCases))
export async function runSessionDeleteChecks(browser, createFixture = createTourFixture, options = {}) {
  const fixtures = options.fixtures || {}, results = []
  const env = { browser, createFixture, options, fixtures }
  try {
    for (const name of options.cases || sessionDeleteCheckNames) {
      deleteAssert(typeof sessionDeleteCases[name] === 'function', `Unknown session-delete check: ${name}`)
      const started = Date.now()
      await options.reporter?.({ name, status: 'running' })
      try {
        await sessionDeleteCases[name](env)
        const result = { name, status: 'passed', elapsedMs: Date.now() - started }
        results.push(result); await options.reporter?.(result)
      } catch (error) {
        const result = { name, status: 'failed', elapsedMs: Date.now() - started, error: error.message }
        results.push(result); await options.reporter?.(result)
        if (!options.continueOnError) { error.results = results; throw error }
      }
    }
    return { results, fixtures, metadata: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, {
      sessionIds: f.data.sessions.map((item) => item.id), transcriptIds: Object.keys(f.data.messages), writes: f.writes,
      errors: [...f.errors], unexpected: [...f.unexpected],
    }])) }
  } finally {
    if (!options.keepOpen) await Promise.all(Object.values(fixtures).map((f) => f.context.close()))
  }
}
