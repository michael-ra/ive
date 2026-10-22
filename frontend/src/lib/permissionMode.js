import { api } from './api'
import useStore from '../state/store'

export async function refreshPermissionMode(sessionId) {
  const info = await api.getPermissionModeApply(sessionId)
  useStore.getState().setPermissionApply(sessionId, info)
  return info
}

export async function changePermissionMode(sessionId, mode) {
  const session = useStore.getState().sessions[sessionId]
  if (!session || session.read_only) return
  try {
    const updated = await api.updateSession(sessionId, { permission_mode: mode, apply_live: true })
    useStore.getState().setPermissionApply(sessionId, updated.permission_apply)
    useStore.setState(state => state.sessions[sessionId] ? {
      sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], permission_mode: updated.permission_mode ?? mode } },
    } : {})
  } catch (error) {
    useStore.getState().addNotification({ type: 'error', sessionId, message: error?.message || 'Could not change the agent mode.' })
  }
}

export async function applyPermissionModeNow(sessionId) {
  try {
    const result = await api.applyPermissionModeNow(sessionId)
    if (['applied', 'none'].includes(result.state)) {
      useStore.getState().setLaunchApply(sessionId, 'model', null)
      useStore.getState().setLaunchApply(sessionId, 'effort', null)
    }
  } catch (error) {
    useStore.getState().addNotification({ type: 'error', sessionId, message: error?.message || 'Could not apply the new mode.' })
  } finally {
    // The response may summarize several fields. Read the exact mode state,
    // including a failure's previous value, rather than replacing it blindly.
    await refreshPermissionMode(sessionId).catch(() => {})
  }
}
