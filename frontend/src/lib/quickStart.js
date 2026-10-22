import { offerUndo } from './undoAction'
// Quick start: open a coding session without choosing a workspace first.
// The backend starts the agent in the quick start root (default ~/Projekte);
// the agent finds the project itself and the session can be attached later.
import useStore from '../state/store'
import { api } from './api'
import { getCliTypes, getDefaultModel, getModelsForCli } from './constants'
import { sendTerminalCommand } from './terminal'
import { lastOutputAt } from './terminalWriters'

const LAST_USED_KEY = 'ive-quickstart-last'

export function readLastUsed() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_USED_KEY) || 'null')
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

export function rememberLastUsed(cliType, model) {
  try { localStorage.setItem(LAST_USED_KEY, JSON.stringify({ cli_type: cliType, model: model || '' })) } catch { /* private mode */ }
}

/** Agent + model for a new session: the last used choice if still valid. */
export function lastAgentChoice(cliTypes = getCliTypes()) {
  const last = readLastUsed()
  const ids = cliTypes.map((c) => c.id)
  const cli = last?.cli_type && ids.includes(last.cli_type) ? last.cli_type : (ids[0] || 'claude')
  const models = getModelsForCli(cli)
  const model = last?.cli_type === cli && last.model && (models.length === 0 || models.some((m) => m.id === last.model))
    ? last.model
    : getDefaultModel(cli)
  return { cli, model }
}

/** "/Users/max/Projekte" → "~/Projekte" for display. */
export function shortenHome(path) {
  if (!path) return ''
  return String(path).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
}

/** Session name from the first words of what the user typed. */
export function nameFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  const words = clean.split(' ').slice(0, 6).join(' ')
  return words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words
}

export function isQuickWorkspace(ws, quickStart = useStore.getState().quickStart) {
  if (!ws) return false
  return !!ws.is_quick || (!!quickStart?.workspace_id && ws.id === quickStart.workspace_id)
}

export function isQuickSession(session, quickStart = useStore.getState().quickStart) {
  if (!session) return false
  if (typeof session.quick === 'boolean') return session.quick
  return !!quickStart?.workspace_id && session.workspace_id === quickStart.workspace_id
}

export async function loadQuickStart() {
  const info = await api.getQuickStart()
  if (info && typeof info === 'object') useStore.getState().setQuickStart(info)
  return info
}

export async function updateQuickStartRoot(root) {
  const info = await api.setQuickStart(root)
  if (info && typeof info === 'object') {
    useStore.getState().setQuickStart(info)
    // The quick workspace moved with the root; keep the sidebar in sync.
    if (info.workspace_id) {
      useStore.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === info.workspace_id ? { ...w, path: info.root } : w)),
      }))
    }
  }
  return info
}

/** Real projects only: every workspace except the start-folder one. */
export function projectWorkspaces(workspaces, quickStart = useStore.getState().quickStart) {
  return (workspaces || []).filter((ws) => !isQuickWorkspace(ws, quickStart))
}

function projectOrNull(store, id) {
  if (!id) return null
  const ws = store.workspaces.find((w) => w.id === id)
  return ws && !isQuickWorkspace(ws, store.quickStart) ? ws.id : null
}

/**
 * The project a new session belongs to when the user did not pick one:
 * the project of the session on screen, else the selected project. null
 * means "no project": the session starts in the quick start folder.
 */
export function currentProjectId(store = useStore.getState()) {
  if (!store.showHome && store.activeSessionId) {
    const session = store.sessions?.[store.activeSessionId]
    if (session?.workspace_id && store.workspaces.some((w) => w.id === session.workspace_id)) {
      return projectOrNull(store, session.workspace_id)
    }
  }
  return projectOrNull(store, store.activeWorkspaceId)
}

/**
 * ⌘N, "+ New session", palette, Home, sidebar "New Session": the short
 * prompt. `workspaceId` picks the project (null = no project, start folder);
 * left out, the current project is used.
 */
export function openQuickStart(options) {
  const target = options && Object.prototype.hasOwnProperty.call(options, 'workspaceId')
    ? (options.workspaceId || null)
    : currentProjectId()
  useStore.setState({ quickStartOpen: true, quickStartWorkspaceId: target, newSessionWorkspaceId: null })
}

/**
 * ⌘⇧N, "Set up session…": the full NewSessionDialog for a project
 * (`workspaceId`, default: the current project). Without a project it opens
 * in the start folder, never in an arbitrary first project.
 */
