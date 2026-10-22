/**
 * Real UI checks for the active coach, with isolated server transports.
 * Import runOnboardingChecks into an existing Playwright-plugin browser.
 * No browser is launched on import, and no success event is injected.
 *
 * Each named case can be called separately (normally under 60 seconds):
 * const fixtures = {}
 * await runOnboardingChecks(browser, createTourFixture, {
 *   cases: ['conversation-and-context'], fixtures, keepOpen: true,
 * })
 * // Continue that exact UI with bounded-loop, then review-and-finish.
 * // Optional screenshotDir must already exist; reporter receives small records.
 */
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

function check(condition, message) { if (!condition) throw new Error(message) }
function equal(actual, expected, message) {
  check(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
async function until(read, description, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out: ${description}`)
}
const coach = (f) => f.page.locator('[data-tour-step]')
const flow = (f) => f.page.locator('.ive-task-flow')
const storedProgress = (f) => f.page.evaluate(() => JSON.parse(localStorage.getItem('ive.interactive-tour.v2.owner') || 'null'))
async function step(f, name) {
  await f.page.locator(`[data-tour-step="${name}"]`).waitFor({ state: 'visible' })
  await until(async () => (await storedProgress(f))?.step === name, 'Persisted and displayed step agree')
}
async function clean(f) {
  equal(f.errors.length, 0, `No browser exceptions: ${f.errors.join('; ')}`)
  check(!f.unexpected?.some((item) => item.method !== 'GET'), `No unimplemented writes: ${JSON.stringify(f.unexpected)}`)
}
async function picture(env, f, name) {
  if (env.options.screenshotDir) await f.page.screenshot({ path: `${env.options.screenshotDir.replace(/\/$/, '')}/${name}.png`, fullPage: false, animations: 'disabled' })
}
async function reloadApp(f) {
  const settingsLoaded = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/settings/product_tour_version' && response.status() === 200)
  await f.page.reload()
  await settingsLoaded
  await f.page.locator('.x-app-shell').waitFor({ state: 'visible' })
}

// These independent regression fixtures begin from saved, already completed
// prerequisites. All actions under test still use real UI and API responses.
function savedLessonOptions(lesson) {
  const workspace = { id: 'tour-saved-workspace', name: 'Tour practice', path: '/isolated/ive-tour/practice', default_worktree: 0 }
  const session = { id: 'tour-saved-session', workspace_id: workspace.id, name: 'Mein erster Dialog', cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [], attention: null }
  const progress = { version: 2, step: lesson, completed: ['project', 'session'], skipped: [], workspaceId: workspace.id, sessionId: session.id, secondSessionId: null, taskId: null, runId: null, paused: false }
  const options = {
    workspaces: [workspace], sessions: [session], tasks: [], runs: [], autoReply: false, autoPlan: false,
    messages: { [session.id]: [{ id: 'tour-saved-old-reply', session_id: session.id, role: 'assistant', content: 'Earlier answer from the saved session.', created_at: '2026-01-01T00:00:00Z' }] },
    storage: { 'ive.interactive-tour.v2.owner': progress },
  }
  if (lesson === 'loop-run') {
    const task = { id: 'tour-saved-task', workspace_id: workspace.id, title: 'Read-only loop cancellation exercise', description: 'Inspect documented commands without changing files.', acceptance_criteria: 'No project files change.', status: 'in_progress', pipeline_stage: 'implement', pipeline_max_iterations: 3 }
    const run = { id: 'tour-saved-run', task_id: task.id, workspace_id: workspace.id, pipeline_id: 'tour-saved-pipeline', status: 'running', current_stages: ['implement'], iteration: 1, max_iterations: 3, created_at: '2026-01-01T00:00:00Z', variables: { require_result_review: true }, stage_history: {
      plan: { status: 'completed', output_summary: '__pipeline_result:pass:Read documented commands. Change no files.' },
      plan_critic: { status: 'completed', output_summary: '__pipeline_result:pass:Read-only plan with clear criteria.' },
      approval: { status: 'completed', output_summary: '__pipeline_result:pass:Previously approved plan.' },
      implement: { status: 'running' },
    } }
    options.tasks.push(task); options.runs.push(run)
    options.sessions.push({ ...session, id: 'tour-saved-second-session', name: 'Meine zweite Session' })
    Object.assign(progress, { completed: ['project', 'session', 'context', 'answer', 'overview', 'loop-setup', 'loop-plan'], secondSessionId: 'tour-saved-second-session', taskId: task.id, runId: run.id, cyclesChosen: true, maxIterations: 3 })
  }
  return options
}
async function fixture(env, key, options = {}) {
  if (!env.fixtures[key]) env.fixtures[key] = await env.createFixture(env.browser, { ...env.options.fixtureOptions, ...options })
  return env.fixtures[key]
}
async function welcome(f) {
  await f.page.getByRole('heading', { name: 'Dein Projekt. Dein erster Durchlauf.', exact: true }).waitFor()
  equal(f.writes.length, 0, 'Opening the guide must not write or start work')
  await f.page.getByRole('button', { name: 'Selbst ausprobieren', exact: true }).click()
  await step(f, 'project')
}
async function connect(f) {
  await coach(f).getByRole('button', { name: 'Projekt auswählen', exact: true }).click()
  await f.page.getByLabel('What would you like to work on?', { exact: true }).fill('Tour practice')
  await f.page.getByRole('button', { name: /Tour practice.*isolated/ }).click()
  await step(f, 'session')
  equal(f.data.workspaces.length, 1, 'The project is connected exactly once')
  equal(f.data.workspaces[0].path, f.data.project.path, 'The selected folder is retained')
}
async function createSession(f, second = false) {
  await coach(f).getByRole('button', { name: second ? 'Zweite Session erstellen' : 'Session einrichten', exact: true }).click()
  const setup = f.page.locator('[data-tour="session-setup"]')
  await setup.waitFor({ state: 'visible' })
  await setup.getByRole('button', { name: 'Create Session', exact: true }).click()
  await setup.waitFor({ state: 'detached' })
  const created = f.controls.latestSession()
  equal(created.workspace_id, f.data.workspaces[0].id, 'Session belongs to the selected project')
  return created
}
async function prepareLoop(f) {
  await step(f, 'loop-setup')
  await coach(f).getByRole('button', { name: 'Übungsauftrag öffnen', exact: true }).click()
  await flow(f).waitFor({ state: 'visible' })
  check(await flow(f).getByLabel('Your request', { exact: true }).inputValue(), 'The exercise has a visible request')
  check(/Keine Projektdateien/.test(await flow(f).getByLabel('Acceptance criteria', { exact: true }).inputValue()), 'Read-only success criteria are visible')
  equal(f.data.tasks.length, 0, 'Opening the exercise does not submit it')
  check(await f.page.locator('[data-tour="plan-submit"]').isDisabled(), 'Cycle selection is a deliberate prerequisite')
  await f.page.locator('[data-tour="loop-cycles"]').selectOption('3')
  check(await f.page.locator('[data-tour="plan-submit"]').isEnabled(), 'Choosing a bound enables submission')
  await f.page.locator('[data-tour="plan-submit"]').click()
  await step(f, 'loop-plan')
  equal(f.data.tasks.length, 1, 'One user submission creates one task')
  equal(f.data.runs.length, 1, 'One execution is created')
  const execution = f.writes.find((item) => /\/tasks\/[^/]+\/execute$/.test(item.path))
  equal(execution?.body?.pipeline_max_iterations, 3, 'The chosen bound reaches the API')
  equal(execution?.body?.auto_approve_plan, false, 'The plan is never automatically approved')
  equal(execution?.body?.require_result_review, true, 'Final human review remains required')
  check(!f.writes.some((item) => item.body?.action === 'resume'), 'No approval before the user clicks')
  f.controls.planReady()
  await f.page.locator('[data-tour="plan-approve"]').waitFor({ state: 'visible' })
  await step(f, 'loop-plan')
  await flow(f).getByRole('heading', { name: 'Proposed plan', exact: true }).waitFor()
  await flow(f).getByRole('heading', { name: 'Plan review', exact: true }).waitFor()
}

const cases = {
  async 'welcome-keyboard'(env) {
    const f = await fixture(env, 'keyboard')
    const dialog = f.page.getByRole('dialog', { name: 'Dein Projekt. Dein erster Durchlauf.', exact: true })
    await dialog.waitFor()
    equal(await f.page.locator('.x-app-shell').evaluate((el) => el.inert), true, 'Welcome keeps the app inert')
    await until(() => dialog.getByRole('button', { name: 'Selbst ausprobieren', exact: true }).evaluate((el) => el === document.activeElement), 'Initial keyboard focus')
    await f.page.keyboard.press('Shift+Tab')
    check(await dialog.getByRole('button', { name: 'Später', exact: true }).evaluate((el) => el === document.activeElement), 'Shift+Tab wraps to the last welcome action')
    await f.page.keyboard.press('Tab')
    check(await dialog.getByRole('button', { name: 'Selbst ausprobieren', exact: true }).evaluate((el) => el === document.activeElement), 'Tab wraps to the first welcome action')
    await picture(env, f, 'welcome-keyboard')
    await f.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    equal(await f.page.locator('.x-app-shell').evaluate((el) => el.inert), false, 'Closing welcome releases the app')
    equal(f.writes.length, 0, 'Pausing does not save a false completion')
    equal((await storedProgress(f)).paused, true, 'Escape persists a paused tour')
    await clean(f)
  },

  async 'conversation-and-context'(env) {
    const f = await fixture(env, 'happy')
    check(!f.testPhase, 'Use a fresh happy fixture for the conversation case')
    await welcome(f)
    await connect(f)
    const first = await createSession(f)
    f.testFirstSessionId = first.id
    await step(f, 'context')
    await coach(f).getByRole('button', { name: 'Zum Overview', exact: true }).click()
    const cell = f.page.locator(`[data-session-view="${first.id}"], [data-grid-cell-session="${first.id}"]`).filter({ visible: true }).first()
    await cell.waitFor()
    // Load an earlier reply before sending context. Re-rendering this existing
    // row after input must never count as the requested new answer.
    f.controls.reply(first.id, 'Earlier answer before this context request.')
    await cell.locator('[id^="msg-"]').getByText('Earlier answer before this context request.', { exact: true }).waitFor()
    await coach(f).getByRole('button', { name: 'Kontext öffnen', exact: true }).click()
    const panel = f.page.getByRole('dialog', { name: 'Add context', exact: true })
    await panel.waitFor()
    await coach(f).getByRole('button', { name: 'Beispielnotiz einsetzen', exact: true }).click()
    const note = await panel.locator('textarea').inputValue()
    check(note.includes('Ändere keine Dateien'), 'The example explicitly asks for read-only work')
    f.controls.failInput = true
    await panel.getByRole('button', { name: 'Send context', exact: true }).click()
    await panel.getByText(/Test: context delivery failed/).waitFor()
    equal(await panel.locator('textarea').inputValue(), note, 'A failed submission keeps the note')
    await step(f, 'context')
    f.controls.failInput = false
    await panel.getByRole('button', { name: 'Send context', exact: true }).click()
    await panel.waitFor({ state: 'detached' })
    await step(f, 'answer')
    await until(async () => (await cell.innerText()).includes(note), 'The API user transcript is displayed')
    await step(f, 'answer')
    check((await storedProgress(f)).replyBaselineIds.length > 0, 'Earlier replies belong to the observed baseline')
    equal(f.data.messages[first.id].filter((item) => item.role === 'assistant').length, 1, 'Sending has not fabricated an assistant answer')
    await picture(env, f, 'answer-pending')
    f.controls.reply(first.id, 'Neue belegte Antwort: package.json enthält npm run dev und npm test. Keine Dateien geändert.')
    await step(f, 'overview')
    const second = await createSession(f, true)
    check(second.id !== first.id, 'The second session has its own identity')
    await step(f, 'overview')
    await until(async () => (await storedProgress(f)).secondSessionId === second.id, 'Second session is observed without completing the focus step')
    // Opening Overview preserves the currently selected second session.
    // Click the first actual card to prove the learner can switch in Overview.
    await coach(f).getByRole('button', { name: 'Zum Overview', exact: true }).click()
    const originalCard = f.page.locator(`[data-session-view="${first.id}"], [data-grid-cell-session="${first.id}"]`).filter({ visible: true }).first()
    await originalCard.locator('.ive-session-title').first().click()
    await step(f, 'loop-setup')
    equal(f.data.sessions.length, 2, 'Exactly two explicitly created sessions exist')
    await picture(env, f, 'two-sessions')
    f.testPhase = 'loop-setup'
    await clean(f)
  },

  async 'bounded-loop'(env) {
    const f = env.fixtures.happy
    check(f?.testPhase === 'loop-setup', 'Run conversation-and-context first with the same fixtures object')
    await prepareLoop(f)
    await picture(env, f, 'plan-awaiting-approval')
    await f.page.locator('[data-tour="plan-approve"]').click()
    await step(f, 'loop-run')
    equal(f.controls.latestRun().current_stages[0], 'implement', 'Manual approval starts the worker stage')
    f.controls.checking()
    await flow(f).getByText('Checking the result', { exact: true }).waitFor()
    f.controls.failCheck()
    await flow(f).getByText('Fixing issues', { exact: true }).waitFor()
    await step(f, 'loop-run')
    equal(f.controls.latestRun().iteration, 2, 'A failed check causes a bounded correction cycle')
    equal(await f.page.locator('[data-tour="result-accept"]').count(), 0, 'A failed check cannot be accepted')
    await picture(env, f, 'loop-correction')
    f.controls.checking()
    await flow(f).getByText('Checking the result', { exact: true }).waitFor()
    f.controls.passCheck()
    await step(f, 'review')
    equal(f.controls.latestTask().status, 'review', 'Passing verification still requires user review')
    check(!f.writes.some((item) => item.body?.status === 'done'), 'No automatic acceptance')
    f.testPhase = 'review'
    await clean(f)
  },

  async 'review-and-finish'(env) {
    const f = env.fixtures.happy
    check(f?.testPhase === 'review', 'Run bounded-loop first with the same fixtures object')
    f.controls.failChanges = true
    await f.page.locator('[data-tour="result-changes"]').click()
    await flow(f).getByRole('alert').filter({ hasText: 'Test: changes unavailable' }).waitFor()
    await step(f, 'review')
    equal(Boolean((await storedProgress(f)).inspected), false, 'A failed diff request does not count as inspection')
    f.controls.failChanges = false
    await f.page.locator('[data-tour="result-changes"]').click()
    await flow(f).getByText('No unstaged diff.', { exact: true }).waitFor()
    await flow(f).getByText('No staged diff.', { exact: true }).waitFor()
    await until(async () => (await storedProgress(f)).inspected === true, 'Successful inspection is observed')
    f.controls.failAccept = true
    await f.page.locator('[data-tour="result-accept"]').click()
    await flow(f).getByRole('alert').filter({ hasText: 'Test: acceptance unavailable' }).waitFor()
    equal(f.controls.latestTask().status, 'review', 'Failed acceptance keeps the task in review')
    await step(f, 'review')
    f.controls.failAccept = false
    await f.page.locator('[data-tour="result-accept"]').click()
    await step(f, 'tools')
    equal(f.controls.latestTask().status, 'done', 'The API confirms user acceptance')
    await coach(f).getByRole('button', { name: 'Work öffnen', exact: true }).click()
    await f.page.locator('[data-command-id="pipeline-editor"]').filter({ visible: true }).click()
    await step(f, 'done')
    const progress = await storedProgress(f)
    equal(progress.completed.length, 10, 'All ten real interactions are completed')
    equal(progress.skipped.length, 0, 'The happy path does not skip any lesson')
    f.controls.failSave = true
    await coach(f).getByRole('button', { name: 'Einführung abschließen', exact: true }).click()
    await coach(f).getByRole('alert').waitFor()
    check(Number(f.data.settings.product_tour_version || 0) < 2, 'Failed saving leaves server completion unset')
    await step(f, 'done')
    await picture(env, f, 'completed-save-retry')
    f.controls.failSave = false
    await coach(f).getByRole('button', { name: 'Einführung abschließen', exact: true }).click()
    await coach(f).waitFor({ state: 'detached' })
    equal(f.data.settings.product_tour_version, '2', 'Completion is persisted only after successful save')
    await reloadApp(f)
    equal(await f.page.locator('[data-ive-onboarding]').count(), 0, 'Completed tour stays dismissed after reload')
    f.testPhase = 'done'
    await clean(f)
  },

  async 'pause-reload-resume'(env) {
    const f = await fixture(env, 'resume')
    await welcome(f)
    await coach(f).getByRole('button', { name: 'Pausieren', exact: true }).click()
    await coach(f).waitFor({ state: 'detached' })
    equal((await storedProgress(f)).paused, true, 'Pause is persisted')
    await f.page.reload()
    await f.page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).first().waitFor()
    equal(await f.page.locator('[data-ive-onboarding]').count(), 0, 'A paused tour does not reopen on reload')
    await f.page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).first().click()
      await f.page.getByRole('button', { name: 'Einführung öffnen', exact: true }).click()
    await step(f, 'project')
    equal((await storedProgress(f)).paused, false, 'Reopening resumes the same step')
    equal(f.writes.length, 0, 'Pause/reload/resume performs no project or completion writes')
    await clean(f)
  },

  async 'pending-context-pause'(env) {
    const f = await fixture(env, 'pending-context', savedLessonOptions('context'))
    await step(f, 'context')
    const sid = f.data.sessions[0].id
    await coach(f).getByRole('button', { name: 'Zum Overview', exact: true }).click()
    const card = f.page.locator(`[data-session-view="${sid}"], [data-grid-cell-session="${sid}"]`).filter({ visible: true }).first()
    await card.locator('[id^="msg-"]').getByText('Earlier answer from the saved session.', { exact: true }).waitFor()
    await coach(f).getByRole('button', { name: 'Kontext öffnen', exact: true }).click()
    const panel = f.page.getByRole('dialog', { name: 'Add context', exact: true })
    await panel.locator('textarea').fill('Late receipt regression: inspect only, do not change files.')
    let release, held = false
    const released = new Promise((resolve) => { release = resolve })
    const pattern = '**/api/sessions/*/input'
    const holdInput = async (route) => { held = true; await released; await route.fallback() }
    await f.context.route(pattern, holdInput)
    try {
      await panel.getByRole('button', { name: 'Send context', exact: true }).click()
      await until(() => held, 'Context input request reached the transport barrier')
      await until(async () => (await storedProgress(f)).contextSending === true, 'Pending context state is persisted')
      await coach(f).getByRole('button', { name: 'Pausieren', exact: true }).click()
      await coach(f).waitFor({ state: 'detached' })
      equal((await storedProgress(f)).paused, true, 'The coach is paused before the API acknowledges input')
      release()
      await panel.waitFor({ state: 'detached' })
      await until(async () => {
        const value = await storedProgress(f)
        return value.step === 'answer' && value.paused === true && value.contextSending === false
      }, 'Late successful acknowledgement advances the paused tour to answer')
      await reloadApp(f)
      equal(await f.page.locator('[data-ive-onboarding]').count(), 0, 'Reload respects the paused receipt state')
      await f.page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).first().click()
      await f.page.getByRole('button', { name: 'Einführung öffnen', exact: true }).click()
      await step(f, 'answer')
      const inputs = f.writes.filter((item) => item.method === 'POST' && item.path === `/sessions/${sid}/input`)
      equal(inputs.length, 1, 'Resume never re-sends the acknowledged context')
      equal(f.data.messages[sid].filter((item) => item.role === 'user').length, 1, 'Exactly one context message exists')
      equal(f.data.messages[sid].filter((item) => item.role === 'assistant').length, 1, 'The earlier answer never counts as a fresh response')
      await picture(env, f, 'pending-context-resumed')
      await clean(f)
    } finally {
      release()
      await f.context.unroute(pattern, holdInput)
    }
  },

  async 'cancelled-loop'(env) {
    const f = await fixture(env, 'cancelled-loop', savedLessonOptions('loop-run'))
    await step(f, 'loop-run')
    await coach(f).getByRole('button', { name: 'Auftrag öffnen', exact: true }).click()
    const cancel = f.page.locator('[data-tour="run-cancel"]')
    await cancel.waitFor({ state: 'visible' })
    await cancel.click()
    await coach(f).getByRole('alert').filter({ hasText: 'Der Ablauf wurde abgebrochen.' }).waitFor()
    await step(f, 'loop-run')
    equal(f.controls.latestRun().status, 'cancelled', 'The server confirms the cancellation')
    const progress = await storedProgress(f)
    check(!progress.completed.includes('loop-run'), 'Cancellation never completes the run lesson')
    check(!progress.completed.includes('review'), 'Cancellation never advances to accepted review')
    equal(await f.page.locator('[data-tour="result-accept"]').count(), 0, 'A cancelled run has no acceptance action')
    equal(await cancel.count(), 0, 'The confirmed stopped run no longer offers cancellation')
    equal(f.writes.filter((item) => item.path === '/pipeline-runs/tour-saved-run' && item.body?.action === 'cancel').length, 1, 'One explicit cancel request is sent')
    check(!f.writes.some((item) => item.body?.status === 'done'), 'No task completion is written')
    await picture(env, f, 'cancelled-loop-not-complete')
    await clean(f)
  },

  async 'mobile-390'(env) { await mobileCheck(env, 390) },
  async 'mobile-320'(env) { await mobileCheck(env, 320) },
  // The whole tour on a phone, with touch: every lesson including context and
  // the final save. Earlier mobile checks stopped at the session step, which
  // hid that "Kontext öffnen" had no target on phones (no TopBar there).
  async 'mobile-full-390'(env) { await mobileFullFlow(env, 390, 844) },
  async 'mobile-full-360'(env) { await mobileFullFlow(env, 360, 740) },
  async 'dark-desktop'(env) {
    const f = await fixture(env, 'dark', { theme: 'dark' })
    await welcome(f)
    await connect(f)
    await coachFits(f)
    await picture(env, f, 'dark-session-step')
    await clean(f)
  },
}

async function coachFits(f) {
  const result = await coach(f).evaluate((el) => {
    const box = el.getBoundingClientRect()
    return { inside: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1, noOverflow: el.scrollWidth <= el.clientWidth + 1 }
  })
  check(result.inside, 'The coach card remains within the viewport')
  check(result.noOverflow, 'The coach has no horizontal text overflow')
}
async function mobileCheck(env, width) {
  const f = await fixture(env, `mobile-${width}`, { width, height: 844, theme: 'dark' })
  await welcome(f)
  await coachFits(f)
  await coach(f).getByRole('button', { name: 'Einführung verkleinern', exact: true }).click()
  const minimized = f.page.getByRole('button', { name: /Einführung fortsetzen/ })
  await minimized.waitFor()
  await minimized.click()
  await step(f, 'project')
  await coach(f).getByRole('button', { name: 'Projekt auswählen', exact: true }).click()
  await minimized.waitFor()
  await f.page.getByLabel('What would you like to work on?', { exact: true }).fill('Tour practice')
  await f.page.getByRole('button', { name: /Tour practice.*isolated/ }).click()
  await minimized.click()
  await step(f, 'session')
  await coachFits(f)
  await picture(env, f, `mobile-${width}-dark`)
  equal(f.data.workspaces.length, 1, 'Mobile project selection uses the actual picker')
  equal(f.data.sessions.length, 0, 'A project selection never starts a session automatically')
  await clean(f)
}

// Phone helpers: tap like a finger, and reopen the coach when an action
// minimised it (it shrinks below 1100 px so the real controls stay usable).
const tap = (locator) => locator.tap()
async function phoneCoach(f) {
  const resume = f.page.getByRole('button', { name: /Einführung fortsetzen/ })
  if (await resume.isVisible()) await tap(resume)
  await coach(f).waitFor({ state: 'visible' })
  return coach(f)
}
async function tapCoach(f, name) {
  const button = (await phoneCoach(f)).getByRole('button', { name, exact: true })
  await button.scrollIntoViewIfNeeded()
  // The coach button must be what a finger at its centre actually hits.
  const box = await button.boundingBox()
  const hit = await f.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent || null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  equal(hit, await button.textContent(), `Coach button "${name}" is not covered`)
  await tap(button)
}
async function phoneStep(f, name) {
  await until(async () => (await storedProgress(f))?.step === name, `Phone tour reached ${name}`)
  await phoneCoach(f)
  await step(f, name)
}
async function phoneCreateSession(f, second = false) {
  await tapCoach(f, second ? 'Zweite Session erstellen' : 'Session einrichten')
  const setup = f.page.locator('[data-tour="session-setup"]')
  await setup.waitFor({ state: 'visible' })
  await tap(setup.getByRole('button', { name: 'Create Session', exact: true }))
  await setup.waitFor({ state: 'detached' })
  return f.controls.latestSession()
}
async function mobileFullFlow(env, width, height) {
  const f = await fixture(env, `mobile-full-${width}`, { width, height, touch: true })
  const shot = (name) => picture(env, f, `mobile-full-${width}-${name}`)
  await tap(f.page.getByRole('button', { name: 'Selbst ausprobieren', exact: true }))
  await phoneStep(f, 'project')
  await coachFits(f)
  await tapCoach(f, 'Projekt auswählen')
  await f.page.getByLabel('What would you like to work on?', { exact: true }).fill('Tour practice')
  await tap(f.page.getByRole('button', { name: /Tour practice.*isolated/ }))
  await phoneCoach(f)
  await phoneStep(f, 'session')
  const first = await phoneCreateSession(f)
  await phoneCoach(f)
  await phoneStep(f, 'context')
  await coachFits(f)
  await shot('1-context')
  await tapCoach(f, 'Kontext öffnen')
  const panel = f.page.getByRole('dialog', { name: 'Add context', exact: true })
  await panel.waitFor()
  const fits = await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 })
  check(fits, 'The context panel stays inside the phone viewport')
  await shot('2-context-open')
  await tapCoach(f, 'Beispielnotiz einsetzen')
  const note = await panel.locator('textarea').inputValue()
  check(note.includes('Ändere keine Dateien'), 'The example note is inserted on the phone')
  await shot('3-context-note')
  await tap(panel.getByRole('button', { name: 'Send context', exact: true }))
  await panel.waitFor({ state: 'detached' })
  await phoneStep(f, 'answer')
  equal(f.writes.filter((item) => item.method === 'POST' && item.path === `/sessions/${first.id}/input`).length, 1, 'The note reaches exactly this session')
  f.controls.reply(first.id, 'Neue belegte Antwort: package.json enthält npm run dev und npm test. Keine Dateien geändert.')
  await phoneStep(f, 'overview')
  const second = await phoneCreateSession(f, true)
  check(second.id !== first.id, 'The second session has its own identity')
  await until(async () => (await storedProgress(f)).secondSessionId === second.id, 'Second session is observed')
  await tapCoach(f, 'Zum Overview')
  // Phone: back to the session list, then tap the first dialog.
  const back = f.page.getByRole('button', { name: 'Back to sessions', exact: true }).filter({ visible: true })
  if (await back.count()) await tap(back.first())
  await tap(f.page.getByText('Mein erster Dialog', { exact: true }).filter({ visible: true }).first())
  await phoneStep(f, 'loop-setup')
  await shot('4-loop-setup')
  await tapCoach(f, 'Übungsauftrag öffnen')
  await flow(f).waitFor({ state: 'visible' })
  await f.page.locator('[data-tour="loop-cycles"]').selectOption('3')
  await tap(f.page.locator('[data-tour="plan-submit"]'))
  await phoneStep(f, 'loop-plan')
  f.controls.planReady()
  await f.page.locator('[data-tour="plan-approve"]').waitFor({ state: 'visible' })
  await tap(f.page.locator('[data-tour="plan-approve"]'))
  await phoneStep(f, 'loop-run')
  f.controls.checking()
  await flow(f).getByText('Checking the result', { exact: true }).waitFor()
  f.controls.passCheck()
  await phoneStep(f, 'review')
  await shot('5-review')
  await tap(f.page.locator('[data-tour="result-changes"]'))
  await until(async () => (await storedProgress(f)).inspected === true, 'Inspection observed on the phone')
  await tap(f.page.locator('[data-tour="result-accept"]'))
  await phoneStep(f, 'tools')
  await tapCoach(f, 'Work öffnen')
  await tap(f.page.locator('[data-command-id="pipeline-editor"]').filter({ visible: true }).first())
  await phoneStep(f, 'done')
  const progress = await storedProgress(f)
  equal(progress.completed.length, 10, 'All ten lessons are completed on the phone')
  equal(progress.skipped.length, 0, 'Nothing is skipped on the phone')
  await phoneCoach(f)
  await coachFits(f)
  await shot('6-done')
  await tapCoach(f, 'Einführung abschließen')
  await coach(f).waitFor({ state: 'detached' })
  equal(f.data.settings.product_tour_version, '2', 'Completion is saved from the phone')
  await clean(f)
}

export const onboardingCheckNames = Object.freeze(Object.keys(cases))

export async function runOnboardingChecks(browser, createFixture = createTourFixture, options = {}) {
  const selected = options.cases || onboardingCheckNames
  const fixtures = options.fixtures || {}
  const env = { browser, createFixture, fixtures, options }
  const results = []
  try {
    for (const name of selected) {
      check(typeof cases[name] === 'function', `Unknown onboarding check: ${name}`)
      const started = Date.now()
      await options.reporter?.({ name, status: 'running' })
      try {
        await cases[name](env)
        const result = { name, status: 'passed', elapsedMs: Date.now() - started }
        results.push(result)
        await options.reporter?.(result)
      } catch (error) {
        const result = { name, status: 'failed', elapsedMs: Date.now() - started, error: error.message }
        results.push(result)
        await options.reporter?.(result)
        if (!options.continueOnError) { error.results = results; throw error }
      }
    }
    return { results, fixtures, metadata: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, {
      phase: f.testPhase || null, sessionIds: f.data.sessions.map((item) => item.id),
      taskIds: f.data.tasks.map((item) => item.id), runIds: f.data.runs.map((item) => item.id),
      writes: f.writes.map(({ method, path }) => ({ method, path })), errors: [...f.errors], unexpected: [...(f.unexpected || [])],
    }])) }
  } finally {
    if (!options.keepOpen) await Promise.all(Object.values(fixtures).map((f) => f.context.close()))
  }
}

// Optional standalone runner. Importing this module never starts a browser.
// The Playwright-plugin runner can omit everything after this comment.
// pathToFileURL, not `file://${argv[1]}`: a hand-built URL does not match
// import.meta.url for paths with spaces or other escaped characters, and the
// file would then run zero checks while `node --test` still reports success.
const { pathToFileURL } = await import('node:url')
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { test } = await import('node:test')
  test('IVE interactive onboarding through real UI', async (t) => {
    const { chromium, webkit } = await import('playwright')
    const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
    t.after(() => browser.close())
    const screenshotDir = process.env.IVE_QA_SCREENSHOTS
    if (screenshotDir) await (await import('node:fs/promises')).mkdir(screenshotDir, { recursive: true })
    // IVE_ONBOARDING_CASES=a,b runs a subset (default: every case).
    const only = process.env.IVE_ONBOARDING_CASES?.split(',').map((name) => name.trim()).filter(Boolean)
    const { results } = await runOnboardingChecks(browser, createTourFixture, { cases: only?.length ? only : undefined, screenshotDir, reporter: (result) => t.diagnostic(JSON.stringify(result)) })
    // Never report green for an empty or partial selection.
    const expected = only?.length ? only.length : onboardingCheckNames.length
    if (results.filter((item) => item.status === 'passed').length !== expected) throw new Error(`Only ${results.length} of ${expected} onboarding checks ran`)
  })
}
