import useStore from '../state/store'
import { clearPromptBuffer } from './outputParser'
import { api } from './api'
import { expandPromptTokens } from './tokens'

/**
 * Detect @ralph in a command and start a RALPH pipeline run.
 * The pipeline orchestrates execute → verify → fix across agents instead
 * of injecting a self-grading prompt into a single session.
 *
 * Returns { command, isRalph } — when isRalph is true the caller should
 * NOT send the command to the PTY (the pipeline engine drives it).
 */
function processRalphTag(command, sessionId) {
  if (!/@ralph\b/i.test(command)) return { command, isRalph: false }

  const task = command.replace(/@ralph\s*/gi, '').trim()
  if (!task) return { command, isRalph: false }

  const session = useStore.getState().sessions?.[sessionId]
  const workspaceId = session?.workspace_id

  api.startRalphPipeline(sessionId, task, workspaceId)
    .then((run) => {
      useStore.getState().addNotification({
        type: 'info',
        message: `RALPH pipeline started: ${task.slice(0, 60)}`,
      })
      if (run) useStore.getState().handlePipelineRunUpdate(run)
    })
    .catch((err) => {
      useStore.getState().addNotification({
        type: 'error',
        message: `RALPH pipeline failed: ${err?.message || 'unknown'}`,
      })
    })

  return { command: task, isRalph: true }
}

/**
 * Detect @research or @research--<model> in a command.
 * Triggers a deep research job and replaces the command with a "wait for research" placeholder.
 * Returns { command, researchJob } where researchJob is the started job promise (or null).
 *
 * Examples:
 *   @research how does the auth flow work?
 *   @research--gemma3:27b explain the codebase architecture
 *   @research--llama3.1:70b@http://your-host:11434/v1 build me a feature plan
 */
function processResearchTag(command, sessionId) {
  const m = command.match(/@research(?:--([^\s]+))?\s+(.+)/i)
  if (!m) return { command, researchJob: null }

  let model = null
  let llmUrl = null
  if (m[1]) {
    // Format: model or model@url (explicit override)
    const parts = m[1].split('@')
    model = parts[0]
    if (parts.length > 1) llmUrl = parts.slice(1).join('@')
  } else {
    // Use sidebar-selected research model
    model = localStorage.getItem('cc-research-model') || null
  }
  const query = m[2].trim()

  // Get workspace_id from active session
  const session = useStore.getState().sessions[sessionId]
  const workspaceId = session?.workspace_id

  // Kick off research job in background. We need to know whether the API
  // accepted it before we tell the agent "research is running" — otherwise
  // the agent waits on findings that will never arrive.
  const job = api.startResearch({ query, workspace_id: workspaceId, model, llm_url: llmUrl })
    .then((res) => {
      if (!res || !res.job_id) {
        throw new Error('startResearch returned no job_id')
      }
      useStore.getState().addNotification({
        sessionId,
        type: 'research_started',
        message: `Research started: ${query.slice(0, 60)}`,
        jobId: res.job_id,
        entryId: res.entry_id,
      })
      return res
    })
    .catch((err) => {
      useStore.getState().addNotification({
        sessionId,
        type: 'research_failed',
        message: `Research failed to start: ${err?.message || 'unknown error'}`,
      })
      throw err
    })

  // Replace command with a research-context placeholder for the agent
  const replacement = `[Deep research started: "${query}"]\nThe research will run in the background. Use the research output once it completes. In the meantime, proceed with what you can do without it.`
  return { command: replacement, researchJob: job }
}

/**
 * Inline @prompt:<name> references with the matching prompt body from
 * the store cache. Supports both `@prompt:foo` (no whitespace in name)
 * and `@prompt:"foo bar"` (quoted name with spaces). Unmatched tokens
 * are left untouched so the user can see the typo land in Claude.
 */
function processPromptTag(command) {
  const prompts = useStore.getState().prompts
  if (!prompts || prompts.length === 0) return command
  return expandPromptTokens(command, prompts)
}


function getWs() {
  const ws = useStore.getState().ws
  return ws?.readyState === WebSocket.OPEN ? ws : null
}

function sendRaw(sessionId, data) {
  const ws = getWs()
  if (!ws || !sessionId) return
  ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data }))
}

/**
 * Return true if this session runs Gemini CLI (not Claude Code).
 * Gemini's TUI handles escape sequences differently — Escape can interfere
 * with plan review, selection menus, and mode toggles, potentially causing
 * premature exit. We use Ctrl-U (kill line) instead.
 */
