// Plain terminal sessions (cli_type "shell"): the user's login shell in a
// project folder, like a Mac Terminal window. No agent, no chat view, no
// model / permission / effort, status is just Running or Exited.
import useStore from '../state/store'
import { api } from './api'
import { lastOutputAt } from './terminalWriters'

export { SHELL_CLI, SHELL_LABEL, isShellSession, isShellCli, getShellStatusMeta } from './sessionStatus.js'
import { SHELL_CLI, SHELL_LABEL } from './sessionStatus.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Type one line into a shell once its prompt has been drawn. */
export async function typeIntoShellWhenReady(sessionId, line, { quietMs = 400, maxWaitMs = 15000 } = {}) {
  const text = String(line || '').trim()
  if (!sessionId || !text) return false
  try { await useStore.getState().ensureSessionRunning?.(sessionId) } catch { /* retried below */ }
  const begin = Date.now()
  while (Date.now() - begin < maxWaitMs) {
    const last = lastOutputAt.get(sessionId)
    if (last && Date.now() - last >= quietMs) break
    await sleep(100)
  }
  const ws = useStore.getState().ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: `${text}\r` }))
  return true
}

function openShell(session) {
  const store = useStore.getState()
  store.addSession(session)
  if (store.tabScope === 'workspace' && session.workspace_id) store.setActiveWorkspace(session.workspace_id)
  return session
}

/** New terminal in a project (workspace) folder. */
export async function createTerminalSession(workspaceId, { name } = {}) {
  const session = await api.createSession(workspaceId, { cli_type: SHELL_CLI, name: name || SHELL_LABEL })
  if (!session?.id) throw new Error('The terminal could not be created.')
  return openShell(session)
}

/**
 * ⌘N with "Terminal": a shell in the chosen project (workspaceId) or the
 * quick start folder; text runs as a command.
 */
export async function startQuickTerminal({ text = '', workspaceId } = {}) {
  if (workspaceId) {
    const shell = await createTerminalSession(workspaceId)
    if (String(text || '').trim()) setTimeout(() => { typeIntoShellWhenReady(shell.id, text) }, 0)
    return shell
  }
  const session = await api.quickSession({ cli_type: SHELL_CLI, name: SHELL_LABEL })
  if (!session?.id) throw new Error('The terminal could not be created.')
  const quick = { ...session, quick: session.quick !== false }
  const store = useStore.getState()
  if (quick.workspace_id && store.quickStart?.workspace_id !== quick.workspace_id) {
    store.setQuickStart({ ...(store.quickStart || {}), workspace_id: quick.workspace_id })
  }
  openShell(quick)
  if (String(text || '').trim()) setTimeout(() => { typeIntoShellWhenReady(quick.id, text) }, 0)
  return quick
}

/** Palette "New terminal": in the active project, else the quick start folder. */
export async function newTerminal() {
  const store = useStore.getState()
  const workspaceId = store.activeWorkspaceId && store.workspaces.some((w) => w.id === store.activeWorkspaceId)
    ? store.activeWorkspaceId
    : null
  return workspaceId ? createTerminalSession(workspaceId) : startQuickTerminal()
}
