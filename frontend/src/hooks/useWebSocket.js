import { useEffect } from 'react'
import useStore from '../state/store'
import { terminalWriters } from '../lib/terminalWriters'
import { startedSessions, lastOutputAt } from '../lib/terminalWriters'
import { detectPlan, detectPlanFile, clearPromptBuffer } from '../lib/outputParser'
import { api } from '../lib/api'
import { sendTerminalCommand } from '../lib/terminal'
import { SOUNDS } from '../lib/sounds'
import { hasBadThinkingSignatureError } from '../lib/sessionRuntime'
import { attentionDetails, handleAttentionEvent } from '../lib/sessionAttention'
import { isHelperSession } from '../lib/visibleSessions'
import { summarizeToolInput } from '../lib/sessionVocabulary'

// Tool names whose start marks a file as changed in this session.
const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
import { handleTerminalError } from '../lib/terminalErrors'
import { handleSessionError } from '../lib/sessionErrors'
import { handleCoordinationEvent, handleStartupBlockerNotice } from '../lib/coordinationEvents'
import { handleGlobalEvent } from '../lib/globalEvents'

const badThinkingSignatureHandled = new Set()

/** Play the sound for this trigger if enabled in settings. */
// One live-apply restart can change perms, model and effort at once and
// sends an "applied" event per field; the terminal re-syncs only once.
const lastProcessReplaced = new Map()
function dispatchLiveApplyReplaced(sessionId, detail) {
  const now = Date.now()
  if (now - (lastProcessReplaced.get(sessionId) || 0) < 500) return
  lastProcessReplaced.set(sessionId, now)
  window.dispatchEvent(new CustomEvent('cc-terminal-process-replaced', { detail }))
}

function maybePling(trigger) {
  const s = useStore.getState()
  if (!s.soundEnabled || !s[trigger]) return
  const fn = SOUNDS[trigger]
  if (fn) fn(s.soundVolume / 100)
}

function requestSessionMessageRefresh(sessionId, reason) {
  if (!sessionId) return
  window.dispatchEvent(new CustomEvent('cc-session-messages-refresh', {
    detail: { sessionId, reason },
  }))
}

