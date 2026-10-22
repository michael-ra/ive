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
  // A whole-word token only: `@ralph-notes.md` is a file mention, not RALPH.
  if (!/(^|\s)@ralph(?=\s|$)/i.test(command)) return { command, isRalph: false }

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
  const job = (llmUrl || /^https?:/i.test(model || '')
    ? Promise.reject(new Error('Choose your research provider in Connectors. Custom endpoint URLs in @research are no longer supported.'))
    : api.startResearch({ query, workspace_id: workspaceId, model }))
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

/**
 * Inline @ticket:<name> or @ticket:<id> references with the matching ticket context.
 * Supports both @ticket:foo (no whitespace) and @ticket:"foo bar" (quoted name/title).
 * Appends resolved ticket information (ID, Title, Status, Priority, Description, Acceptance Criteria)
 * as a markdown context block at the end of the command.
 */
function processTicketTag(command) {
  if (!/@ticket:/i.test(command)) return command

  const tasks = useStore.getState().tasks
  if (!tasks || Object.keys(tasks).length === 0) return command

  // Matches @ticket:"([^"]+)" or @ticket:([^\s\n]+)
  const regex = /@ticket:(?:"([^"]+)"|([^\s\n]+))/gi
  let match
  const resolvedTasks = []

  while ((match = regex.exec(command)) !== null) {
    const query = (match[1] || match[2] || '').trim()
    if (!query) continue

    // Resolve task by:
    // 1. Exact ID
    // 2. ID prefix (first 8 chars)
    // 3. Exact title / subtitle match (case-insensitive)
    const task = Object.values(tasks).find(
      (t) =>
        t.id === query ||
        t.id?.startsWith(query) ||
        t.title?.toLowerCase() === query.toLowerCase() ||
        t.title?.toLowerCase().includes(query.toLowerCase())
    )

    if (task && !resolvedTasks.some((t) => t.id === task.id)) {
      resolvedTasks.push(task)
    }
  }

  if (resolvedTasks.length === 0) return command

  const contexts = resolvedTasks.map((t) => {
    const lines = [
      `---`,
      `[Ticket Context: #${t.id.slice(0, 8)}]`,
      `Title: ${t.title}`,
      `Status: ${t.status || 'backlog'}`,
      t.priority ? `Priority: ${t.priority}` : null,
      t.description ? `Description:\n${t.description}` : null,
      t.acceptance_criteria ? `Acceptance Criteria:\n${t.acceptance_criteria}` : null,
      `---`
    ].filter(Boolean)
    return lines.join('\n')
  })

  return `${command}\n\n${contexts.join('\n\n')}`
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

function getCliType(sessionId) {
  return useStore.getState().sessions[sessionId]?.cli_type || 'claude'
}

function usesManagedInputEndpoint(sessionId) {
  // A live PTY may still be inside first-run/trust setup. Claude prompts need
  // the same server-side readiness check and acknowledgement as Codex input;
  // raw WS frames can be discarded during startup without reaching the chat.
  return ['claude', 'antigravity', 'codex'].includes(getCliType(sessionId))
}

function queuesAutoInputUntilReady(sessionId) {
  return getCliType(sessionId) === 'codex'
}

function isQueuedDeliveryForDisplay(sessionId, item) {
  return item?.delivery === 'wait_for_ready' ||
    (item?.delivery === 'auto' && queuesAutoInputUntilReady(sessionId))
}

function isSessionWorkingForInput(sessionId) {
  const session = useStore.getState().sessions[sessionId]
  const status = String(session?.status || '').toLowerCase()
  const agentState = String(session?.agentState || '').toLowerCase()
  return ['working', 'executing'].includes(status) ||
    ['working', 'executing', 'running'].includes(agentState)
}

function isBusyInputError(err) {
  const body = err?.body || {}
  const message = String(err?.message || body?.error || '').toLowerCase()
  return body.state === 'busy' || message.includes('still generating')
}

async function sendManagedInput(sessionId, message, readyTimeout) {
  const result = await api.sendSessionInput(sessionId, message, { ready_timeout: readyTimeout })
  if (!result?.ok || result.intercepted) {
    throw new Error(result?.message || 'The assistant did not accept this message.')
  }
  return result
}

