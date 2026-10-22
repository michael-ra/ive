import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

async function expectEventually(check, message) {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  assert(check(), message)
}

test('Side chat stays independent, supports multiple projects and recovers its conversation', async (t) => {
  const cache = await mkdtemp(join(tmpdir(), 'ive-sidechat-qa-'))
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'),
    server: { host: '127.0.0.1', port: 5191, strictPort: false, open: false }, logLevel: 'error',
  })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Side chat test')
    localStorage.setItem('cc-soundEnabled', '0')
  })
  await context.routeWebSocket('**/ws', (socket) => socket.onMessage(() => {}))
  const workspaces = [
    { id: 'frontend', name: 'Customer website', path: '/isolated/website' },
    { id: 'backend', name: 'Billing service', path: '/isolated/billing' },
  ]
  const jobs = new Map(), questions = [], writes = [], errors = []
  await context.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(4)
    let value = []
    if (path === '/sidechat/options') value = {
      providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [{ id: 'sonnet', label: 'Sonnet' }] },
        { id: 'codex', label: 'Codex CLI', installed: true, models: [{ id: 'test-model', label: 'Test model' }] }], accounts: [],
    }
    else if (path === '/sidechat/ask') {
      const data = request.postDataJSON()
      if (!jobs.has(data.request_id)) {
        questions.push(data)
        jobs.set(data.request_id, { id: data.request_id, status: 'running', answer: '', error: '', cli_type: data.cli_type, model: data.model })
      }
      value = jobs.get(data.request_id)
    } else if (path.startsWith('/sidechat/requests/')) {
      value = jobs.get(path.split('/').at(-1))
      if (!value) return route.fulfill({ status: 404, json: { error: 'Answer no longer available' } })
      if (request.method() === 'DELETE') value.status = 'cancelled'
    } else if (request.method() !== 'GET') {
      writes.push(path)
      return route.fulfill({ status: 409, json: { error: 'Unexpected change to the main workspace' } })
    } else if (path === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Side chat test' }
    else if (path === '/workspaces') value = workspaces
    else if (path === '/project-search') value = { matches: workspaces.map((item) => ({ ...item, kind: 'Project' })) }
    else if (path.startsWith('/settings/')) value = { value: path.endsWith('/product_tour_version') ? '2' : 'sidechat-test' }
    else if (path === '/settings' || path === '/cli-info/features' || path.endsWith('/brainstormer')) value = {}
    else if (path === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (path.endsWith('/files')) value = { items: [] }
    else if (path === '/overview') value = { workspace_total: 2, detail_limit: 5, workspaces: [] }
    await route.fulfill({ json: value || {} })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(error.message))
  const url = server.resolvedUrls.local[0]
  await page.goto(url)
  const chatToggle = page.getByRole('button', { name: 'Chat with Claude', exact: true }).first()
  await chatToggle.click()
  const panel = page.getByRole('complementary', { name: 'Side chat' })
  await panel.getByRole('button', { name: /Claude Code/ }).waitFor()
  const mainBox = await page.locator('main').boundingBox(), panelBox = await panel.boundingBox()
  assert(mainBox.x + mainBox.width <= panelBox.x + 1, 'Desktop chat is beside the main workspace')
  const input = panel.getByLabel('Ask a side question')
  const initialHeight = (await input.boundingBox()).height
  const longPrompt = Array.from({ length: 12 }, (_, index) => `Requirement ${index + 1}: improve this prompt.`).join('\n')
  await input.fill(longPrompt)
  assert((await input.boundingBox()).height > initialHeight + 40, 'Long prompts grow the input')
  await input.press('Shift+Enter')
  assert.equal(await input.inputValue(), longPrompt + '\n', 'Shift+Enter edits without sending')
  assert.equal(questions.length, 0)
  await panel.getByRole('button', { name: 'Close side chat' }).click()
  await chatToggle.click()
  assert.equal(await input.inputValue(), longPrompt + '\n', 'Closing preserves an unsent prompt')
  await input.fill('')

  await page.evaluate(async () => {
    const { default: store } = await import('/src/state/store.js')
    // Toasts only show for sessions the store knows (stale ids are hidden).
    store.getState().loadSessions([{ id: 'unrelated-session', workspace_id: 'frontend', name: 'Main session', cli_type: 'claude', status: 'idle', pty_alive: false }])
    store.getState().addNotification({ type: 'auth_failed', sessionId: 'unrelated-session', cli: 'claude', message: 'A main session needs login.' })
  })
  await page.getByText('A main session needs login.').waitFor()
  const toastBox = await page.locator('.ive-toasts').boundingBox()
  assert(toastBox.x + toastBox.width <= panelBox.x, 'Main-session errors do not cover side chat')
  await panel.getByRole('button', { name: 'Close side chat' }).click({ trial: true })
  await panel.getByRole('button', { name: /Claude Code/ }).click({ trial: true })
  await page.screenshot({ path: '/tmp/ive-sidechat-desktop.png' })

  await panel.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('searchbox', { name: 'What would you like to work on?' }).fill('project')
  await page.getByRole('button', { name: /Customer website Project/ }).click()
  await panel.getByRole('button', { name: 'Add project' }).click()
  await page.getByRole('searchbox', { name: 'What would you like to work on?' }).fill('project')
  await page.getByRole('button', { name: /Billing service Project/ }).click()
  await panel.getByRole('button', { name: /Claude Code/ }).click()
  await panel.getByLabel('Side chat agent').selectOption('codex')
  await panel.getByLabel('Side chat model').selectOption('test-model')
  await panel.getByLabel('Ask a side question').fill('How do these two projects relate?')
  await panel.getByRole('button', { name: 'Send side question' }).click()
  await panel.getByRole('status').waitFor()
  await panel.getByRole('button', { name: 'Close side chat' }).click()
  assert.equal(await panel.isVisible(), false)
  await chatToggle.click()
  await panel.getByRole('status').waitFor()
  assert.equal(questions.length, 1)
  assert.deepEqual(questions[0].project_paths, workspaces.map((item) => item.path))
  assert.equal(questions[0].cli_type, 'codex')
  jobs.get(questions[0].request_id).status = 'completed'
  jobs.get(questions[0].request_id).answer = 'The website and billing service can be discussed together.'
  await panel.getByText('The website and billing service can be discussed together.').waitFor()
  await page.screenshot({ path: '/tmp/ive-sidechat-conversation.png' })

  await panel.getByLabel('Ask a side question').fill('What about deployment?')
  await panel.getByRole('button', { name: 'Send side question' }).click()
  await panel.getByRole('status').waitFor()
  await panel.getByRole('button', { name: 'Stop side chat answer' }).click()
  await panel.getByText('Answer stopped. You can retry or ask a new question.').waitFor()
  assert.equal(questions[1].messages.length, 3, 'Follow-up contains only side chat history')
  await page.reload()
  await chatToggle.click()
  await panel.getByText('The website and billing service can be discussed together.').waitFor()
  await panel.getByText('Answer stopped. You can retry or ask a new question.').waitFor()

  await input.fill('Please improve this prompt.')
  await input.press('Enter')
  await panel.getByRole('status').waitFor()
  await input.fill('My next draft stays here.')
  jobs.delete(questions.at(-1).request_id)
  await panel.getByText('This answer is no longer available. Retry or edit your question.').waitFor()
  assert.equal(await panel.getByRole('status').count(), 0, 'An expired request releases the composer')
  assert.equal(await input.inputValue(), 'My next draft stays here.', 'A failed answer does not overwrite the next draft')
  await panel.getByRole('button', { name: 'Edit question', exact: true }).click()
  assert.equal(await input.inputValue(), 'Please improve this prompt.\n\nMy next draft stays here.', 'Edit question is offered with a draft and keeps it below the question')
  await input.fill('Please improve this prompt with examples.')
  await input.press('Enter')
  await panel.getByRole('status').waitFor()
  assert.equal(questions.at(-1).messages.at(-1).content, 'Please improve this prompt with examples.')
  assert(!questions.at(-1).messages.some((message) => message.content === 'Please improve this prompt.'), 'Editing replaces the failed question')
  jobs.get(questions.at(-1).request_id).status = 'completed'
  jobs.get(questions.at(-1).request_id).answer = 'Here is the improved prompt.'
  await panel.getByText('Here is the improved prompt.').waitFor()

  // Follow-ups typed while an answer runs wait in a queue and go out when it finishes.
  await input.fill('Shorter, please.')
  await input.press('Enter')
  await panel.getByRole('status').waitFor()
  const asked = questions.length
  await input.fill('And in German.')
  await input.press('Enter')
  assert.equal(await input.inputValue(), '', 'Queuing clears the composer')
  await panel.getByText('And in German.', { exact: true }).waitFor()
  await panel.getByText('Sends when the answer is done', { exact: true }).waitFor()
  assert(await panel.getByRole('button', { name: 'Stop side chat answer' }).isVisible(), 'Stop stays reachable while queuing')
  await page.screenshot({ path: '/tmp/ive-sidechat-queue.png' })
  assert.equal(questions.length, asked, 'A queued follow-up is not sent mid-answer')
  jobs.get(questions.at(-1).request_id).status = 'completed'
  jobs.get(questions.at(-1).request_id).answer = 'Short version.'
  await panel.getByText('Short version.').waitFor()
  await expectEventually(() => questions.length === asked + 1, 'The queue is sent after the answer')
  assert.equal(questions.at(-1).messages.at(-1).content, 'And in German.')
  assert.equal(await panel.locator('.is-queued').count(), 0, 'The sent follow-up leaves the queue')
  await input.fill('Never mind.')
  await input.press('Enter')
  await panel.getByRole('button', { name: 'Remove queued message' }).click()
  assert.equal(await panel.locator('.is-queued').count(), 0)
  await panel.getByRole('button', { name: 'Stop side chat answer' }).click()
  await panel.getByText('Answer stopped. You can retry or ask a new question.').waitFor()
  assert.equal(questions.length, asked + 1, 'A removed follow-up is never sent')
  await panel.getByRole('button', { name: 'Retry answer' }).click()
  await panel.getByRole('status').waitFor()
  await input.fill('Queued before a stop.')
  await input.press('Enter')
  await panel.getByRole('button', { name: 'Stop side chat answer' }).click()
  await panel.getByText('Answer stopped. You can retry or ask a new question.').waitFor()
  const beforeEdit = questions.length
  await panel.getByRole('button', { name: 'Edit question', exact: true }).click()
  assert.equal(await input.inputValue(), 'And in German.')
  await page.waitForTimeout(300)
  assert.equal(questions.length, beforeEdit, 'Editing a stopped question does not flush the queue')
  assert.equal(await panel.locator('.is-queued').count(), 1, 'The queue waits until you decide')
  await panel.getByRole('button', { name: 'Remove queued message' }).click()
  await input.fill('')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: '/tmp/ive-sidechat-dark.png' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })

  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByLabel('Ask a side question').waitFor()
  const mobileBox = await panel.boundingBox()
  assert(mobileBox.x >= 0 && mobileBox.width <= 390 && mobileBox.height <= 844)
  assert(await panel.getByRole('button', { name: 'Close side chat' }).isVisible())
  const sendBox = await panel.getByRole('button', { name: 'Send side question' }).boundingBox()
  assert(sendBox.y + sendBox.height <= 844, 'Mobile composer remains visible')
  await page.screenshot({ path: '/tmp/ive-sidechat-mobile.png' })
  await page.setViewportSize({ width: 390, height: 420 })
  await input.fill(longPrompt)
  await panel.getByRole('button', { name: /Codex CLI/ }).click()
  await panel.getByLabel('Side chat agent').waitFor()
  const compactSend = await panel.getByRole('button', { name: 'Send side question' }).boundingBox()
  assert(compactSend.y + compactSend.height <= 420, 'Composer remains reachable with settings and a small viewport')
  await panel.getByRole('button', { name: 'Send side question' }).click({ trial: true })
  assert.deepEqual(writes, [], 'No main session or workspace was modified')
  assert.deepEqual(errors, [])
})
