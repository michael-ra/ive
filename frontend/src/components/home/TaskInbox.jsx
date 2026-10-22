import { useEffect, useState } from 'react'
import { ArrowRight, CheckCheck, ClipboardList, FilePenLine } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { readTaskDraft, taskNextStep } from '../../lib/taskFlow'

const labels = { backlog: 'Ready to plan', todo: 'Ready', planning: 'Planning', in_progress: 'Working', review: 'Review result', testing: 'Checking', documenting: 'Documenting', blocked: 'Needs attention', done: 'Accepted' }
const rank = (task) => task.pipeline_stage === 'awaiting_plan_approval' || task.status === 'review' || task.status === 'blocked' ? 0 : task.status === 'done' ? 2 : 1

export default function TaskInbox({ workspaceId, onOpen, onResumeDraft, onBoard }) {
  const tasks = useStore((s) => s.tasks)
  const pipelineRuns = useStore((s) => s.pipelineRuns)
  const [draft, setDraft] = useState(readTaskDraft)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const update = () => setDraft(readTaskDraft())
    window.addEventListener('task-draft-changed', update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener('task-draft-changed', update); window.removeEventListener('storage', update) }
  }, [])
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    Promise.all([api.getTasks(workspaceId || undefined), api.listPipelineRuns(workspaceId || undefined)]).then(([items, runs]) => {
      if (alive) {
        useStore.getState().loadTasks(items)
        // The API breaks equal timestamps by insertion order. Preserve its
        // newest-first ordering; prepending each result reverses those ties.
        const ids = new Set(runs.map((run) => run.id))
        useStore.setState((state) => ({ pipelineRuns: [...runs, ...state.pipelineRuns.filter((run) => !ids.has(run.id))] }))
      }
    }).catch((err) => { if (alive) setError(err.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [workspaceId, retry])
  const latestRun = (task) => pipelineRuns.filter((run) => run.task_id === task.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
  const needsAttention = (task) => {
    const run = latestRun(task)
    return run && ['paused', 'failed', 'max_iterations', 'budget_exceeded', 'cancelled'].includes(run.status) ? 0 : rank(task)
  }
  const all = Object.values(tasks).filter((task) => !workspaceId || task.workspace_id === workspaceId)
    .sort((a, b) => needsAttention(a) - needsAttention(b) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  const visible = all.slice(0, 6)
  return <section className="ive-task-inbox" aria-labelledby="your-tasks-title">
    <header className="ive-panel-heading">
      <span className="ive-panel-icon is-accent"><ClipboardList size={18} /></span>
      <div className="flex-1"><p className="ive-eyebrow">From request to result</p><h2 id="your-tasks-title">Your tasks</h2></div>
      <button type="button" className="ive-text-action" onClick={onBoard}>Open board <ArrowRight size={14} /></button>
    </header>
    {draft && <button className="ive-task-row" type="button" onClick={onResumeDraft}><FilePenLine size={18} /><span className="min-w-0 flex-1"><strong className="block truncate">{draft.goal || 'Untitled task'}</strong><span className="text-xs text-x-muted">{draft.submitted ? 'Continue setup · your request is saved' : 'Draft · continue where you left off'}</span></span><ArrowRight size={16} /></button>}
    {error && <p role="alert" className="ive-flow-error">Could not refresh tasks: {error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
    {visible.map((task) => <button type="button" className="ive-task-row" key={task.id} onClick={() => onOpen(task.id)}>
      {task.status === 'done' ? <CheckCheck size={18} className="text-x-good" /> : <span className={`ive-task-status-dot ${rank(task) === 0 ? 'is-attention' : ''}`} />}
      <span className="min-w-0 flex-1"><strong className="block truncate">{task.title}</strong><span className="text-xs text-x-muted">{latestRun(task) ? taskNextStep(task, latestRun(task)).label : task.pipeline_stage === 'awaiting_plan_approval' ? 'Approve plan' : labels[task.status] || task.status}</span></span>
      <ArrowRight size={16} className="text-x-muted" />
    </button>)}
    {!visible.length && !draft && !error && <p className="ive-task-empty">{loading ? 'Loading tasks…' : 'Describe what you want to change above. Your plan, progress, and results will appear here.'}</p>}
    {all.length > 6 && <button type="button" className="ive-text-action mt-3" onClick={onBoard}>View all {all.length} tasks <ArrowRight size={14} /></button>}
  </section>
}