function isGeminiSession(sessionId) {
  const session = useStore.getState().sessions[sessionId]
  return session?.cli_type === 'gemini'
}

/**
 * CLI-aware "clear input line" sequence:
 *   Claude: \x1b + \x7f×N  (Escape + Alt-Backspace to clear Ink input)
 *   Gemini: \x15            (Ctrl-U, readline kill-line — safe for Gemini TUI)
 */
function getClearSequence(sessionId) {
  return isGeminiSession(sessionId) ? '\x15' : '\x1b' + '\x7f'.repeat(50)
}

/**
 * Force-interrupt Claude and send a message.
 *
 * Unlike sendTerminalCommand (which clears the input field with
 * \x1b\x7f… as a combined chunk that Ink reads as Alt+Backspace),
 * this sends a STANDALONE Escape first so Ink registers it as
 * "cancel current operation". Then waits for Claude to actually stop
 * before typing the message.
 *
 * Timing:
 *   0ms  → \x1b alone (Ink sees Escape → cancels work)
 *   800ms → \x1b + \x7f×50 (clear any residual input in the prompt)
 *   1100ms → type message + Enter
 *
 * No dedup, no queue, no tag processing — force messages are raw
 * interrupts, not structured commands.
 */
export function sendForceMessage(sessionId, message) {
  if (!getWs() || !sessionId) return

  if (isGeminiSession(sessionId)) {
    // Gemini: Ctrl-U to clear, then type and submit.
    // Gemini doesn't support Escape-based interrupts like Claude's Ink TUI.
    sendRaw(sessionId, '\x15')
    setTimeout(() => {
      if (!getWs()) return
      sendRaw(sessionId, message + '\r')
    }, 200)
  } else {
    // Claude: Standalone Escape to cancel generation, then clear + type.
    // Step 1: Standalone Escape — Ink sees this as "cancel" during generation
    sendRaw(sessionId, '\x1b')

    // Step 2: Wait for Claude to process the interrupt and return to prompt
    setTimeout(() => {
      if (!getWs()) return
      // Step 3: Clear any residual text in the input field
      sendRaw(sessionId, '\x1b' + '\x7f'.repeat(50))

      setTimeout(() => {
        if (!getWs()) return
        // Step 4: Type the message and submit
        sendRaw(sessionId, message + '\r')
      }, 300)
    }, 800)
  }
}

/**
 * Per-session command queue. Multiple rapid sendTerminalCommand calls used to
 * race each other (each fired Escape immediately and queued a 300ms delayed
 * text+Enter), corrupting Ink's input field. We now serialise dispatch per
 * session and dedupe identical pending/in-flight commands so a flood of
 * nudges can't glitch the terminal.
 */
const _commandQueues = new Map() // sessionId -> [{ command, processed }]
const _commandDraining = new Set() // sessionIds currently being drained
const _commandInFlight = new Map() // sessionId -> command currently dispatching
const COMMAND_SPACING_MS = 600

async function _drainCommandQueue(sessionId) {
  if (_commandDraining.has(sessionId)) return
  _commandDraining.add(sessionId)
  try {
    let firstInBatch = true
    while (true) {
      const queue = _commandQueues.get(sessionId)
      if (!queue || queue.length === 0) break
      const item = queue.shift()
      _commandInFlight.set(sessionId, item.command)
      if (!getWs()) break
      if (firstInBatch) {
        // Only the first message in a drain cycle clears the input field.
        // Subsequent messages skip the clear — otherwise they'd interrupt any
        // work the CLI started in response to the earlier message. Claude
        // Code queues typed follow-ups as "upcoming messages" on its own.
        sendRaw(sessionId, getClearSequence(sessionId))
        await new Promise((r) => setTimeout(r, 300))
        if (!getWs()) break
        firstInBatch = false
      }
      sendRaw(sessionId, item.processed + '\r')
      await new Promise((r) => setTimeout(r, COMMAND_SPACING_MS))
    }
  } finally {
    _commandDraining.delete(sessionId)
    _commandInFlight.delete(sessionId)
    if ((_commandQueues.get(sessionId) || []).length === 0) {
      _commandQueues.delete(sessionId)
    }
  }
}

/**
 * Send a command to the terminal, clearing any existing input first.
 *
 * Uses Escape (\x1b) to clear Claude Code's Ink input,
 * then waits for the UI to settle before typing the command.
 *
 * Calls are queued per-session and identical pending commands are deduped.
 */
