// Only identifiers and progress belong here. Prompts, replies and repository
// contents must never be copied into persisted tour state.
export const TOUR_STEPS = Object.freeze([
  'project', 'session', 'context', 'answer', 'overview',
  'loop-setup', 'loop-plan', 'loop-run', 'review', 'tools',
])

const STEPS = new Set(TOUR_STEPS)
const VALID_STEPS = new Set(['welcome', ...TOUR_STEPS, 'done'])
const TOOL_IDS = new Set(['pipeline-editor', 'prompts', 'guidelines', 'search', 'connectors', 'memory', 'research'])
const ID_FIELDS = ['workspaceId', 'sessionId', 'secondSessionId', 'taskId', 'runId']
const FAILED_RUNS = new Set(['failed', 'cancelled', 'canceled', 'max_iterations'])
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300 && /^[A-Za-z0-9_.:@/-]+$/.test(value)
const validCycles = (value) => Number.isInteger(value) && value >= 1 && value <= 20
const validIds = (value, limit = 200) => Array.isArray(value) && value.length <= limit && value.every(validId)

export const newTour = () => ({
  version: 2, step: 'welcome', completed: [], skipped: [],
  workspaceId: null, sessionId: null, secondSessionId: null,
  taskId: null, runId: null, paused: false,
})

export const tourProgressKey = (owner) => `ive.interactive-tour.v2.${owner ? 'owner' : 'guest'}`

function cleanState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2 || !VALID_STEPS.has(value.step)) return null
  if (typeof value.paused !== 'boolean') return null
  if (![value.completed, value.skipped].every((items) => Array.isArray(items) && items.length <= TOUR_STEPS.length && items.every((id) => STEPS.has(id)))) return null
  if (value.completed.some((id) => value.skipped.includes(id))) return null
  if (ID_FIELDS.some((field) => value[field] !== null && !validId(value[field]))) return null
  if (value.secondSessionId && value.secondSessionId === value.sessionId) return null
  const next = { ...newTour(), step: value.step, completed: [...new Set(value.completed)], skipped: [...new Set(value.skipped)], paused: value.paused }
  for (const field of ID_FIELDS) next[field] = value[field]
  for (const field of ['cyclesChosen', 'inspected', 'contextSending']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') return null
      next[field] = value[field]
    }
  }
  if (value.maxIterations !== undefined) {
    if (!validCycles(value.maxIterations)) return null
    next.maxIterations = value.maxIterations
  }
  if (value.replyBaselineIds !== undefined) {
    if (!validIds(value.replyBaselineIds)) return null
    next.replyBaselineIds = [...new Set(value.replyBaselineIds)]
  }
  if (value.replyAfter !== undefined) {
    if (!Number.isFinite(value.replyAfter) || value.replyAfter < 0) return null
    next.replyAfter = value.replyAfter
  }
  return next
}

export function readTour(storage, owner) {
  try {
    const raw = storage?.getItem(tourProgressKey(owner))
    if (typeof raw !== 'string' || raw.length > 100000) return newTour()
    return cleanState(JSON.parse(raw)) || newTour()
  } catch { return newTour() }
}

export function writeTour(storage, owner, state) {
  try {
    const clean = cleanState(state)
    if (!clean || typeof storage?.setItem !== 'function') return false
    storage.setItem(tourProgressKey(owner), JSON.stringify(clean))
    return true
  } catch { return false }
}

export function emitTourEvent(type, payload = {}) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  const EventClass = window.CustomEvent || globalThis.CustomEvent
  if (typeof EventClass !== 'function') return
  window.dispatchEvent(new EventClass('ive-tour-event', { detail: { ...payload, type } }))
}

export function advanceTour(state, { skip = false } = {}) {
  if (!VALID_STEPS.has(state?.step) || state.step === 'done') return state
  const current = state.step
  const nextIndex = TOUR_STEPS.indexOf(current) + 1
  return {
    ...state,
    step: TOUR_STEPS[nextIndex] || 'done',
    completed: [...new Set([...(state.completed || []).filter((id) => id !== current), ...(!skip && STEPS.has(current) ? [current] : [])])],
    skipped: [...new Set([...(state.skipped || []).filter((id) => id !== current), ...(skip && STEPS.has(current) ? [current] : [])])],
    paused: false,
  }
}

