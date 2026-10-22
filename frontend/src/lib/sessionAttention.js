// Attention is independent of the selected tab: a selected terminal can be
// collapsed, behind Home, or in another workspace.

// Mirror of backend/session_attention.py `details()`: the fields a question
// card needs without reading the terminal screen (options, actions, the
// trimmed tool input and when the agent asked).
const TOOL_INPUT_KEYS = 8
const TOOL_INPUT_VALUE = 240

function trimToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) return null
  const out = {}
  for (const key of Object.keys(input).slice(0, TOOL_INPUT_KEYS)) {
    const value = input[key]
    out[key] = typeof value === 'string' ? value.slice(0, TOOL_INPUT_VALUE)
      : typeof value === 'number' || typeof value === 'boolean' || value === null ? value
      : (() => { try { return JSON.stringify(value).slice(0, TOOL_INPUT_VALUE) } catch { return '' } })()
  }
  return out
}

export function attentionDetails(data = {}, source = 'hook') {
  const context = String(data.context || '').slice(-6000)
  const input = data.tool_input || {}
  const operation = String(input.command || input.cmd || input.file_path || input.path || '').slice(0, 240)
  const message = String(data.reason || data.message || data.question || operation).slice(0, 1200)
  const compact = `${message} ${context}`.replace(/\s+/g, '').toLowerCase()
  const configuration = compact.includes('safetygate') && /missingapi[_ ]?key|notconfigured|classifierunavailable/.test(compact)
  const permission = configuration || !!data.tool_name || /permission|confirmation|proceed|approve/i.test(message)
  return {
    kind: configuration ? 'configuration' : permission ? 'permission' : 'question',
    title: configuration ? 'Safety check needs setup' : permission ? 'Permission needed' : 'Your answer is needed',
    message: configuration ? 'The extra safety check is unavailable. Open Safety settings to fix its provider.' : message || (data.tool_name ? `Review the ${data.tool_name} request.` : 'The agent is waiting for your input.'),
    tool_name: data.tool_name || '', context, source,
    options: Array.isArray(data.options) ? data.options : [],
    actions: Array.isArray(data.actions) ? data.actions : [],
    notification_type: data.notification_type || '',
    tool_input: trimToolInput(data.tool_input),
    // Unix seconds, like the backend. Terminal detection runs on every poll
    // and must stay byte-identical, so it carries no timestamp of its own.
    asked_at: typeof data.asked_at === 'number' ? data.asked_at : null,
  }
}

const askedNow = (data) => (typeof data.asked_at === 'number' ? data : { ...data, asked_at: Date.now() / 1000 })

export function detectTerminalAttention(text = '') {
  // Legacy backends expose stripped scrollback. Require the approval footer
  // at the *end*, so answered prompts further up cannot become live again.
  const tail = String(text).slice(-8000)
  const compact = tail.replace(/\s+/g, '').toLowerCase()
  const footer = Math.max(compact.lastIndexOf('esctocancel'), compact.lastIndexOf('esctointerrupt'))
  const approvalFooter = compact.lastIndexOf('esctocancel')
  const after = compact.slice(approvalFooter)
  if (approvalFooter < 0 || footer !== approvalFooter || after.length > 260 || /interrupted|automodeon|bypasspermissions|shift\+tab|cogitated|workedfor/.test(after)) return null
  const before = compact.slice(0, approvalFooter)
  if (!/(doyouwanttoproceed|wouldyouliketorun|readytocode|requiresconfirmation|allowthis|approve)/.test(before.slice(-2500))) return null
  if (!/[12][.)]/.test(before.slice(-1500))) return null
  return attentionDetails({ message: 'Review the request in the terminal.', tool_name: 'command', context: tail.slice(-5000) }, 'terminal')
}

export function handleAttentionEvent(store, sid, data) {
  if (!store.sessions[sid] || store.sessions[sid].status === 'auth_failed') return
  if (data.type === 'session_attention') {
    store.setSessionAttention(sid, data.attention || null)
  } else if (data.type === 'permission_event' && data.phase === 'request') {
    store.setSessionAttention(sid, attentionDetails(askedNow(data)))
  } else if (data.type === 'session_state' && data.state === 'prompting') {
    store.setSessionAttention(sid, attentionDetails(askedNow(data)))
  } else if ((data.type === 'session_state' && ['working', 'idle'].includes(data.state)) || (data.type === 'permission_event' && data.phase === 'denied')) {
    store.setSessionAttention(sid, null)
  }
}

// A startup blocker (trust menu, login, first-run setup, CLI update) also
// waits for the user, even though no hook event marks the session as
// prompting. Terminal.jsx / coordinationEvents attach it as
// `session.startup_blocker` when GET output or a WS error reports one.
export function sessionNeedsAttention(session) {
  return !!session?.attention || !!session?.startup_blocker
    || ['waiting', 'prompting', 'input_needed', 'needs_input', 'auth_failed', 'error', 'failed', 'crashed'].includes(session?.status)
    || session?.agentState === 'prompting'
}

export function taskAttention(task, runs = []) {
  const run = runs.filter((r) => r.task_id === task.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
  if (task.status === 'done' && !['running', 'paused'].includes(run?.status)) return null
  if (run?.status === 'paused') {
    const summaries = (run.current_stages || []).map((id) => run.stage_history?.[id]?.output_summary || '')
    return { title: summaries.some((s) => s.startsWith('waiting_for_command_approval')) ? 'Command approval needed' : summaries.some((s) => s.startsWith('waiting_for_plan_approval')) ? 'Plan approval needed' : 'Task paused', message: 'Review the task to continue.' }
  }
  if (task.pipeline_stage === 'awaiting_plan_approval') return { title: 'Plan approval needed', message: 'Review the proposed work to continue.' }
  if (task.status === 'review') return { title: 'Result ready for review', message: 'Review the changes and test results.' }
  if (task.status === 'blocked' || ['failed', 'max_iterations', 'budget_exceeded'].includes(run?.status)) return { title: 'Task blocked', message: 'Open the task to see what stopped the work.' }
  return null
}
