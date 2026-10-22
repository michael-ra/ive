// WebSocket messages that are not tied to one session. useWebSocket runs
// these before its `if (!data.session_id) return` guard; anything that only
// arrived with a workspace_id (or nothing) used to be dropped there.
//
// `ctx` keeps this module free of React/zustand so it can be unit tested:
//   store            useStore.getState()
//   dispatch(n, d)   window.dispatchEvent(new CustomEvent(n, { detail: d }))
//   refreshWorkspaces()  reload the workspace list from the API

function handleResearch(data, { store, dispatch }) {
  // research_error is a failed run: reuse the research_done(failed) path
  // so panels refresh and the user sees a toast.
  if (data.type === 'research_error') data = { ...data, type: 'research_done', status: 'failed' }
  // Job-scoped, not session-scoped. One DOM event per message (cc-research_*);
  // a second dash alias used to make ResearchHub log and toast everything twice.
  dispatch('cc-' + data.type, data)
  if (data.type === 'research_done' && data.status === 'failed') {
    store.addNotification({
      type: 'error',
      message: `Research failed: ${data.error || 'no findings written'}`,
    })
  }
  return true
}

export function handleGlobalEvent(data, ctx) {
  const { store, dispatch } = ctx
  switch (data.type) {
    case 'research_started':
    case 'research_progress':
    case 'research_done':
    case 'research_error':
      return handleResearch(data, ctx)

    case 'session_update': {
      // Full session row (e.g. after a quick session was attached to a
      // project: workspace_id and quick flip).
      const session = data.session
      if (!session?.id) return true
      const prev = store.sessions[session.id]
      store.loadSessions([{ ...(prev || {}), ...session }])
      if (session.quick === false) store.clearProjectHint(session.id)
      const wsId = session.workspace_id
      if (wsId && !store.workspaces.some((w) => w.id === wsId)) ctx.refreshWorkspaces?.()
      return true
    }

    case 'test_queue_update':
      // Workspace-scoped; the overview dashboard refreshes its queue counts.
      dispatch('test-queue-update', data)
      return true

    case 'auto_exec_dispatch': {
      const duplicate = store.notifications.some((n) => (
        n.type === 'info' && n.source === 'auto_exec' && n.taskId === data.task_id
      ))
      if (!duplicate) {
        store.addNotification({
          type: 'info',
          source: 'auto_exec',
          taskId: data.task_id,
          workspaceId: data.workspace_id,
          message: `Task handed to Commander: ${data.title || data.task_id}`,
        })
      }
      return true
    }

    case 'workspace_preview_registered': {
      // An agent registered a dev-server preview: the workspace's preview_url
      // feeds the preview palette, so patch it in place.
      if (!data.workspace_id || !data.preview_url) return true
      let changed = false
      const next = store.workspaces.map((w) => {
        if (w.id !== data.workspace_id || w.preview_url === data.preview_url) return w
        changed = true
        return { ...w, preview_url: data.preview_url }
      })
      if (changed) store.setWorkspaces(next)
      return true
    }

    case 'phone_paired':
      // PhonePanel reloads its device list immediately instead of waiting
      // for the next poll tick.
      dispatch('ive:phone-paired', { device_id: data.device_id, label: data.label })
      return true

    default:
      return false
  }
}
