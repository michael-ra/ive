import { sessionNeedsAttention } from './sessionAttention.js'

const normalizeStatus = (value) => String(value || '').toLowerCase()

// Plain terminal sessions (cli_type "shell", see lib/shellSession.js): the
// user's login shell, no agent. Their only states are Running and Stopped.
export const SHELL_CLI = 'shell'
export const SHELL_LABEL = 'Terminal'

export function isShellSession(session) {
  return !!session && (session.cli_type === SHELL_CLI || session.session_type === SHELL_CLI)
}

export function isShellCli(cliType) {
  return cliType === SHELL_CLI
}

// One vocabulary everywhere (sidebar, board, header, phone): the five words
// Running / Waiting / Done / Failed / Stopped. `state` is the machine value,
// `label` the word, `tone` the finer reason that older callers (chat activity,
// phone ranking, composer queue) still branch on. The product words stay
// English in every UI language (lib/sessionVocabulary.js translates details).
const META = {
  running: { state: 'running', label: 'Running', dotClass: 'bg-x-accent animate-subtle-pulse', textClass: 'text-x-accent-ink' },
  waiting: { state: 'waiting', label: 'Waiting', dotClass: 'bg-x-warning animate-subtle-pulse', textClass: 'text-x-warning' },
  done: { state: 'done', label: 'Done', dotClass: 'bg-x-good', textClass: 'text-x-good' },
  failed: { state: 'failed', label: 'Failed', dotClass: 'bg-x-danger', textClass: 'text-x-danger' },
  stopped: { state: 'stopped', label: 'Stopped', dotClass: 'bg-x-faint', textClass: 'text-x-muted' },
}

const meta = (state, tone, isWorking = false) => ({ ...META[state], tone, isWorking })

export function getShellStatusMeta(session, sessionStarted = {}) {
  const status = normalizeStatus(session?.status)
  const alive = session?.pty_alive === true
    || (session?.pty_alive !== false && !!sessionStarted[session?.id] && !['exited', 'error', 'stopped'].includes(status))
  if (alive) return meta('running', 'shell-running')
  return meta('stopped', 'offline')
}

const WORKING = new Set(['running', 'working', 'executing'])
const WAITING = new Set(['prompting', 'waiting', 'input_needed', 'needs_input'])
const EXITED = new Set(['exited', 'offline', 'stopped', 'disconnected'])
const ERROR = new Set(['error', 'failed', 'crashed'])
const AUTH = new Set(['auth_failed'])
const REPLAYING = new Set(['replaying'])

export function hasSessionStarted(session, sessionStarted = {}) {
  if (!session) return false
  const status = normalizeStatus(session.status)
  return Boolean(
    session.pty_alive ||
    session.is_external ||
    sessionStarted[session.id] ||
    WORKING.has(status) ||
    WORKING.has(normalizeStatus(session.agentState))
  )
}

export function getSessionStatusMeta(status = 'idle', agentState = null, hasStarted = true) {
  const rawStatus = normalizeStatus(status) || 'idle'
  const rawAgentState = normalizeStatus(agentState)
  const state = rawAgentState || rawStatus

  if (AUTH.has(rawStatus) || AUTH.has(state)) return meta('failed', 'auth')
  if (ERROR.has(rawStatus) || ERROR.has(state)) return meta('failed', 'error')
  if (EXITED.has(rawStatus)) return meta('stopped', 'offline')
  if (WAITING.has(state) || WAITING.has(rawStatus)) return meta('waiting', 'waiting')
  if (REPLAYING.has(rawStatus)) return meta('running', 'replaying')
  if (WORKING.has(state) || WORKING.has(rawStatus)) return meta('running', 'working', true)
  if (!hasStarted && (rawStatus === 'idle' || rawStatus === 'ready' || !rawStatus)) return meta('stopped', 'not-started')
  return meta('done', 'ready')
}

export function getSubagentStatusMeta(status = 'running') {
  const rawStatus = normalizeStatus(status)
  if (WORKING.has(rawStatus)) {
    return {
      label: 'Running',
      dotClass: 'bg-x-accent animate-subtle-pulse',
    }
  }
  if (rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done') {
    return {
      label: 'Done',
      dotClass: 'bg-x-good',
    }
  }
  if (ERROR.has(rawStatus)) {
    return {
      label: 'Failed',
      dotClass: 'bg-x-danger',
    }
  }
  return {
    label: rawStatus || 'Idle',
    dotClass: 'bg-x-line-strong',
  }
}

// What a session looks like everywhere in the UI (sidebar, board cards,
// session header, phone list). Same words, same dot: an open question,
// permission prompt or startup blocker shows as "Waiting" even when the raw
// process status still says idle or running.
export function getSessionDisplayStatus(session, sessionStarted = {}) {
  if (isShellSession(session)) return getShellStatusMeta(session, sessionStarted)
  const result = getSessionStatusMeta(session?.status, session?.agentState, hasSessionStarted(session, sessionStarted))
  if (!session || result.tone === 'auth' || result.tone === 'error' || result.tone === 'offline' || result.tone === 'waiting') return result
  if (!sessionNeedsAttention(session)) return result
  return meta('waiting', 'waiting')
}
