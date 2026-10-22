import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

test('requests stay visible across selected tabs, Home, refresh and terminal fallback', async (t) => {
  const sent = [], errors = []
  // A real socket exercises Safari's actual WebSocket event handling as well
  // as React StrictMode cleanup; no running IVE sessions are contacted.
  const mock = spawn(fileURLToPath(new URL('../../.venv/bin/python', import.meta.url)), ['-u', '-c', `
import asyncio, json
from aiohttp import web
sockets=set()
async def ws(request):
    socket=web.WebSocketResponse()
    await socket.prepare(request)
    sockets.add(socket)
    try:
        async for event in socket:
            if event.type == web.WSMsgType.TEXT:
                print(event.data, flush=True)
    finally:
        sockets.discard(socket)
    return socket
async def emit(request):
    data=await request.json()
    for socket in list(sockets):
        await socket.send_json(data)
    return web.json_response({'ok':True})
async def main():
    app=web.Application()
    app.router.add_get('/ws', ws)
    app.router.add_post('/emit', emit)
    runner=web.AppRunner(app)
    await runner.setup()
    site=web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    print(json.dumps({'port':site._server.sockets[0].getsockname()[1]}),flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
`], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => mock.kill())
  const lines = createInterface({ input: mock.stdout })
  const port = await new Promise((resolve, reject) => {
    mock.on('error', reject)
    lines.on('line', (line) => { const data = JSON.parse(line); if (data.port) resolve(data.port); else sent.push(data) })
  })
  const mockUrl = `http://127.0.0.1:${port}`
  const emit = async (data) => { await fetch(`${mockUrl}/emit`, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }) }
  const cache = await mkdtemp(join(tmpdir(), 'ive-attention-qa-'))
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'), server: { host: '127.0.0.1', port: 5192, strictPort: false, open: false, proxy: { '/ws': { target: mockUrl, ws: true } } }, logLevel: 'error' })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { localStorage.setItem('cc-pwa-install-dismissed-v1', '1'); localStorage.setItem('ive_client_name', 'Attention test'); localStorage.setItem('cc-soundEnabled', '0') })
  const workspace = { id: 'project', name: 'Customer website', path: '/isolated/website' }
  let sessions = [{ id: 'website', name: 'Website', workspace_id: workspace.id, session_type: 'worker', cli_type: 'claude', status: 'idle', pty_alive: true, model: 'sonnet', plan_model: 'opus', execute_model: 'sonnet' }]
  let output = '❯\nauto mode on', tasks = []
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4)
    let value = []
    if (path === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Attention test' }
    else if (path === '/workspaces') value = [workspace]
    else if (path === '/sessions') value = sessions
    else if (path === '/sessions/website') value = sessions[0]
    else if (path === '/sessions/website/output') value = { text: output }
    else if (path === '/tasks') value = tasks
    else if (path.startsWith('/settings/')) value = { value: path.endsWith('/product_tour_version') ? '2' : 'attention-test' }
    else if (path === '/settings' || path === '/cli-info/features' || path.endsWith('/brainstormer')) value = {}
    else if (path === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (path.endsWith('/files')) value = { items: [] }
    else if (path === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [] }
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  await page.waitForFunction(async () => {
    const store = (await import('/src/state/store.js')).default.getState()
    return !!store.sessions.website && store.connected && store.ws?.readyState === 1
  })
  await page.evaluate(async () => {
    const store = (await import('/src/state/store.js')).default
    store.setState({ activeSessionId: 'website', showHome: true })
  })
  await emit({ type: 'permission_event', phase: 'request', session_id: 'website', tool_name: 'Bash' })
  const bar = page.getByRole('region', { name: 'Needs your attention' })
  await bar.getByText('Permission needed', { exact: true }).waitFor()
  await bar.getByText('Review the Bash request.').waitFor()
  assert.equal(await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().sessions.website.status), 'waiting')
  await page.screenshot({ path: '/tmp/ive-attention-home.png' })
  await bar.getByRole('button', { name: 'Review', exact: true }).click()
  await page.waitForFunction(async () => !(await import('/src/state/store.js')).default.getState().showHome)
  assert(await bar.isVisible(), 'Opening a request must not dismiss it')
  await page.getByText('Execution model', { exact: true }).waitFor()
  await page.screenshot({ path: '/tmp/ive-attention-session.png' })
  await emit({ type: 'session_state', session_id: 'website', state: 'working' })
  await bar.waitFor({ state: 'hidden' })

  // An ordinary question must also appear when the session is already selected.
  await emit({ type: 'session_state', session_id: 'website', state: 'prompting', message: 'Which project should I change?' })
  await bar.getByText('Which project should I change?', { exact: true }).waitFor()
  await emit({ type: 'session_state', session_id: 'website', state: 'idle' })
  await bar.waitFor({ state: 'hidden' })

  // Backend snapshot restores an outstanding request after page reload.
  sessions = [{ ...sessions[0], status: 'waiting', agentState: 'prompting', attention: { kind: 'permission', title: 'Permission needed', message: 'Review the saved request.', source: 'hook' } }]
  await page.reload()
  await bar.getByText('Review the saved request.').waitFor()
  await page.waitForFunction(async () => (await import('/src/state/store.js')).default.getState().connected)
  sessions = [{ ...sessions[0], status: 'idle', agentState: 'idle', attention: null }]
  await emit({ type: 'session_state', session_id: 'website', state: 'idle' })
  await bar.waitFor({ state: 'hidden' })

  // Legacy running server: reconstruct only an outstanding terminal dialog.
  delete sessions[0].attention
  output = "[Safety Gate] provider 'gemini_api' is not configured: missing API key\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel · Tab to amend"
  await bar.getByText('Safety check needs setup').waitFor()
  await bar.getByRole('button', { name: 'Safety settings' }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/ive-attention-mobile.png' })
  const box = await bar.boundingBox()
  assert(box.x >= 0 && box.width <= 390)
  const reviewBox = await bar.getByRole('button', { name: 'Review', exact: true }).boundingBox()
  assert(reviewBox.x + reviewBox.width <= 390 && reviewBox.y + reviewBox.height <= 844)
  output += '\nInterrupted · What should Claude do instead?\n❯\nauto mode on'
  await bar.waitFor({ state: 'hidden' })
  tasks = [{ id: 'review-task', title: 'Checkout flow', status: 'review', workspace_id: workspace.id }]
  await bar.getByText('Result ready for review').waitFor({ timeout: 20000 })
  assert.deepEqual(errors, [])
  assert.equal(sent.some((event) => ['input', 'write', 'command'].includes(event.action)), false, 'Attention never approves or sends a terminal command')
})
