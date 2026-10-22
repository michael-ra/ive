/**
 * Built-frontend fixture for a browser supplied by the Playwright plugin.
 * Never launches a browser, starts a backend, or writes project files.
 *
 * const f = await createTourFixture(browser)
 * // Drive the real UI. Mock work stays pending until explicitly released:
 * f.controls.reply(sessionId, 'Antwort aus dem Testtransport')
 * f.controls.planReady(runId)       // then click Approve plan & start
 * f.controls.checking(runId)
 * f.controls.failCheck(runId)       // real API state: correction cycle
 * f.controls.checking(runId)
 * f.controls.passCheck(runId)       // then inspect changes and accept in UI
 * await f.context.close()
 *
 * TaskFlow observes transitions on its normal 3.5 s API polling interval.
 * Chat uses normal message cursors plus session_idle WS refresh. No tour
 * events, store imports, DOM modifications, or optimistic completions occur.
 */
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ORIGIN = 'http://ive-guide.test'
const DEFAULT_PROJECT = Object.freeze({
  name: 'Tour practice', path: '/isolated/ive-tour/practice', kind: 'git repository',
  description: 'Isolated test transport: a project with documented start and test commands.',
})
const clone = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const passed = (text) => ({ status: 'completed', output_summary: `__pipeline_result:pass:${text}`, completed_at: now() })