async function sendManagedInputWhenReady(sessionId, itemId, message) {
  const startedAt = Date.now()
  const maxWaitMs = 45 * 60 * 1000
  let notified = false
  while (true) {
    // The socket dropped while waiting: not sent. The drain puts the item
    // back and sends it after the reconnect.
    if (!getWs()) throw new Error('disconnected')
    if (_commandInFlight.get(sessionId)?.id !== itemId) {
      throw new Error('aborted')
    }
    try {
      await sendManagedInput(sessionId, message, 30)
      if (notified) {
        useStore.getState().addNotification?.({
          type: 'success',
          sessionId,
          message: 'Queued input sent.',
        })
      }
      return
    } catch (err) {
      if (!isBusyInputError(err)) throw err
      if (Date.now() - startedAt > maxWaitMs) {
        throw new Error('Timed out waiting for the agent to finish before sending queued input.')
      }
      if (_commandInFlight.get(sessionId)?.id !== itemId) {
        throw new Error('aborted')
      }
      if (!notified) {
        notified = true
        useStore.getState().addNotification?.({
          type: 'info',
          sessionId,
          message: 'Input queued until the agent is ready.',
        })
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/**
 * CLI-aware "clear input line" sequence:
 *   Claude: \x1b + \x7f×N  (Escape + Alt-Backspace to clear Ink input)
 *   Gemini: \x15            (Ctrl-U, readline kill-line — safe for Gemini TUI)
 */
function getClearSequence(sessionId) {
  if (isGeminiSession(sessionId)) {
    return '\x15'
  }
  // Send Ctrl-U and Escape + 1000 Backspaces to guarantee clearing even very long prompts
  return '\x15\x1b' + '\x7f'.repeat(1000)
}

/**
 * CLI-aware generation interrupt.
 *
 * Do not route this through sendTerminalCommand: that helper is for user
 * prompts and queues text + Enter. Raw control keys need to bypass the queue.
 *
 * Claude/Codex/Antigravity-style Ink TUIs cancel active output on standalone
 * Escape. Gemini has historically handled Escape/Ctrl-U poorly in its TUI, so
 * use Ctrl-C as the least surprising terminal interrupt for that CLI.
 */
export function interruptTerminalOutput(sessionId) {
  if (!getWs() || !sessionId) return
  useStore.getState().clearReplyWait?.(sessionId)
  _commandQueues.delete(sessionId)
  _commandInFlight.delete(sessionId)
  syncQueueToStore(sessionId)
  const cliType = getCliType(sessionId)
  sendRaw(sessionId, cliType === 'gemini' ? '\x03' : '\x1b')
  window.dispatchEvent(new CustomEvent('cc-session-interrupted', { detail: { sessionId, cliType } }))
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
      // Type and submit in separate frames for parity with the Claude
      // path — keeps the input/submit pattern consistent across CLIs.
      sendRaw(sessionId, message)
      setTimeout(() => {
        if (!getWs()) return
        sendRaw(sessionId, '\r')
      }, 200)
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
        // Step 4: Type the message, then submit \r in a separate frame.
        // Combining `message + '\r'` lets Ink's paste detection swallow
        // the trailing CR for any message past ~80 chars.
        sendRaw(sessionId, message)
        setTimeout(() => {
          if (!getWs()) return
          sendRaw(sessionId, '\r')
        }, 300)
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
const _commandQueues = new Map() // sessionId -> [{ id, command, processed, delivery }]
const _commandDraining = new Set() // sessionIds currently being drained
const _commandInFlight = new Map() // sessionId -> { id, command, processed, delivery } currently dispatching
const COMMAND_SPACING_MS = 600
// A prompt typed while the socket is down waits this long for the reconnect,
// then goes back into the composer.
const DISCONNECTED_HOLD_MS = 60000

/**
 * A prompt that could not be delivered never disappears silently: it leaves
 * the queue, its optimistic bubble goes, the text goes back into the
 * composer of the session it was typed in, and the user gets a notice.
 */
function failQueuedItems(sessionId, items, reason) {
  const list = (items || []).filter(Boolean)
  if (!list.length) return
  const store = useStore.getState()
  const byTarget = new Map()
  for (const item of list) {
    const target = item.restore?.sessionId || sessionId
    const text = String(item.restore?.text ?? item.command ?? '').trim()
    if (!text) continue
    byTarget.set(target, [...(byTarget.get(target) || []), text])
  }
  for (const [target, texts] of byTarget) {
    const current = String(useStore.getState().sessionInputs?.[target] || '').trim()
    const restored = texts.join('\n\n')
    if (!current.includes(restored)) {
      store.setSessionInput?.(target, current ? `${restored}\n\n${current}` : restored)
    }
  }
  const commands = list.map((item) => String(item.command || ''))
  store.clearReplyWait?.(sessionId)
  const pending = useStore.getState().pendingOptimisticMessages?.[sessionId] || []
  const kept = pending.filter((msg) => {
    const text = String(typeof msg.content === 'string' ? msg.content : '').trim()
    return !text || !commands.some((cmd) => cmd.trim() === text || cmd.trim().endsWith(text))
  })
  if (kept.length !== pending.length) {
    useStore.setState((s) => ({ pendingOptimisticMessages: { ...s.pendingOptimisticMessages, [sessionId]: kept } }))
  }
  if (commands.includes(useStore.getState().lastSentPrompts?.[sessionId])) store.setLastSentPrompt?.(sessionId, '')
  try {
    window.dispatchEvent(new CustomEvent('cc-terminal-send-failed', { detail: { sessionId, commands, reason } }))
  } catch { /* non-browser test env */ }
  store.addNotification?.({
    type: 'warning',
    sessionId,
    message: `Not sent: ${reason}. Your message is back in the message box.`,
  })
}

function failWholeQueue(sessionId, reason, extra = null) {
  const queue = _commandQueues.get(sessionId) || []
  const items = extra ? [extra, ...queue] : [...queue]
  _commandQueues.delete(sessionId)
  failQueuedItems(sessionId, items, reason)
}

// Queues held back while the socket was down go out after the reconnect.
if (typeof window !== 'undefined') {
  window.addEventListener('cc-websocket-reconnected', () => {
    for (const [sessionId, queue] of _commandQueues) {
      if (queue?.length) _drainCommandQueue(sessionId)
    }
  })
}

function syncQueueToStore(sessionId) {
  const queue = _commandQueues.get(sessionId) || []
  const inFlight = _commandInFlight.get(sessionId)
  
  const uiQueue = []
  if (inFlight && isQueuedDeliveryForDisplay(sessionId, inFlight)) {
    uiQueue.push({ ...inFlight, status: 'waiting' })
  }
  for (const item of queue) {
    if (isQueuedDeliveryForDisplay(sessionId, item)) {
      uiQueue.push({ ...item, status: 'queued' })
    }
  }
  
  useStore.getState().setQueuedCommands?.(sessionId, uiQueue)
}

export function cancelQueuedCommand(sessionId, itemId) {
  const inFlight = _commandInFlight.get(sessionId)
  if (inFlight && inFlight.id === itemId) {
    _commandInFlight.delete(sessionId)
    syncQueueToStore(sessionId)
    return
  }
  
  const queue = _commandQueues.get(sessionId)
  if (queue) {
    const idx = queue.findIndex(item => item.id === itemId)
    if (idx !== -1) {
      queue.splice(idx, 1)
      syncQueueToStore(sessionId)
    }
  }
}

async function _drainCommandQueue(sessionId) {
  if (_commandDraining.has(sessionId)) return
  _commandDraining.add(sessionId)
  try {
    // Socket down: keep the queue, the reconnect drains it.
    if (!getWs()) return
    const ensureRunning = useStore.getState().ensureSessionRunning
    if (typeof ensureRunning === 'function') {
      const ready = await ensureRunning(sessionId)
      if (!ready) {
        // A dropped socket retries after the reconnect; anything else (no
        // such session, start failed) would leave the prompt in a hidden
        // queue that only goes out in front of the next one.
        if (getWs()) {
          const sess = useStore.getState().sessions[sessionId]
          failWholeQueue(sessionId, sess ? 'the agent could not be started' : 'the session is not loaded yet')
        }
        return
      }
    }

    let firstInBatch = true
    while (true) {
      const queue = _commandQueues.get(sessionId)
      if (!queue || queue.length === 0) break
      const item = queue.shift()
      _commandInFlight.set(sessionId, item)
      syncQueueToStore(sessionId)
      if (!getWs()) { queue.unshift(item); break }

      // The placeholder promises the agent an accepted research job.
      // Never send it when the job was rejected, or leave a rejected
      // research promise unhandled while the command waits offline.
      if (item.researchReady) {
        const research = await item.researchReady
        if (research.error) {
          failQueuedItems(sessionId, [item], `research could not start: ${research.error.message || 'request rejected'}`)
          continue
        }
        if (_commandInFlight.get(sessionId)?.id !== item.id) continue
        if (!getWs()) { queue.unshift(item); break }
      }

      if (usesManagedInputEndpoint(sessionId)) {
        try {
          if (item.delivery === 'wait_for_ready' || (item.delivery === 'auto' && queuesAutoInputUntilReady(sessionId))) {
            await sendManagedInputWhenReady(sessionId, item.id, item.processed)
          } else {
            const readyTimeout = item.delivery === 'immediate' || isSessionWorkingForInput(sessionId) ? 0 : 8
            await sendManagedInput(sessionId, item.processed, readyTimeout)
          }
        } catch (err) {
          if (err.message === 'aborted') {
            continue
          }
          if (err.message === 'disconnected' || !getWs()) {
            const q = _commandQueues.get(sessionId) || []
            q.unshift(item)
            _commandQueues.set(sessionId, q)
            break
          }
          const blocker = err?.body?.startup_blocker
          failQueuedItems(sessionId, [item], blocker?.label || err?.message || 'the agent did not take the input')
          continue
        }
        await new Promise((r) => setTimeout(r, COMMAND_SPACING_MS))
        continue
      }
      if (firstInBatch) {
        // Only the first message in a drain cycle clears the input field.
        // Subsequent messages skip the clear — otherwise they'd interrupt any
        // work the CLI started in response to the earlier message. Claude
        // Code queues typed follow-ups as "upcoming messages" on its own.
        sendRaw(sessionId, getClearSequence(sessionId))
        await new Promise((r) => setTimeout(r, 300))
        if (!getWs()) { queue.unshift(item); break }
        firstInBatch = false
      }
      // Always send the text and the submit \r in *separate* frames with
      // a delay between. Combining them into one frame works for short
      // inputs but Claude's Ink TUI auto-detects bursts >~80 chars as a
      // paste and absorbs a trailing \r into the paste body — leaving
      // the message sitting unsubmitted in the prompt (the documentor /
      // tester / commander auto-kickoff bug). Mirrors auto_exec.py's
      // backend pattern (write text → sleep → write \r).
      //
      //   * Claude (Ink): bracketed-paste wrap for multi-line, raw text
      //     for single-line; submit Enter is always its own frame.
      //   * Gemini: every \n submits partial lines, so collapse newlines
      //     to spaces; submit Enter is still its own frame.
      const isMulti = item.processed.includes('\n')
      if (!isMulti) {
        sendRaw(sessionId, item.processed)
      } else if (isGeminiSession(sessionId)) {
        sendRaw(sessionId, item.processed.replace(/\r?\n/g, ' '))
      } else {
        sendRaw(sessionId, '\x1b[200~' + item.processed + '\x1b[201~')
      }
      await new Promise((r) => setTimeout(r, 300))
      // Text typed but not submitted: send it again (cleared first) later.
      if (!getWs()) { queue.unshift(item); break }
      sendRaw(sessionId, '\r')
      await new Promise((r) => setTimeout(r, COMMAND_SPACING_MS))
    }
  } finally {
    _commandDraining.delete(sessionId)
    _commandInFlight.delete(sessionId)
    if ((_commandQueues.get(sessionId) || []).length === 0) {
      _commandQueues.delete(sessionId)
    }
    syncQueueToStore(sessionId)
  }
}

/**
 * Send a command through the CLI's input transport.
 *
 * Claude, Codex and Antigravity use the acknowledged input endpoint. Its
 * readiness guard protects cold starts; immediate/busy follow-ups keep their
 * existing zero-wait behavior. Other CLIs use the queued WS fallback.
 *
 * Calls are queued per-session and identical pending commands are deduped.
 */
export function sendTerminalCommand(sessionId, command, options = {}) {
  if (!sessionId) return false

  // Check before expanding tokens: a duplicate must not launch research
  // a second time just because its original message is still queued.
  if (_commandInFlight.get(sessionId)?.command === command) return false
  if ((_commandQueues.get(sessionId) || []).some((item) => item.command === command)) return false

  // @ralph starts a pipeline — the task prompt is sent by the pipeline engine, not here
  const { command: afterRalph, isRalph } = processRalphTag(command, sessionId)
  if (isRalph) return // pipeline engine takes over

  let processed = afterRalph
  const { command: afterResearch, researchJob } = processResearchTag(processed, sessionId)
  const researchReady = researchJob?.then((result) => ({ result }), (error) => ({ error })) || null
  processed = afterResearch
  processed = processPromptTag(processed)
  processed = processTicketTag(processed)

  // Drop identical commands either already pending OR currently dispatching.
  // Back-to-back dupes are noise — e.g. a flood of the same oversight nudge.
  if (_commandInFlight.get(sessionId)?.command === command) return false
  let queue = _commandQueues.get(sessionId)
  if (!queue) {
    queue = []
    _commandQueues.set(sessionId, queue)
  }
  if (queue.some((item) => item.command === command)) return false
  
  const id = Math.random().toString(36).substring(2, 11) + '-' + Date.now()
  const item = { id, command, processed, delivery: options.delivery || 'auto', restore: options.restore || null, researchReady }
  queue.push(item)
  syncQueueToStore(sessionId)
  if (!getWs()) {
    // Held for the reconnect; give it back if the socket stays down.
    const holdTimer = setTimeout(() => {
      const q = _commandQueues.get(sessionId)
      const idx = q ? q.indexOf(item) : -1
      if (idx < 0 || getWs()) return
      q.splice(idx, 1)
      syncQueueToStore(sessionId)
      failQueuedItems(sessionId, [item], 'IVE lost its connection to the backend')
    }, DISCONNECTED_HOLD_MS)
    holdTimer?.unref?.() // node tests only
  }
  _drainCommandQueue(sessionId)
  // What the CLI will get (tags expanded), so callers can match the
  // transcript row against it.
  return { id, processed }
}

/**
 * Expand @ralph / @research / @prompt / @ticket exactly like
 * sendTerminalCommand, without sending anything. Used by the composer queue
 * (lib/composerQueue.js), which delivers through the acknowledged input
 * endpoint itself so it knows whether the CLI took the message.
 * Returns { processed, isRalph, researchReady }.
 */
export function prepareCommandForDelivery(sessionId, command) {
  const { command: afterRalph, isRalph } = processRalphTag(command, sessionId)
  if (isRalph) return { processed: afterRalph, isRalph: true, researchReady: null }
  const { command: afterResearch, researchJob } = processResearchTag(afterRalph, sessionId)
  const researchReady = researchJob?.then((result) => ({ result }), (error) => ({ error })) || null
  const processed = processTicketTag(processPromptTag(afterResearch))
  return { processed, isRalph: false, researchReady }
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
 * Send keys sequentially with a delay to prevent pseudoterminals/Ink dropping back-to-back keys.
 */
function sendKeysSequentially(sessionId, keys, delay = 80) {
  return new Promise((resolve) => {
    let index = 0
    function sendNext() {
      if (index < keys.length) {
        sendRaw(sessionId, keys[index])
        index++
        setTimeout(sendNext, delay)
      } else {
        resolve()
      }
    }
    sendNext()
  })
}

/**
 * Send a choice to the plan prompt (1=auto-accept, 2=manual, 3=give feedback).
 * Uses arrow keys since Ink's SelectInput navigates with arrows, not numbers.
 * Option 1 is pre-selected (cursor starts there).
 */
export async function sendPlanChoice(sessionId, choice) {
  if (!getWs() || !sessionId) return
  // Navigate: option 1 = 0 downs, option 2 = 1 down, option 3 = 2 downs
  const downs = Math.max(0, choice - 1)
  const keys = []
  for (let i = 0; i < downs; i++) {
    keys.push(ARROW_DOWN)
  }
  keys.push('\r')

  await sendKeysSequentially(sessionId, keys, 80)
  clearPromptBuffer(sessionId)
  useStore.getState().setSessionPlanWaiting(sessionId, false)
}

/**
 * Send feedback through option 3 of the plan prompt.
 * Navigates to option 3 (2 arrow downs + Enter), waits for the text input, then types feedback.
 */
export async function sendPlanFeedback(sessionId, feedback) {
  if (!getWs() || !sessionId) return
  // Step 1: Navigate to option 3 (2 arrow downs) and select (Enter)
  await sendKeysSequentially(sessionId, [ARROW_DOWN, ARROW_DOWN, '\r'], 80)

  // Step 2: Wait for Claude to show the text input, then type feedback.
  // Submit \r in a separate frame so Ink's paste detection on long
  // feedback bodies doesn't swallow the trailing CR.
  setTimeout(() => {
    sendRaw(sessionId, feedback)
    setTimeout(() => sendRaw(sessionId, '\r'), 300)
  }, 600)

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
  processed = processTicketTag(processed)

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
    const isMulti = processed.includes('\n')
    // Always split text and \r into separate frames — combining them lets
    // Claude's Ink paste detection swallow the trailing CR on bursts above
    // ~80 chars. Gemini needs newlines collapsed because its TUI treats \n
    // as Enter (submits partial lines).
    if (claudeIds.length) {
      ws2.send(JSON.stringify({
        action: 'broadcast',
        session_ids: claudeIds,
        data: processed,
      }))
    }
    if (geminiIds.length) {
      ws2.send(JSON.stringify({
        action: 'broadcast',
        session_ids: geminiIds,
        data: isMulti ? processed.replace(/\r?\n/g, ' ') : processed,
      }))
    }
    setTimeout(() => {
      const ws3 = getWs()
      if (!ws3) return
      ws3.send(JSON.stringify({
        action: 'broadcast',
        session_ids: sessionIds,
        data: '\r',
      }))
    }, 400)
  }, 300)
}