export default function useWebSocket() {
  // Initialize multiplayer identity once on mount
  useEffect(() => { useStore.getState().initIdentity() }, [])

  // Broadcast active session changes as presence updates
  useEffect(() => {
    let prev = useStore.getState().activeSessionId
    const unsub = useStore.subscribe((state) => {
      if (state.activeSessionId !== prev) {
        prev = state.activeSessionId
        const { ws, myClientId } = state
        if (ws && ws.readyState === WebSocket.OPEN && myClientId) {
          ws.send(JSON.stringify({
            action: 'presence_update',
            client_id: myClientId,
            viewing_session: state.activeSessionId,
          }))
        }
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    // Use closure-local cancellation instead of a shared ref so React
    // StrictMode's double-mount can't leave a stale first-mount WebSocket
    // alive alongside a fresh second-mount one. Each effect invocation has
    // its own `cancelled` — when cleanup runs we flip only that copy.
    let cancelled = false
    let currentWs = null
    let reconnectTimer = null
    let hasConnected = false
    let resyncSeq = 0

    async function resyncSessionsFromBackend() {
      const seq = ++resyncSeq
      const knownSessionIdsAtRequest = Object.keys(useStore.getState().sessions)
      try {
        const rows = await api.getSessions()
        if (cancelled || seq !== resyncSeq || !Array.isArray(rows)) return
        useStore.getState().resyncSessions(rows, { knownSessionIdsAtRequest })
      } catch {
        // The next reconnect tries again; live events keep flowing meanwhile.
      }
    }

    function connect() {
      if (cancelled) return null

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/ws`
      let ws
      try {
        ws = new WebSocket(wsUrl)
      } catch {
        // Some webviews (notably Tauri's WKWebView, whose `tauri://localhost`
        // origin is a *secure* context) block insecure ws:// as mixed content and
        // throw synchronously from the WebSocket constructor. Never let that crash
        // the whole app — treat it like a dropped connection and retry with backoff.
        useStore.getState().setConnected(false)
        if (!cancelled && !reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 2000)
        }
        return null
      }
      currentWs = ws

      ws.onopen = () => {
        if (cancelled) { ws.close(); return }
        const isReconnect = hasConnected
        hasConnected = true
        useStore.getState().setWs(ws)
        useStore.getState().setConnected(true)
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        // Terminals re-attach on their own (resume_pty / start_pty). Session
        // state is taken from the backend as it is now, not wiped: chat tiles
        // have no terminal to reattach and kept "Not Started", and a turn that
        // ended during the gap kept "Working".
        startedSessions.clear()
        resyncSessionsFromBackend()
        // Send multiplayer hello
        const { myClientId, myName, myColor } = useStore.getState()
        if (myClientId) {
          ws.send(JSON.stringify({ action: 'hello', client_id: myClientId, name: myName, color: myColor }))
        }
        if (isReconnect) {
          window.dispatchEvent(new CustomEvent('cc-websocket-reconnected', {
            detail: { ws },
          }))
        }
      }

      ws.onclose = () => {
        if (cancelled) return
        useStore.getState().setWs(null)
        useStore.getState().setConnected(false)
        useStore.setState({ peers: {} })
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
        if (data.type === 'phone_locked') {
          window.dispatchEvent(new CustomEvent('ive:phone-locked', { detail: { error: 'locked' } }))
          return
        }
        if (data.type === 'session_created' && data.session) {
          const store = useStore.getState()
          store.loadSessions([data.session])
          // Update parent with branch_group/label so its badge appears
          if (data.updated_parent) {
            store.loadSessions([data.updated_parent])
          }
          // Branch sessions open as a background tab (no focus steal). Helper
          // sessions (Commander, Brainstormer) never become a tab on their own.
          if (data.auto_open && !isHelperSession(data.session)) {
            store.openSessionInBackground(data.session.id)
            // Notify user when a branch preserved their original conversation
            if (data.parent_session_id) {
              store.addNotification({
                type: 'branch_created',
                sessionId: data.session.id,
                message: `Original conversation preserved as "${data.session.name || 'Session'}"`,
              })
            }
          }
          return
        }

        // Session-less events (research jobs, session_update, test queue,
        // auto-dispatch, preview registration, phone pairing). They carry no
        // session_id and would otherwise be dropped by the guard below.
        if (handleGlobalEvent(data, {
          store: useStore.getState(),
          dispatch: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
          refreshWorkspaces: () => {
            api.getWorkspaces().then((list) => {
              if (Array.isArray(list)) useStore.getState().setWorkspaces(list)
            }).catch(() => {})
          },
        })) return

        // Background LLM jobs (distill session, MCP parse, etc.)
        if (data.type === 'distill_done' || data.type === 'distill_error'
            || data.type === 'mcp_parse_done' || data.type === 'mcp_parse_error') {
          window.dispatchEvent(new CustomEvent('cc-' + data.type, { detail: data }))
          return
        }

        // Commander event bus envelope. The bus broadcasts every emit() as
        // {type: "commander_event", event: {event_type, payload, workspace_id, ...}}.
        // Most consumers go through the activity-feed query, but a few panels
        // want push semantics (e.g. ResearchHub refreshing on observatory scan
        // completion so scheduled scans don't require a tab bounce). Unwrap
        // and re-dispatch the inner event_type as a DOM CustomEvent so panels
        // can listen without us coupling them to the WS hook.
        if (data.type === 'commander_event' && data.event?.event_type) {
          const evt = data.event
          const detail = { ...evt.payload, event_type: evt.event_type, workspace_id: evt.workspace_id }
          // One canonical name (cc-<event_type>); no dash alias, so a panel
          // never runs the same handler twice for one event.
          window.dispatchEvent(new CustomEvent('cc-' + evt.event_type, { detail }))
          if (evt.event_type === 'blueprint_ready') {
            const store = useStore.getState()
            if (!store.notifications.some((n) => n.type === 'blueprint_ready' && n.taskId === detail.task_id)) {
              maybePling('soundOnPlanReady')
              store.addNotification({
                type: 'blueprint_ready',
                taskId: detail.task_id,
                workspaceId: detail.workspace_id,
                blueprintPath: detail.blueprint_path,
                message: `Blueprint ready for approval: ${detail.title || detail.task_id}`,
              })
            }
          }
          if (evt.event_type === 'task_created' && detail.source === 'observatory') {
            const store = useStore.getState()
            if (!store.notifications.some((notification) => notification.type === 'board_suggestion' && notification.taskId === detail.task_id)) {
              store.addNotification({
                type: 'board_suggestion',
                taskId: detail.task_id,
                workspaceId: detail.workspace_id,
                message: detail.title || 'Agent-suggested board item',
              })
            }
          }
          if (evt.event_type === 'safety_rule_proposed' && detail.suggestion) {
            const store = useStore.getState()
            const suggestionId = detail.suggestion_id || detail.suggestion.id
            if (!store.notifications.some((notification) => (
              notification.type === 'safety_rule_proposed'
              && notification.suggestionId === suggestionId
            ))) {
              store.addNotification({
                type: 'safety_rule_proposed',
                suggestionId,
                workspaceId: detail.workspace_id,
                suggestion: detail.suggestion,
                message: detail.suggestion.rationale || 'Repeated approvals can become an allow rule.',
              })
            }
          }
          return
        }

        // Session Advisor: guideline recommendations
        if (data.type === 'guideline_recommendation') {
          window.dispatchEvent(new CustomEvent('cc-guideline_recommendation', { detail: data }))
          return
        }

        // Skill Suggester: auto-matched skill suggestions
        if (data.type === 'skill_suggestion') {
          window.dispatchEvent(new CustomEvent('cc-skill_suggestion', { detail: data }))
          return
        }

        // Doom loop detection warning
        if (data.type === 'doom_loop_warning') {
          const sess = useStore.getState().sessions[data.session_id]
          useStore.getState().addNotification({
            type: 'warning',
            message: `Loop detected in ${sess?.name || 'session'}: ${data.pattern}`,
            sessionId: data.session_id,
          })
          return
        }

        // Multiplayer presence events
        if (data.type === 'presence_snapshot') {
          useStore.getState().handlePresenceSnapshot(data.peers || [])
          return
        }
        if (data.type === 'presence_join') {
          useStore.getState().handlePresenceJoin(data)
          return
        }
        if (data.type === 'presence_update') {
          useStore.getState().handlePresenceUpdate(data)
          return
        }
        if (data.type === 'presence_leave') {
          useStore.getState().handlePresenceLeave(data)
          return
        }

        // Task and pipeline updates are global (no session_id) — handle before the sid guard
        if (data.type === 'task_update') {
          const store = useStore.getState()
          if (data.action === 'deleted' && data.task?.id) {
            store.removeTaskFromStore(data.task.id)
          } else if (data.task) {
            store.updateTaskInStore(data.task)
          }
          return
        }
        if (data.type === 'pipeline_run_update') {
          if (data.run) useStore.getState().handlePipelineRunUpdate(data.run)
          return
        }

        // Scratchpad live-sync — routed to the open Scratchpad via window event
        // (component-local textarea state, not Zustand, to avoid re-render storms).
        if (data.type === 'scratchpad_updated') {
          window.dispatchEvent(new CustomEvent('scratchpad-remote-update', {
            detail: { sessionId: data.session_id, content: data.content, origin: data.origin },
          }))
          return
        }

        // Memory sync conflict (workspace-scoped, no session_id)
        if (data.type === 'memory_sync_conflict') {
          useStore.getState().addNotification({
            type: 'memory_sync_conflict',
            message: `Memory sync: ${data.conflict_count} conflict${data.conflict_count !== 1 ? 's' : ''} detected`,
            workspaceId: data.workspace_id,
            conflictCount: data.conflict_count,
          })
          return
        }

        if (data.type === 'workspace_deleted') {
          useStore.getState().removeWorkspace(data.workspace_id, data.session_ids)
          return
        }

        const sid = data.session_id
        if (!sid) return

        switch (data.type) {
          case 'output': {
            const writer = terminalWriters.get(sid)
            if (writer) writer(data.data, data)
            lastOutputAt.set(sid, Date.now())

            if (hasBadThinkingSignatureError(data.data)) {
              const store = useStore.getState()
              startedSessions.delete(sid)
              clearPromptBuffer(sid)
              store.setSessionStarted?.(sid, false)
              store.setSessionPlanWaiting(sid, false)
              store.setSessionAgentState?.(sid, 'idle')
              store.setSessionStatus(sid, 'error', {
                pty_alive: false,
                agentState: 'idle',
              })
              if (!badThinkingSignatureHandled.has(sid)) {
                badThinkingSignatureHandled.add(sid)
                api.updateSession(sid, { native_session_id: null }).catch(() => {})
                store.addNotification({
                  type: 'error',
                  sessionId: sid,
                  message: 'Claude resume transcript has a signed thinking-block error. Resume was disabled for this session; restart it to continue fresh.',
                })
              }
            }

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

          case 'terminal_reset': {
            window.dispatchEvent(new CustomEvent('cc-terminal-reset', { detail: data }))
            if (data.reason && !['new_view', 'missing_sequence'].includes(data.reason)) {
              useStore.getState().addNotification({
                type: 'warning',
                sessionId: sid,
                message: 'Terminal connection gap exceeded retained output; the view was explicitly reset.',
              })
            }
            break
          }

          case 'terminal_resumed': {
            const resumedStore = useStore.getState()
            if (data.pty_alive) startedSessions.add(sid)
            else startedSessions.delete(sid)
            resumedStore.setSessionStarted?.(sid, !!data.pty_alive)
            window.dispatchEvent(new CustomEvent('cc-terminal-resumed', { detail: data }))
            break
          }

          case 'terminal_geometry':
          case 'terminal_geometry_available': {
            window.dispatchEvent(new CustomEvent(`cc-${data.type.replace(/_/g, '-')}`, {
              detail: data,
            }))
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
            const exitStore = useStore.getState()
            exitStore.setSessionStarted?.(sid, false)
            const alreadyAuthFailed = exitStore.sessions[sid]?.status === 'auth_failed'
            exitStore.setSessionStatus(
              sid,
              alreadyAuthFailed
                ? 'auth_failed'
                : badThinkingSignatureHandled.has(sid) ? 'error' : 'exited',
              { pty_alive: false, exit_code: data.code ?? null, exit_classification: data.classification || null }
            )
            exitStore.setSessionPlanWaiting(sid, false)
            if (typeof exitStore.setSessionAgentState === 'function') {
              exitStore.setSessionAgentState(sid, 'idle')
            }
            // "Session done" is an agent finishing; a shell closing is not news.
            if (exitStore.activeSessionId !== sid && exitStore.sessions[sid]?.cli_type !== 'shell') maybePling('soundOnSessionDone')
            break
          }

          case 'error': {
            // Setup / trust / update prompts swallowed the keystroke: say why once.
            handleStartupBlockerNotice(useStore.getState(), sid, data)
            handleTerminalError(useStore.getState(), sid, data, terminalWriters.get(sid))
            break
          }

          case 'hooks_notice': {
            // Codex skips config.toml hooks that have no persisted trust, so the
            // session would run without status, id capture or Safety Gate.
            const store = useStore.getState()
            if (!store.notifications.some((n) => n.sessionId === sid && n.type === 'warning' && n.reason === data.reason)) {
              store.addNotification({
                sessionId: sid,
                type: 'warning',
                reason: data.reason,
                cli: data.cli,
                message: data.message || 'Codex hooks need review: run /hooks in Codex.',
              })
            }
            break
          }

          case 'status': {
            const extra = Object.prototype.hasOwnProperty.call(data, 'pty_alive') ? { pty_alive: data.pty_alive } : {}
            const store = useStore.getState()
            if (Object.prototype.hasOwnProperty.call(data, 'pty_alive')) {
              if (data.pty_alive) startedSessions.add(sid)
              else startedSessions.delete(sid)
              store.setSessionStarted?.(sid, !!data.pty_alive)
            }
            store.setSessionStatus(sid, data.status, extra)
            break
          }

          case 'replay_done': {
            useStore.getState().setSessionStatus(sid, 'idle')
            break
          }

          case 'session_project_hint': {
            // Quick session: the backend saw the agent working in one project.
            const store = useStore.getState()
            store.setProjectHint(sid, { path: data.path, name: data.name, workspace_id: data.workspace_id || null })
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

          case 'session_deleted': {
            // Deleted in another tab/client (or via the API): drop the ghost.
            const store = useStore.getState()
            store.removeSession(sid)
            break
          }

          case 'session_archived': {
            useStore.getState().setSessionArchived(data.session_id, data.archived)
            break
          }

          case 'session_summary': {
            useStore.getState().setSessionSummary(data.session_id, data.summary)
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
                }, { focus: false })
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
            store.setSessionStarted?.(sid, false)
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
            // The oversight nudge into Commander is now posted server-side
            // (see hooks._nudge_commander_for_idle_worker) so it lands
            // exactly once per worker idle regardless of how many WS
            // clients are connected. Here we only handle the user-facing
            // notification + sound.
            requestSessionMessageRefresh(sid, 'session_idle')
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (!sess || sess.session_type === 'commander') break

            const workspace = store.workspaces.find((w) => w.id === sess.workspace_id)
            const oversight = workspace?.human_oversight || 'approve_plans'

            const hasCommander = Object.values(store.sessions).some(
              (s) =>
                s.workspace_id === sess.workspace_id &&
                s.session_type === 'commander' &&
                s.status !== 'exited'
            )

            if (store.activeSessionId !== sid) {
              maybePling('soundOnSessionDone')
              if (oversight === 'approve_all' || (oversight === 'approve_plans' && !hasCommander)) {
                store.addNotification({
                  sessionId: sid,
                  type: 'session_done',
                  message: `${sess.name || sid.slice(0, 8)} finished working`,
                })
              }
            }
            break
          }

          case 'permission_question': {
            // Session went idle after asking "Want me to implement this?"
            // instead of just doing it.  In full_auto workspaces we auto-
            // respond; otherwise keep the question in the attention bar.
            const store = useStore.getState()
            const sess = store.sessions[sid]
            if (!sess) break

            const workspace = store.workspaces.find((w) => w.id === sess.workspace_id)
            const oversight = workspace?.human_oversight || 'approve_plans'

            if (oversight === 'full_auto') {
              sendTerminalCommand(sid, 'Yes, go ahead and implement it.')
            } else {
              if (!sess.attention) maybePling('soundOnInputNeeded')
              store.setSessionAttention(sid, attentionDetails(data))
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
            // The CLI is being terminated after an auth failure. A delayed
            // lifecycle hook from that dying process must not resurrect the
            // session as Working/Idle over the blocking Auth state.
            if (store.sessions[sid]?.status === 'auth_failed') break
            handleAttentionEvent(store, sid, data)
            store.setSessionStarted?.(sid, true)
            if (typeof store.setSessionAgentState === 'function') {
              store.setSessionAgentState(sid, data.state)
            }
            if (data.state === 'working') {
              store.setSessionActive(sid)
              store.setSessionPlanWaiting(sid, false)
              store.setSessionStatus(sid, 'running', { pty_alive: true })
              if (data.tool_name) store.setSessionLastTool(sid, { tool_name: data.tool_name, summary: '', input: null, at: Date.now() })
            } else if (data.state === 'prompting') {
              requestSessionMessageRefresh(sid, 'session_prompting')
              const wasWaiting = store.planWaiting[sid]
              store.setSessionPlanWaiting(sid, true)
              store.setSessionStatus(sid, 'waiting', { pty_alive: true })
              if (!wasWaiting) maybePling('soundOnInputNeeded')
            } else if (data.state === 'idle') {
              requestSessionMessageRefresh(sid, 'session_idle_state')
              store.setSessionPlanWaiting(sid, false)
              store.setSessionStatus(sid, 'idle', { pty_alive: true })
              // Claude finished naturally — clear force-message combine history
              if (store.forceHistory[sid]) store.setForceHistory(sid, null)
            }
            break
          }

          // Claude StopFailure (API error, overload, rate limit): the turn is
          // over and the CLI is back at its prompt. Without this the session
          // kept showing "Working" until the next hook arrived.
          case 'prompt_state':
          case 'session_error': {
            if (handleSessionError(useStore.getState(), sid, data) && data.type === 'session_error') {
              requestSessionMessageRefresh(sid, 'session_error')
            }
            break
          }

          // Peer warnings, file conflicts and queue handoffs: the agent gets
          // them in its PTY, the user gets one toast per distinct event.
          case 'peer_warning':
          case 'file_conflict':
          case 'worker_queue_delivery': {
            handleCoordinationEvent(useStore.getState(), sid, data)
            break
          }

          case 'permission_event':
          case 'session_attention': {
            const store = useStore.getState()
            const wasWaiting = !!store.sessions[sid]?.attention
            handleAttentionEvent(store, sid, data)
            if (!wasWaiting && useStore.getState().sessions[sid]?.attention) maybePling('soundOnInputNeeded')
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
            // The main session's activity line ("Editing src/x.ts") and its
            // list of changed files; subagent calls stay in their own tree.
            if (!data.agent_id && data.action === 'start' && data.tool_name) {
              const store = useStore.getState()
              const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : null
              store.setSessionLastTool(sid, { tool_name: data.tool_name, summary: summarizeToolInput(data.tool_name, input), input, at: Date.now() })
              if (EDIT_TOOL_NAMES.has(String(data.tool_name).toLowerCase())) {
                const path = input?.file_path || input?.path || input?.notebook_path
                if (path) store.addChangedFile(sid, path)
              }
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

          case 'quota_suspected': {
            const store = useStore.getState()
            const session = store.sessions[sid]
            store.addNotification({
              sessionId: sid,
              type: 'quota_suspected',
              message: `Terminal text suggests a quota limit for ${session?.name || sid.slice(0, 8)}. Credentials will not move without your confirmation.`,
              action: {
                label: 'Confirm & switch',
                onClick: async () => {
                  try {
                    await api.confirmSessionQuota(sid, session?.account_id, data.reset_unix)
                  } catch (error) {
                    useStore.getState().addNotification({
                      sessionId: sid,
                      type: 'error',
                      message: `Quota confirmation failed: ${error?.message || error}`,
                    })
                  }
                },
              },
            })
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

          case 'auth_failed': {
            const store = useStore.getState()
            const cli = String(data.cli || store.sessions[sid]?.cli_type || 'claude').toLowerCase()
            const cliLabel = cli === 'codex' ? 'Codex' : cli === 'claude' ? 'Claude' : cli
            const fallbackHint = cli === 'codex'
              ? 'Restart the session to reload credentials; if it fails again run `codex login` in a terminal.'
              : 'Restart the session to re-sync credentials; if it fails again run `claude /login` in a terminal.'

            startedSessions.delete(sid)
            clearPromptBuffer(sid)
            store.setSessionStarted?.(sid, false)
            store.setSessionPlanWaiting(sid, false)
            store.setSessionAgentState?.(sid, 'idle')
            store.setSessionStatus(sid, 'auth_failed', {
              pty_alive: false,
              agentState: 'idle',
            })

            if (!store.notifications.some((n) => n.sessionId === sid && n.type === 'auth_failed')) {
              store.addNotification({
                sessionId: sid,
                type: 'auth_failed',
                message: `${cliLabel} login expired — session paused. ${data.hint || fallbackHint}`,
                action: {
                  label: 'Restart',
                  onClick: () => useStore.getState().restartSession(sid),
                },
              })
            }
            break
          }

          case 'permission_mode_apply': {
            // The backend restarts the CLI (resuming the conversation) so a
            // Perms change takes effect; see backend/permission_mode_live.py.
            const store = useStore.getState()
            store.setPermissionApply(sid, data)
            if (data.state === 'applied') {
              if (store.sessions[sid]) {
                useStore.setState((s) => s.sessions[sid]
                  ? { sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], permission_mode: data.mode } } }
                  : {})
              }
              // New process: the terminal re-syncs from the fresh stream.
              dispatchLiveApplyReplaced(sid, data)
            } else if (data.state === 'failed') {
              store.addNotification({
                sessionId: sid,
                type: 'error',
                message: `Could not switch permissions to ${data.mode}: ${data.error || 'restart failed'}`,
              })
            }
            break
          }

          case 'launch_apply': {
            // Model / effort change on a running session: same restart path
            // as Perms (backend/permission_mode_live.py).
            const store = useStore.getState()
            const field = data.field
            if (field !== 'model' && field !== 'effort') break
            store.setLaunchApply(sid, field, data)
            if (data.state === 'applied') {
              useStore.setState((s) => s.sessions[sid]
                ? { sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], [field]: data.value ?? '' } } }
                : {})
              dispatchLiveApplyReplaced(sid, data)
              window.dispatchEvent(new CustomEvent('cc-launch-applied', { detail: data }))
            } else if (data.state === 'failed') {
              store.addNotification({
                sessionId: sid,
                type: 'error',
                message: `Could not switch ${field} to ${data.value || 'default'}: ${data.error || 'restart failed'}`,
              })
            }
            break
          }

          case 'account_switched': {
            // Backend reports success only after its locked stop/restart has
            // started the replacement PTY with the new verified account.
            const store = useStore.getState()
            const session = store.sessions[sid]
            store.addNotification({
              sessionId: sid,
              type: 'info',
              message: `Auto-cycled ${session?.name || sid.slice(0, 8)}: ${data.old_account_name} → ${data.new_account_name}`,
            })
            const writer = terminalWriters.get(sid)
            if (writer) {
              writer(`\r\n\x1b[33m[auth cycled: ${data.old_account_name} → ${data.new_account_name}]\x1b[0m\r\n`)
            }
            window.dispatchEvent(new CustomEvent('cc-terminal-process-replaced', {
              detail: data,
            }))
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
