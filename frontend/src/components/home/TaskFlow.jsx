import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ExternalLink, FolderSearch, Loader2, RefreshCw, Sparkles, Square, Terminal } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button, Modal } from '../ui'
import WorkspacePicker from '../workspace/WorkspacePicker'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { uuid } from '../../lib/uuid'
import { canAcceptTaskResult, clearTaskDraft, connectProject, hasPassingVerification, pipelineOutput, readTaskDraft, saveTaskDraft, taskNextStep } from '../../lib/taskFlow'

const PipelineRunDetail = lazy(() => import('../pipeline/PipelineRunDetail'))
const stageNames = { research: 'Research', plan: 'Proposed plan', plan_critic: 'Plan review', implement: 'What changed', fix: 'Corrections', verify: 'Test evidence' }
const executionOptions = { plan_first: true, auto_approve_plan: false, test_with_agent: true, ralph_loop: true, require_result_review: true }
const newId = uuid
const safeUrl = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null } catch { return null } }

function Report({ title, output, truncated, sessionId, onSession }) {
  const { text, result } = pipelineOutput(output)
  return <section className="ive-flow-report">
    <header><h3>{title}</h3>{result && <span className={`ive-result-badge ${result === 'fail' ? 'is-failed' : ''}`}>{result === 'pass' ? 'Reported pass' : 'Reported failure'}</span>}{sessionId && <button type="button" className="ive-text-action" onClick={() => onSession(sessionId)}><Terminal size={13} /> Session</button>}</header>
    {text ? <div className="ive-flow-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown></div> : <p className="text-sm text-x-muted">No report yet. Open the session to follow live work.</p>}
    {truncated && <p className="ive-flow-error">This report is truncated. Open the session for the complete output before approving.</p>}
  </section>
}

export default function TaskFlow({ initial = {}, onClose, onCreated, onBoard, onKnowledge }) {
  const workspaces = useStore((s) => s.workspaces)
  const [draft, setDraft] = useState(() => initial.resume ? readTaskDraft() || { goal: '', requestId: newId() } : {
    goal: initial.goal || '', workspaceId: initial.workspaceId || '', criteria: initial.criteria || '', context: initial.context || '',
    maxIterations: Number.isInteger(initial.maxIterations) && initial.maxIterations >= 1 && initial.maxIterations <= 20 ? initial.maxIterations : 3, requestId: newId(),
  })
  const [draftConflict, setDraftConflict] = useState(() => !initial.taskId && !initial.resume ? readTaskDraft() : null)
  const [taskId, setTaskId] = useState(initial.taskId || (initial.resume && readTaskDraft()?.taskId) || null)
  const [task, setTask] = useState(null)
  const [run, setRun] = useState(null)
  const [runs, setRuns] = useState([])
  const [picker, setPicker] = useState(() => !initial.taskId && !initial.resume && !initial.workspaceId && !!initial.goal && !readTaskDraft())
  const [detailRun, setDetailRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [loading, setLoading] = useState(Boolean(taskId))
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [changes, setChanges] = useState(null)
  const [changesError, setChangesError] = useState('')
  const [changesBusy, setChangesBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [revision, setRevision] = useState(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const refreshController = useRef(null)
  const lastTourState = useRef(null)
  const [tourCyclesChosen, setTourCyclesChosen] = useState(false)
  const workspace = workspaces.find((ws) => ws.id === (task?.workspace_id || draft.workspaceId))
  const current = task ? taskNextStep(task, run) : null
  const history = run?.stage_history || {}
  const verified = hasPassingVerification(run)
  const canAccept = canAcceptTaskResult(task, run)

  useEffect(() => {
    if (!initial.guidedTour) { lastTourState.current = null; return }
    // Publish observed state, not button clicks. In particular, approval,
    // cancellation and acceptance count only after a server response.
    const detail = {
      type: 'task-state', taskId: task?.id || taskId || null,
      workspaceId: task?.workspace_id || draft.workspaceId || null,
      runId: run?.id || null, runStatus: run?.status || null, taskStatus: task?.status || null,
      currentStages: run?.current_stages || [], iteration: run?.iteration ?? null,
      approval: !!current?.approval, current, canAccept, verified, inspected: !!changes,
    }
    const serialized = JSON.stringify(detail)
    // A coach update may re-render this dialog; don't create an event loop.
    if (serialized === lastTourState.current) return
    lastTourState.current = serialized
    window.dispatchEvent(new CustomEvent('ive-tour-event', { detail }))
  }, [initial.guidedTour, task, taskId, draft.workspaceId, run, current, canAccept, verified, changes])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!draftConflict && !initial.taskId && (!taskId || draft.submitted)) setStorageError(!saveTaskDraft(draft))
  }, [draft, taskId, initial.taskId, draftConflict])

  const refresh = useCallback(async () => {
    // Let slow reads finish. Starting another poll every 3.5 seconds used to
    // invalidate every response whenever the connection took longer than that.
    if (!taskId || busyRef.current || refreshController.current) return
    const controller = new AbortController()
    refreshController.current = controller
    const ticket = ++generation.current
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    try {
      const [nextTask, nextRuns] = await Promise.all([
        api.getTask(taskId, { signal: controller.signal }),
        api.listPipelineRuns(undefined, undefined, false, taskId, controller.signal),
      ])
      if (!mounted.current || generation.current !== ticket) return
      if (nextTask?.id !== taskId) throw new Error('Invalid task response')
      if (!Array.isArray(nextRuns)) throw new Error('Invalid run response')
      setTask(nextTask); setRuns(nextRuns)
      setRun(nextRuns.find((item) => ['running', 'paused'].includes(item.status)) || nextRuns[0] || null)
      useStore.getState().updateTaskInStore(nextTask)
      // A lost execute response is recovered from the server's persisted key.
      // Only reconcile this exact request; unrelated drafts remain untouched.
      const pending = readTaskDraft()
      if (pending?.submitted && pending.taskId === taskId && nextRuns.some((item) => item.variables?.request_id === pending.requestId)) {
        clearTaskDraft(pending.requestId)
        setDraft((value) => value.requestId === pending.requestId ? { ...value, submitted: false } : value)
      }
      setRefreshError('')
    } catch (err) {
      if (mounted.current && generation.current === ticket) setRefreshError(timedOut ? 'The server did not respond within 15 seconds. Please retry.' : err.message)
    }
    finally {
      clearTimeout(timeout)
      controller.abort()
      if (refreshController.current === controller) refreshController.current = null
      if (mounted.current && generation.current === ticket) setLoading(false)
    }
  }, [taskId])
  useEffect(() => {
    refresh()
    const timer = setInterval(() => { if (!document.hidden && !busyRef.current) refresh() }, 3500)
    return () => {
      clearInterval(timer); generation.current++
      refreshController.current?.abort(); refreshController.current = null
    }
  }, [refresh])

  const action = async (fn) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(''); generation.current++
    refreshController.current?.abort(); refreshController.current = null
    try { await fn() }
    catch (err) { if (mounted.current) setError(err.message || 'The action could not be completed. You can retry safely.') }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); refresh() } }
  }
  const plan = (input) => action(async () => {
    let saved = { ...(input?.requestId ? input : draft), submitted: true }
    setDraft(saved)
    if (!saveTaskDraft(saved)) setStorageError(true)
    let created = task
    if (!taskId) {
      try { created = await api.createTask({
        workspace_id: saved.workspaceId, title: saved.goal.trim().split('\n')[0].slice(0, 140), description: saved.goal.trim(),
        acceptance_criteria: (saved.criteria || '').trim(), status: 'backlog', labels: ['ive-guided'], request_id: saved.requestId, parent_task_id: saved.parentTaskId || null,
        pipeline: true, plan_first: true, test_with_agent: true, ralph_loop: true, pipeline_max_iterations: saved.maxIterations,
      }) } catch (err) {
        // Explicit rejection means creation did not happen; allow corrections.
        // Transport/server failures stay locked because the response is uncertain.
        if (err.status >= 400 && err.status < 500) {
          saved = { ...saved, submitted: false }
          setDraft(saved); saveTaskDraft(saved)
        }
        throw err
      }
      saved = { ...saved, taskId: created.id }
      saveTaskDraft(saved); setDraft(saved); setTaskId(created.id); setTask(created)
      useStore.getState().updateTaskInStore(created)
      onCreated?.()
    }
    if (saved.previousRunId) {
      // On a retry the replacement run may already exist. Do not reset its
      // task back to backlog or rewrite its request while it is executing.
      const previousAttempts = await api.listPipelineRuns(undefined, undefined, false, taskId)
      const recovered = previousAttempts.find((item) => item.variables?.request_id === saved.requestId)
      if (recovered) {
        setRun(recovered)
        clearTaskDraft(saved.requestId)
        setDraft((value) => ({ ...value, submitted: false }))
        return
      }
      const previous = await api.getPipelineRun(saved.previousRunId)
      if (previous.status === 'paused' && previous.current_stages?.includes('approval')) await api.updatePipelineRun(previous.id, 'cancel')
      else if (previous.status !== 'cancelled') throw new Error('The plan is no longer waiting for approval. Refresh before revising it.')
      await api.updateTask2(taskId, { description: saved.goal, status: 'backlog' })
    }
    const response = await api.executeTask(created?.id || taskId, { ...executionOptions, request_id: saved.requestId, pipeline_max_iterations: saved.maxIterations || 3, execution_context: saved.context || '' })
    setRun(response.run)
    clearTaskDraft(saved.requestId)
    setDraft((value) => ({ ...value, submitted: false }))
  })
  const replan = () => {
    const pending = readTaskDraft()
    if (pending && pending.taskId !== taskId) {
      setError('You have another saved draft. Continue it from Your tasks before starting another plan.')
      return
    }
    const saved = pending?.taskId === taskId && pending.submitted ? pending : {
      goal: current.approval ? `${task.description || task.title}\n\nPlan revision requested:\n${feedback.trim()}` : task.description || task.title,
      workspaceId: task.workspace_id, criteria: task.acceptance_criteria || '', taskId, maxIterations: task.pipeline_max_iterations || 3,
      context: run?.variables?.execution_context || '', requestId: newId(), previousRunId: current.approval ? run.id : null,
    }
    plan(saved)
  }
  const resume = () => action(async () => { await api.updatePipelineRun(run.id, 'resume') })
  const cancel = () => action(async () => {
    const stopped = await api.updatePipelineRun(run.id, 'cancel')
    if (stopped?.id !== run.id || stopped.status !== 'cancelled') throw new Error('The run did not confirm cancellation. Refresh its status before retrying.')
    setRun(stopped)
  })
  const accept = () => action(async () => {
    // Re-read before accepting so stale UI cannot approve a newly started run.
    const [freshTask, freshRuns] = await Promise.all([api.getTask(taskId), api.listPipelineRuns(undefined, undefined, false, taskId)])
    if (!canAcceptTaskResult(freshTask, freshRuns[0]) || freshRuns.some((item) => ['running', 'paused'].includes(item.status)) || freshRuns[0]?.id !== run.id) throw new Error('The task changed. Refresh and review its current result first.')
    const updated = await api.updateTask2(taskId, { status: 'done', reviewed_run_id: run.id })
    setTask(updated); useStore.getState().updateTaskInStore(updated)
  })
  const requestRevision = () => action(async () => {
    // Save a separate follow-up linked to the original task. Retain all previous
    // evidence and never silently restart an already accepted implementation.
    const pending = readTaskDraft()
    if (pending && pending.requestId !== revision?.requestId) throw new Error('You have a saved draft. Continue it from Your tasks before creating another follow-up.')
    const saved = revision || { goal: `Follow-up: ${task.title.slice(0, 60)} — ${feedback.trim().split('\n')[0].slice(0, 60)}\n\n${feedback.trim()}\n\nOriginal task: ${task.id}`, workspaceId: task.workspace_id, criteria: task.acceptance_criteria || '', context: `Review the original task ${task.id} and address this feedback.`, maxIterations: 3, requestId: newId() }
    setRevision(saved)
    if (!saveTaskDraft({ ...saved, parentTaskId: task.id, submitted: true })) setStorageError(true)
    let next
    try {
      next = await api.createTask({ workspace_id: saved.workspaceId, title: saved.goal.split('\n')[0].slice(0, 140), description: saved.goal, acceptance_criteria: saved.criteria, status: 'backlog', labels: ['ive-guided'], parent_task_id: task.id, request_id: saved.requestId })
    } catch (err) {
      if (err.status >= 400 && err.status < 500) { setRevision(null); clearTaskDraft(saved.requestId) }
      throw err
    }
    useStore.getState().updateTaskInStore(next)
    setDraft({ ...saved, taskId: next.id, submitted: true }); saveTaskDraft({ ...saved, taskId: next.id, submitted: true })
    setTaskId(next.id); setTask(next); setRun(null); setRuns([]); setChanges(null); setFeedback(''); setRevision(null)
  })
  const loadChanges = async () => {
    if (changesBusy) return
    setChangesBusy(true); setChangesError('')
    try {
      const [unstaged, staged] = await Promise.all([api.getGitDiff(workspace.id), api.getGitDiff(workspace.id, { staged: true })])
      setChanges({ unstaged: unstaged.diff || '', staged: staged.diff || '', truncated: unstaged.truncated || staged.truncated })
    } catch (err) { setChangesError(err.message) }
    finally { setChangesBusy(false) }
  }
  const openSession = (id) => { useStore.getState().openSession(id); onClose() }
  const change = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))
  const changeCycles = (event) => {
    const maxIterations = Number(event.target.value)
    if (maxIterations === draft.maxIterations && tourCyclesChosen) return
    setTourCyclesChosen(true)
    change('maxIterations', maxIterations)
    if (initial.guidedTour) window.dispatchEvent(new CustomEvent('ive-tour-event', {
      detail: { type: 'loop-settings', chosen: true, maxIterations, workspaceId: task?.workspace_id || draft.workspaceId || null },
    }))
  }

  if (picker) return <WorkspacePicker initialQuery={draft.goal.slice(0, 240)} onClose={() => setPicker(false)} onSelect={async (project) => { const { workspace: selected } = await connectProject(project); change('workspaceId', selected.id); setPicker(false) }} />
  if (draftConflict) return <Modal title="You have a saved draft" size="sm" onClose={onClose}><div className="ive-flow-body"><p className="text-sm text-x-muted">{draftConflict.goal}</p><div className="ive-flow-actions"><Button variant="primary" onClick={() => { setDraft(draftConflict); setTaskId(draftConflict.taskId || null); setDraftConflict(null) }}>Continue saved draft</Button>{!draftConflict.submitted && <Button onClick={() => setDraftConflict(null)}>Replace with new request</Button>}</div>{draftConflict.submitted && <p className="mt-4 text-sm text-x-muted">Finish the saved setup first so a request with an uncertain response is not lost.</p>}</div></Modal>
  if (detailRun) return <Suspense fallback={<Modal title="Loading run…" onClose={() => setDetailRun(null)} />}><PipelineRunDetail runId={detailRun} onClose={() => { setDetailRun(null); refresh() }} /></Suspense>
  return <Modal title={task ? task.title : 'Turn your request into a result'} subtitle={workspace ? workspace.name : 'Choose the project, then review the plan.'} icon={Sparkles} size="lg" className="ive-task-flow" onClose={busy ? undefined : onClose} bodyClassName="overflow-y-auto">
    <div className="ive-flow-body" aria-busy={busy || loading}>
      {storageError && <p role="alert" className="ive-flow-error">Your browser could not save this draft. Keep this window open until the task is created.</p>}
      {error && <p role="alert" className="ive-flow-error">{error}</p>}
      {refreshError && <p role="alert" className="ive-flow-error">Could not refresh this task. Actions are paused until current data is available. {refreshError} <button onClick={refresh}>Retry</button></p>}
      {loading && !task && <p className="ive-flow-loading"><Loader2 className="animate-spin" size={18} /> Loading task and reports…</p>}
      {!taskId && <>
        <div className="ive-flow-intro"><span className="ive-eyebrow">01 / Define the outcome</span><h3>What should be better when we’re done?</h3><p>IVE prepares a plan, waits for your approval, implements the work, and checks the result.</p></div>
        {initial.guidedTour && <p className="text-sm text-x-muted">Ein Loop lässt die KI arbeiten, das Ergebnis prüfen und bei gefundenen Fehlern nachbessern. So musst du nicht jede Korrektur selbst anstoßen. Du gibst zuerst den Plan frei und prüfst am Ende das Ergebnis.</p>}
        <label className="ive-flow-field">Your request<textarea aria-label="Your request" autoFocus value={draft.goal} disabled={draft.submitted || busy} onChange={(e) => change('goal', e.target.value)} rows={4} maxLength={24000} placeholder="Improve the checkout on my shop. Keep the existing payment options." /></label>
        <div className="ive-flow-field"><label htmlFor="task-project">Project</label><div className="flex flex-wrap items-center gap-2"><select id="task-project" value={draft.workspaceId} onChange={(e) => change('workspaceId', e.target.value)} disabled={draft.submitted || busy}><option value="">Choose a connected project</option>{workspaces.map((ws) => <option key={ws.id} value={ws.id}>{ws.name}</option>)}</select><Button icon={FolderSearch} disabled={draft.submitted || busy} onClick={() => setPicker(true)}>Find project</Button></div>{workspace && <span className="ive-flow-path">{workspace.path}</span>}</div>
        <label className="ive-flow-field">Acceptance criteria <span className="text-x-muted font-normal">Optional · one outcome per line</span><textarea aria-label="Acceptance criteria" value={draft.criteria} disabled={draft.submitted || busy} onChange={(e) => change('criteria', e.target.value)} rows={3} maxLength={12000} placeholder={'Existing workflows still work.\nThe page is usable on mobile.\nRelevant tests and the build pass.'} /></label>
        <details data-tour="loop-settings" className="ive-flow-settings" open={initial.guidedTour || undefined}><summary>Context & execution settings</summary><p>Uses your configured planner, plan reviewer, worker, and tester. The plan needs your approval; failed verification returns to the worker.</p><label className="ive-flow-field">Additional context<textarea value={draft.context} disabled={draft.submitted || busy} onChange={(e) => change('context', e.target.value)} rows={3} maxLength={12000} placeholder="Conventions, constraints, or things to preserve." /></label><label className="ive-flow-field">Maximum cycles<select data-tour="loop-cycles" value={initial.guidedTour && !tourCyclesChosen ? '' : draft.maxIterations} disabled={draft.submitted || busy} onChange={changeCycles}>{initial.guidedTour && !tourCyclesChosen && <option value="" disabled>Limit wählen</option>}{[...new Set([1, 2, 3, 5, 10, draft.maxIterations])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}</select></label><p>One shared counter starts at 1 and limits repeated plan and verification stages. It is not a time or spending limit.</p>{workspace && <Button onClick={() => onKnowledge(workspace.id)}>View & edit project knowledge</Button>}</details>
        {draft.submitted && <p className="text-sm text-x-muted">This request is saved for a safe retry. Its content is locked until the server confirms creation.</p>}
        <div className="ive-flow-actions"><p>{initial.guidedTour && !tourCyclesChosen ? 'Wähle zuerst ein Wiederholungslimit unter „Maximum cycles“.' : 'Planning starts an agent. File changes start after you approve the plan.'}</p><Button data-tour="plan-submit" variant="primary" icon={busy ? Loader2 : ArrowRight} onClick={plan} disabled={busy || !draft.goal.trim() || !workspace || (initial.guidedTour && !tourCyclesChosen && !draft.submitted)}>{busy ? 'Preparing…' : draft.submitted ? 'Retry safely' : 'Prepare plan'}</Button></div>
      </>}
      {task && <>
        <ol className="ive-flow-steps" aria-label="Task progress">{['Request', 'Plan', 'Work', 'Check', 'Review', 'Accepted'].map((label, index) => <li key={label} aria-current={current.step === index ? 'step' : undefined} className={index <= current.step ? 'is-reached' : ''}><span>{index < current.step ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol>
        <section className={`ive-flow-next ${current.tone === 'danger' ? 'is-error' : ''}`}><div><p className="ive-eyebrow">Next step</p><h3>{current.label}</h3><p>{current.detail}</p></div><div className="ive-flow-next-actions">
          {run?.status === 'paused' && <Button data-tour={current.approval ? 'plan-approve' : undefined} variant="primary" disabled={busy || !!refreshError} icon={ArrowRight} onClick={resume}>{current.approval ? 'Approve plan & start' : 'Resume run'}</Button>}
          {canAccept && <Button data-tour="result-accept" variant="primary" icon={Check} disabled={busy || !!refreshError} onClick={accept}>Accept result</Button>}
          {current.boardReview && <Button variant="primary" onClick={() => onBoard(task.workspace_id)} disabled={busy}>Open full task board</Button>}
          {!run && ['backlog', 'todo'].includes(task.status) && <Button data-tour="plan-submit" variant="primary" icon={ArrowRight} disabled={busy || !!refreshError} onClick={plan}>Prepare plan</Button>}
          {run && !['running', 'paused', 'completed'].includes(run.status) && <Button onClick={replan} disabled={busy || !!refreshError}>Prepare a new plan</Button>}
          {run && <Button data-tour="run-details" onClick={() => setDetailRun(run.id)} disabled={busy}>Run details</Button>}
          {['running', 'paused'].includes(run?.status) && <Button data-tour="run-cancel" variant="destructive" icon={Square} onClick={cancel} disabled={busy} title="Beendet diesen Ablauf und unterbricht seine aktive Arbeit.">Run abbrechen</Button>}
        </div></section>
        {initial.guidedTour && run && <section data-tour="loop-status" aria-label="Loop-Status" className="ive-flow-report">
          <p role="status">Status: {run.status}{run.iteration != null && <> · Durchlauf {run.iteration}{run.max_iterations != null && <> von {run.max_iterations}</>}</>}. Aktuelle Schritte: {run.current_stages?.length ? run.current_stages.map((id) => stageNames[id] || id).join(', ') : 'keine'}.</p>
          <p className="mt-2 text-sm text-x-muted">{run.status === 'cancelled' ? 'Abgebrochen – dieser Ablauf ist nicht erfolgreich abgeschlossen. Bereits entstandene Ergebnisse bleiben zur Prüfung erhalten.' : run.status === 'max_iterations' ? 'Das Wiederholungslimit wurde erreicht. Prüfe die Berichte; das ist kein bestätigter Erfolg.' : 'Ein zweiter Agent prüft das Ergebnis. Nur bei gefundenen Problemen beginnt eine Korrekturrunde; ein erfolgreicher erster Versuch braucht keine Wiederholung.'}</p>
          {['running', 'paused'].includes(run.status) && <p className="mt-2 text-xs text-x-muted">„Run abbrechen“ stoppt den Ablauf. Dieses Fenster zu schließen beendet die Arbeit nicht.</p>}
        </section>}
        <details className="ive-flow-settings"><summary>Request & acceptance criteria</summary><div className="ive-flow-markdown"><ReactMarkdown>{task.description || task.title}</ReactMarkdown><h4>Acceptance criteria</h4><ReactMarkdown>{task.acceptance_criteria || 'No additional criteria supplied. The plan and verification report should state what was checked.'}</ReactMarkdown></div></details>
        {Object.entries(stageNames).filter(([id]) => history[id] && (history[id].output_summary || history[id].status === 'running')).map(([id, title]) => <Report key={id} title={title} output={history[id].output_summary} truncated={history[id].output_truncated} sessionId={history[id].session_id} onSession={openSession} />)}
        {current.approval && <details className="ive-flow-settings"><summary>Request a plan revision</summary><label className="ive-flow-field">What should change?<textarea aria-label="Plan revision" value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={busy} rows={3} maxLength={12000} /></label><Button onClick={replan} disabled={busy || !feedback.trim() || !!refreshError}>Revise plan</Button><p>The current plan remains in previous runs. IVE prepares a new plan for your approval.</p></details>}
        {task.result_summary && <Report title="Task summary" output={task.result_summary} />}
        {['review', 'done'].includes(task.status) && <>
          {!verified && <p className="text-sm text-x-muted">{task.status === 'done' ? 'This task was completed without a passing verification report for this run.' : 'Acceptance here requires a completed run with a passing verification report. You can review and manage this task manually in the full task board.'}</p>}
          <section className="ive-flow-report"><header><h3>Inspect the result</h3></header><p className="text-sm text-x-muted">Project changes include the current staged and unstaged diff; they can include work from other tasks. Committed changes are available in the full review tools.</p><div className="flex flex-wrap gap-2 mt-3"><Button data-tour="result-changes" icon={changesBusy ? Loader2 : RefreshCw} disabled={!workspace || changesBusy} onClick={loadChanges}>{changes ? 'Refresh project changes' : 'Show project changes'}</Button>{safeUrl(workspace?.preview_url) && <a className="ive-flow-link" href={safeUrl(workspace.preview_url)} target="_blank" rel="noreferrer">Open project preview <ExternalLink size={14} /></a>}</div>{!safeUrl(workspace?.preview_url) && <p className="mt-3 text-xs text-x-muted">No project preview is configured. Any preview provided by the agent appears in its report.</p>}{changesError && <p role="alert" className="ive-flow-error">{changesError}</p>}{changes?.truncated && <p className="mt-3 text-sm text-x-muted">This diff is truncated. Use the full review tools to inspect all changes.</p>}{changes && <><h4 className="mt-4 text-sm font-semibold">Unstaged changes</h4><pre className="ive-flow-diff">{changes.unstaged || 'No unstaged diff.'}</pre><h4 className="mt-4 text-sm font-semibold">Staged changes</h4><pre className="ive-flow-diff">{changes.staged || 'No staged diff.'}</pre></>}</section>
          <section className="ive-flow-report"><h3>Something still needs work?</h3><label className="ive-flow-field">Feedback<textarea aria-label="Feedback" value={feedback} disabled={busy || !!revision} onChange={(e) => setFeedback(e.target.value)} rows={3} maxLength={12000} placeholder="Describe what should be corrected." /></label><Button disabled={busy || !feedback.trim() || !!refreshError} onClick={requestRevision}>Create follow-up for review</Button><p className="mt-2 text-xs text-x-muted">Keeps this result and its evidence. The linked follow-up gets its own plan and approval.</p></section>
        </>}
        {runs.length > 1 && <details className="ive-flow-settings"><summary>Previous runs ({runs.length - 1})</summary>{runs.filter((item) => item.id !== run?.id).map((item) => <button className="ive-task-row" key={item.id} onClick={() => setDetailRun(item.id)}>{item.status} · {item.created_at}<ArrowRight size={14} /></button>)}</details>}
        <div className="ive-flow-actions"><p>{workspace?.path}</p><Button onClick={() => onBoard(task.workspace_id)} disabled={busy}>Full task board</Button></div>
      </>}
    </div>
  </Modal>
}
