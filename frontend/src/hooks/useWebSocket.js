import { useEffect } from 'react'
import useStore from '../state/store'
import { terminalWriters } from '../lib/terminalWriters'
import { startedSessions } from '../lib/terminalWriters'
import { detectPlan, detectPlanFile, clearPromptBuffer } from '../lib/outputParser'
import { api } from '../lib/api'
import { sendTerminalCommand } from '../lib/terminal'
import { SOUNDS } from '../lib/sounds'

/** Play the sound for this trigger if enabled in settings. */
function maybePling(trigger) {
  const s = useStore.getState()
  if (!s.soundEnabled || !s[trigger]) return
  const fn = SOUNDS[trigger]
  if (fn) fn(s.soundVolume / 100)
}

// Per-worker cooldown for the auto-oversight nudge so a worker whose state
// flickers can't spam the Commander with "Worker X is idle..." messages.
const _lastNudgeAt = new Map() // session_id -> timestamp ms
const NUDGE_COOLDOWN_MS = 30000
// A worker only earns a Commander nudge if it has a task in one of these
// statuses. Workers without an active task are user-driven and shouldn't
// generate Commander noise.
const NUDGE_ACTIVE_STATUSES = new Set(['todo', 'planning', 'in_progress', 'review'])

export default function useWebSocket() {
  useEffect(() => {
    // Use closure-local cancellation instead of a shared ref so React
    // StrictMode's double-mount can't leave a stale first-mount WebSocket
    // alive alongside a fresh second-mount one. Each effect invocation has
    // its own `cancelled` — when cleanup runs we flip only that copy.
    let cancelled = false
    let currentWs = null
    let reconnectTimer = null

    function connect() {
      if (cancelled) return null

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/ws`
      const ws = new WebSocket(wsUrl)
      currentWs = ws

      ws.onopen = () => {
        if (cancelled) { ws.close(); return }
        useStore.getState().setWs(ws)
        useStore.getState().setConnected(true)
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        // Backend restarted — clear PTY tracking so terminals re-start
        startedSessions.clear()
      }

      ws.onclose = () => {
        if (cancelled) return
        useStore.getState().setWs(null)
        useStore.getState().setConnected(false)
        reconnectTimer = setTimeout(connect, 2000)
      }

      ws.onerror = () => ws.close()

      ws.onmessage = (e) => {
        if (cancelled) return
        let data
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }

        // Handle messages that don't require a session_id first
        if (data.type === 'session_created' && data.session) {
          const store = useStore.getState()
          store.loadSessions([data.session])
          // Update parent with branch_group/label so its badge appears
          if (data.updated_parent) {
            store.loadSessions([data.updated_parent])
          }
          // Branch sessions open as a background tab (no focus steal)
          if (data.auto_open) {
            store.openSessionInBackground(data.session.id)
          }
          return
        }

        // Deep-research subprocess events are job-scoped, not session-scoped.
        // Surface them as DOM events so any open ResearchPanel can refresh
        // without us needing to add a research slice to the global store.
        if (data.type === 'research_started'
            || data.type === 'research_progress'
            || data.type === 'research_done') {
          window.dispatchEvent(new CustomEvent('cc-' + data.type, { detail: data }))
          // Also dispatch dash-variant for consistency (cc-research-progress etc.)
          const dashType = 'cc-' + data.type.replace(/_/g, '-')
          if (dashType !== 'cc-' + data.type) {
            window.dispatchEvent(new CustomEvent(dashType, { detail: data }))
          }
          return
        }

        // Background LLM jobs (distill session, MCP parse, etc.)
        if (data.type === 'distill_done' || data.type === 'distill_error'
            || data.type === 'mcp_parse_done' || data.type === 'mcp_parse_error') {
          window.dispatchEvent(new CustomEvent('cc-' + data.type, { detail: data }))
          return
        }

        // Session Advisor: guideline recommendations
        if (data.type === 'guideline_recommendation') {
          window.dispatchEvent(new CustomEvent('cc-guideline_recommendation', { detail: data }))
          return
        }

        const sid = data.session_id
        if (!sid) return

        switch (data.type) {
          case 'output': {
            const writer = terminalWriters.get(sid)
            if (writer) writer(data.data)

            // Permission and activity detection now handled by CLI hooks
            // (session_state events). Only plan detection still parses output
            // since there's no hook equivalent for plan file paths.

            const plan = detectPlan(data.data)
            if (plan) {
              useStore.getState().setActivePlan({ sessionId: sid, ...plan })
            }

            const planFile = detectPlanFile(data.data, sid)
            if (planFile) {
              const store = useStore.getState()
              store.setPlanFilePath(sid, planFile.filePath)

              // Determine if plan should be auto-approved. Check (in priority order):
              // 1. Task-level auto_approve_plan (specific to assigned task)
              // 2. Cascade-level autoApprovePlan (running cascade on this session)
              // 3. Session-level auto_approve_plan (session config)
              const planTask = Object.values(store.tasks).find(
                (t) => t.assigned_session_id === sid && t.plan_first && t.status === 'in_progress'
              )
              const cascadeRunner = store.cascadeRunners[sid]
              const session = store.sessions[sid]
              const shouldAutoApprove = planTask?.auto_approve_plan
                || cascadeRunner?.autoApprovePlan
                || session?.auto_approve_plan

              if (planTask && planTask.auto_approve_plan) {
                // Task-level auto-approve (existing behavior)
                sendTerminalCommand(sid, 'Plan looks good, proceed with implementation.')
                store.addNotification({
                  sessionId: sid,
                  type: 'plan_ready',
                  message: `Plan auto-approved: ${planTask.title}`,
                  taskId: planTask.id,
                })
              } else if (shouldAutoApprove) {
                // Session or cascade-level auto-approve
                sendTerminalCommand(sid, 'Plan looks good, proceed with implementation.')
                store.addNotification({
                  sessionId: sid,
                  type: 'plan_ready',
                  message: `Plan auto-approved${cascadeRunner ? ` (cascade: ${cascadeRunner.name})` : ' (session setting)'}`,
                })
              } else if (planTask) {
                // Task exists but no auto-approve — pause for review
                api.updateTask2(planTask.id, { status: 'planning' })
                store.updateTaskInStore({ ...planTask, status: 'planning' })
                maybePling('soundOnPlanReady')
                store.addNotification({
                  sessionId: sid,
                  type: 'plan_ready',
                  message: `Plan ready for review: ${planTask.title}`,
                  taskId: planTask.id,
                })
              }
            }

            break
          }

          case 'exit': {
            const writer = terminalWriters.get(sid)
            if (writer) {
              writer(`\r\n\x1b[33m[process exited with code ${data.code}]\x1b[0m\r\n`)
              // Restart hint is shown as an interactive banner inside TerminalView
            }
            startedSessions.delete(sid)
            clearPromptBuffer(sid)
            _lastNudgeAt.delete(sid)
            const exitStore = useStore.getState()
            exitStore.setSessionStatus(sid, 'exited')
            exitStore.setSessionPlanWaiting(sid, false)
            if (exitStore.activeSessionId !== sid) maybePling('soundOnSessionDone')
            break
          }

          case 'error': {
            const writer = terminalWriters.get(sid)
            if (writer) {
              writer(`\r\n\x1b[31m[error: ${data.message}]\x1b[0m\r\n`)
            }
            break
          }

          // prompt_state — no longer emitted by backend (replaced by session_state from hooks)

          case 'status': {
            useStore.getState().setSessionStatus(sid, data.status)
            break
          }

          case 'replay_done': {
            useStore.getState().setSessionStatus(sid, 'idle')
            break
          }

          case 'session_created': {
            // New session created (e.g., by Commander via MCP) — add to store
            if (data.session) {
              useStore.getState().loadSessions([data.session])
            }
            break
          }

          case 'session_renamed': {
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (sess) {
              store.loadSessions([{ ...sess, name: data.name }])
            }
            break
          }

          case 'session_popped_out': {
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (sess) {
              store.loadSessions([{ ...sess, is_external: 1 }])
            }
            break
          }

          case 'session_created': {
            // External session auto-registered — add to store if in active workspace
            if (data.is_external) {
              const store = useStore.getState()
              if (data.workspace_id === store.activeWorkspaceId) {
                store.addSession({
                  id: data.session_id,
                  workspace_id: data.workspace_id,
                  name: data.name,
                  is_external: 1,
                  status: 'running',
                })
              }
            }
            break
          }

          case 'session_switched': {
            // CLI type changed — update store and trigger re-start of PTY
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (sess) {
              store.loadSessions([{ ...sess, cli_type: data.cli_type, model: data.model }])
            }
            // Clear the started flag and restart with correct dimensions
            startedSessions.delete(sid)
            setTimeout(() => {
              store.restartSession(sid)
            }, 500)
            break
          }

          case 'model_changed': {
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (sess) {
              store.loadSessions([{ ...sess, model: data.model }])
            }
            break
          }

          case 'session_idle': {
            // Emitted by hooks.py when a Stop hook fires (throttled).
            // Triggers the oversight nudge to the Commander session.
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (!sess || sess.session_type === 'commander') break

            // Get workspace oversight setting
            const workspace = store.workspaces.find((w) => w.id === sess.workspace_id)
            const oversight = workspace?.human_oversight || 'approve_plans'

            // Look up the active task assigned to this worker — both to gate
            // the nudge and to pick the *right* Commander when a workspace
            // has more than one.
            const activeTask = Object.values(store.tasks || {}).find(
              (t) => t.assigned_session_id === sid && NUDGE_ACTIVE_STATUSES.has(t.status)
            )
            const hasActiveTask = !!activeTask

            // Prefer the task's own commander, fall back to any running
            // Commander in the workspace.
            let commander = null
            if (activeTask && activeTask.commander_session_id) {
              const c = store.sessions[activeTask.commander_session_id]
              if (c && c.session_type === 'commander' && c.status !== 'exited') {
                commander = c
              }
            }
            if (!commander) {
              commander = Object.values(store.sessions).find(
                (s) =>
                  s.workspace_id === sess.workspace_id &&
                  s.session_type === 'commander' &&
                  s.status !== 'exited'
              )
            }

            // Per-worker cooldown to prevent nudge floods.
            const now = Date.now()
            const lastNudge = _lastNudgeAt.get(sid) || 0
            const recentlyNudged = now - lastNudge < NUDGE_COOLDOWN_MS

            if (commander && hasActiveTask && !recentlyNudged) {
              _lastNudgeAt.set(sid, now)
              // Nudge the Commander to check on this worker
              const autoMsg = oversight === 'full_auto'
                ? `Worker "${sess.name}" is idle. Read its output with read_session_output. If it produced a plan, approve it and proceed autonomously. If it finished a task, update the task status. Handle everything without asking the user.`
                : oversight === 'approve_plans'
                  ? `Worker "${sess.name}" is idle. Read its output with read_session_output. If it produced a plan, summarize it for the user and wait for their approval. If it finished a task, update the task status and report results.`
                  : `Worker "${sess.name}" is idle. Read its output with read_session_output and report to the user. Wait for user instructions before taking any action.`
              sendTerminalCommand(commander.id, autoMsg)
            }

            // Notify user based on oversight level
            if (store.activeSessionId !== sid) {
              maybePling('soundOnSessionDone')
              if (oversight === 'approve_all' || (oversight === 'approve_plans' && !commander)) {
                store.addNotification({
                  sessionId: sid,
                  type: 'session_done',
                  message: `${sess.name || sid.slice(0, 8)} finished working`,
                })
              }
            }
            break
          }

          case 'task_update': {
            useStore.getState().updateTaskInStore(data.task)
            break
          }

          case 'test_queue_update': {
            // Broadcast from backend when test queue changes
            window.dispatchEvent(new CustomEvent('test-queue-update', { detail: data }))
            break
          }

          case 'permission_question': {
            // Session went idle after asking "Want me to implement this?"
            // instead of just doing it.  In full_auto workspaces we auto-
            // respond; otherwise surface a notification with a quick-approve.
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (!sess) break

            const workspace = store.workspaces.find((w) => w.id === sess.workspace_id)
            const oversight = workspace?.human_oversight || 'approve_plans'

            if (oversight === 'full_auto') {
              // Auto-respond — don't bother the user
              sendTerminalCommand(sid, 'Yes, go ahead and implement it.')
            } else if (store.activeSessionId !== sid) {
              // Only notify if the session isn't already focused
              if (!store.notifications.some((n) => n.sessionId === sid && n.type === 'permission_question')) {
                const name = sess.name || sid.slice(0, 8)
                maybePling('soundOnInputNeeded')
                store.addNotification({
                  sessionId: sid,
                  type: 'permission_question',
                  message: `${name} is asking permission instead of acting`,
                  question: data.question || '',
                  context: data.context || '',
                })
              }
            }
            break
          }

          // ─── Hook-sourced events (replace ANSI detection) ──────────
          // These fire from CLI lifecycle hooks via POST /api/hooks/event.
          // Once a session receives a hook event, it's marked as
          // "hook-enabled" and ANSI-detected state is ignored for it.

          case 'session_state': {
            // Definitive state from hooks: working, idle, prompting

            const store = useStore.getState()
            if (data.state === 'working') {
              store.setSessionActive(sid)
              store.setSessionPlanWaiting(sid, false)
            } else if (data.state === 'prompting') {
              const wasWaiting = store.planWaiting[sid]
              store.setSessionPlanWaiting(sid, true)
              if (!wasWaiting && store.activeSessionId !== sid) {
                const sess = store.sessions[sid]
                if (!store.notifications.some((n) => n.sessionId === sid && n.type === 'input_needed')) {
                  // Build a descriptive message from available context
                  const name = sess?.name || sid.slice(0, 8)
                  let message
                  if (data.tool_name) {
                    message = `${name}: permission needed for ${data.tool_name}`
                  } else if (data.message) {
                    message = `${name}: ${data.message}`
                  } else {
                    message = `${name} needs your input`
                  }
                  // Use structured data from hook payload; fall back to
                  // parsing numbered lines from terminal context
                  const ctx = data.context || ''
                  let options = data.options
                  if (!options || !options.length) {
                    options = []
                    for (const line of ctx.split('\n')) {
                      const m = line.match(/^\s*[❯►>]?\s*(\d+)[\.\)]\s+(.+)/)
                      if (m) {
                        const text = m[2].trim()
                        if (text) options.push({ num: parseInt(m[1]), text })
                      }
                    }
                  }
                  const actions = data.actions || []
                  maybePling('soundOnInputNeeded')
                  store.addNotification({
                    sessionId: sid,
                    type: 'input_needed',
                    message,
                    context: ctx,
                    ...(options.length >= 2 ? { options } : {}),
                    ...(actions.length ? { actions } : {}),
                  })
                }
              }
            } else if (data.state === 'idle') {
              store.setSessionPlanWaiting(sid, false)
              // Claude finished naturally — clear force-message combine history
              if (store.forceHistory[sid]) store.setForceHistory(sid, null)
            }
            break
          }

          case 'tool_event': {
            // Structured tool lifecycle from hooks (PreToolUse/PostToolUse)
            // If the event carries an agent_id, attribute the tool call to that sub-agent
            if (data.agent_id && data.action === 'start') {
              useStore.getState().addSubagentTool(sid, data.agent_id, {
                tool: data.tool_name,
                input: data.tool_input,
                startedAt: Date.now(),
              })
            }
            break
          }

          case 'subagent_event': {
            const store = useStore.getState()
            if (data.action === 'start' && data.agent_id) {
              store.addSubagent(sid, {
                id: data.agent_id,
                type: data.agent_type || 'unknown',
              })
            } else if (data.action === 'stop' && data.agent_id) {
              store.completeSubagent(sid, data.agent_id, data.result_preview || null, data.transcript_path || null)
              maybePling('soundOnAgentDone')
            }
            break
          }

          case 'capture': {
            useStore.getState().addCapture({ session_id: data.session_id, ...data.capture })
            break
          }

          case 'quota_exceeded': {
            const store = useStore.getState()
            const session = store.sessions[sid]
            store.addNotification({
              sessionId: sid,
              type: 'permission',
              message: `Usage depleted for ${session?.name || sid.slice(0, 8)} — 4h cooldown started. Switch account or wait for reset.`,
            })
            break
          }

          case 'context_low': {
            // Pre-warning: Claude Code's status line says context is low.
            // Drives the same indicator as the compaction hooks but with
            // a 'warning' status (orange) and the actual % in the pill.
            const store = useStore.getState()
            const session = store.sessions[sid]

            // Don't downgrade an active compacting/compacted state.
            const cur = store.compactionState[sid]
            if (cur && (cur.status === 'compacting' || cur.status === 'compacted')) break

            store.setCompactionState(sid, {
              status: 'warning',
              percent_left: data.percent_left,
              startedAt: Date.now(),
            })

            if (!store.notifications.some((n) => n.sessionId === sid && n.type === 'context_warning')) {
              store.addNotification({
                sessionId: sid,
                type: 'context_warning',
                message: `${session?.name || sid.slice(0, 8)}: only ${data.percent_left}% context left until auto-compact.`,
              })
            }
            // No setTimeout — the warning persists until a real compaction
            // (PreCompact) replaces it, or PostCompact's 60s timer fires.
            break
          }

          case 'compaction': {
            // Driven by CLI hooks (Claude PreCompact/PostCompact, Gemini
            // PreCompress). Replaces the old regex-based detection that
            // false-positived on the word "compact" appearing in Claude
            // Code's own status bar. Manual /compact is filtered server-side.
            const store = useStore.getState()
            const session = store.sessions[sid]
            const startedAt = Date.now()
            const status = data.phase === 'post' ? 'compacted' : 'compacting'

            store.setCompactionState(sid, { status, startedAt, trigger: data.trigger })

            // One notification per compaction event — dedup against any
            // existing compaction notification for this session.
            if (
              data.phase !== 'post' &&
              !store.notifications.some((n) => n.sessionId === sid && n.type === 'compaction')
            ) {
              store.addNotification({
                sessionId: sid,
                type: 'compaction',
                message: `Auto-compacting ${session?.name || sid.slice(0, 8)} — context will be summarized.`,
              })
            }

            // Auto-clear the visual indicator after 60s, but only if no
            // newer compaction event has replaced this one in the meantime.
            setTimeout(() => {
              const cur = useStore.getState().compactionState[sid]
              if (cur && cur.startedAt === startedAt) {
                useStore.getState().clearCompactionState(sid)
              }
            }, 60000)
            break
          }

          case 'cascade_progress':
          case 'cascade_completed':
          case 'cascade_loop_reprompt': {
            useStore.getState().handleCascadeEvent(data)
            break
          }

          case 'pipeline_run_update': {
            if (data.run) useStore.getState().handlePipelineRunUpdate(data.run)
            break
          }
        }
      }

      return ws
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (currentWs) {
        // Detach handlers before closing so any in-flight onopen / onmessage
        // that fires during the close handshake can't leak into store state.
        currentWs.onopen = null
        currentWs.onmessage = null
        currentWs.onclose = null
        currentWs.onerror = null
        if (currentWs.readyState <= WebSocket.OPEN) currentWs.close()
        currentWs = null
      }
    }
  }, [])
}