export async function createTourFixture(browser, options = {}) {
  if (!browser?.newContext) throw new TypeError('Pass the existing Playwright browser; this fixture never launches one.')
  const origin = options.origin || DEFAULT_ORIGIN
  if (new URL(origin).hostname !== 'ive-guide.test') throw new Error('Fixture origin must stay on ive-guide.test.')
  const dist = resolve(options.dist || fileURLToPath(new URL('../dist/', import.meta.url)))
  // Fail before opening a context when the app has not been built.
  await readFile(resolve(dist, 'index.html'))
  const cliFeatures = options.cliFeatures || JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
  const project = { ...DEFAULT_PROJECT, ...options.project }
  const context = await browser.newContext({
    viewport: options.viewport || { width: options.width || 1440, height: options.height || 1000 },
    reducedMotion: 'reduce', serviceWorkers: 'block', deviceScaleFactor: 1,
    // Phone emulation: touch input and the mobile viewport meta tag.
    ...(options.touch ? { hasTouch: true, isMobile: options.isMobile ?? true } : {}),
  })
  const writes = [], reads = [], errors = [], unexpected = [], sockets = new Set(), timers = new Set()
  const data = {
    settings: { ...(options.settings || {}) }, project,
    workspaces: clone(options.workspaces || []), sessions: clone(options.sessions || []),
    tasks: clone(options.tasks || []), runs: clone(options.runs || []), pipelines: clone(options.pipelines || []),
    messages: clone(options.messages || {}), pty: [], gridTemplates: clone(options.gridTemplates || []),
    diff: options.diff || '', stagedDiff: options.stagedDiff || '',
    guidelines: clone(options.guidelines || [{ id: 'tour-guideline', name: 'Read-only analysis', content: 'Explain source files and commands. Do not change project files.' }]),
  }
  let sequence = 0, closed = false
  const archiveReleases = new Set()
  const deleteReleases = new Set()
  const workspaceDeleteReleases = new Set()
  const id = (kind) => `tour-${kind}-${++sequence}`
  const required = (rows, key, kind) => {
    const row = key ? rows.find((item) => item.id === key) : rows.at(-1)
    if (!row) throw new Error(`No fixture ${kind}: ${key || '(none created)'}`)
    return row
  }
  const session = (key) => required(data.sessions, key, 'session')
  const run = (key) => required(data.runs, key, 'run')
  const taskFor = (item) => required(data.tasks, item.task_id, 'task')
  const broadcast = (event) => {
    if (closed) return
    for (const socket of sockets) {
      try { socket.send(JSON.stringify(event)) } catch { sockets.delete(socket) }
    }
  }
  const notifyRun = (item) => {
    item.updated_at = now()
    broadcast({ type: 'pipeline_run_update', run: item })
    broadcast({ type: 'task_update', task: taskFor(item) })
    return clone(item)
  }
  const schedule = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!closed) fn() }, Math.max(0, delay))
    timers.add(timer)
    return timer
  }
  const appendMessage = (sid, role, content, extra = {}) => {
    session(sid)
    const message = { id: id('message'), session_id: sid, role, content, created_at: now(), ...extra }
    ;(data.messages[sid] ||= []).push(message)
    return clone(message)
  }
  const controls = {
    emit(event) { broadcast(event) },
    failSave: Boolean(options.failSave), failInput: false, failExecute: false, failAccept: false, failChanges: false,
    failArchive: Boolean(options.failArchive), holdArchive: Boolean(options.holdArchive), archiveDelayMs: options.archiveDelayMs || 0,
    releaseArchives() { controls.holdArchive = false; for (const release of archiveReleases) release(); archiveReleases.clear() },
    failDelete: Boolean(options.failDelete), holdDelete: Boolean(options.holdDelete), deleteDelayMs: options.deleteDelayMs || 0,
    releaseDeletes() { controls.holdDelete = false; for (const release of deleteReleases) release(); deleteReleases.clear() },
    failWorkspaceDelete: Boolean(options.failWorkspaceDelete), holdWorkspaceDelete: Boolean(options.holdWorkspaceDelete),
    releaseWorkspaceDeletes() { controls.holdWorkspaceDelete = false; for (const release of workspaceDeleteReleases) release(); workspaceDeleteReleases.clear() },
    autoReply: options.autoReply ?? false, replyDelayMs: options.replyDelayMs ?? 600,
    autoPlan: options.autoPlan ?? false, planDelayMs: options.planDelayMs ?? 600,
    latestSession: () => clone(session()), latestRun: () => clone(run()),
    latestTask: () => clone(required(data.tasks, null, 'task')),
    setSessionStatus(sid, status, extra = {}) {
      const item = session(sid)
      Object.assign(item, { status, agentState: status === 'running' ? 'working' : status === 'waiting' ? 'prompting' : 'idle' }, extra)
      broadcast({ type: 'session_update', session_id: item.id, session: item })
      broadcast({ type: 'status', session_id: item.id, status: item.status, pty_alive: item.pty_alive })
      return clone(item)
    },
    reply(sid, text = 'Dieses Testprojekt startet mit `npm run dev`; `npm test` prüft seine Funktion. Quelle: package.json. Ich habe keine Dateien geändert.', { transport = 'ws', delayMs = 0, ...extra } = {}) {
      const target = session(sid).id
      const deliver = () => {
        const message = appendMessage(target, 'assistant', text, extra)
        // API-only mode deliberately withholds WS signals; normal chat polling
        // must discover the persisted assistant row without an injected event.
        if (transport === 'api') Object.assign(session(target), { status: 'idle', agentState: 'idle' })
        else {
          controls.setSessionStatus(target, 'idle')
          broadcast({ type: 'session_idle', session_id: target })
        }
        return message
      }
      return delayMs > 0 ? schedule(deliver, delayMs) : deliver()
    },
    addMessage: appendMessage,
    setRun(rid, patch, taskPatch = {}) {
      const item = run(rid)
      Object.assign(item, clone(patch))
      Object.assign(taskFor(item), clone(taskPatch))
      return notifyRun(item)
    },
    planReady(rid) {
      const item = run(rid)
      if (item.status !== 'running') throw new Error('Only a running plan can become ready for approval.')
      Object.assign(item, { status: 'paused', current_stages: ['approval'] })
      item.stage_history.plan = passed('Read README.md and package.json. Explain documented start and test commands. Do not install, publish, or modify project files.')
      item.stage_history.plan_critic = passed('The plan is read-only, bounded, and tied to the requested source evidence.')
      item.stage_history.approval = { status: 'running', output_summary: 'waiting_for_plan_approval: Review the plan before resuming.' }
      Object.assign(taskFor(item), { status: 'planning', pipeline_stage: 'awaiting_plan_approval' })
      return notifyRun(item)
    },
    checking(rid) {
      const item = run(rid)
      if (item.status !== 'running' || !item.stage_history.approval || item.stage_history.approval.status !== 'completed') throw new Error('Approve the plan through the real UI before checking.')
      const correcting = item.current_stages.includes('fix')
      item.stage_history[correcting ? 'fix' : 'implement'] = passed(correcting ? 'Added the missing source reference to the report. Project files remain unchanged.' : 'README.md and package.json document npm run dev and npm test. No project files were changed.')
      item.stage_history.verify = { status: 'running', started_at: now() }
      item.current_stages = ['verify']
      Object.assign(taskFor(item), { status: 'testing', pipeline_stage: 'verify' })
      return notifyRun(item)
    },
    failCheck(rid, text = 'The reported test command is missing its source reference.') {
      const item = run(rid)
      if (item.status !== 'running' || !item.current_stages.includes('verify')) throw new Error('The fixture must be checking before a check can fail.')
      item.stage_history.verify = { status: 'completed', output_summary: `__pipeline_result:fail:${text}`, completed_at: now() }
      if (item.iteration >= item.max_iterations) {
        Object.assign(item, { status: 'max_iterations', current_stages: [], completed_at: now() })
        Object.assign(taskFor(item), { status: 'blocked', pipeline_stage: 'max_iterations' })
      } else {
        item.iteration += 1
        item.current_stages = ['fix']
        item.stage_history.fix = { status: 'running', started_at: now() }
        Object.assign(taskFor(item), { status: 'in_progress', pipeline_stage: 'fix' })
      }
      return notifyRun(item)
    },
    passCheck(rid, text = 'Both commands have a package.json source. No files changed. This fixture scripts the check; it does not run a provider or npm test.') {
      const item = run(rid)
      if (item.status !== 'running' || !item.current_stages.includes('verify')) throw new Error('The fixture must be checking before a check can pass.')
      item.stage_history.verify = passed(text)
      Object.assign(item, { status: 'completed', current_stages: [], completed_at: now() })
      Object.assign(taskFor(item), { status: 'review', pipeline_stage: 'review' })
      return notifyRun(item)
    },
    failRun(rid, status = 'failed') {
      if (!['failed', 'max_iterations', 'cancelled'].includes(status)) throw new Error('Expected a terminal failure state.')
      return controls.setRun(rid, { status, current_stages: [], completed_at: now() }, { status: 'blocked', pipeline_stage: status })
    },
    setChanges(diff = '', staged = '') { data.diff = diff; data.stagedDiff = staged },
    // Useful for reconnect tests; this still sends the application's actual
    // transport protocol, never a guided-tour event.
    broadcast,
  }
  context.on('close', () => { closed = true; controls.releaseArchives(); controls.releaseDeletes(); controls.releaseWorkspaceDeletes(); for (const timer of timers) clearTimeout(timer); timers.clear(); sockets.clear() })
  await context.addInitScript(({ theme, storage, blockNativeConfirm }) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('ive-theme.v2', theme)
    if (blockNativeConfirm) {
      // Match a native WebView with no JavaScript confirmation handler.
      // App-rendered confirmation must work without calling this at all.
      window.__iveTestNativeConfirmCalls = 0
      window.confirm = () => { window.__iveTestNativeConfirmCalls += 1; return false }
    }
    // Only seed missing keys. Reload must preserve real UI tour progress.
    for (const [key, value] of Object.entries(storage)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }, { theme: options.theme || 'light', storage: options.storage || {}, blockNativeConfirm: Boolean(options.blockNativeConfirm) })

  await context.routeWebSocket('**/*', (socket) => {
    sockets.add(socket)
    socket.onClose(() => sockets.delete(socket))
    socket.onMessage((raw) => {
      let request
      try { request = JSON.parse(String(raw)) } catch { return }
      data.pty.push(clone(request))
      const item = data.sessions.find((entry) => entry.id === request.session_id)
      if (item && (request.action === 'start_pty' || (request.action === 'resume_pty' && item.pty_alive))) {
        Object.assign(item, { status: 'idle', agentState: 'idle', pty_alive: true })
        schedule(() => {
          broadcast({ type: 'status', session_id: item.id, status: 'idle', pty_alive: true })
          socket.send(JSON.stringify({ type: 'output', session_id: item.id, data: '\r\nIVE test transport · no provider process\r\n❯ ' }))
        }, 25)
      } else if (request.action === 'stop' && item) controls.setSessionStatus(item.id, 'exited', { pty_alive: false })
    })
  })

  const filtered = (rows, params) => rows.filter((item) => (
    (!params.get('workspace') || item.workspace_id === params.get('workspace'))
    && (!params.get('workspace_id') || item.workspace_id === params.get('workspace_id'))
    && (!params.get('task_id') || item.task_id === params.get('task_id'))
    && (!params.get('pipeline_id') || item.pipeline_id === params.get('pipeline_id'))
    && (!params.get('active') || ['running', 'paused'].includes(item.status))
  ))
  const messageResponse = (sid, params) => {
    const rows = data.messages[sid] || []
    if (!params.has('cursor') && !params.has('before')) return rows
    const cursor = params.get('cursor') || ''
    const parsed = /^tour:(\d+)$/.exec(cursor)
    const start = parsed && Number(parsed[1]) <= rows.length ? Number(parsed[1]) : 0
    return { rows: rows.slice(start), start, updates: [], reset: !parsed, cursor: `tour:${rows.length}`, base: 0, total: rows.length, before: null }
  }
  const emptyLists = new Set(['/accounts', '/templates', '/output-styles', '/mcp-servers', '/prompts', '/skills', '/captures', '/tasks/events', '/test-queue', '/cascades', '/cascade-runs', '/broadcast-groups', '/tab-groups', '/grid-templates', '/research', '/research/schedules', '/history/projects', '/session-rules', '/connectors', '/notifications', '/safety/rules'])

  // Intercept every HTTP request. Unknown external requests are blocked, so
  // even a future app feature cannot reach a real backend from this fixture.
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    if (url.origin !== origin) {
      unexpected.push({ method, url: url.href, reason: 'external request blocked' })
      return route.fulfill({ status: 403, body: 'External request blocked by isolated tour fixture' })
    }
    if (!url.pathname.startsWith('/api/')) {
      const path = resolve(dist, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`)
      if (!path.startsWith(`${dist}${sep}`)) return route.fulfill({ status: 403, body: 'Invalid asset path' })
      try { return await route.fulfill({ path }) }
      catch { return route.fulfill({ status: 404, body: 'Fixture asset not found; build frontend/dist first.' }) }
    }
    const path = url.pathname.slice(4), params = url.searchParams
    let body = null
    try { body = request.postDataJSON() } catch { /* GET or empty body */ }
    const call = { method, path, query: url.search, body: clone(body) }
    ;(method === 'GET' ? reads : writes).push(call)
    const reply = (value, status = 200) => route.fulfill({ status, json: clone(value) })
    const reject = (message, status = 409) => reply({ error: message }, status)
    if (method === 'OPTIONS') return route.fulfill({ status: 204, body: '' })
    if (method !== 'GET') {
      if (options.guest) return reject('A view-only guest cannot write.', 403)
      if (path.startsWith('/settings/') && method === 'PUT') {
        if (controls.failSave) return reject('Test: saving unavailable', 503)
        data.settings[decodeURIComponent(path.slice('/settings/'.length))] = body?.value
        return reply({ ok: true })
      }
      if (path === '/browse-folder' && method === 'POST') return reply({ path: project.path })
      if (path === '/workspaces' && method === 'POST') {
        const existing = data.workspaces.find((item) => item.path === body?.path)
        if (existing) return reply({ error: 'Workspace already connected', existing }, 409)
        if (!body?.path) return reject('A folder path is required', 400)
        const item = { id: id('workspace'), name: body.name || (body.path === project.path ? project.name : body.path.split('/').filter(Boolean).at(-1)), path: body.path, created_at: now(), default_worktree: 0 }
        data.workspaces.push(item)
        return reply(item)
      }
      const deleteWorkspace = /^\/workspaces\/([^/]+)$/.exec(path)
      if (deleteWorkspace && method === 'DELETE') {
        const workspace = data.workspaces.find((item) => item.id === deleteWorkspace[1])
        if (!workspace) return reject('Workspace not found', 404)
        if (controls.holdWorkspaceDelete) await new Promise((release) => workspaceDeleteReleases.add(release))
        if (closed) return
        if (controls.failWorkspaceDelete) return reject('Test: project removal unavailable', 503)
        const ids = new Set(data.sessions.filter((item) => item.workspace_id === workspace.id).map((item) => item.id))
        data.workspaces = data.workspaces.filter((item) => item.id !== workspace.id)
        data.sessions = data.sessions.filter((item) => !ids.has(item.id))
        for (const sid of ids) delete data.messages[sid]
        for (const key of ['tasks', 'runs', 'pipelines', 'gridTemplates']) data[key] = data[key].filter((item) => item.workspace_id !== workspace.id)
        // Deliberately HTTP-only: the initiating UI must reconcile its own
        // workspace/session state even if a cross-window event is lost.
        return reply({ ok: true })
      }
      if (path === '/sessions' && method === 'POST') {
        if (!data.workspaces.some((item) => item.id === body?.workspace_id)) return reject('Workspace does not exist', 404)
        const item = { id: id('session'), ...body, cli_type: body.cli_type || 'claude', model: body.model || 'sonnet', status: 'idle', agentState: 'idle', pty_alive: false, session_type: body.session_type || 'worker', created_at: now(), archived: 0, tags: body.tags || [], attention: null }
        data.sessions.push(item); data.messages[item.id] = []
        return reply(item)
      }
      const updateSession = /^\/sessions\/([^/]+)$/.exec(path)
      if (updateSession && method === 'DELETE') {
        const item = data.sessions.find((entry) => entry.id === updateSession[1])
        if (!item) return reject('Session not found', 404)
        if (controls.holdDelete) await new Promise((release) => deleteReleases.add(release))
        if (controls.deleteDelayMs) await new Promise((release) => setTimeout(release, controls.deleteDelayMs))
        if (closed) return
        if (controls.failDelete) return reject('Test: deletion unavailable', 503)
        data.sessions = data.sessions.filter((entry) => entry.id !== item.id)
        delete data.messages[item.id]
        broadcast({ type: 'session_deleted', session_id: item.id, workspace_id: item.workspace_id })
        return reply({ ok: true })
      }
      if (updateSession && method === 'PUT' && Object.hasOwn(body || {}, 'archived')) {
        const item = data.sessions.find((entry) => entry.id === updateSession[1])
        if (!item) return reject('Session not found', 404)
        if (controls.holdArchive) await new Promise((release) => archiveReleases.add(release))
        if (controls.archiveDelayMs) await new Promise((release) => setTimeout(release, controls.archiveDelayMs))
        if (closed) return
        if (controls.failArchive) return reject('Test: archive unavailable', 503)
        // Match update_session: archiving is persisted and broadcast, but it
        // does not delete transcript rows or invent a process stop.
        item.archived = body.archived ? 1 : 0
        broadcast({ type: 'session_archived', session_id: item.id, archived: item.archived })
        return reply(item)
      }
      const updateGrid = /^\/grid-templates\/([^/]+)$/.exec(path)
      if (updateGrid && method === 'PUT') {
        const item = data.gridTemplates.find((entry) => entry.id === updateGrid[1])
        if (!item) return reject('Grid template not found', 404)
        Object.assign(item, clone(body))
        return reply(item)
      }
      const input = /^\/sessions\/([^/]+)\/input$/.exec(path)
      if (input && method === 'POST') {
        const item = data.sessions.find((entry) => entry.id === input[1])
        if (!item) return reject('Session not found', 404)
        if (controls.failInput) return reject('Test: context delivery failed; retry is safe', 503)
        if (!item.pty_alive) return reject('Session not running')
        if (!body?.message?.trim()) return reject('Message is required', 400)
        appendMessage(item.id, 'user', body.message)
        controls.setSessionStatus(item.id, 'running')
        if (controls.autoReply) controls.reply(item.id, undefined, { delayMs: controls.replyDelayMs })
        return reply({ ok: true, state: 'sent', session_id: item.id })
      }
      if (path === '/tasks' && method === 'POST') {
        if (!data.workspaces.some((item) => item.id === body?.workspace_id)) return reject('Workspace does not exist', 404)
        const existing = data.tasks.find((item) => body.request_id && item.request_id === body.request_id)
        if (existing) return reply(existing)
        const item = { ...body, id: id('task'), created_at: now(), updated_at: now(), pipeline_stage: null }
        data.tasks.push(item)
        return reply(item)
      }
      const execute = /^\/tasks\/([^/]+)\/execute$/.exec(path)
      if (execute && method === 'POST') {
        if (controls.failExecute) return reject('Test: execution unavailable', 503)
        const task = data.tasks.find((item) => item.id === execute[1])
        if (!task) return reject('Task not found', 404)
        const existing = data.runs.find((item) => item.task_id === task.id && body?.request_id && item.variables?.request_id === body.request_id)
        if (existing) return reply({ run: existing })
        const pipeline = {
          id: id('pipeline'), name: 'Guided practice workflow', workspace_id: task.workspace_id, status: 'active',
          stages: ['plan', 'plan_critic', 'approval', 'implement', 'verify', 'fix'].map((stage, index) => ({ id: stage, name: stage, type: stage === 'approval' ? 'approval' : 'agent', position: { x: index * 220, y: 0 }, config: {} })),
          transitions: [{ id: 'plan-critic', source: 'plan', target: 'plan_critic' }, { id: 'critic-approval', source: 'plan_critic', target: 'approval' }, { id: 'approval-implement', source: 'approval', target: 'implement' }, { id: 'implement-verify', source: 'implement', target: 'verify' }, { id: 'verify-fix', source: 'verify', target: 'fix', condition: 'fail' }, { id: 'fix-verify', source: 'fix', target: 'verify' }],
        }
        data.pipelines.push(pipeline)
        const item = { id: id('run'), task_id: task.id, pipeline_id: pipeline.id, workspace_id: task.workspace_id, status: 'running', current_stages: ['plan'], iteration: 1, max_iterations: body.pipeline_max_iterations || 3, created_at: now(), started_at: now(), variables: { ...body }, stage_history: { plan: { status: 'running', started_at: now() } } }
        data.runs.push(item)
        Object.assign(task, { status: 'planning', pipeline_stage: 'plan', pipeline_id: pipeline.id })
        if (controls.autoPlan) schedule(() => { if (item.status === 'running' && item.current_stages.includes('plan')) controls.planReady(item.id) }, controls.planDelayMs)
        return reply({ run: item })
      }
      const runAction = /^\/pipeline-runs\/([^/]+)$/.exec(path)
      if (runAction && method === 'PUT') {
        const item = data.runs.find((entry) => entry.id === runAction[1])
        if (!item) return reject('Run not found', 404)
        if (body?.action === 'cancel' && ['running', 'paused'].includes(item.status)) {
          return reply(controls.failRun(item.id, 'cancelled'))
        }
        if (body?.action === 'pause' && item.status === 'running') return reply(controls.setRun(item.id, { status: 'paused' }))
        if (body?.action === 'resume' && item.status === 'paused') {
          if (item.current_stages.includes('approval')) {
            item.stage_history.approval = passed('User approved the plan through the UI.')
            item.stage_history.implement = { status: 'running', started_at: now() }
            item.current_stages = ['implement']
            Object.assign(taskFor(item), { status: 'in_progress', pipeline_stage: 'implement' })
          }
          item.status = 'running'
          return reply(notifyRun(item))
        }
        return reject('Invalid action for this run state')
      }
      const updateTask = /^\/tasks\/([^/]+)$/.exec(path)
      if (updateTask && method === 'PUT') {
        const task = data.tasks.find((item) => item.id === updateTask[1])
        if (!task) return reject('Task not found', 404)
        if (body?.status === 'done') {
          if (controls.failAccept) return reject('Test: acceptance unavailable', 503)
          const item = data.runs.filter((entry) => entry.task_id === task.id).at(-1)
          if (task.status !== 'review' || !item || item.id !== body.reviewed_run_id || item.status !== 'completed' || !item.stage_history.verify?.output_summary?.startsWith('__pipeline_result:pass:')) return reject('Only the latest completed and verified run can be accepted')
        }
        Object.assign(task, body, { updated_at: now() })
        broadcast({ type: 'task_update', task })
        return reply(task)
      }
      unexpected.push(call)
      return reject(`Unimplemented fixture write: ${method} ${path}`, 501)
    }

    if (path === '/whoami') return reply({ actor_kind: options.guest ? 'joiner_session' : 'localhost', mode: options.guest ? 'view' : 'full', label: 'Isolated tour test' })
    if (path === '/settings') return reply(data.settings)
    if (path.startsWith('/settings/')) return reply({ value: data.settings[decodeURIComponent(path.slice('/settings/'.length))] ?? null })
    if (path === '/extensions') return reply({ edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] })
    if (path === '/cli-info/features') return reply(cliFeatures)
    if (path === '/cli-info') return reply({ available_clis: { claude: true, codex: true }, version: 'isolated-fixture' })
    if (path === '/cli-profiles') return reply(Object.values(cliFeatures.profiles || {}))
    if (path === '/model-providers') return reply({ providers: [], health: [] })
    if (path === '/runtime/status') return reply({ multiplayer: { enabled: false }, tunnel: { running: false } })
    if (path === '/sidechat/options') return reply({ providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [] }], accounts: [] })
    if (path === '/quick-start') return reply({ root: '/isolated/ive-tour', workspace_id: null, workspace_name: 'Quick sessions' })
    if (path === '/project-search') return reply({ matches: [{ ...project, workspace_id: data.workspaces.find((item) => item.path === project.path)?.id || null }], partial: false })
    if (path === '/workspaces') return reply(data.workspaces)
    if (path === '/sessions') return reply(filtered(data.sessions, params))
    if (path === '/tasks') return reply(filtered(data.tasks, params))
    if (path === '/pipeline-runs') return reply(filtered(data.runs, params).slice().reverse())
    if (path === '/pipelines') return reply(filtered(data.pipelines, params))
    if (path === '/guidelines') return reply(data.guidelines)
    if (path === '/grid-templates') return reply(filtered(data.gridTemplates, params))
    if (path === '/overview') return reply({ workspace_total: data.workspaces.length, detail_limit: 5, workspaces: data.workspaces.map((workspace) => ({
      ...workspace, sessions: { total: data.sessions.filter((item) => item.workspace_id === workspace.id).length, by_status: {} },
      blocked_sessions: { total: 0, items: [] }, test_queue: { depth: 0, running_total: 0, running: null },
      open_tasks: { total: data.tasks.filter((item) => item.workspace_id === workspace.id && item.status !== 'done').length, items: data.tasks.filter((item) => item.workspace_id === workspace.id && item.status !== 'done') }, active_research: { total: 0, items: [] },
    })) })
    const messages = /^\/sessions\/([^/]+)\/messages$/.exec(path)
    if (messages) return reply(messageResponse(messages[1], params))
    const entity = /^\/(tasks|pipeline-runs|pipelines|sessions)\/([^/]+)$/.exec(path)
    if (entity) {
      const rows = { tasks: data.tasks, 'pipeline-runs': data.runs, pipelines: data.pipelines, sessions: data.sessions }[entity[1]]
      const item = rows.find((entry) => entry.id === entity[2])
      return item ? reply(item) : reject('Not found', 404)
    }
    if (/\/git\/diff$/.test(path)) return controls.failChanges ? reject('Test: changes unavailable', 503) : reply({ diff: params.get('staged') ? data.stagedDiff : data.diff, truncated: false })
    if (/\/git\/status$/.test(path)) return reply({ branch: 'main', files: [], clean: !data.diff && !data.stagedDiff })
    if (/\/output$/.test(path)) {
      const live = data.sessions.find((item) => item.id === path.split('/')[2])?.pty_alive !== false
      return reply({ text: live ? 'IVE test transport\n❯ ' : '', output: live ? 'IVE test transport\n❯ ' : '', startup_blocker: null, pty_alive: live })
    }
    if (/\/files$/.test(path)) return reply({ items: [] })
    if (/\/capabilities$/.test(path)) return reply({ force_send: true, cli_type: 'claude' })
    if (/\/runtime-model$/.test(path)) return reply({ model: 'sonnet', source: 'fixture' })
    if (/\/(brainstormer|project-hint|runtime-env)$/.test(path)) return reply({})
    if (/\/(captures|events|queue|test-queue|git\/log)$/.test(path) || emptyLists.has(path)) return reply([])
    unexpected.push(call)
    return options.strictReads ? reject(`Unimplemented fixture read: ${path}`, 501) : reply([])
  })
  const page = await context.newPage()
  page.setDefaultTimeout(options.timeout || 12000)
  page.on('pageerror', (error) => errors.push(error.message))
  try { await page.goto(origin) }
  catch (error) { await context.close(); throw error }
  return { page, context, data, writes, reads, errors, unexpected, controls }
}
