/**
 * Project removal checks for the real built app with isolated HTTP transport.
 * The caller supplies a Playwright-plugin browser. No browser is launched.
 * Workspace DELETE deliberately emits no WS shortcut: the initiating UI must
 * clear its own project, sessions, tabs and focus after the HTTP confirmation.
 */
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const REMOVE_PROJECT = 'remove-project'
const KEEP_PROJECT = 'keep-project'
const REMOVE_SESSION_IDS = ['remove-session-one', 'remove-session-two']
const KEEP_SESSION = 'keep-session'
const REMOVE_PROJECT_NAME = 'Alpha remove project'
const KEEP_PROJECT_NAME = 'Beta preserve project'
const KEEP_HISTORY = 'Other project history stays intact: PROJECT-KEEP-917.'
const workspaceDeleteAssert = (condition, message) => { if (!condition) throw new Error(message) }
const workspaceDeleteEqual = (actual, expected, message) => workspaceDeleteAssert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
async function workspaceDeleteUntil(read, message, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out: ${message}`)
}
function workspaceDeleteSeed(single = false) {
  const workspaces = [{ id: REMOVE_PROJECT, name: REMOVE_PROJECT_NAME, path: '/isolated/ive-project-delete/alpha', default_worktree: 0 },
    ...(!single ? [{ id: KEEP_PROJECT, name: KEEP_PROJECT_NAME, path: '/isolated/ive-project-delete/beta', default_worktree: 0 }] : [])]
  const sessions = [
    ...REMOVE_SESSION_IDS.map((id, index) => ({ id, workspace_id: REMOVE_PROJECT, name: `Alpha session ${index + 1}` })),
    ...(!single ? [{ id: KEEP_SESSION, workspace_id: KEEP_PROJECT, name: 'Beta unchanged session' }] : []),
  ].map((item) => ({ ...item, cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], attention: null }))
  return {
    width: 1800, height: 1000, blockNativeConfirm: true,
    settings: { product_tour_version: '2', owner_name: 'Project removal test' }, workspaces, sessions,
    messages: Object.fromEntries(sessions.map((item) => [item.id, [{ id: `saved-${item.id}`, session_id: item.id, role: 'assistant',
      content: item.id === KEEP_SESSION ? KEEP_HISTORY : `History owned by ${item.id}.`, created_at: '2026-01-01T00:00:00Z',
    }]])),
    storage: {
      'ive.operator-desk': { activeWorkspaceId: REMOVE_PROJECT, activeSessionId: REMOVE_SESSION_IDS[0], openTabs: sessions.map((item) => item.id), showHome: false, activeNavGroup: 'work', notifications: [], planWaiting: {} },
      'ive.grid-session-views': Object.fromEntries(sessions.map((item) => [item.id, 'chat'])),
      'cc-gridColumns': '2',
    },
  }
}
const workspaceDeleteGroup = (f, id = REMOVE_PROJECT) => f.page.locator(`.x-sidebar [data-workspace-id="${id}"]`)
const workspaceDeleteSessionRow = (f, id) => f.page.locator(`.x-sidebar [data-session-id="${id}"]`)
const workspaceDeleteCard = (f, id) => f.page.locator(`[data-session-view="${id}"], [data-grid-cell-session="${id}"]`).filter({ visible: true }).first()
const workspaceDeleteDialog = (f) => f.page.getByRole('dialog', { name: 'Remove project?', exact: true })
const workspaceDeleteConfirm = (f) => workspaceDeleteDialog(f).getByRole('button', { name: 'Remove project', exact: true })
const workspaceDeleteWrites = (f) => f.writes.filter((item) => item.method === 'DELETE')
async function workspaceDeleteFixture(env, name, options = {}) {
  const f = await env.createFixture(env.browser, { ...env.options.fixtureOptions, ...workspaceDeleteSeed(Boolean(options.single)), ...options })
  env.fixtures[name] = f
  await workspaceDeleteGroup(f).waitFor({ state: 'visible' })
  for (const sid of REMOVE_SESSION_IDS) await workspaceDeleteSessionRow(f, sid).waitFor({ state: 'visible' })
  await workspaceDeleteCard(f, REMOVE_SESSION_IDS[0]).waitFor({ state: 'visible' })
  return f
}
async function workspaceDeleteClean(f) {
  workspaceDeleteEqual(await f.page.evaluate(() => window.__iveTestNativeConfirmCalls), 0, 'Project removal never calls native window.confirm')
  workspaceDeleteEqual(f.errors.length, 0, `No browser errors: ${f.errors.join('; ')}`)
  workspaceDeleteAssert(!f.unexpected.some((item) => item.method !== 'GET'), `No unsupported writes: ${JSON.stringify(f.unexpected)}`)
}
async function workspaceDeletePicture(env, f, name) {
  if (env.options.screenshotDir) await f.page.screenshot({ path: `${env.options.screenshotDir.replace(/\/$/, '')}/${name}.png`, animations: 'disabled' })
}
async function openWorkspaceDelete(f) {
  await workspaceDeleteGroup(f).hover()
  await workspaceDeleteGroup(f).getByRole('button', { name: 'Delete workspace', exact: true }).click()
  await workspaceDeleteDialog(f).waitFor({ state: 'visible' })
  workspaceDeleteAssert((await workspaceDeleteDialog(f).innerText()).includes(REMOVE_PROJECT_NAME), 'The dialog names the exact selected project')
  await workspaceDeleteClean(f)
}
async function workspaceDeleteUnchanged(f, attempts = 0) {
  workspaceDeleteEqual(f.data.workspaces.length, 2, 'Both projects remain while unconfirmed or rejected')
  workspaceDeleteEqual(f.data.sessions.length, 3, 'All project sessions remain')
  for (const sid of REMOVE_SESSION_IDS) {
    workspaceDeleteAssert(f.data.messages[sid]?.length === 1, 'Selected project histories remain until confirmed success')
    await workspaceDeleteSessionRow(f, sid).waitFor({ state: 'visible' })
  }
  workspaceDeleteEqual(f.data.messages[KEEP_SESSION][0].content, KEEP_HISTORY, 'Other project history is unchanged')
  workspaceDeleteEqual(workspaceDeleteWrites(f).length, attempts, 'No unintended DELETE request occurs')
  await workspaceDeleteClean(f)
}
async function workspaceDeleteRemoved(f, { single = false, attempts = 1 } = {}) {
  await workspaceDeleteDialog(f).waitFor({ state: 'detached' })
  await workspaceDeleteGroup(f).waitFor({ state: 'detached' })
  workspaceDeleteAssert(!f.data.workspaces.some((item) => item.id === REMOVE_PROJECT), 'The selected project is removed from app state')
  for (const sid of REMOVE_SESSION_IDS) {
    await workspaceDeleteSessionRow(f, sid).waitFor({ state: 'detached' })
    await workspaceDeleteUntil(async () => await workspaceDeleteCard(f, sid).count() === 0, 'Removed-project sessions no longer occupy tiles')
    workspaceDeleteAssert(!f.data.sessions.some((item) => item.id === sid), 'Selected-project session is removed')
    workspaceDeleteAssert(!Object.hasOwn(f.data.messages, sid), 'Selected-project transcript is removed from app history')
  }
  workspaceDeleteEqual(workspaceDeleteWrites(f).length, attempts, 'The expected number of explicit attempts reached the API')
  workspaceDeleteAssert(workspaceDeleteWrites(f).every((item) => item.path === `/workspaces/${REMOVE_PROJECT}`), 'Only the selected project is targeted; no separate unrelated deletion occurs')
  await workspaceDeleteUntil(async () => f.page.evaluate(({ workspaceId, sessionIds }) => {
    const desk = JSON.parse(localStorage.getItem('ive.operator-desk') || '{}')
    return desk.activeWorkspaceId !== workspaceId && !sessionIds.includes(desk.activeSessionId) && !(desk.openTabs || []).some((id) => sessionIds.includes(id))
  }, { workspaceId: REMOVE_PROJECT, sessionIds: REMOVE_SESSION_IDS }), 'Persisted project selection, session focus and tabs are reconciled')
  if (single) {
    workspaceDeleteEqual(f.data.workspaces.length, 0, 'No project remains')
    workspaceDeleteEqual(f.data.sessions.length, 0, 'No orphan session remains')
    await f.page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
  } else {
    workspaceDeleteEqual(f.data.workspaces.length, 1, 'The unrelated project remains')
    workspaceDeleteEqual(f.data.workspaces[0].id, KEEP_PROJECT, 'The retained project has the original identity')
    workspaceDeleteEqual(f.data.sessions.length, 1, 'Only the other project session remains')
    workspaceDeleteEqual(f.data.messages[KEEP_SESSION][0].content, KEEP_HISTORY, 'Other project transcript remains intact')
    await workspaceDeleteGroup(f, KEEP_PROJECT).waitFor({ state: 'visible' })
    await workspaceDeleteSessionRow(f, KEEP_SESSION).waitFor({ state: 'visible' })
    // Prove the unrelated project remains usable through a real sidebar click.
    await workspaceDeleteSessionRow(f, KEEP_SESSION).locator('.x-session-card').click()
    await workspaceDeleteCard(f, KEEP_SESSION).getByText(KEEP_HISTORY, { exact: true }).waitFor()
  }
  await workspaceDeleteClean(f)
}
async function workspaceDeleteReload(f, single = false) {
  const loaded = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspaces' && response.status() === 200)
  await f.page.reload()
  await loaded
  if (single) await f.page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
  else await workspaceDeleteSessionRow(f, KEEP_SESSION).waitFor({ state: 'visible' })
  workspaceDeleteEqual(await workspaceDeleteGroup(f).count(), 0, 'Reload does not revive the removed project')
  for (const sid of REMOVE_SESSION_IDS) {
    workspaceDeleteEqual(await workspaceDeleteSessionRow(f, sid).count(), 0, 'Reload does not revive its sidebar sessions')
    workspaceDeleteEqual(await workspaceDeleteCard(f, sid).count(), 0, 'Reload does not revive its Overview tiles')
  }
  await workspaceDeleteClean(f)
}

const workspaceDeleteCases = {
  async 'workspace-cancel-escape'(env) {
    const f = await workspaceDeleteFixture(env, 'workspace-cancel-escape')
    await openWorkspaceDelete(f)
    await workspaceDeleteUnchanged(f)
    await workspaceDeleteDialog(f).getByRole('button', { name: 'Cancel', exact: true }).click()
    await workspaceDeleteDialog(f).waitFor({ state: 'detached' })
    await workspaceDeleteUnchanged(f)
    await openWorkspaceDelete(f)
    await f.page.keyboard.press('Escape')
    await workspaceDeleteDialog(f).waitFor({ state: 'detached' })
    await workspaceDeleteUnchanged(f)
  },
  async 'workspace-remove-and-reload'(env) {
    const f = await workspaceDeleteFixture(env, 'workspace-remove-and-reload')
    await openWorkspaceDelete(f)
    await workspaceDeleteUnchanged(f)
    await workspaceDeletePicture(env, f, 'workspace-removal-confirmation')
    await workspaceDeleteConfirm(f).click()
    await workspaceDeleteRemoved(f)
    await workspaceDeleteReload(f)
    await workspaceDeletePicture(env, f, 'workspace-removed-other-history-preserved')
  },
  async 'workspace-failure-retry'(env) {
    const f = await workspaceDeleteFixture(env, 'workspace-failure-retry', { failWorkspaceDelete: true })
    await openWorkspaceDelete(f)
    await workspaceDeleteConfirm(f).click()
    await workspaceDeleteDialog(f).getByRole('alert').filter({ hasText: 'Test: project removal unavailable' }).waitFor()
    await workspaceDeleteUnchanged(f, 1)
    workspaceDeleteAssert(await workspaceDeleteConfirm(f).isEnabled(), 'Failed removal can be retried in the same dialog')
    await workspaceDeletePicture(env, f, 'workspace-removal-failure-retry')
    f.controls.failWorkspaceDelete = false
    await workspaceDeleteConfirm(f).click()
    await workspaceDeleteRemoved(f, { attempts: 2 })
  },
  async 'workspace-dedup'(env) {
    const f = await workspaceDeleteFixture(env, 'workspace-dedup', { holdWorkspaceDelete: true })
    try {
      await openWorkspaceDelete(f)
      await workspaceDeleteConfirm(f).dblclick()
      await workspaceDeleteUntil(() => workspaceDeleteWrites(f).length > 0, 'A single confirmed request is held in flight')
      await f.page.keyboard.press('Enter')
      await workspaceDeleteDialog(f).getAttribute('role')
      await workspaceDeleteUnchanged(f, 1)
      f.controls.releaseWorkspaceDeletes()
      await workspaceDeleteRemoved(f)
    } finally { f.controls.releaseWorkspaceDeletes() }
  },
  async 'last-workspace-home'(env) {
    const f = await workspaceDeleteFixture(env, 'last-workspace-home', { single: true })
    await openWorkspaceDelete(f)
    workspaceDeleteEqual(workspaceDeleteWrites(f).length, 0, 'The last project still requires explicit confirmation')
    await workspaceDeleteConfirm(f).click()
    await workspaceDeleteRemoved(f, { single: true })
    await workspaceDeleteReload(f, true)
    await workspaceDeletePicture(env, f, 'last-workspace-removed-home')
  },
  async 'workspace-deleted-elsewhere'(env) {
    const f = await workspaceDeleteFixture(env, 'workspace-deleted-elsewhere')
    workspaceDeleteEqual(await workspaceDeleteDialog(f).count(), 0, 'No local confirmation is open')
    // APIRequestContext (page.request) bypasses context.route, so use browser
    // fetch to reach this fixture's isolated HTTP interception. This bypasses
    // app deletion actions and simulates another client's confirmed write.
    const response = await f.page.evaluate(async (id) => {
      const result = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return { status: result.status, body: await result.json() }
    }, REMOVE_PROJECT)
    workspaceDeleteEqual(response.status, 200, 'The simulated remote deletion is confirmed')
    workspaceDeleteEqual(response.body.ok, true, 'The remote client receives success')
    // HTTP alone must not invoke the initiating UI's local cleanup: this case
    // specifically verifies cleanup through the backend's broadcast protocol.
    await workspaceDeleteGroup(f).waitFor({ state: 'visible' })
    workspaceDeleteEqual(await workspaceDeleteDialog(f).count(), 0, 'The remote write opens no local confirmation')
    f.controls.broadcast({ type: 'workspace_deleted', workspace_id: REMOVE_PROJECT, session_ids: [...REMOVE_SESSION_IDS] })
    await workspaceDeleteRemoved(f)
    workspaceDeleteEqual(await workspaceDeleteDialog(f).count(), 0, 'The deletion broadcast opens no confirmation')
    await workspaceDeleteReload(f)
    await workspaceDeletePicture(env, f, 'workspace-deleted-elsewhere')
  },
}

export const workspaceDeleteCheckNames = Object.freeze(Object.keys(workspaceDeleteCases))
export async function runWorkspaceDeleteChecks(browser, createFixture = createTourFixture, options = {}) {
  const fixtures = options.fixtures || {}, results = []
  const env = { browser, createFixture, options, fixtures }
  try {
    for (const name of options.cases || workspaceDeleteCheckNames) {
      workspaceDeleteAssert(typeof workspaceDeleteCases[name] === 'function', `Unknown workspace-delete check: ${name}`)
      const started = Date.now()
      await options.reporter?.({ name, status: 'running' })
      try {
        await workspaceDeleteCases[name](env)
        const result = { name, status: 'passed', elapsedMs: Date.now() - started }
        results.push(result); await options.reporter?.(result)
      } catch (error) {
        const result = { name, status: 'failed', elapsedMs: Date.now() - started, error: error.message }
        results.push(result); await options.reporter?.(result)
        if (!options.continueOnError) { error.results = results; throw error }
      }
    }
    return { results, fixtures, metadata: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, {
      workspaceIds: f.data.workspaces.map((item) => item.id), sessionIds: f.data.sessions.map((item) => item.id), transcriptIds: Object.keys(f.data.messages),
      writes: f.writes, errors: [...f.errors], unexpected: [...f.unexpected],
    }])) }
  } finally {
    if (!options.keepOpen) await Promise.all(Object.values(fixtures).map((f) => f.context.close()))
  }
}
