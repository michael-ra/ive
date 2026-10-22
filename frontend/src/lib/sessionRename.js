import { create } from 'zustand'
import { api } from './api'
import useStore from '../state/store'

// Render the editor in the app: native prompt() is unavailable in some WebViews.
export const useSessionRename = create(() => ({ request: null }))

export function requestSessionRename(sessionId) {
  const session = useStore.getState().sessions[sessionId]
  if (!session || useSessionRename.getState().request) return
  useSessionRename.setState({ request: { id: sessionId, name: session.name || '', pending: false, error: null } })
}

export function cancelSessionRename() {
  if (!useSessionRename.getState().request?.pending) useSessionRename.setState({ request: null })
}

export async function saveSessionRename(value) {
  const request = useSessionRename.getState().request
  const name = value.trim()
  if (!request || request.pending || !name) return false
  if (name === request.name) {
    cancelSessionRename()
    return true
  }
  useSessionRename.setState({ request: { ...request, pending: true, error: null } })
  try {
    const updated = await api.renameSession(request.id, name)
    // Preserve live process state and do not revive a session deleted meanwhile.
    if (useStore.getState().sessions[request.id]) {
      useStore.getState().loadSessions([{ id: request.id, name: updated?.name || name }])
    }
    useSessionRename.setState({ request: null })
    return true
  } catch (err) {
    useSessionRename.setState({ request: { ...request, pending: false,
      error: `Could not rename this session: ${err?.message || 'unknown error'}. Please try again.` } })
    return false
  }
}
