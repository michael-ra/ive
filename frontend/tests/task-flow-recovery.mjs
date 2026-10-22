// Browser regressions with an isolated Vite server and fully mocked transports.
// No task, CLI session, or project on the user's backend is modified.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

test('Task flow recovers slow reads and uncertain execution responses', async (t) => {
  const testDir = await mkdtemp(join(tmpdir(), 'ive-recovery-vite-'))
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    cacheDir: join(testDir, 'node_modules', '.vite'),
    server: { host: '127.0.0.1', port: 5187, strictPort: false, open: false },
    logLevel: 'error',
  })
  t.after(async () => { await server.close(); await rm(testDir, { recursive: true, force: true }) })
  await server.listen()
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 } })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Recovery test')
    localStorage.setItem('cc-soundEnabled', '0')
  })
  await context.routeWebSocket('**/ws', (socket) => socket.onMessage(() => {}))
  const workspace = { id: 'ws', name: 'Test project', path: '/isolated/test' }
  const requestId = '52be5d17-6b4c-4bf6-9803-c671a17fc102'
  const task = { id: 't0', title: 'Recovery review task', description: 'Keep this request', workspace_id: 'ws', status: 'planning', pipeline_stage: 'awaiting_plan_approval' }
  const newest = {
    id: 'r1', task_id: task.id, status: 'paused', created_at: '2026-09-10 15:00:00',
    variables: { request_id: requestId }, current_stages: ['approval'],
    stage_history: {
      plan: { status: 'completed', output_summary: '__pipeline_result:pass:Reviewable plan' },
      approval: { status: 'running', output_summary: 'waiting_for_plan_approval: resume' },
    },
  }
  const pending = { requestId, taskId: task.id, workspaceId: 'ws', goal: task.title, criteria: '', context: '', submitted: true, maxIterations: 3 }
  let runs = [newest]
  let slowReads = false
  let holdReads = false
  const heldReads = []
  const writes = [], errors = []
  await context.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(4)
    if (request.method() !== 'GET') {
      writes.push(path)
      return route.fulfill({ status: 409, json: { error: 'Unexpected write in recovery test' } })
    }
    let value = []
    if (path === '/whoami') value = { actor_kind: 'localhost', mode: 'view', label: 'Recovery test' }
    else if (path.startsWith('/settings/')) value = { value: path.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'recovery-test' }
    else if (path === '/settings' || path === '/cli-info/features' || path.endsWith('/brainstormer')) value = {}
    else if (path === '/workspaces') value = [workspace]
    else if (path === '/tasks') value = [task]
    else if (path === `/tasks/${task.id}`) {
      if (holdReads) await new Promise((resolve) => heldReads.push(resolve))
      if (slowReads) await new Promise((resolve) => setTimeout(resolve, 4400))
      value = task
    } else if (path === '/pipeline-runs') value = runs
    else if (path === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (path.endsWith('/files')) value = { items: [] }
    else if (path === '/overview') value = {
      workspace_total: 1, detail_limit: 5, workspaces: [{
        ...workspace, sessions: { total: 0, by_status: {} }, blocked_sessions: { total: 0, items: [] },
        test_queue: { depth: 0, running_total: 0, running: null },
        open_tasks: { total: 1, items: [task] }, active_research: { total: 0, items: [] },
      }],
    }
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(error.message))
  const url = server.resolvedUrls.local[0]
  const taskRow = page.locator('.ive-task-inbox').getByRole('button', { name: /Recovery review task/ })
  const savePending = (draft) => page.evaluate((value) => localStorage.setItem('ive-task-draft.v1', JSON.stringify(value)), draft)

  await t.test('a successful read slower than the polling interval still updates the UI', async () => {
    slowReads = true
    await page.goto(url)
    await taskRow.click()
    await page.getByRole('button', { name: 'Approve plan & start', exact: true }).waitFor({ timeout: 6500 })
    slowReads = false
  })
  await t.test('a stalled read times out and can be retried', async () => {
    holdReads = true
    await page.reload()
    await taskRow.click()
    await page.getByRole('alert').filter({ hasText: 'did not respond within 15 seconds' }).waitFor({ timeout: 18000 })
    holdReads = false
    heldReads.splice(0).forEach((release) => release())
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('button', { name: 'Approve plan & start', exact: true }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
  })
  await t.test('a persisted run reconciles a draft whose execute response was lost', async () => {
    await savePending(pending)
    await page.reload()
    await page.getByRole('button', { name: /Continue setup/ }).click()
    await page.getByRole('button', { name: 'Approve plan & start' }).waitFor()
    await page.waitForFunction(() => localStorage.getItem('ive-task-draft.v1') === null)
  })
  await t.test('reconciliation never removes an unrelated pending request', async () => {
    const other = { ...pending, requestId: '8c84bb6e-d72d-40d0-8f8d-62b1d36a063b' }
    await savePending(other)
    await page.reload()
    await taskRow.click()
    await page.getByRole('button', { name: 'Approve plan & start' }).waitFor()
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ive-task-draft.v1')).requestId), other.requestId)
    await page.evaluate(() => localStorage.removeItem('ive-task-draft.v1'))
  })
  await t.test('runs created in the same second retain server order in the task list', async () => {
    runs = [newest, { ...newest, id: 'r0', status: 'cancelled' }]
    await page.reload()
    await taskRow.waitFor()
    assert.match(await taskRow.innerText(), /Approve the plan/)
  })
  await t.test('retrying a plan replacement does not reset an already running task', async () => {
    const previous = { ...newest, id: 'r0', status: 'cancelled', variables: {} }
    runs = [previous]
    await savePending({ ...pending, previousRunId: previous.id })
    await page.reload()
    await taskRow.click()
    await page.getByRole('button', { name: 'Prepare a new plan' }).waitFor()
    // The server has advanced since the last read, and retained the request key.
    runs = [{ ...newest, status: 'running', current_stages: ['implement'] }, previous]
    task.status = 'in_progress'
    await page.getByRole('button', { name: 'Prepare a new plan' }).click()
    await page.getByRole('heading', { name: 'Working', exact: true }).waitFor()
    await page.waitForFunction(() => localStorage.getItem('ive-task-draft.v1') === null)
    assert.deepEqual(writes, [])
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
})