export function sendTerminalCommand(sessionId, command) {
  if (!getWs() || !sessionId) return

  // @ralph starts a pipeline — the task prompt is sent by the pipeline engine, not here
  const { command: afterRalph, isRalph } = processRalphTag(command, sessionId)
  if (isRalph) return // pipeline engine takes over

  let processed = afterRalph
  const { command: afterResearch } = processResearchTag(processed, sessionId)
  processed = afterResearch
  processed = processPromptTag(processed)

  // Drop identical commands either already pending OR currently dispatching.
  // Back-to-back dupes are noise — e.g. a flood of the same oversight nudge.
  if (_commandInFlight.get(sessionId) === command) return
  let queue = _commandQueues.get(sessionId)
  if (!queue) {
    queue = []
    _commandQueues.set(sessionId, queue)
  }
  if (queue.some((item) => item.command === command)) return
  queue.push({ command, processed })
  _drainCommandQueue(sessionId)
}

/**
 * Type text into a terminal without executing.
 */
export function typeInTerminal(sessionId, text) {
  sendRaw(sessionId, text)
}

// Arrow keys for Ink's SelectInput
const ARROW_DOWN = '\x1b[B'

/**
 * Send a choice to the plan prompt (1=auto-accept, 2=manual, 3=give feedback).
 * Uses arrow keys since Ink's SelectInput navigates with arrows, not numbers.
 * Option 1 is pre-selected (cursor starts there).
 */
export function sendPlanChoice(sessionId, choice) {
  if (!getWs() || !sessionId) return
  // Navigate: option 1 = 0 downs, option 2 = 1 down, option 3 = 2 downs
  const downs = Math.max(0, choice - 1)
  for (let i = 0; i < downs; i++) sendRaw(sessionId, ARROW_DOWN)
  // Small delay after arrows for Ink to update selection, then Enter
  setTimeout(() => sendRaw(sessionId, '\r'), 100)
  clearPromptBuffer(sessionId)
  useStore.getState().setSessionPlanWaiting(sessionId, false)
}

/**
 * Send feedback through option 3 of the plan prompt.
 * Navigates to option 3 (2 arrow downs + Enter), waits for the text input, then types feedback.
 */
export function sendPlanFeedback(sessionId, feedback) {
  if (!getWs() || !sessionId) return
  // Step 1: Navigate to option 3 (2 arrow downs)
  sendRaw(sessionId, ARROW_DOWN)
  sendRaw(sessionId, ARROW_DOWN)
  // Step 2: Select option 3 (Enter)
  setTimeout(() => {
    sendRaw(sessionId, '\r')
    // Step 3: Wait for Claude to show the text input, then type feedback + Enter
    setTimeout(() => {
      sendRaw(sessionId, feedback + '\r')
    }, 600)
  }, 150)
  clearPromptBuffer(sessionId)
  useStore.getState().setSessionPlanWaiting(sessionId, false)
}

/**
 * Broadcast a command to multiple terminal sessions.
 */
export function broadcastCommand(sessionIds, command) {
  const ws = getWs()
  if (!ws) return

  // Strip @global — it's a broadcast-scope directive, not a PTY command
  let processed = command.replace(/@global\s*/gi, '').trim()
  // @ralph in broadcast doesn't make sense — strip it but don't start pipeline
  processed = processed.replace(/@ralph\s*/gi, '')
  processed = processPromptTag(processed)

  // Clear input for each session using CLI-appropriate sequence.
  // Claude uses Escape+DEL; Gemini uses Ctrl-U (Escape can interfere
  // with Gemini's TUI and cause premature exit).
  const claudeIds = sessionIds.filter((id) => !isGeminiSession(id))
  const geminiIds = sessionIds.filter((id) => isGeminiSession(id))
  if (claudeIds.length) {
    ws.send(JSON.stringify({
      action: 'broadcast',
      session_ids: claudeIds,
      data: '\x1b' + '\x7f'.repeat(50),
    }))
  }
  if (geminiIds.length) {
    ws.send(JSON.stringify({
      action: 'broadcast',
      session_ids: geminiIds,
      data: '\x15',
    }))
  }

  setTimeout(() => {
    const ws2 = getWs()
    if (!ws2) return
    ws2.send(JSON.stringify({
      action: 'broadcast',
      session_ids: sessionIds,
      data: processed + '\r',
    }))
  }, 300)
}
