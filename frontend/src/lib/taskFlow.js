import { api } from './api'
import useStore from '../state/store'

export const TASK_DRAFT_KEY = 'ive-task-draft.v1'
export function readTaskDraft() {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_DRAFT_KEY))
    return value && typeof value.goal === 'string' && typeof value.requestId === 'string' ? value : null
  } catch { return null }
}
export function saveTaskDraft(draft) {
  try { localStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(draft)) }
  catch { return false }
  window.dispatchEvent(new Event('task-draft-changed'))
  return true
}
export function clearTaskDraft(requestId) {
  if (readTaskDraft()?.requestId !== requestId) return
  try { localStorage.removeItem(TASK_DRAFT_KEY) } catch { return }
  window.dispatchEvent(new Event('task-draft-changed'))
}
export function pipelineOutput(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/^__pipeline_result:(pass|fail):([\s\S]*)$/)
  return { result: match?.[1] || null, text: match ? match[2].trim() : raw }
}
export function hasPassingVerification(run) {
  const verify = run?.stage_history?.verify
  // Match task_review.py exactly; display formatting is more permissive.
  return verify?.status === 'completed' && String(verify.output_summary || '').startsWith('__pipeline_result:pass:')
}
export function canAcceptTaskResult(task, run) {
  return task?.status === 'review' && run?.status === 'completed' && hasPassingVerification(run)
}
export function taskNextStep(task, run) {
  if (task.status === 'done' && !['running', 'paused'].includes(run?.status)) return { label: 'Accepted', detail: 'This task is complete.', step: 5, tone: 'good' }
  if (run?.status === 'paused') {
    const approval = run.current_stages?.includes('approval') && run.stage_history?.approval?.output_summary?.startsWith('waiting_for_plan_approval')
    return approval
      ? { label: 'Approve the plan', detail: 'Review the proposed work before implementation begins.', step: 1, approval: true }
      : { label: 'Run paused', detail: 'Inspect the run before resuming. No new stages will start while paused.', step: 2 }
  }
  if (run && !['running', 'completed'].includes(run.status)) return { label: 'Needs attention', detail: `Run ${run.status.replaceAll('_', ' ')}. Inspect the stage reports before trying again.`, step: 2, tone: 'danger' }
  if (run?.status === 'running') {
    const stages = run.current_stages || []
    if (stages.some((id) => ['plan', 'plan_critic', 'plan_gate', 'research', 'approval'].includes(id))) return { label: 'Planning', detail: 'IVE is preparing and checking the plan. Your approval comes next.', step: 1 }
    if (stages.some((id) => ['verify', 'verify_gate'].includes(id))) return { label: 'Checking the result', detail: 'The testing agent is checking the implementation against your criteria.', step: 3 }
    return { label: stages.includes('fix') ? 'Fixing issues' : 'Working', detail: 'Follow the stage reports or open the agent session for live output.', step: 2 }
  }
  if (task.status === 'review') return canAcceptTaskResult(task, run)
    ? { label: 'Review the result', detail: 'Read the changes and test evidence, then accept the result or request another pass.', step: 4 }
    : { label: 'Review in the task board', detail: 'This result has no completed run with a passing verification report. Use the full task board to inspect the work and choose its status manually.', step: 4, boardReview: true }
  if (task.status === 'blocked') return { label: 'Needs attention', detail: 'Open the task details to resolve the blocker.', step: 2, tone: 'danger' }
  if (!run && ['planning', 'in_progress', 'testing', 'documenting'].includes(task.status)) return { label: 'Work in progress', detail: 'This task uses a direct session. Follow its work in the task board or assigned session.', step: task.status === 'testing' ? 3 : 2 }
  if (run?.status === 'completed') return { label: 'Run completed', detail: 'Inspect the reports and task status in the full task details.', step: 4 }
  return { label: 'Ready to plan', detail: 'Prepare a plan and review it before implementation starts.', step: 0 }
}
export async function connectProject(project) {
  const store = useStore.getState()
  let workspace = store.workspaces.find((ws) => ws.id === project.workspace_id || ws.path === project.path)
  let created = false
  if (!workspace) {
    try { workspace = await api.createWorkspace(project.path); created = true }
    catch (error) {
      if (error.status !== 409 || !error.body?.existing?.id) throw error
      const all = await api.getWorkspaces()
      useStore.getState().setWorkspaces(all)
      workspace = all.find((ws) => ws.id === error.body.existing.id)
      if (!workspace) throw error
    }
  }
  const latest = useStore.getState()
  latest.setWorkspaces([...latest.workspaces.filter((ws) => ws.id !== workspace.id), workspace])
  latest.setActiveWorkspace(workspace.id)
  window.dispatchEvent(new CustomEvent('workspace-selected', { detail: { id: workspace.id } }))
  return { workspace, created }
}
