// The only way to count or list sessions. IVE's own helper sessions
// (Commander, Brainstormer) are hidden everywhere except ⌘K; archived and
// read-only (other users' Brainstormers) sessions are out unless asked for.
// planner/tester/documentor/architect/test_worker are real work and stay.
import { sessionStateOf, toMillis } from './sessionVocabulary.js'

export const HELPER_SESSION_TYPES = new Set(['commander', 'brainstormer'])

export function isHelperSession(session) {
  return HELPER_SESSION_TYPES.has(String(session?.session_type || '').toLowerCase())
}

export function isVisibleSession(session, { includeArchived = false, includeReadOnly = false } = {}) {
  if (!session || !session.id || isHelperSession(session)) return false
  if (!includeArchived && session.archived) return false
  if (!includeReadOnly && session.read_only) return false
  return true
}

export function visibleSessions(sessionsMap, opts) {
  return Object.values(sessionsMap || {}).filter((session) => isVisibleSession(session, opts))
}

export function visibleSessionsOf(sessionsMap, workspaceId, opts) {
  return visibleSessions(sessionsMap, opts).filter((session) => !workspaceId || session.workspace_id === workspaceId)
}

const stampOf = (session) => {
  const at = toMillis(session.last_active_at || session.updated_at || session.created_at)
  return Number.isFinite(at) ? at : 0
}

export function recentSessions(sessionsMap, { limit = 8, workspaceId = null, ...opts } = {}) {
  return visibleSessionsOf(sessionsMap, workspaceId, opts)
    .sort((a, b) => stampOf(b) - stampOf(a) || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, limit)
}

// { running, waiting, done, failed, stopped, total }
export function countByState(sessionsArray, sessionStarted = {}) {
  const counts = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0, total: 0 }
  for (const session of sessionsArray || []) {
    counts[sessionStateOf(session, sessionStarted).state] += 1
    counts.total += 1
  }
  return counts
}
