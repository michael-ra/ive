// Pure selectors over the store state. Results are memoized on the inputs
// they read so `useStore(selector)` sees the same reference until the data
// changes (zustand bails out on identical references).
import { viewOf } from '../lib/route.js'
import { countByState, recentSessions, visibleSessions, visibleSessionsOf } from '../lib/visibleSessions.js'
import { sessionStateOf } from '../lib/sessionVocabulary.js'

const OWNER_ACTORS = ['localhost', 'owner_legacy', 'owner_device']
const CONTROL_MODES = ['code', 'full']

// Caches the last result for a tuple of inputs, compared by identity.
function memoizeArgs(fn) {
  let lastArgs = null
  let lastResult
  return (...args) => {
    if (lastArgs && lastArgs.length === args.length && lastArgs.every((value, index) => Object.is(value, args[index]))) return lastResult
    lastArgs = args
    lastResult = fn(...args)
    return lastResult
  }
}

const visibleOf = memoizeArgs((sessions) => visibleSessions(sessions))
const countsOf = memoizeArgs((sessions, sessionStarted) => countByState(visibleOf(sessions), sessionStarted))
const waitingOf = memoizeArgs((sessions, sessionStarted) => visibleOf(sessions).filter((session) => sessionStateOf(session, sessionStarted).state === 'waiting'))
const summaryOf = memoizeArgs((workspaces, sessions, sessionStarted) => (workspaces || [])
  .filter((workspace) => !workspace.is_quick)
  .map((workspace) => ({ workspace, counts: countByState(visibleSessionsOf(sessions, workspace.id), sessionStarted) })))

const perKey = (factory) => {
  const cache = new Map()
  return (key) => {
    if (!cache.has(key)) cache.set(key, memoizeArgs(factory(key)))
    return cache.get(key)
  }
}
const visibleOfWorkspace = perKey((workspaceId) => (sessions) => visibleSessionsOf(sessions, workspaceId))
const recentOf = perKey((limit) => (sessions) => recentSessions(sessions, { limit }))

export const selectView = (s) => viewOf(s)
export const selectVisibleSessions = (s) => visibleOf(s.sessions)
export const selectVisibleSessionsOf = (workspaceId) => (s) => visibleOfWorkspace(workspaceId)(s.sessions)
export const selectRecentSessions = (limit = 8) => (s) => recentOf(limit)(s.sessions)
// {running, waiting, done, failed, stopped, total}
export const selectCounts = (s) => countsOf(s.sessions, s.sessionStarted)
export const selectWaitingSessions = (s) => waitingOf(s.sessions, s.sessionStarted)
export const selectSessionState = (id) => (s) => sessionStateOf(s.sessions[id], s.sessionStarted)
export const selectSessionCost = (id) => (s) => s.sessionCosts?.[id]?.cost_usd ?? s.sessions[id]?.total_cost_usd ?? null
export const selectSessionTokens = (id) => (s) => s.sessionCosts?.[id]?.tokens ?? s.sessions[id]?.token_count ?? null
const EMPTY = Object.freeze([])
export const selectChangedFiles = (id) => (s) => s.changedFiles?.[id] || EMPTY
export const selectLastTool = (id) => (s) => s.sessionLastTool?.[id] || null
export const selectProjectSummary = (s) => summaryOf(s.workspaces, s.sessions, s.sessionStarted)
export const selectIsOwner = (s) => OWNER_ACTORS.includes(s.currentAuth?.actor_kind)
// Allow/Deny/Stop/Restart are shown only when the viewer may control PTYs.
export const selectCanControl = (s) => CONTROL_MODES.includes(s.currentAuth?.mode)
