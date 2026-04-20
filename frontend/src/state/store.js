import { create } from 'zustand'
import { api } from '../lib/api'
import { getKeybindings } from '../lib/keybindings'
import { terminalControls, startedSessions } from '../lib/terminalWriters'
import { hasVariables } from '../lib/cascadeVariables'

const useStore = create((set, get) => ({
  // ─── CLI Profiles (loaded from /api/cli-info/features) ────
  cliProfiles: {},
  loadCliProfiles: (profiles) => set({ cliProfiles: profiles }),

  // ─── Keybindings ────────────────────────────
  keybindings: getKeybindings(),
  reloadKeybindings: () => set({ keybindings: getKeybindings() }),

  // ─── UI ─────────────────────────────────────
  sidebarVisible: true,
  showHome: false,
  homeColumns: parseInt(localStorage.getItem('cc-homeColumns')) || 3,
  setHomeColumns: (cols) => {
    localStorage.setItem('cc-homeColumns', String(cols))
    set({ homeColumns: cols })
  },
  gridMinRowHeight: parseInt(localStorage.getItem('cc-gridMinRowHeight')) || 200,
  setGridMinRowHeight: (px) => {
    localStorage.setItem('cc-gridMinRowHeight', String(px))
    set({ gridMinRowHeight: px })
  },
  // When true, terminal font size is scaled down so the 80x24 PTY floor fits
  // exactly inside the cell (no horizontal scrolling, no clipped output).
  terminalAutoFit: localStorage.getItem('cc-terminalAutoFit') === '1',
  setTerminalAutoFit: (enabled) => {
    localStorage.setItem('cc-terminalAutoFit', enabled ? '1' : '0')
    set({ terminalAutoFit: enabled })
    // Tell all mounted terminals to re-measure
    window.dispatchEvent(new Event('cc-terminal-refit'))
  },
  splitMode: false,
  splitSessionId: null,
  // Per-workspace view mode — stored as JSON map in localStorage
  viewMode: (() => {
    try { const m = JSON.parse(localStorage.getItem('cc-viewModes') || '{}'); return Object.values(m)[0] || 'tabs' } catch { return localStorage.getItem('cc-viewMode') || 'tabs' }
  })(),
  setViewMode: (mode) => {
    const wsId = get().activeWorkspaceId || '_global'
    try {
      const map = JSON.parse(localStorage.getItem('cc-viewModes') || '{}')
      map[wsId] = mode
      localStorage.setItem('cc-viewModes', JSON.stringify(map))
    } catch {}
    set({ viewMode: mode })
  },
  _restoreViewMode: () => {
    const wsId = get().activeWorkspaceId || '_global'
    try {
      const map = JSON.parse(localStorage.getItem('cc-viewModes') || '{}')
      set({ viewMode: map[wsId] || 'tabs' })
    } catch {
      set({ viewMode: 'tabs' })
    }
  },
  gridLayout: localStorage.getItem('cc-gridLayout') || 'equal', // 'equal' | 'focusRight' | 'focusBottom'
  setGridLayout: (layout) => {
    localStorage.setItem('cc-gridLayout', layout)
    // Switching to a built-in layout clears any active custom template
    set({ gridLayout: layout, activeGridTemplateId: null })
    localStorage.removeItem('cc-activeGridTemplateId')
  },

  // ─── Grid templates ─────────────────────────────────
  // A template defines a custom CSS-grid layout for the multi-terminal grid view.
  // Shape: { id, workspace_id, name, cols, cells: [{ id, col, row, colSpan, rowSpan }], cell_assignments: { [cellId]: sessionId } }
  // Persisted server-side via /api/grid-templates. activeGridTemplateId is stored
  // per-workspace in localStorage as a JSON map.
  gridTemplates: [],
  activeGridTemplateId: (() => {
    try { const m = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}'); return Object.values(m)[0] || null } catch { return null }
  })(),
  setGridTemplates: (templates) => set({ gridTemplates: templates }),
  setActiveGridTemplateId: (id) => {
    const wsId = get().activeWorkspaceId || '_global'
    try {
      const map = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}')
      if (id) map[wsId] = id; else delete map[wsId]
      localStorage.setItem('cc-activeGridTemplateIds', JSON.stringify(map))
    } catch {}
    // Clean up legacy key
    localStorage.removeItem('cc-activeGridTemplateId')
    set({ activeGridTemplateId: id })
  },
  _restoreActiveGridTemplate: () => {
    const wsId = get().activeWorkspaceId || '_global'
    try {
      const map = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}')
      set({ activeGridTemplateId: map[wsId] || null })
    } catch {
      set({ activeGridTemplateId: null })
    }
  },
  loadGridTemplates: async (workspaceId) => {
    const wsId = workspaceId || get().activeWorkspaceId
    try {
      const list = await api.getGridTemplates(wsId)
      if (Array.isArray(list)) set({ gridTemplates: list })
    } catch (e) {
      console.error('loadGridTemplates failed:', e)
    }
  },
  addGridTemplate: async (tpl) => {
    const wsId = get().activeWorkspaceId
    try {
      const created = await api.createGridTemplate({ ...tpl, workspace_id: wsId })
      set((s) => ({ gridTemplates: [...s.gridTemplates, created] }))
      return created
    } catch (e) {
      console.error('addGridTemplate failed:', e)
    }
  },
  updateGridTemplate: async (id, patch) => {
    // Optimistic local update first; the API call updates updated_at server-side
    set((s) => ({
      gridTemplates: s.gridTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }))
    try {
      await api.updateGridTemplate(id, patch)
    } catch (e) {
      console.error('updateGridTemplate failed:', e)
    }
  },
  removeGridTemplate: async (id) => {
    const wasActive = get().activeGridTemplateId === id
    set((s) => ({
      gridTemplates: s.gridTemplates.filter((t) => t.id !== id),
      activeGridTemplateId: s.activeGridTemplateId === id ? null : s.activeGridTemplateId,
    }))
    if (wasActive) {
      const wsId = get().activeWorkspaceId || '_global'
      try {
        const map = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}')
        delete map[wsId]
        localStorage.setItem('cc-activeGridTemplateIds', JSON.stringify(map))
      } catch {}
    }
    try {
      await api.deleteGridTemplate(id)
    } catch (e) {
      console.error('removeGridTemplate failed:', e)
    }
  },
  assignSessionToCell: (templateId, cellId, sessionId) => {
    // Optimistic update + PUT the new cell_assignments map
    let nextAssignments = null
    set((s) => {
      const templates = s.gridTemplates.map((t) => {
        if (t.id !== templateId) return t
        const assignments = { ...(t.cell_assignments || {}) }
        if (sessionId == null) {
          delete assignments[cellId]
        } else {
          // A session can only occupy one cell at a time
          for (const k of Object.keys(assignments)) {
            if (assignments[k] === sessionId) delete assignments[k]
          }
          assignments[cellId] = sessionId
        }
        nextAssignments = assignments
        return { ...t, cell_assignments: assignments }
      })
      return { gridTemplates: templates }
    })
    if (nextAssignments) {
      api.updateGridTemplate(templateId, { cell_assignments: nextAssignments })
        .catch((e) => console.error('assignSessionToCell PUT failed:', e))
    }
  },
  tabScope: localStorage.getItem('cc-tabScope') || 'project', // 'project' | 'workspace'
  setTabScope: (scope) => {
    localStorage.setItem('cc-tabScope', scope)
    set({ tabScope: scope })
  },

  // ─── Tab groups ────────────────────────────────────
  // Named sets of open tabs per workspace that can be switched between.
  tabGroups: [],
  loadTabGroups: async (workspaceId) => {
    try {
      const list = await api.getTabGroups(workspaceId)
      if (Array.isArray(list)) set({ tabGroups: list })
    } catch (e) {
      console.error('loadTabGroups failed:', e)
    }
  },
  addTabGroup: async (data) => {
    try {
      const created = await api.createTabGroup(data)
      set((s) => ({ tabGroups: [...s.tabGroups, created] }))
      return created
    } catch (e) {
      console.error('addTabGroup failed:', e)
    }
  },
  updateTabGroup: async (id, patch) => {
    set((s) => ({
      tabGroups: s.tabGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }))
    try {
      await api.updateTabGroup(id, patch)
    } catch (e) {
      console.error('updateTabGroup failed:', e)
    }
  },
  removeTabGroup: async (id) => {
    set((s) => ({ tabGroups: s.tabGroups.filter((g) => g.id !== id) }))
    try {
      await api.deleteTabGroup(id)
    } catch (e) {
      console.error('removeTabGroup failed:', e)
    }
  },
  saveCurrentTabsAsGroup: async (name) => {
    const s = get()
    const wsId = s.activeWorkspaceId
    const sessionIds = wsId
      ? s.openTabs.filter((id) => s.sessions[id]?.workspace_id === wsId)
      : [...s.openTabs]
    return get().addTabGroup({ workspace_id: wsId, name, session_ids: sessionIds })
  },
  activateTabGroup: (group) => {
    // Open all sessions in this group, set the first as active
    const s = get()
    const validIds = group.session_ids.filter((id) => s.sessions[id])
    if (validIds.length === 0) return
    set({
      openTabs: validIds,
      activeSessionId: validIds[0],
    })
  },

  // ─── Sidebar ordering (server-persisted via order_index columns) ──
  // Reorder actions optimistically update local order_index then POST to backend.
  reorderWorkspaces: (orderedIds) =>
    set((s) => {
      const indexMap = {}
      orderedIds.forEach((id, i) => { indexMap[id] = i + 1 })
      const workspaces = s.workspaces.map((w) =>
        indexMap[w.id] != null ? { ...w, order_index: indexMap[w.id] } : w
      )
      api.reorderWorkspaces(orderedIds).catch((e) => console.error('reorderWorkspaces failed:', e))
      return { workspaces }
    }),
  reorderSessionsInWorkspace: (wsId, orderedIds) =>
    set((s) => {
      const indexMap = {}
      orderedIds.forEach((id, i) => { indexMap[id] = i + 1 })
      const sessions = { ...s.sessions }
      for (const id of orderedIds) {
        if (sessions[id]) sessions[id] = { ...sessions[id], order_index: indexMap[id] }
      }
      api.reorderSessions(wsId, orderedIds).catch((e) => console.error('reorderSessions failed:', e))
      return { sessions }
    }),

  // ─── Inbox dismissals ─────────────────────────
  // Persisted in-memory so dismissals survive panel close/reopen and sync
  // across MailboxPill + InboxPanel. Sessions that start running again are
  // automatically un-dismissed.
  dismissedInbox: {}, // sessionId → true
  dismissInboxItem: (id) =>
    set((s) => ({ dismissedInbox: { ...s.dismissedInbox, [id]: true } })),
  dismissAllInboxItems: (ids) =>
    set((s) => {
      const next = { ...s.dismissedInbox }
      ids.forEach((id) => { next[id] = true })
      return { dismissedInbox: next }
    }),
  undismissInboxItem: (id) =>
    set((s) => {
      const next = { ...s.dismissedInbox }
      delete next[id]
      return { dismissedInbox: next }
    }),

  // ─── Sound notifications ─────────────────────────
  soundEnabled: localStorage.getItem('cc-soundEnabled') !== '0',
  soundVolume: parseInt(localStorage.getItem('cc-soundVolume')) || 60,
  soundOnSessionDone: localStorage.getItem('cc-soundSessionDone') !== '0',
  soundOnAgentDone: localStorage.getItem('cc-soundAgentDone') !== '0',
  soundOnPlanReady: localStorage.getItem('cc-soundPlanReady') !== '0',
  soundOnInputNeeded: localStorage.getItem('cc-soundInputNeeded') === '1',
  setSoundEnabled: (v) => { localStorage.setItem('cc-soundEnabled', v ? '1' : '0'); set({ soundEnabled: v }) },
  setSoundVolume: (v) => { localStorage.setItem('cc-soundVolume', String(v)); set({ soundVolume: v }) },
  setSoundOnSessionDone: (v) => { localStorage.setItem('cc-soundSessionDone', v ? '1' : '0'); set({ soundOnSessionDone: v }) },
  setSoundOnAgentDone: (v) => { localStorage.setItem('cc-soundAgentDone', v ? '1' : '0'); set({ soundOnAgentDone: v }) },
  setSoundOnPlanReady: (v) => { localStorage.setItem('cc-soundPlanReady', v ? '1' : '0'); set({ soundOnPlanReady: v }) },
  setSoundOnInputNeeded: (v) => { localStorage.setItem('cc-soundInputNeeded', v ? '1' : '0'); set({ soundOnInputNeeded: v }) },

  // ─── Notifications ─────────────────────────
  notifications: [],
  addNotification: (notif) =>
    set((s) => ({
      notifications: [...s.notifications, { id: crypto.randomUUID(), timestamp: Date.now(), ...notif }],
    })),
  removeNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  // ─── Background Results (distill, mcp parse, etc.) ────
  backgroundResults: [],
  addBackgroundResult: (result) =>
    set((s) => ({
      backgroundResults: [{ id: crypto.randomUUID(), timestamp: Date.now(), ...result }, ...s.backgroundResults],
    })),
  removeBackgroundResult: (id) =>
    set((s) => ({ backgroundResults: s.backgroundResults.filter((r) => r.id !== id) })),

  // ─── Plan ──────────────────────────────────
  activePlan: null,
  setActivePlan: (plan) => set({ activePlan: plan }),
  planFilePaths: {}, // sessionId → file path (e.g. ~/.claude/plans/foo.md)
  allPlanFiles: [], // all discovered plan files (including unmatched)
  setPlanFilePath: (sessionId, filePath) =>
    set((s) => ({ planFilePaths: { ...s.planFilePaths, [sessionId]: filePath } })),
  setPlanFilePaths: (mapping) =>
    set((s) => ({ planFilePaths: { ...s.planFilePaths, ...mapping } })),
  setAllPlanFiles: (plans) => set({ allPlanFiles: plans }),
  planWaiting: {}, // sessionId → true when Claude is showing the "Ready to code?" prompt
  setSessionPlanWaiting: (sessionId, waiting) =>
    set((s) => ({ planWaiting: { ...s.planWaiting, [sessionId]: waiting } })),
  planReopenSession: null, // sessionId to auto-reopen plan viewer for after feedback
  setPlanReopenSession: (sessionId) => set({ planReopenSession: sessionId }),

  // ─── Session activity ─────────────────────────
  sessionActivity: {}, // sessionId → timestamp of last detected spinner/activity
  setSessionActive: (sessionId) =>
    set((s) => ({ sessionActivity: { ...s.sessionActivity, [sessionId]: Date.now() } })),

  // ─── Compaction state ─────────────────────────
  // Driven by Claude PreCompact/PostCompact and Gemini PreCompress hooks.
  // 'compacting' = between PreCompact and PostCompact (or for ~60s after Pre*
  // when PostCompress isn't fired by Gemini). 'compacted' = recently finished,
  // shown as a fading badge for ~60s so the user notices even if they were on
  // another tab.
  compactionState: {}, // sessionId → { status: 'compacting' | 'compacted', startedAt, trigger }
  setCompactionState: (sessionId, state) =>
    set((s) => ({ compactionState: { ...s.compactionState, [sessionId]: state } })),
  clearCompactionState: (sessionId) =>
    set((s) => {
      const next = { ...s.compactionState }
      delete next[sessionId]
      return { compactionState: next }
    }),

  // ─── Force-message history ──────────────────
  // Tracks recent Shift+Enter force-messages per session so consecutive
  // interruptions can be combined into one "I paused…" message.
  forceHistory: {}, // { [sessionId]: { messages: string[] } | null } — cleared when session starts working
  setForceHistory: (sessionId, data) =>
    set((s) => ({ forceHistory: { ...s.forceHistory, [sessionId]: data } })),

  // ─── Workspaces ─────────────────────────────
  workspaces: [],
  activeWorkspaceId: null,

  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspace: (id) => {
    const prev = get().activeWorkspaceId
    set({ activeWorkspaceId: id })
    if (prev !== id) {
      // Restore per-workspace view mode, grid template + reload workspace-scoped templates
      get()._restoreViewMode()
      get()._restoreActiveGridTemplate()
      get().loadGridTemplates(id)
    }
  },

  // ─── Sub-agents (internal CLI agents tracked via hooks) ─────────
  // subagents: { [sessionId]: { [agentId]: { id, type, status, startedAt, tools: [], result } } }
  subagents: {},
  // sidebarExpanded: which sessions have their subagent list expanded in the sidebar
  sidebarExpanded: {},

  toggleSessionExpanded: (sessionId) =>
    set((s) => ({
      sidebarExpanded: { ...s.sidebarExpanded, [sessionId]: !s.sidebarExpanded[sessionId] },
    })),

  addSubagent: (sessionId, agent) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sessionId]: {
          ...(s.subagents[sessionId] || {}),
          [agent.id]: {
            id: agent.id,
            type: agent.type || 'unknown',
            status: 'running',
            startedAt: Date.now(),
            tools: [],
            result: null,
          },
        },
      },
    })),

  completeSubagent: (sessionId, agentId, result, transcriptPath) =>
    set((s) => {
      const existing = s.subagents[sessionId]?.[agentId]
      if (!existing) return {}
      return {
        subagents: {
          ...s.subagents,
          [sessionId]: {
            ...s.subagents[sessionId],
            [agentId]: { ...existing, status: 'completed', result, transcriptPath: transcriptPath || null },
          },
        },
      }
    }),

  addSubagentTool: (sessionId, agentId, tool) =>
    set((s) => {
      const existing = s.subagents[sessionId]?.[agentId]
      if (!existing) return {}
      return {
        subagents: {
          ...s.subagents,
          [sessionId]: {
            ...s.subagents[sessionId],
            [agentId]: { ...existing, tools: [...existing.tools, tool] },
          },
        },
      }
    }),

  clearSubagents: (sessionId) =>
    set((s) => {
      const next = { ...s.subagents }
      delete next[sessionId]
      return { subagents: next }
    }),

  // viewingSubagent: { sessionId, agentId } when a subagent transcript is open
  viewingSubagent: null,
  setViewingSubagent: (sessionId, agentId) => set({ viewingSubagent: { sessionId, agentId } }),
  clearViewingSubagent: () => set({ viewingSubagent: null }),

  // ─── Session selection (merge) ──────────────
  selectedSessionIds: [],
  selectionWorkspaceId: null,

  toggleSessionSelect: (id) =>
    set((s) => {
      const session = s.sessions[id]
      if (!session) return {}
      const isSelected = s.selectedSessionIds.includes(id)
      if (isSelected) {
        const next = s.selectedSessionIds.filter((sid) => sid !== id)
        return {
          selectedSessionIds: next,
          selectionWorkspaceId: next.length > 0 ? s.selectionWorkspaceId : null,
        }
      }
      // Enforce same-workspace constraint
      if (s.selectionWorkspaceId && session.workspace_id !== s.selectionWorkspaceId) return {}
      return {
        selectedSessionIds: [...s.selectedSessionIds, id],
        selectionWorkspaceId: session.workspace_id,
      }
    }),

  clearSessionSelection: () => set({ selectedSessionIds: [], selectionWorkspaceId: null }),

  // ─── Sessions ───────────────────────────────
  sessions: {},
  activeSessionId: null,
  openTabs: [],

  loadSessions: (sessions) =>
    set((s) => {
      const map = { ...s.sessions }
      for (const sess of sessions) {
        map[sess.id] = { ...sess, status: map[sess.id]?.status || sess.status || 'idle' }
      }
      return { sessions: map }
    }),

  addSession: (session) =>
    set((s) => ({
      sessions: { ...s.sessions, [session.id]: { ...session, status: 'idle' } },
      openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
      activeSessionId: session.id,
    })),

  openSession: (id) =>
    set((s) => ({
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
      activeSessionId: id,
    })),

  openSessionInBackground: (id) =>
    set((s) => ({
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
    })),

  reorderTabs: (fromIdx, toIdx) =>
    set((s) => {
      const tabs = [...s.openTabs]
      const [moved] = tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, moved)
      return { openTabs: tabs }
    }),

  removeSession: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.sessions
      const tabs = s.openTabs.filter((t) => t !== id)
      const msgs = { ...s.messages }
      delete msgs[id]
      return {
        sessions: rest,
        openTabs: tabs,
        messages: msgs,
        activeSessionId: s.activeSessionId === id ? tabs[tabs.length - 1] || null : s.activeSessionId,
      }
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  closeTab: (id) =>
    set((s) => {
      const tabs = s.openTabs.filter((t) => t !== id)
      if (s.activeSessionId !== id) return { openTabs: tabs }
      // Pick the next active tab from the scope-visible set so the user
      // doesn't jump to a tab from another workspace they can't see.
      const visible = (s.tabScope === 'workspace' && s.activeWorkspaceId)
        ? tabs.filter((t) => s.sessions[t]?.workspace_id === s.activeWorkspaceId)
        : tabs
      // Prefer the tab that was adjacent (same index position), else last visible.
      const oldIdx = s.openTabs.indexOf(id)
      const nextInVisible =
        visible.find((t) => tabs.indexOf(t) >= oldIdx - 1) ||
        visible[visible.length - 1] ||
        null
      return { openTabs: tabs, activeSessionId: nextInVisible }
    }),

  setSessionStatus: (id, status) =>
    set((s) => {
      if (!s.sessions[id]) return {}
      const update = { sessions: { ...s.sessions, [id]: { ...s.sessions[id], status } } }
      // Auto-undismiss: if a dismissed session starts running again, pull it
      // out of the dismissed archive so it shows up live in the inbox/mailbox.
      if (status === 'running' && s.dismissedInbox[id]) {
        const next = { ...s.dismissedInbox }
        delete next[id]
        update.dismissedInbox = next
      }
      return update
    }),

  // ─── Tasks ───────────────────────────────────
  tasks: {},
  loadTasks: (tasks) => set((s) => {
    const map = { ...s.tasks }
    for (const t of tasks) map[t.id] = t
    return { tasks: map }
  }),
  updateTaskInStore: (task) => set((s) => ({
    tasks: { ...s.tasks, [task.id]: task }
  })),
  removeTaskFromStore: (id) => set((s) => {
    const { [id]: _, ...rest } = s.tasks
    return { tasks: rest }
  }),

  // ─── Captures ────────────────────────────────
  pendingCaptures: [],
  addCapture: (capture) => set((s) => ({
    pendingCaptures: [...s.pendingCaptures, { id: crypto.randomUUID(), timestamp: Date.now(), ...capture }]
  })),
  resolveCapture: (id) => set((s) => ({
    pendingCaptures: s.pendingCaptures.filter((c) => c.id !== id)
  })),

  // ─── WebSocket ──────────────────────────────
  ws: null,
  connected: false,

  setWs: (ws) => set({ ws }),
  setConnected: (connected) => set({ connected }),

  stopSession: (sessionId) => {
    const { ws } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ action: 'stop', session_id: sessionId }))
  },

  restartSession: (sessionId) => {
    const { ws } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Clear terminal buffer for a clean slate and get actual dimensions
    const ctrl = terminalControls.get(sessionId)
    if (ctrl?.clear) ctrl.clear()
    const size = ctrl?.getSize?.() || { cols: 120, rows: 40 }
    startedSessions.add(sessionId)
    ws.send(JSON.stringify({ action: 'start_pty', session_id: sessionId, cols: size.cols, rows: size.rows }))
    set((s) => s.sessions[sessionId]
      ? { sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], status: 'running' } } }
      : {}
    )
  },

  restartAllSessions: () => {
    const { ws, sessions } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const running = Object.values(sessions).filter((s) => s.status === 'running')
    for (const s of running) {
      ws.send(JSON.stringify({ action: 'stop', session_id: s.id }))
      // Re-start after a short delay to let stop complete
      setTimeout(() => {
        get().restartSession(s.id)
      }, 1000)
    }
    return running.length
  },

  // ─── Prompt cascade runner ──────────────────────────
  // Cascade execution is now driven by the backend (cascade_runner.py).
  // The frontend starts runs via API and receives progress updates via
  // WebSocket events (cascade_progress, cascade_completed, cascade_loop_reprompt).
  //
  // Per-session cascade runners. Keys are sessionId strings.
  // Each value mirrors the backend cascade_run state:
  //   { runId, sessionId, cascadeId, name, steps, currentStep, totalSteps,
  //     loop, running, status, iteration, startedAt, variables, variableValues,
  //     loopReprompt }
  cascadeRunners: {},

  // Pending cascade that needs variable input before starting.
  // When set, CascadeVariableDialog renders.
  // Shape: { sessionId, cascade, isLoopReprompt?, iteration? }
  cascadeVariablePending: null,
  setCascadeVariablePending: (pending) => set({ cascadeVariablePending: pending }),
  clearCascadeVariablePending: () => set({ cascadeVariablePending: null }),

  // Convenience selector: get the runner for a specific session
  getCascadeRunner: (sessionId) => get().cascadeRunners[sessionId] || null,

  // Gate: checks for variables and either starts immediately or parks for input.
  // Returns true if cascade started, false if variable input is pending.
  startCascade: (sessionId, cascade) => {
    const steps = Array.isArray(cascade.steps) ? cascade.steps : []
    if (steps.length === 0) return true

    // Check if steps contain {variable} patterns that need user input
    if (hasVariables(steps) || (cascade.variables && cascade.variables.length > 0)) {
      set({ cascadeVariablePending: { sessionId, cascade } })
      return false // pending — caller should not close palette
    }

    // No variables — run directly
    get().executeCascade(sessionId, cascade, steps)
    return true
  },

  // Execute a cascade via the backend server-side runner.
  // The backend drives step advancement so cascades survive browser close.
  executeCascade: (sessionId, cascade, resolvedSteps) => {
    const steps = resolvedSteps || cascade.steps
    if (!steps || steps.length === 0) return

    const needsRestart = cascade.bypass_permissions || cascade.auto_approve
    const newMode = cascade.bypass_permissions ? 'bypassPermissions'
      : cascade.auto_approve ? 'auto' : null

    // Clear variable pending state
    set({ cascadeVariablePending: null })

    const doStart = async () => {
      // If permission mode change needed, update + restart session first
      if (needsRestart && newMode) {
        try {
          await api.updateSession(sessionId, { permission_mode: newMode })
          get().stopSession(sessionId)
          await new Promise((r) => setTimeout(r, 600))
          get().restartSession(sessionId)
          // Wait for session to be ready
          await new Promise((r) => setTimeout(r, 2000))
        } catch (e) {
          console.error('cascade: failed to update permission mode', e)
        }
      }

      // Start the run on the backend
      try {
        const run = await api.createCascadeRun({
          session_id: sessionId,
          cascade_id: cascade.id || null,
          steps,
          original_steps: cascade.steps,
          loop: !!cascade.loop,
          auto_approve: !!cascade.auto_approve,
          bypass_permissions: !!cascade.bypass_permissions,
          auto_approve_plan: !!cascade.auto_approve_plan,
          variables: cascade.variables || [],
          variable_values: cascade._lastVariableValues || {},
          loop_reprompt: !!cascade.loop_reprompt,
        })

        // Set local runner state from the backend response
        set((s) => ({
          cascadeRunners: {
            ...s.cascadeRunners,
            [sessionId]: {
              runId: run.id,
              sessionId,
              cascadeId: cascade.id,
              name: cascade.name,
              steps: JSON.parse(run.steps),
              originalSteps: JSON.parse(run.original_steps || '[]'),
              currentStep: run.current_step,
              totalSteps: JSON.parse(run.steps).length,
              loop: !!run.loop,
              loopReprompt: !!run.loop_reprompt,
              running: true,
              status: run.status,
              iteration: run.iteration,
              startedAt: Date.now(),
              variables: JSON.parse(run.variables || '[]'),
              variableValues: JSON.parse(run.variable_values || '{}'),
            },
          },
        }))
      } catch (e) {
        console.error('cascade: failed to start server-side run', e)
        get().addNotification({ type: 'error', message: `Cascade start failed: ${e.message}` })
      }
    }

    doStart()
  },

  clearCascadeRestart: (sessionId) =>
    set((s) => {
      const runner = s.cascadeRunners[sessionId]
      if (!runner) return {}
      return { cascadeRunners: { ...s.cascadeRunners, [sessionId]: { ...runner, restartPending: false } } }
    }),

  // Handle backend cascade progress events (called from useWebSocket)
  handleCascadeEvent: (event) => {
    const { session_id, status, current_step, total_steps, iteration,
            loop, loop_reprompt, variables, variable_values, run_id } = event
    const eventType = event.type

    if (eventType === 'cascade_completed') {
      set((s) => {
        const next = { ...s.cascadeRunners }
        const runner = next[session_id]
        const name = runner?.name || 'Cascade'
        const stepCount = runner?.totalSteps || total_steps
        delete next[session_id]
        return { cascadeRunners: next }
      })
      // Find runner name for notification
      const runner = get().cascadeRunners[session_id]
      get().addNotification({
        type: 'info',
        message: `Cascade "${runner?.name || 'Cascade'}" completed (${total_steps} steps).`,
      })
      return
    }

    if (eventType === 'cascade_loop_reprompt') {
      const runner = get().cascadeRunners[session_id]
      if (!runner) return
      set((s) => ({
        cascadeRunners: { ...s.cascadeRunners, [session_id]: { ...runner, running: false, status: 'paused' } },
        cascadeVariablePending: {
          sessionId: session_id,
          cascade: {
            id: runner.cascadeId,
            name: runner.name,
            steps: runner.originalSteps || runner.steps,
            loop: runner.loop,
            loop_reprompt: runner.loopReprompt,
            auto_approve: false,
            bypass_permissions: false,
            variables: variables || runner.variables,
            _lastVariableValues: variable_values || runner.variableValues,
            _iteration: iteration,
            _runId: run_id,
          },
          isLoopReprompt: true,
          iteration,
        },
      }))
      return
    }

    // cascade_progress — update local state
    set((s) => {
      const runner = s.cascadeRunners[session_id]
      if (!runner) return {}
      return {
        cascadeRunners: {
          ...s.cascadeRunners,
          [session_id]: {
            ...runner,
            currentStep: current_step,
            totalSteps: total_steps,
            iteration,
            status,
            running: status === 'running' || status === 'waiting_idle',
          },
        },
      }
    })
  },

  // Resume a loop-reprompt cascade with new variable values (server-side)
  resumeCascadeWithVariables: async (sessionId, runId, variableValues, resolvedSteps) => {
    try {
      await api.updateCascadeRun(runId, 'resume_with_variables', { variable_values: variableValues })
    } catch (e) {
      console.error('cascade: failed to resume with variables', e)
    }
  },

  advanceCascade: () => {
    // No-op: advancement is now handled server-side by cascade_runner.py
  },

  stopCascade: (sessionId) => {
    // If no sessionId provided, stop cascade on active session (backward compat for ⌘+Esc)
    const sid = sessionId || get().activeSessionId
    const runner = get().cascadeRunners[sid]
    if (runner) {
      // Stop on the backend
      if (runner.runId) {
        api.updateCascadeRun(runner.runId, 'stop').catch(() => {})
      }
      set((s) => {
        const next = { ...s.cascadeRunners }
        delete next[sid]
        return { cascadeRunners: next }
      })
      get().addNotification({
        type: 'info',
        message: `Cascade "${runner.name}" stopped at step ${runner.currentStep + 1}/${runner.steps.length}.`,
      })
    }
  },

  // ─── Pipeline Engine (configurable graph pipelines) ──────────────
  pipelines: [],
  pipelineRuns: [],
  activePipelineRunId: null,

  loadPipelines: async (workspaceId) => {
    try {
      const list = await api.getPipelines(workspaceId)
      if (Array.isArray(list)) set({ pipelines: list })
    } catch (e) {
      console.error('loadPipelines failed:', e)
    }
  },
  loadPipelineRuns: async (workspaceId) => {
    try {
      const list = await api.listPipelineRuns(workspaceId)
      if (Array.isArray(list)) set({ pipelineRuns: list })
    } catch (e) {
      console.error('loadPipelineRuns failed:', e)
    }
  },
  addPipeline: async (data) => {
    try {
      const created = await api.createPipeline(data)
      set((s) => ({ pipelines: [...s.pipelines, created] }))
      return created
    } catch (e) {
      console.error('addPipeline failed:', e)
    }
  },
  updatePipelineInStore: (updated) =>
    set((s) => ({ pipelines: s.pipelines.map((p) => (p.id === updated.id ? updated : p)) })),
  removePipelineFromStore: (id) =>
    set((s) => ({ pipelines: s.pipelines.filter((p) => p.id !== id) })),
  handlePipelineRunUpdate: (run) => {
    set((s) => {
      const exists = s.pipelineRuns.some((r) => r.id === run.id)
      return {
        pipelineRuns: exists
          ? s.pipelineRuns.map((r) => (r.id === run.id ? run : r))
          : [run, ...s.pipelineRuns],
      }
    })
  },

  // ─── Prompts cache ──────────────────────────
  // Mirrors /api/prompts so token expansion (@prompt:<name>) and the chip
  // preview can resolve names without each consumer fetching independently.
  prompts: [],
  setPrompts: (prompts) => set({ prompts: Array.isArray(prompts) ? prompts : [] }),
  loadPrompts: async () => {
    try {
      const list = await api.getPrompts()
      if (Array.isArray(list)) set({ prompts: list })
    } catch (e) {
      console.error('loadPrompts failed:', e)
    }
  },

  // ─── Terminal input buffer (best-effort) ──────────────────────
  // Per-session approximation of what the user has typed into the live
  // terminal input. Maintained by Terminal.jsx by sniffing term.onData
  // and applying simple rules (printable → append, backspace → pop,
  // Enter/Escape/Ctrl-U → clear, CSI sequences → reset). It's not a
  // perfect mirror of Claude's Ink input field — cursor movement mid
  // string isn't tracked — but it's good enough to power the floating
  // "@token detected" badge over the terminal so the user can see when
  // they've typed something the system recognizes.
  inputBuffers: {},
  setInputBuffer: (sessionId, text) =>
    set((s) => ({ inputBuffers: { ...s.inputBuffers, [sessionId]: text || '' } })),
  clearInputBuffer: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.inputBuffers)) return {}
      const { [sessionId]: _, ...rest } = s.inputBuffers
      return { inputBuffers: rest }
    }),
}))

export default useStore