export const pauseTour = (state) => ({ ...state, paused: true })
export const resumeTour = (state) => ({ ...state, paused: false })
export const restartTour = () => newTour()

function workingStage(stages) {
  if (!Array.isArray(stages)) return false
  return stages.some((stage) => {
    const id = typeof stage === 'string' ? stage : stage?.id ?? stage?.name ?? stage?.type
    return ['implement', 'verify', 'fix'].includes(id)
  })
}

export function reduceTourEvent(state, event) {
  if (!state || state.paused || state.step === 'done' || !event || typeof event !== 'object') return state
  const sameSession = validId(state.sessionId) && event.sessionId === state.sessionId
  const sameWorkspace = validId(state.workspaceId) && event.workspaceId === state.workspaceId
  switch (event.type) {
    case 'project-connected':
      return state.step === 'project' && validId(event.workspaceId)
        ? advanceTour({ ...state, workspaceId: event.workspaceId }) : state
    case 'session-created': {
      if (!sameWorkspace || !validId(event.sessionId) || !validId(event.cliType) || event.cliType === 'shell') return state
      if (state.step === 'session') return advanceTour({ ...state, sessionId: event.sessionId })
      if (state.step === 'overview' && event.sessionId !== state.sessionId) return { ...state, secondSessionId: event.sessionId }
      return state
    }
    case 'session-focused':
      return state.step === 'overview' && sameSession && validId(state.secondSessionId) && state.secondSessionId !== state.sessionId ? advanceTour(state) : state
    case 'context-started':
      if (state.step !== 'context' || !sameSession || !validIds(event.baselineIds) || !Number.isFinite(event.replyAfter) || event.replyAfter < 0) return state
      return { ...state, replyBaselineIds: [...new Set(event.baselineIds)], replyAfter: event.replyAfter, contextSending: true }
    case 'context-sent':
      return state.step === 'context' && sameSession ? advanceTour({ ...state, contextSending: false }) : state
    case 'context-failed':
      return state.step === 'context' && sameSession ? { ...state, contextSending: false } : state
    case 'assistant-reply':
      return state.step === 'answer' && sameSession && validId(event.messageId) && !(state.replyBaselineIds || []).includes(event.messageId)
        ? advanceTour(state) : state
    case 'loop-settings':
      return state.step === 'loop-setup' && typeof event.chosen === 'boolean' && validCycles(event.maxIterations)
        ? { ...state, cyclesChosen: event.chosen, maxIterations: event.maxIterations } : state
    case 'task-state': {
      if (!['loop-setup', 'loop-plan', 'loop-run', 'review'].includes(state.step)) return state
      if (!sameWorkspace || !validId(event.taskId) || (state.taskId && event.taskId !== state.taskId) || (state.runId && event.runId !== state.runId)) return state
      if (FAILED_RUNS.has(event.runStatus)) return state
      const next = event.inspected === true && state.inspected !== true ? { ...state, inspected: true } : state
      if (state.step === 'loop-setup' && state.cyclesChosen === true && validId(event.runId)) return advanceTour({ ...next, taskId: event.taskId, runId: event.runId })
      // Later steps only follow the run explicitly bound during setup. Recovery
      // returns to setup and clears the binding; an unrelated run is never adopted.
      if (!validId(state.taskId) || !validId(state.runId)) return state
      if (state.step === 'loop-plan' && event.approval === false && (event.runStatus === 'running' && workingStage(event.currentStages) || event.runStatus === 'completed' && event.verified === true)) return advanceTour(next)
      // After acceptance canAccept becomes false. A reloaded tour can still
      // review that verified result, but must independently observe inspection.
      if (state.step === 'loop-run' && event.runStatus === 'completed' && event.verified === true && (event.canAccept === true || event.taskStatus === 'done')) return advanceTour(next)
      if (state.step === 'review' && event.taskStatus === 'done' && next.inspected === true) return advanceTour(next)
      return next
    }
    case 'tool-opened':
      return state.step === 'tools' && TOOL_IDS.has(event.toolId) ? advanceTour(state) : state
    default: return state
  }
}
