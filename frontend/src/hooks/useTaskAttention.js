import { useEffect, useMemo } from 'react'
import useStore from '../state/store'
import { api } from '../lib/api'
import { taskAttention } from '../lib/sessionAttention'

const POLL_MS = 15000

// Tasks and pipeline runs that need a human (plan approval, command approval,
// review, blocked). Polls every 15 s while mounted; the items feed the Board
// badge and the "Needs you" list on Home.
export default function useTaskAttention({ enabled = true } = {}) {
  const tasks = useStore((s) => s.tasks)
  const pipelineRuns = useStore((s) => s.pipelineRuns)

  useEffect(() => {
    if (!enabled) return undefined
    let disposed = false, timer
    async function refresh() {
      try {
        const before = useStore.getState()
        const [items, runs] = await Promise.all([api.getTasks(), api.listPipelineRuns()])
        if (!disposed) {
          const current = useStore.getState()
          if (current.tasks === before.tasks && Array.isArray(items)) current.loadTasks(items)
          if (current.pipelineRuns === before.pipelineRuns && Array.isArray(runs)) useStore.setState({ pipelineRuns: runs })
        }
      } catch { /* Existing task views provide retry controls. */ }
      if (!disposed) timer = setTimeout(refresh, POLL_MS)
    }
    refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [enabled])

  const items = useMemo(() => Object.values(tasks || {}).map((task) => {
    const attention = taskAttention(task, pipelineRuns)
    return attention ? {
      taskId: task.id, title: attention.title, message: attention.message,
      name: task.title, workspaceId: task.workspace_id,
    } : null
  }).filter(Boolean), [tasks, pipelineRuns])

  return { items, count: items.length }
}
