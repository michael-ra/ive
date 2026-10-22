import { offerUndo } from './undoAction'
import { api } from './api'
import useStore from '../state/store'
import { create } from 'zustand'

const closing = new Map()
const continuing = new Map()

export function continueSession(sessionId, contextMode = 'handoff') {
  const key = `${sessionId}:${contextMode}`
  if (continuing.has(key)) return continuing.get(key)
  const operation = (async () => {
    const created = await api.cloneSession(sessionId, { context_mode: contextMode })
    useStore.getState().addSession(created)
    useStore.getState().goSession(created.id)
    return created
  })()
  continuing.set(key, operation)
  operation.then(() => continuing.delete(key), () => continuing.delete(key))
  return operation
}

// Closing is durable across views, windows and restarts. Archive retains the
// conversation; only the separately confirmed Delete action removes history.
export function closeSession(sessionId) {
  if (!sessionId || !useStore.getState().sessions[sessionId]) return Promise.resolve(false)
  if (closing.has(sessionId)) return closing.get(sessionId)
  const operation = (async () => {
    const session = useStore.getState().sessions[sessionId]
    try {
      if (!session.archived) await api.updateSession(sessionId, { archived: 1 })
      useStore.getState().setSessionArchived(sessionId, 1)
      useStore.getState().closeTab(sessionId)
      if (!session.archived) offerUndo(`Archived “${session.name || 'Session'}”.`, async()=>{
        await api.updateSession(sessionId,{archived:0})
        useStore.getState().setSessionArchived(sessionId,0)
        useStore.getState().goSession(sessionId)
      })
      return true
    } catch (err) {
      useStore.getState().addNotification?.({
        type: 'warning',
        message: `Could not close "${session.name || sessionId}": ${err?.message || 'unknown error'}`,
      })
      return false
    }
  })()
  closing.set(sessionId, operation)
  operation.finally(() => closing.delete(sessionId))
  return operation
}

// Browser JavaScript dialogs are not available in every desktop webview.
// Session and project deletion share one rendered, accessible confirmation.
export const useSessionDelete = create(() => ({ request: null }))
let deletionResult = null

export function deleteSessionWithConfirm(sessionId) {
  const session = useStore.getState().sessions[sessionId]
  if (!session) return Promise.resolve(false)
  return requestDeletion({ kind: 'session', id: sessionId, name: session.name || sessionId })
}

export function deleteWorkspaceWithConfirm(workspaceId) {
  const store = useStore.getState()
  const workspace = store.workspaces.find((item) => item.id === workspaceId)
  if (!workspace) return Promise.resolve(false)
  return requestDeletion({ kind: 'workspace', id: workspaceId, name: workspace.name || workspaceId,
    path: workspace.path, sessionCount: Object.values(store.sessions).filter((s) => s.workspace_id === workspaceId).length })
}

function requestDeletion(target) {
  const current = useSessionDelete.getState().request
  if (current) return current.id === target.id && current.kind === target.kind ? deletionResult.promise : Promise.resolve(false)
  let resolve
  const promise = new Promise((done) => { resolve = done })
  deletionResult = { promise, resolve }
  useSessionDelete.setState({ request: { ...target, pending: false, error: null } })
  return promise
}

function finishDeletion(deleted) {
  const result = deletionResult
  deletionResult = null
  useSessionDelete.setState({ request: null })
  result?.resolve(deleted)
}

export function cancelSessionDeletion() {
  if (useSessionDelete.getState().request?.pending) return
  finishDeletion(false)
}

export async function confirmSessionDeletion() {
  const request = useSessionDelete.getState().request
  if (!request || request.pending) return false
  useSessionDelete.setState({ request: { ...request, pending: true, error: null } })
  try {
    if (request.kind === 'workspace') {
      const result = await api.deleteWorkspace(request.id)
      useStore.getState().removeWorkspace(request.id, result?.session_ids)
    } else {
      await api.deleteSession(request.id)
      useStore.getState().removeSession(request.id)
    }
    finishDeletion(true)
    return true
  } catch (err) {
    useSessionDelete.setState({ request: { ...request, pending: false,
      error: `Could not delete "${request.name}": ${err?.message || 'unknown error'}. Please try again.` } })
    return false
  }
}