export async function openSessionSetup(workspaceId) {
  const store = useStore.getState()
  const target = workspaceId === undefined ? currentProjectId(store) : workspaceId
  if (target) {
    useStore.setState({ quickStartOpen: false, newSessionWorkspaceId: target })
    return true
  }
  let quickId = store.quickStart?.workspace_id
  if (!quickId || !store.workspaces.some((w) => w.id === quickId)) {
    try {
      const ws = await api.ensureQuickWorkspace()
      if (ws?.id) {
        quickId = ws.id
        const current = useStore.getState()
        current.setQuickStart({ ...(current.quickStart || {}), root: ws.path, workspace_id: ws.id })
        if (!current.workspaces.some((w) => w.id === ws.id)) current.setWorkspaces([...current.workspaces, { ...ws, is_quick: true }])
      }
    } catch { quickId = null }
  }
  if (quickId) {
    useStore.setState({ quickStartOpen: false, newSessionWorkspaceId: quickId })
    return true
  }
  useStore.setState({ quickStartOpen: false })
  window.dispatchEvent(new CustomEvent('open-add-workspace'))
  return false
}

async function ensureWorkspaceLoaded(workspaceId) {
  if (!workspaceId) return
  if (useStore.getState().workspaces.some((w) => w.id === workspaceId)) return
  try {
    const list = await api.getWorkspaces()
    if (Array.isArray(list)) useStore.getState().setWorkspaces(list)
  } catch { /* the session still opens; the sidebar catches up on reload */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Statuses after which a PTY will not read input any more.
const DEAD_STATUSES = new Set(['exited', 'error', 'failed', 'auth_failed', 'stopped', 'crashed'])

/**
 * Send text as the agent's first message once it can take input: after
 * start_pty plus the boot delay (ensureSessionRunning) and after the TUI has
 * drawn something and gone quiet, so Claude Code's input box exists.
 *
 * A slow CLI start (MCP servers, auth refresh, cold npx) can stay silent for
 * many seconds; typing into it then is lost, so this waits for the first
 * output for up to maxWaitMs instead of sending blind after a few seconds.
 * The message shows in the conversation pane like a composer send. If the
 * agent dies first, the text goes back into the composer instead of being
 * dropped. Resolves true when the message was handed to the terminal queue.
 */
export async function sendWhenAgentReady(sessionId, text, { quietMs = 700, settleMs = 1200, maxWaitMs = 120000 } = {}) {
  const message = String(text || '').trim()
  if (!sessionId || !message) return false
  const store = useStore.getState()
  let started = true
  store.beginReplyWait?.(sessionId, { content: message })
  try { started = (await store.ensureSessionRunning?.(sessionId)) !== false } catch { /* drain retries */ }
  const begin = Date.now()
  let firstOutputSeenAt = 0
  let dead = !started
  while (!dead && Date.now() - begin < maxWaitMs) {
    const sess = useStore.getState().sessions[sessionId]
    if (!sess) return false // deleted meanwhile
    if (DEAD_STATUSES.has(String(sess.status || '').toLowerCase())) { dead = true; break }
    const last = lastOutputAt.get(sessionId)
    if (last && !firstOutputSeenAt) firstOutputSeenAt = Date.now()
    if (last && sess.status !== 'replaying'
      && Date.now() - last >= quietMs && Date.now() - firstOutputSeenAt >= settleMs) break
    await sleep(150)
  }
  if (dead) {
    const current = useStore.getState()
    current.clearReplyWait?.(sessionId)
    if (!current.sessions[sessionId]) return false
    if (!current.sessionInputs?.[sessionId]?.trim()) current.setSessionInput?.(sessionId, message)
    current.addNotification?.({
      type: 'warning',
      sessionId,
      message: 'The agent stopped before it could take your first message. It is in the message box; restart and send it again.',
    })
    return false
  }
  const now = Date.now()
  useStore.getState().addOptimisticMessage?.(sessionId, {
    id: 'optimistic-first-' + now,
    session_id: sessionId,
    role: 'user',
    content: message,
    created_at: new Date(now).toISOString(),
    local_created_at: now,
  })
  sendTerminalCommand(sessionId, message)
  useStore.getState().setLastSentPrompt?.(sessionId, message)
  try {
    window.dispatchEvent(new CustomEvent('cc-session-messages-refresh', { detail: { sessionId } }))
  } catch { /* non-browser test env */ }
  return true
}

/**
 * Create a session in `workspaceId` (a project) or, without one, in the
 * quick start folder; open it large and focused, then deliver the text as
 * the first message. Returns the session JSON.
 */
export async function startQuickSession({ text = '', cliType, model, workspaceId } = {}) {
  const session = await api.quickSession({
    cli_type: cliType || undefined,
    model: model || undefined,
    name: nameFromText(text),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  })
  if (!session?.id) throw new Error('The session could not be created.')
  rememberLastUsed(cliType || session.cli_type, model || session.model)
  const quick = { ...session, quick: typeof session.quick === 'boolean' ? session.quick : !workspaceId }
  const store = useStore.getState()
  if (quick.quick && quick.workspace_id && store.quickStart?.workspace_id !== quick.workspace_id) {
    store.setQuickStart({ ...(store.quickStart || {}), workspace_id: quick.workspace_id })
  }
  store.addSession(quick)
  if (store.tabScope === 'workspace' && quick.workspace_id) store.setActiveWorkspace(quick.workspace_id)
  ensureWorkspaceLoaded(quick.workspace_id)
  // Queue after addSession's own start so the PTY starts at the fitted size.
  if (String(text || '').trim()) setTimeout(() => { sendWhenAgentReady(quick.id, text) }, 0)
  return quick
}

let directStart = null
/**
 * Home composer Enter: a conversation in the shown project (or the start
 * folder) with the last used agent. One start at a time.
 */
export function startDirectSession({ text, workspaceId }) {
  if (directStart) return directStart
  const { cli, model } = lastAgentChoice()
  directStart = startQuickSession({ text, cliType: cli, model, workspaceId })
    .finally(() => { directStart = null })
  return directStart
}

/** Attach a quick session to a project: { workspace_id } or { path }. */
export async function attachSessionToProject(sessionId, target, { undoable = true } = {}) {
  const body = target?.undo_token ? { undo_token: target.undo_token } : target?.workspace_id ? { workspace_id: target.workspace_id } : { path: target?.path }
  const result = await api.attachSession(sessionId, body)
  const store = useStore.getState()
  const workspace = result?.workspace
  if (workspace?.id) {
    const exists = store.workspaces.some((w) => w.id === workspace.id)
    store.setWorkspaces(exists
      ? store.workspaces.map((w) => (w.id === workspace.id ? { ...w, ...workspace } : w))
      : [...store.workspaces, workspace])
  }
  const prev = store.sessions[sessionId]
  const next = result?.session || (prev && workspace?.id ? { ...prev, workspace_id: workspace.id } : null)
  if (next) store.loadSessions([{ ...prev, ...next, quick: isQuickWorkspace(workspace) }])
  store.clearProjectHint(sessionId)
  if (undoable && result?.undo_token) offerUndo(`Moved to ${workspace?.name || target?.name || 'project'}.`, () => attachSessionToProject(sessionId, { undo_token: result.undo_token }, { undoable: false }))
  return result
}

/** One message with the chosen guidelines and the note, for a running agent. */
export function composeContextMessage(guidelines = [], note = '') {
  const parts = []
  for (const g of guidelines) {
    const content = String(g?.content || '').trim()
    if (!content) continue
    parts.push(`## ${g.name || 'Guideline'}\n${content}`)
  }
  const trimmedNote = String(note || '').trim()
  if (!parts.length) return trimmedNote
  const intro = 'Additional context for this session. Keep it in mind for the rest of the work.'
  return [intro, ...parts, ...(trimmedNote ? [`## Note\n${trimmedNote}`] : [])].join('\n\n')
}

/**
 * What a start target means, for labels: a project (name + folder) or no
 * project (the quick start folder).
 */
export function describeTarget(workspaceId, store = useStore.getState()) {
  const ws = workspaceId ? store.workspaces.find((w) => w.id === workspaceId) : null
  if (ws && !isQuickWorkspace(ws, store.quickStart)) {
    return { isProject: true, name: ws.name || String(ws.path || '').split('/').pop() || 'Project', path: ws.path || '', short: shortenHome(ws.path) }
  }
  const root = store.quickStart?.root || ''
  return { isProject: false, name: 'No project', path: root, short: shortenHome(root) || '~/Projekte' }
}
