import { offerUndo } from '../lib/undoAction'
import { create } from 'zustand'
import { api } from '../lib/api'
import { getKeybindings } from '../lib/keybindings'
import { terminalControls, startedSessions, pendingPtyStarts } from '../lib/terminalWriters'
import { hasVariables } from '../lib/cascadeVariables'
import { uuid } from '../lib/uuid'
import { getSessionLevelTarget, isMobileViewport } from '../lib/focusableSessions'
import { notificationSessionId, reconcileGridAssignments, reconcileSessionReferences } from '../lib/operatorDesk'
import { readSidebarVisibility, persistSidebarVisibility } from '../lib/sidebarPreference'
import { isHelperSession } from '../lib/visibleSessions'
import { beginReplyWait, hasNewReply } from '../lib/replyPending'

const OVERVIEW_MODE_KEY = 'ive.overview-mode'
const BOARD_FILTERS_KEY = 'ive.board-filters'
const TERMINAL_DRAWER_KEY = 'ive.terminal-drawer'
const TERMINAL_DRAWER_DEFAULT_HEIGHT = 320
const TERMINAL_DRAWER_MIN_HEIGHT = 160

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* privacy mode */ }
}

// The drawer toggles the terminal's size: refit right away, after the CSS
// transition and once more for late layout.
function requestTerminalRefit() {
  if (typeof window === 'undefined') return
  for (const delay of [0, 150, 350]) setTimeout(() => window.dispatchEvent(new Event('cc-terminal-refit')), delay)
}

const PTY_BOOT_DELAY_MS = 1500

// Resolves after React has committed and the browser has laid out the next
// frames (two rAFs), with a timer fallback because rAF pauses in background
// tabs and a PTY start must never hang on that.
const afterLayout = () => new Promise((resolve) => {
  let done = false
  const finish = () => { if (!done) { done = true; resolve() } }
  try { requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 30))) } catch { /* no rAF */ }
  setTimeout(finish, 250)
})
const sessionStartPromises = new Map()

// Hook events (session_state, tool_event, ...) arrive several times per second
// per agent and mostly repeat the state the store already holds. Every set()
// that returns fresh objects re-renders App, the sidebar and every terminal,
// so the per-session setters below return the unchanged state when nothing
// actually changes. Zustand skips listeners when set() yields the same object.
function shallowEqualObjects(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

// Non-reactive counter of attention events that did not change any visible
// state (e.g. a repeated "working" hook while no request is open). The HTTP
// attention poller compares it so a stale poll still cannot override a newer
// WebSocket event, without forcing a React render for every repeated hook.
const attentionTouches = new Map()
export function attentionStamp(session) {
  if (!session) return '0:0'
  return `${session.attentionVersion || 0}:${attentionTouches.get(session.id) || 0}`
}

// Activity timestamps feed a "recently active" dot (5 s window, checked every
// 2 s). Refreshing them more often than every 2 s only causes extra renders.
const ACTIVITY_REFRESH_MS = 2000

function normalizeChatDraft(draft = {}) {
  const source = draft || {}
  return {
    pastedImages: Array.isArray(source.pastedImages) ? source.pastedImages : [],
    terminalPastedImages: Array.isArray(source.terminalPastedImages) ? source.terminalPastedImages : [],
    pendingAnnotation: source.pendingAnnotation || null,
    annotationNote: source.annotationNote || '',
    textAnnotations: Array.isArray(source.textAnnotations) ? source.textAnnotations : [],
    showProcessing: Boolean(source.showProcessing),
  }
}

const useStore = create((set, get) => ({
  // ─── Auth context (PR 2/3) — who am I, in what mode? ────
  // Populated on app boot via api.whoami(). Listened to by ModeBadge,
  // route guards in the UI, and the active-sessions panel.
  currentAuth: null,                  // { actor_kind, mode, brief_subscope, label, expires_at } | null
  activeJoinerSessions: [],
  loadWhoami: async () => {
    try {
      const ctx = await api.whoami()
      set({ currentAuth: ctx })
    } catch {
      set({ currentAuth: null })
    }
  },
  loadAuthSessions: async () => {
    try {
      const r = await api.listAuthSessions()
      set({ activeJoinerSessions: Array.isArray(r?.sessions) ? r.sessions : [] })
    } catch {}
  },
  revokeAuthSession: async (id) => {
    try {
      await api.revokeAuthSession(id)
      const r = await api.listAuthSessions()
      set({ activeJoinerSessions: Array.isArray(r?.sessions) ? r.sessions : [] })
    } catch {}
  },

  // ─── CLI Profiles (loaded from /api/cli-info/features) ────
  cliProfiles: {},
  loadCliProfiles: (profiles) => set({ cliProfiles: profiles }),

  // ─── Keybindings ────────────────────────────
  keybindings: getKeybindings(),
  reloadKeybindings: () => set({ keybindings: getKeybindings() }),

  // ─── UI ─────────────────────────────────────
  sidebarVisible: readSidebarVisibility(),
  showHome: false,
  // ─── Navigation levels ──────────────────────
  // IVE has three places, always in this order (lib/route.js `viewOf`):
  //   Home      → composer, recent sessions, projects         (showHome)
  //   Board     → every session in Running / Waiting / Done   (!showHome && !sessionFocus)
  //   Session   → one session full size, chat + terminal      (!showHome && sessionFocus)
  // The sidebar, breadcrumb, Escape, ⌘⇧E/⌘⇧H and the URL hash all use these
  // helpers so every entry point lands in the same, named place.
  sessionFocus: false,
  setSessionFocus: (value) => {
    if (get().sessionFocus === !!value) return
    set({ sessionFocus: !!value })
    globalThis.requestAnimationFrame?.(() => window.dispatchEvent(new Event('cc-terminal-refit')))
  },
  goHome: () => set({ showHome: true }),
  goOverview: () => {
    if (get().openTabs.length === 0) { set({ showHome: true }); return }
    set({ showHome: false, sessionFocus: false })
    globalThis.requestAnimationFrame?.(() => window.dispatchEvent(new Event('cc-terminal-refit')))
  },
  // Board is the overview level's new name; both ids stay valid.
  goBoard: () => get().goOverview(),
  // Board | Grid (the tile wall). The board agent reads it; the grid tests
  // set it in their fixtures.
  overviewMode: (() => { try { return localStorage.getItem(OVERVIEW_MODE_KEY) === 'grid' ? 'grid' : 'board' } catch { return 'board' } })(),
  setOverviewMode: (mode) => {
    const next = mode === 'grid' ? 'grid' : 'board'
    try { localStorage.setItem(OVERVIEW_MODE_KEY, next) } catch { /* privacy mode */ }
    if (get().overviewMode === next) return
    set({ overviewMode: next })
    globalThis.requestAnimationFrame?.(() => window.dispatchEvent(new Event('cc-terminal-refit')))
  },
  // Board filters ('' = all). Deliberately separate from tabScope.
  boardFilters: { workspaceId: '', agent: '', ...readJson(BOARD_FILTERS_KEY, {}) },
  setBoardFilters: (patch) => {
    const next = { ...get().boardFilters, ...(patch || {}) }
    next.workspaceId = typeof next.workspaceId === 'string' ? next.workspaceId : ''
    next.agent = typeof next.agent === 'string' ? next.agent : ''
    writeJson(BOARD_FILTERS_KEY, next)
    set({ boardFilters: next })
  },
  // Terminal per session: absent = chat, true = drawer, 'full' = expanded.
  terminalDrawer: readJson(TERMINAL_DRAWER_KEY, {}).drawer || {},
  terminalDrawerHeight: Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Number(readJson(TERMINAL_DRAWER_KEY, {}).height) || TERMINAL_DRAWER_DEFAULT_HEIGHT),
  focusSessionTerminal: (sessionId) => {
    if (get().activeSessionId === sessionId) window.dispatchEvent(new Event('cc-focus-terminal'))
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (get().activeSessionId === sessionId) window.dispatchEvent(new Event('cc-focus-terminal'))
    }))
  },
  toggleTerminalDrawer: (sessionId, force) => {
    if (!sessionId) return
    const current = !!get().terminalDrawer[sessionId]
    const next = typeof force === 'boolean' ? force : !current
    if (next) get().focusSessionTerminal(sessionId)
    if (next === current) return
    const terminalDrawer = { ...get().terminalDrawer, [sessionId]: next }
    if (!next) delete terminalDrawer[sessionId]
    writeJson(TERMINAL_DRAWER_KEY, { drawer: terminalDrawer, height: get().terminalDrawerHeight })
    set({ terminalDrawer })
    requestTerminalRefit()
  },
  setTerminalExpanded: (sessionId, expanded) => {
    if (!sessionId) return
    const terminalDrawer = { ...get().terminalDrawer, [sessionId]: expanded ? 'full' : true }
    writeJson(TERMINAL_DRAWER_KEY, { drawer: terminalDrawer, height: get().terminalDrawerHeight })
    set({ terminalDrawer })
    requestTerminalRefit()
    get().focusSessionTerminal(sessionId)
  },
  setTerminalDrawerHeight: (px) => {
    const height = Math.max(TERMINAL_DRAWER_MIN_HEIGHT, Math.round(Number(px) || TERMINAL_DRAWER_DEFAULT_HEIGHT))
    if (height === get().terminalDrawerHeight) return
    writeJson(TERMINAL_DRAWER_KEY, { drawer: get().terminalDrawer, height })
    set({ terminalDrawerHeight: height })
    requestTerminalRefit()
  },
  // What the agent is doing right now, from tool_event / session_state
  // (useWebSocket) and from `last_activity` of GET /sessions after a reload.
  // Kept on idle so a Done card can still say what the last step was.
  sessionLastTool: {},
  setSessionLastTool: (id, lastTool) =>
    set((s) => {
      if (!id) return s
      if (!lastTool) {
        if (!(id in s.sessionLastTool)) return s
        const { [id]: _, ...rest } = s.sessionLastTool
        return { sessionLastTool: rest }
      }
      const entry = {
        tool_name: String(lastTool.tool_name || ''),
        summary: String(lastTool.summary || ''),
        input: lastTool.input && typeof lastTool.input === 'object' ? lastTool.input : null,
        at: Number(lastTool.at) || Date.now(),
      }
      if (shallowEqualObjects(s.sessionLastTool[id], entry)) return s
      return { sessionLastTool: { ...s.sessionLastTool, [id]: entry } }
    }),
  // Files the agent edited in this session (Edit/Write/MultiEdit/NotebookEdit
  // tool_event starts). Shell sessions and sessions without hooks stay empty.
  changedFiles: {},
  addChangedFile: (id, path) =>
    set((s) => {
      const file = String(path || '').trim()
      if (!id || !file) return s
      const current = s.changedFiles[id] || []
      if (current.includes(file)) return s
      return { changedFiles: { ...s.changedFiles, [id]: [...current, file] } }
    }),
  clearChangedFiles: (id) =>
    set((s) => {
      if (!(id in s.changedFiles)) return s
      const { [id]: _, ...rest } = s.changedFiles
      return { changedFiles: rest }
    }),
  // From useCostPoll: {[id]: {cost_usd, tokens, estimated, at}} and today's sum.
  sessionCosts: {},
  costToday: null,
  setSessionCosts: (bySession, today) =>
    set({
      sessionCosts: bySession && typeof bySession === 'object' ? bySession : {},
      costToday: today === null || today === undefined || Number.isNaN(Number(today)) ? null : Number(today),
    }),
  goSession: (id, opts = {}) => {
    const state = get()
    // Without an explicit id, pick from what the overview can show full size
    // (a custom grid template limits that), or App drops the focus again.
    const target = id || getSessionLevelTarget(state, { isMobile: isMobileViewport() }) || state.activeSessionId || state.openTabs[0]
    if (!target) return
    if (!state.openTabs.includes(target)) state.openSession(target, { focus: false, autoStart: opts.autoStart })
    state.setActiveSession(target, { autoStart: opts.autoStart })
    set({ showHome: false, sessionFocus: true })
    globalThis.requestAnimationFrame?.(() => window.dispatchEvent(new Event('cc-terminal-refit')))
  },
  activeNavGroup: localStorage.getItem('ive-active-nav-group') || 'work',
  setActiveNavGroup: (group) => {
    const next = ['work', 'know', 'operate', 'configure'].includes(group) ? group : 'work'
    localStorage.setItem('ive-active-nav-group', next)
    set({ activeNavGroup: next })
  },
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
  // When true, terminal font size is scaled down so the PTY size floor fits
  // exactly inside the cell (no horizontal scrolling, no clipped output).
  terminalAutoFit: localStorage.getItem('cc-terminalAutoFit') === '1',
  setTerminalAutoFit: (enabled) => {
    localStorage.setItem('cc-terminalAutoFit', enabled ? '1' : '0')
    set({ terminalAutoFit: enabled })
    // Tell all mounted terminals to re-measure
    window.dispatchEvent(new Event('cc-terminal-refit'))
  },
  terminalBoardMode: localStorage.getItem('cc-terminalBoardMode') === '1',
  setTerminalBoardMode: (enabled) => {
    localStorage.setItem('cc-terminalBoardMode', enabled ? '1' : '0')
    set({ terminalBoardMode: enabled })
    window.dispatchEvent(new Event('cc-terminal-refit'))
  },
  viewMode: 'grid',
  setViewMode: () => {},
  _restoreViewMode: () => {},
  gridAdjustMode: false,
  setGridAdjustMode: (val) => set({ gridAdjustMode: val }),
  gridColumns: parseInt(localStorage.getItem('cc-gridColumns')) || 0,
  setGridColumns: (cols) => {
    localStorage.setItem('cc-gridColumns', String(cols))
    set({ gridColumns: cols })
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
  setGridTemplates: (templates) => set((s) => ({
    gridTemplates: s.sessionSnapshotIds === null ? templates
      : reconcileGridAssignments(templates, (id) => s.sessionSnapshotIds.includes(id) || !!s.sessions[id]),
  })),
  setActiveGridTemplateId: (id) => {
    const wsId = get().activeWorkspaceId || '_global'
    try {
      const map = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}')
      if (id) map[wsId] = id; else delete map[wsId]
      localStorage.setItem('cc-activeGridTemplateIds', JSON.stringify(map))
    } catch {}
    // Clean up legacy key
    localStorage.removeItem('cc-activeGridTemplateId')
    // Choosing a saved layout explicitly opens its assigned views locally.
    // Restoring the saved layout below deliberately does not: tabs the user
    // closed must stay closed across a reload or workspace switch.
    set((s) => {
      const template = s.gridTemplates.find((item) => item.id === id)
      const assigned = [...new Set(Object.values(template?.cell_assignments || {}))].filter((sessionId) =>
        s.sessions[sessionId] && !s.sessions[sessionId].archived && (s.tabScope !== 'workspace' || !s.activeWorkspaceId || s.sessions[sessionId].workspace_id === s.activeWorkspaceId))
      return { activeGridTemplateId: id, openTabs: [...new Set([...s.openTabs, ...assigned])] }
    })
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
      if (Array.isArray(list)) get().setGridTemplates(list)
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
  // Persist first so a failed reorder never looks successful.
  reorderWorkspaces: async (orderedIds, { undoable = true } = {}) => {
    const before = [...get().workspaces].sort((a,b)=>(a.order_index||99999)-(b.order_index||99999)).map(w=>w.id)
    try {
      await api.reorderWorkspaces(orderedIds)
      set(s=>({workspaces:s.workspaces.map(w=>orderedIds.includes(w.id)?{...w,order_index:orderedIds.indexOf(w.id)+1}:w)}))
      if (undoable) offerUndo('Project order changed.',()=>get().reorderWorkspaces(before,{undoable:false}))
    } catch (e) { if (!undoable) throw e; get().addNotification({type:'warning',message:`Could not reorder projects: ${e.message}`}) }
  },
  reorderSessionsInWorkspace: async (wsId, orderedIds, { undoable = true } = {}) => {
    const before = Object.values(get().sessions).filter(s => s.workspace_id === wsId).sort((a,b)=>(a.order_index||99999)-(b.order_index||99999)).map(s=>s.id)
    try {
      await api.reorderSessions(wsId, orderedIds)
      set(s => ({ sessions: Object.fromEntries(Object.entries(s.sessions).map(([id, session]) => [id, session.workspace_id === wsId && orderedIds.includes(id) ? { ...session, order_index: orderedIds.indexOf(id) + 1 } : session])) }))
      if (undoable) offerUndo('Session order changed.', () => get().reorderSessionsInWorkspace(wsId, before, { undoable: false }))
    } catch (error) {
      if (!undoable) throw error
      get().addNotification({ type: 'warning', message: `Could not reorder sessions: ${error.message}` })
    }
  },

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
  // Live permission-mode apply per session, from PUT responses and
  // permission_mode_apply events: { state, mode, from, error }.
  // state: scheduled | pending (waits for idle) | applying | failed.
  permissionApply: {},
  setPermissionApply: (sessionId, info) => set((s) => {
    if (!info || ['applied', 'cancelled', 'saved', 'unchanged', 'none', 'unsupported'].includes(info.state)) {
      if (!s.permissionApply[sessionId]) return {}
      const { [sessionId]: _, ...rest } = s.permissionApply
      return { permissionApply: rest }
    }
    return { permissionApply: { ...s.permissionApply, [sessionId]: info } }
  }),

  // Live model/effort apply per session and field, from PUT responses and
  // launch_apply events: { [sessionId]: { model?: info, effort?: info } }
  // with info = { state, value, from, error } (same states as above).
  launchApply: {},
  setLaunchApply: (sessionId, field, info) => set((s) => {
    const current = s.launchApply[sessionId] || {}
    if (!info || ['applied', 'cancelled', 'saved', 'unchanged', 'none', 'unsupported'].includes(info.state)) {
      if (!current[field]) return {}
      const { [field]: _, ...restFields } = current
      if (Object.keys(restFields).length) return { launchApply: { ...s.launchApply, [sessionId]: restFields } }
      const { [sessionId]: __, ...rest } = s.launchApply
      return { launchApply: rest }
    }
    return { launchApply: { ...s.launchApply, [sessionId]: { ...current, [field]: info } } }
  }),

  notifications: [],
  addNotification: (notif) =>
    set((s) => ({
      notifications: [...s.notifications, { id: uuid(), timestamp: Date.now(), ...notif }],
    })),
  removeNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  // ─── Background Results (distill, mcp parse, etc.) ────
  backgroundResults: [],
  addBackgroundResult: (result) =>
    set((s) => ({
      backgroundResults: [{ id: uuid(), timestamp: Date.now(), ...result }, ...s.backgroundResults],
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
  setSessionAttention: (id, attention) => set((s) => {
    const session = s.sessions[id]
    if (!session) return {}
    const wasWaiting = ['waiting', 'prompting', 'input_needed', 'needs_input'].includes(session.status)
    if (
      !attention && !session.attention && !session.resolvedAttentionContext && !wasWaiting
      && s.planWaiting[id] === false
      && !s.notifications.some((n) => n.sessionId === id && ['input_needed', 'permission_question'].includes(n.type))
    ) {
      attentionTouches.set(id, (attentionTouches.get(id) || 0) + 1)
      return s
    }
    return {
      sessions: { ...s.sessions, [id]: { ...session, attention,
        attentionVersion: (session.attentionVersion || 0) + 1,
        resolvedAttentionContext: !attention && session.attention?.context ? session.attention.context : null,
        ...(attention ? { status: 'waiting', agentState: 'prompting' } : wasWaiting ? { status: 'idle', agentState: 'idle' } : {}),
      } },
      planWaiting: { ...s.planWaiting, [id]: !!attention },
      ...(!attention ? { notifications: s.notifications.filter((n) => n.sessionId !== id || !['input_needed', 'permission_question'].includes(n.type)) } : {}),
    }
  }),
  setSessionPlanWaiting: (sessionId, waiting) =>
    set((s) => (s.planWaiting[sessionId] === waiting ? s : { planWaiting: { ...s.planWaiting, [sessionId]: waiting } })),
  planReopenSession: null, // sessionId to auto-reopen plan viewer for after feedback
  setPlanReopenSession: (sessionId) => set({ planReopenSession: sessionId }),

  // ─── Session activity ─────────────────────────
  sessionActivity: {}, // sessionId → timestamp of last detected spinner/activity
  setSessionActive: (sessionId) =>
    set((s) => {
      const now = Date.now()
      if (now - (s.sessionActivity[sessionId] || 0) < ACTIVITY_REFRESH_MS) return s
      return { sessionActivity: { ...s.sessionActivity, [sessionId]: now } }
    }),

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
  newSessionWorkspaceId: null,
  // One-shot purpose prefill for NewSessionDialog (e.g. "edit this agent
  // system" from an attached agentario pin); the dialog consumes + clears it.
  newSessionPrefillPurpose: null,
  // Optional board routing context. These remain one-shot dialog defaults: the
  // user can still cancel or change the session before anything is spawned.
  newSessionPrefillTaskId: null,
  newSessionPrefillName: null,

  // ─── Quick start ────────────────────────────
  // ⌘N / "New session" opens a small prompt instead of the full dialog: the
  // session starts in the quick start root without a workspace choice.
  quickStartOpen: false,
  // Project the quick start prompt starts in (workspace id); null = no
  // project, the quick start folder. Set by openQuickStart.
  quickStartWorkspaceId: null,
  // { root, workspace_id, workspace_name } from GET /api/quick-start.
  quickStart: null,
  // Backend guesses which project a quick session works on:
  // { [sessionId]: { path, name, workspace_id } }
  projectHints: {},
  dismissedProjectHints: {}, // { [sessionId]: path }
  setQuickStart: (quickStart) => set({ quickStart }),
  setProjectHint: (sessionId, hint) => set((s) => {
    if (!sessionId || !hint?.path) return {}
    if (s.dismissedProjectHints[sessionId] === hint.path) return {}
    return { projectHints: { ...s.projectHints, [sessionId]: hint } }
  }),
  clearProjectHint: (sessionId, { dismiss = false } = {}) => set((s) => {
    const { [sessionId]: hint, ...rest } = s.projectHints
    return {
      projectHints: rest,
      ...(dismiss && hint ? { dismissedProjectHints: { ...s.dismissedProjectHints, [sessionId]: hint.path } } : {}),
    }
  }),

  setWorkspaces: (workspaces) => set({ workspaces }),
  removeWorkspace: (id, sessionIds = []) => {
    if (!id) return
    try {
      const layouts = JSON.parse(localStorage.getItem('cc-activeGridTemplateIds') || '{}')
      delete layouts[id]
      localStorage.setItem('cc-activeGridTemplateIds', JSON.stringify(layouts))
    } catch { /* State cleanup must also work when storage is unavailable. */ }
    set((s) => {
      const removed = new Set(Array.isArray(sessionIds) ? sessionIds : [])
      for (const session of Object.values(s.sessions)) if (session.workspace_id === id) removed.add(session.id)
      const keep = (sessionId) => !removed.has(sessionId)
      const refs = reconcileSessionReferences(s, keep)
      const cleaned = {}
      for (const key of ['sessions', 'messages', 'sessionPtyStartedAt', 'sessionWorkStartedAt', 'sessionStarted',
        'backgroundTasks', 'sessionInputs', 'chatDrafts', 'pendingOptimisticMessages', 'lastSentPrompts',
        'queuedCommands', 'subagents', 'sidebarExpanded', 'forceHistory', 'dismissedInbox', 'permissionApply',
        'launchApply', 'projectHints', 'dismissedProjectHints', 'cascadeRunners', 'restartInterrupted',
        'sessionLastTool', 'changedFiles', 'sessionCosts', 'terminalDrawer']) {
        cleaned[key] = Object.fromEntries(Object.entries(s[key] || {}).filter(([keyId]) => keep(keyId)))
      }
      const workspaces = s.workspaces.filter((workspace) => workspace.id !== id)
      const gridTemplates = refs.gridTemplates.filter((template) => template.workspace_id !== id)
      const pipelineRuns = s.pipelineRuns.filter((run) => run.workspace_id !== id)
      return {
        ...refs, ...cleaned, workspaces, gridTemplates, pipelineRuns,
        activeWorkspaceId: s.activeWorkspaceId === id
          ? cleaned.sessions[refs.activeSessionId]?.workspace_id || workspaces[0]?.id || null : s.activeWorkspaceId,
        activeGridTemplateId: gridTemplates.some((template) => template.id === s.activeGridTemplateId) ? s.activeGridTemplateId : null,
        activePipelineRunId: pipelineRuns.some((run) => run.id === s.activePipelineRunId) ? s.activePipelineRunId : null,
        newSessionWorkspaceId: s.newSessionWorkspaceId === id ? null : s.newSessionWorkspaceId,
        selectionWorkspaceId: s.selectionWorkspaceId === id ? null : s.selectionWorkspaceId,
        selectedSessionIds: s.selectedSessionIds.filter(keep),
        sessionSnapshotIds: s.sessionSnapshotIds?.filter(keep) ?? null,
        tasks: Object.fromEntries(Object.entries(s.tasks).filter(([, task]) => task.workspace_id !== id)),
        pipelines: s.pipelines.filter((pipeline) => pipeline.workspace_id !== id),
        tabGroups: s.tabGroups.filter((group) => group.workspace_id !== id),
        quickStart: s.quickStart?.workspace_id === id ? null : s.quickStart,
        ...(!refs.openTabs.length ? { showHome: true, sessionFocus: false } : {}),
      }
    })
  },
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
  setNewSessionWorkspaceId: (id) => set({ newSessionWorkspaceId: id }),

  // ─── Sub-agents (internal CLI agents tracked via hooks) ─────────
  // subagents: { [sessionId]: { [agentId]: { id, type, status, startedAt, tools: [], result } } }
  subagents: {},
  backgroundTasks: {},
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

  mergeBackgroundTasks: (sessionId, tasks) =>
    set((s) => {
      if (!sessionId || !Array.isArray(tasks)) return {}
      const existing = s.backgroundTasks[sessionId] || {}
      const nextForSession = {}
      for (const task of tasks) {
        const id = task.id || task.task_id || task.outputFile || task.output_file
        if (!id) continue
        const previous = nextForSession[id] || existing[id] || {}
        const previousStatus = String(previous.status || '').toLowerCase()
        const nextStatus = String(task.status || '').toLowerCase()
        const previousTerminal = ['completed', 'complete', 'done', 'failed', 'error'].includes(previousStatus)
        const nextRunning = ['running', 'started', 'pending', 'in_progress'].includes(nextStatus)
        const merged = previousTerminal && nextRunning
          ? { ...task, ...previous }
          : { ...previous, ...task }
        nextForSession[id] = {
          ...merged,
          id,
          updatedAt: Math.max(Number(previous.updatedAt) || 0, Number(task.updatedAt) || 0) || Date.now(),
        }
      }
      return {
        backgroundTasks: {
          ...s.backgroundTasks,
          [sessionId]: nextForSession,
        },
      }
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
  sessionSnapshotIds: null, // null until the first successful unscoped /sessions response
  messages: {}, // sessionId -> Array of messages
  awaitingReplies: {},
  beginReplyWait: (sessionId, message) => set((s) => ({
    awaitingReplies: { ...s.awaitingReplies, [sessionId]: beginReplyWait(message, s.messages[sessionId] || []) },
  })),
  clearReplyWait: (sessionId) => set((s) => {
    if (!s.awaitingReplies[sessionId]) return {}
    const next = { ...s.awaitingReplies }
    delete next[sessionId]
    return { awaitingReplies: next }
  }),
  setSessionMessages: (sessionId, messages) =>
    set((s) => ({
      messages: { ...s.messages, [sessionId]: messages },
      ...(hasNewReply(s.awaitingReplies[sessionId], messages)
        ? { awaitingReplies: { ...s.awaitingReplies, [sessionId]: null } } : {}),
    })),
  // Long transcripts load only their tail: base = transcript position of
  // messages[sessionId][0], before = server summary (turns, tokens) of the
  // rows not loaded yet. Absent: the whole transcript is loaded.
  transcriptWindows: {},
  setTranscriptWindow: (sessionId, base, before) =>
    set((s) => {
      const cur = s.transcriptWindows[sessionId]
      if (!base) {
        if (!cur) return {}
        const next = { ...s.transcriptWindows }
        delete next[sessionId]
        return { transcriptWindows: next }
      }
      if (cur && cur.base === base && cur.before === before) return {}
      return { transcriptWindows: { ...s.transcriptWindows, [sessionId]: { base, before: before || null } } }
    }),
  // Sessions whose CLI was working when the backend went away and came back
  // without it (IVE restart): the chat marks the unanswered prompt.
  restartInterrupted: {},
  clearRestartInterrupted: (id) =>
    set((s) => {
      if (!s.restartInterrupted[id]) return {}
      const next = { ...s.restartInterrupted }
      delete next[id]
      return { restartInterrupted: next }
    }),
  activeSessionId: null,
  openTabs: [],
  sessionStarted: {},
  sessionPtyStartedAt: {},
  sessionWorkStartedAt: {},

  loadSessions: (sessions) =>
    set((s) => {
      const map = { ...s.sessions }
      const ptyStartedAt = { ...s.sessionPtyStartedAt }
      const workStartedAt = { ...s.sessionWorkStartedAt }
      const planWaiting = { ...s.planWaiting }
      for (const sess of sessions) {
        const existing = map[sess.id] || {}
        map[sess.id] = {
          ...existing,
          ...sess,
          status: sess.status || existing.status || 'idle',
          agentState: sess.agentState || existing.agentState,
        }
        // Older servers report idle for a CLI approval. Keep a live request
        // until a lifecycle event or an explicit snapshot clears it.
        if (map[sess.id].attention && sess.pty_alive !== false && !['exited', 'auth_failed', 'error', 'failed', 'stopped'].includes(sess.status)) {
          map[sess.id].status = 'waiting'
          map[sess.id].agentState = 'prompting'
        }
        if (Object.hasOwn(sess, 'attention')) planWaiting[sess.id] = !!sess.attention
        if (sess.pty_alive && !ptyStartedAt[sess.id]) ptyStartedAt[sess.id] = Date.now()
        const status = String(map[sess.id]?.status || '').toLowerCase()
        const agentState = String(map[sess.id]?.agentState || '').toLowerCase()
        if ((status === 'running' || status === 'working' || status === 'executing' || agentState === 'working' || agentState === 'executing') && !workStartedAt[sess.id]) {
          workStartedAt[sess.id] = Date.now()
        }
      }
      return { sessions: map, planWaiting, sessionPtyStartedAt: ptyStartedAt, sessionWorkStartedAt: workStartedAt }
    }),

  // Bumped whenever the user opens a session (new or existing). App.jsx
  // answers it by showing that terminal large and focused instead of adding
  // one more cell somewhere below the fold of the overview grid.
  terminalFocusRequest: null,

  addSession: (session, opts = {}) => {
    set((s) => ({
      sessions: { ...s.sessions, [session.id]: { ...session, status: session.status || 'idle' } },
      openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
      activeSessionId: session.id,
      showHome: false,
      ...(opts.focus === false ? {} : { terminalFocusRequest: { id: session.id, seq: (s.terminalFocusRequest?.seq || 0) + 1 } }),
    }))

    if (opts.autoStart !== false && !session.is_external) {
      setTimeout(() => {
        const current = get()
        if (current.openTabs.includes(session.id) && current.sessions[session.id] && !current.sessions[session.id].archived && !current.sessions[session.id].is_external && current.sessions[session.id].status !== 'exited') {
          get().ensureSessionRunning(session.id).catch(() => {})
        }
      }, 0)
    }
  },

  openSession: (id, opts = {}) => {
    set((s) => ({
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
      activeSessionId: id,
      showHome: false,
      ...(opts.focus === false ? {} : { terminalFocusRequest: { id, seq: (s.terminalFocusRequest?.seq || 0) + 1 } }),
    }))

    if (opts.autoStart !== false) {
      setTimeout(() => {
        const current = get()
        const session = current.sessions[id]
        if (current.openTabs.includes(id) && session && !session.archived && !session.is_external && session.status !== 'exited') {
          get().ensureSessionRunning(id).catch(() => {})
        }
      }, 0)
    }
  },

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
      const { [id]: _pty, ...ptyRest } = s.sessionPtyStartedAt
      const { [id]: _work, ...workRest } = s.sessionWorkStartedAt
      const { [id]: _bg, ...bgRest } = s.backgroundTasks
      const tabs = s.openTabs.filter((t) => t !== id)
      const msgs = { ...s.messages }
      delete msgs[id]
      const awaitingReplies = { ...s.awaitingReplies }
      delete awaitingReplies[id]
      const inputs = { ...s.sessionInputs }
      delete inputs[id]
      const chatDrafts = { ...s.chatDrafts }
      delete chatDrafts[id]
      const pendingOpt = { ...s.pendingOptimisticMessages }
      delete pendingOpt[id]
      const lastSent = { ...s.lastSentPrompts }
      delete lastSent[id]
      const queues = { ...s.queuedCommands }
      delete queues[id]
      const { [id]: _lastTool, ...sessionLastTool } = s.sessionLastTool
      const { [id]: _changed, ...changedFiles } = s.changedFiles
      const { [id]: _drawer, ...terminalDrawer } = s.terminalDrawer
      return {
        ...reconcileSessionReferences(s, (candidate) => candidate !== id),
        sessionLastTool, changedFiles, terminalDrawer,
        sessions: rest,
        sessionSnapshotIds: s.sessionSnapshotIds?.filter((candidate) => candidate !== id) ?? null,
        sessionPtyStartedAt: ptyRest,
        sessionWorkStartedAt: workRest,
        backgroundTasks: bgRest,
        openTabs: tabs,
        messages: msgs,
        awaitingReplies,
        sessionInputs: inputs,
        chatDrafts,
        pendingOptimisticMessages: pendingOpt,
        lastSentPrompts: lastSent,
        queuedCommands: queues,
        activeSessionId: s.activeSessionId === id ? tabs[tabs.length - 1] || null : s.activeSessionId,
      }
    }),

  setActiveSession: (id, opts = {}) => {
    set({ activeSessionId: id, showHome: false })

    if (id && opts.autoStart !== false) {
      setTimeout(() => {
        const current = get()
        const session = current.sessions[id]
        if (current.openTabs.includes(id) && session && !session.archived && !session.is_external && session.status !== 'exited') {
          get().ensureSessionRunning(id).catch(() => {})
        }
      }, 0)
    }
  },

  closeTab: (id) =>
    set((s) => {
      const tabs = s.openTabs.filter((t) => t !== id)
      const focusRequest = s.terminalFocusRequest?.id === id ? null : s.terminalFocusRequest
      if (s.activeSessionId !== id) return { openTabs: tabs, terminalFocusRequest: focusRequest }
      // Pick the next active tab from the scope-visible set so the user
      // doesn't jump to a tab from another workspace they can't see.
      const visible = tabs.filter((t) => s.sessions[t] &&
        (s.tabScope !== 'workspace' || !s.activeWorkspaceId || s.sessions[t].workspace_id === s.activeWorkspaceId))
      // Prefer the next visible tab to the right, then the nearest to the left.
      const oldIdx = s.openTabs.indexOf(id)
      const nextInVisible = s.openTabs.slice(oldIdx + 1).find((t) => visible.includes(t))
        || s.openTabs.slice(0, oldIdx).reverse().find((t) => visible.includes(t)) || null
      return {
        openTabs: tabs,
        activeSessionId: nextInVisible,
        terminalFocusRequest: focusRequest,
        ...(!nextInVisible ? { showHome: true, sessionFocus: false } : {}),
      }
    }),

  setSessionStarted: (id, started = true) =>
    set((s) => {
      // A started CLI ends the "interrupted by IVE restart" marker.
      let cleared = null
      if (started && s.restartInterrupted[id]) {
        cleared = { ...s.restartInterrupted }
        delete cleared[id]
      }
      const extra = cleared ? { restartInterrupted: cleared } : {}
      if (started ? (s.sessionStarted[id] && s.sessionPtyStartedAt[id]) : (!(id in s.sessionStarted) && !(id in s.sessionPtyStartedAt))) return cleared ? extra : s
      const next = { ...s.sessionStarted }
      const ptyStartedAt = { ...s.sessionPtyStartedAt }
      if (started) next[id] = true
      else delete next[id]
      if (started && !ptyStartedAt[id]) ptyStartedAt[id] = Date.now()
      if (!started) delete ptyStartedAt[id]
      return { sessionStarted: next, sessionPtyStartedAt: ptyStartedAt, ...extra }
    }),

  // Live state from GET /sessions after the socket (re)connected: status,
  // agentState and pty_alive come from the backend as they are now. Events
  // missed while the socket was down (a turn that ended, a backend restart
  // that killed the PTYs) are corrected here instead of wiping every session
  // to "not started" until something happens to reattach it.
  resyncSessions: (rows, { knownSessionIdsAtRequest = null } = {}) =>
    set((s) => {
      if (!Array.isArray(rows)) return {}
      const validIds = new Set(rows.filter((row) => row?.id).map((row) => row.id))
      // A session created while this GET was in flight is newer than its
      // snapshot. Keep it until a later authoritative response can assess it.
      if (Array.isArray(knownSessionIdsAtRequest)) {
        const known = new Set(knownSessionIdsAtRequest)
        for (const id of Object.keys(s.sessions)) if (!known.has(id)) validIds.add(id)
      }
      const isAvailable = (id) => validIds.has(id)
      const references = reconcileSessionReferences(s, isAvailable)
      const referencedIds = new Set([
        ...references.openTabs,
        references.activeSessionId,
        ...references.notifications.map(notificationSessionId),
        ...references.gridTemplates.flatMap((template) => Object.values(template.cell_assignments || {})),
      ])
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([id]) => isAvailable(id)))
      const sessionStarted = { ...s.sessionStarted }
      const ptyStartedAt = { ...s.sessionPtyStartedAt }
      const workStartedAt = { ...s.sessionWorkStartedAt }
      const restartInterrupted = { ...s.restartInterrupted }
      for (const state of [sessionStarted, ptyStartedAt, workStartedAt, restartInterrupted]) {
        for (const id of Object.keys(state)) if (!isAvailable(id)) delete state[id]
      }
      const WORKING = new Set(['running', 'working', 'executing'])
      const sessionLastTool = { ...s.sessionLastTool }
      for (const id of Object.keys(sessionLastTool)) if (!isAvailable(id)) delete sessionLastTool[id]
      for (const row of rows) {
        // Restore valid cached tabs/notices before workspace lists arrive,
        // without opening every archived/background session in the snapshot.
        if (!row?.id || (!sessions[row.id] && !referencedIds.has(row.id))) continue
        // What the agent was doing survives a reload via `last_activity`.
        if (row.last_activity?.tool_name && !sessionLastTool[row.id]) {
          const { tool_name, summary, at } = row.last_activity
          sessionLastTool[row.id] = { tool_name: String(tool_name), summary: String(summary || ''), input: null, at: at ? (Number(at) < 1e11 ? Number(at) * 1000 : Number(at)) : Date.now() }
        }
        const shown = sessions[row.id]
        const existing = shown || {}
        // A session this client already showed was working before the gap and
        // its CLI is gone now: the backend restarted and the running turn was lost.
        if (shown) {
          const wasWorking = Boolean(s.sessionWorkStartedAt[row.id])
            || WORKING.has(String(existing.status || '').toLowerCase())
            || WORKING.has(String(existing.agentState || '').toLowerCase())
          if (wasWorking && !row.pty_alive) restartInterrupted[row.id] = Date.now()
        }
        const status = row.status || 'idle'
        const agentState = row.agentState || (WORKING.has(status) ? 'working' : status)
        sessions[row.id] = { ...existing, ...row, status, agentState, pty_alive: !!row.pty_alive }
        if (row.pty_alive) {
          if (!ptyStartedAt[row.id]) ptyStartedAt[row.id] = Date.now()
        } else {
          delete sessionStarted[row.id]
          delete ptyStartedAt[row.id]
        }
        if (WORKING.has(String(status).toLowerCase()) || WORKING.has(String(agentState).toLowerCase())) {
          if (!workStartedAt[row.id]) workStartedAt[row.id] = Date.now()
        } else {
          delete workStartedAt[row.id]
        }
      }
      return { ...references, sessionSnapshotIds: [...validIds], sessions, sessionStarted, sessionPtyStartedAt: ptyStartedAt, sessionWorkStartedAt: workStartedAt, restartInterrupted, sessionLastTool }
    }),

  clearSessionStarted: () =>
    set((s) => {
      const sessions = {}
      for (const [id, session] of Object.entries(s.sessions)) {
        sessions[id] = { ...session, pty_alive: false }
      }
      return { sessionStarted: {}, sessionPtyStartedAt: {}, sessionWorkStartedAt: {}, sessions }
    }),

  setSessionStatus: (id, status, extra = {}) =>
    set((s) => {
      if (!s.sessions[id]) return {}
      const normalized = String(status || '').toLowerCase()
      const clearsWorking = normalized && normalized !== 'running' && normalized !== 'working' && normalized !== 'executing'
      const priorAgentState = String(s.sessions[id].agentState || '').toLowerCase()
      const shouldClearStaleAgentState =
        clearsWorking &&
        !Object.prototype.hasOwnProperty.call(extra, 'agentState') &&
        (priorAgentState === 'working' || priorAgentState === 'executing' || priorAgentState === 'running')
      const nextSession = {
        ...s.sessions[id],
        ...(shouldClearStaleAgentState ? { agentState: 'idle' } : {}),
        status,
        ...extra,
      }
      if (extra.pty_alive === false || ['exited', 'auth_failed', 'error', 'failed', 'stopped'].includes(normalized)) {
        nextSession.attention = null
        nextSession.agentState = normalized
        nextSession.attentionVersion = (nextSession.attentionVersion || 0) + 1
      } else if (nextSession.attention) {
        nextSession.status = 'waiting'
        nextSession.agentState = 'prompting'
      }
      const update = { sessions: { ...s.sessions, [id]: nextSession },
        ...(nextSession.attention === null ? { planWaiting: { ...s.planWaiting, [id]: false } } : {}),
      }
      if (extra.pty_alive === false || ['exited', 'auth_failed', 'error', 'failed', 'stopped'].includes(normalized)) {
        update.awaitingReplies = { ...s.awaitingReplies, [id]: null }
      }
      const agentState = String(nextSession.agentState || '').toLowerCase()
      const isWorking = !nextSession.attention && (normalized === 'running' || normalized === 'working' || normalized === 'executing' || agentState === 'working' || agentState === 'executing')
      const hasPtyAliveField = Object.prototype.hasOwnProperty.call(extra, 'pty_alive')
      const isPtyAlive = hasPtyAliveField ? !!extra.pty_alive : !!nextSession.pty_alive
      const nextPtyStartedAt = { ...s.sessionPtyStartedAt }
      const nextWorkStartedAt = { ...s.sessionWorkStartedAt }
      if (isPtyAlive && !nextPtyStartedAt[id]) nextPtyStartedAt[id] = Date.now()
      if ((hasPtyAliveField && !extra.pty_alive) || normalized === 'exited') delete nextPtyStartedAt[id]
      if (isWorking && !nextWorkStartedAt[id]) nextWorkStartedAt[id] = Date.now()
      if (!isWorking || normalized === 'exited') delete nextWorkStartedAt[id]
      update.sessionPtyStartedAt = shallowEqualObjects(nextPtyStartedAt, s.sessionPtyStartedAt) ? s.sessionPtyStartedAt : nextPtyStartedAt
      update.sessionWorkStartedAt = shallowEqualObjects(nextWorkStartedAt, s.sessionWorkStartedAt) ? s.sessionWorkStartedAt : nextWorkStartedAt
      // Auto-undismiss: if a dismissed session starts running again, pull it
      // out of the dismissed archive so it shows up live in the inbox/mailbox.
      if (status === 'running' && s.dismissedInbox[id]) {
        const next = { ...s.dismissedInbox }
        delete next[id]
        update.dismissedInbox = next
      }
      if (
        !update.dismissedInbox
        && shallowEqualObjects(nextSession, s.sessions[id])
        && update.sessionPtyStartedAt === s.sessionPtyStartedAt
        && update.sessionWorkStartedAt === s.sessionWorkStartedAt
        && (!update.planWaiting || s.planWaiting[id] === false)
      ) return s
      return update
    }),

  setSessionAgentState: (id, agentState) =>
    set((s) => {
      if (!s.sessions[id]) return {}
      const normalized = String(agentState || '').toLowerCase()
      const nextWorkStartedAt = { ...s.sessionWorkStartedAt }
      if (normalized === 'working' || normalized === 'executing' || normalized === 'running') {
        if (!nextWorkStartedAt[id]) nextWorkStartedAt[id] = Date.now()
      } else {
        delete nextWorkStartedAt[id]
      }
      const workUnchanged = shallowEqualObjects(nextWorkStartedAt, s.sessionWorkStartedAt)
      if (s.sessions[id].agentState === agentState && workUnchanged) return s
      return {
        sessions: { ...s.sessions, [id]: { ...s.sessions[id], agentState } },
        sessionWorkStartedAt: workUnchanged ? s.sessionWorkStartedAt : nextWorkStartedAt,
      }
    }),

  // ─── Archive & Summary ──────────────────────
  setSessionArchived: (id, archived) => {
    set((s) => {
      if (!s.sessions[id]) return {}
      return { sessions: { ...s.sessions, [id]: { ...s.sessions[id], archived: archived ? 1 : 0 } } }
    })
    // The archive event can arrive from another browser/client. Apply the
    // same local view cleanup without stopping or deleting the conversation.
    if (archived) get().closeTab(id)
  },
  setSessionSummary: (id, summary) =>
    set((s) => {
      if (!s.sessions[id]) return {}
      return { sessions: { ...s.sessions, [id]: { ...s.sessions[id], summary } } }
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
    pendingCaptures: [...s.pendingCaptures, { id: uuid(), timestamp: Date.now(), ...capture }]
  })),
  resolveCapture: (id) => set((s) => ({
    pendingCaptures: s.pendingCaptures.filter((c) => c.id !== id)
  })),

  // ─── WebSocket ──────────────────────────────
  ws: null,
  connected: false,

  setWs: (ws) => set({ ws }),
  setConnected: (connected) => set({ connected }),

  // ─── Multiplayer Presence ──────────────────
  peers: {},          // client_id -> { name, color, viewing_session }
  myClientId: null,
  myName: null,
  myColor: null,

  initIdentity: () => {
    const ADJECTIVES = ['Cosmic', 'Swift', 'Neon', 'Lunar', 'Quiet', 'Bold', 'Vivid', 'Calm', 'Bright', 'Sharp', 'Mystic', 'Drift', 'Pixel', 'Glitch', 'Turbo']
    const NOUNS = ['Fox', 'Owl', 'Wolf', 'Bear', 'Hawk', 'Lynx', 'Sage', 'Raven', 'Otter', 'Crane', 'Panda', 'Cobra', 'Spark', 'Atlas', 'Orbit']
    const PEER_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316', '#84cc16', '#ef4444', '#6366f1']
    let clientId = localStorage.getItem('ive_client_id')
    let name = localStorage.getItem('ive_client_name')
    let color = localStorage.getItem('ive_client_color')
    if (!clientId) {
      clientId = uuid()
      localStorage.setItem('ive_client_id', clientId)
    }
    if (!name) {
      name = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + ' ' + NOUNS[Math.floor(Math.random() * NOUNS.length)]
      localStorage.setItem('ive_client_name', name)
    }
    if (!color) {
      color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]
      localStorage.setItem('ive_client_color', color)
    }
    set({ myClientId: clientId, myName: name, myColor: color })
  },

  setMyName: (name) => {
    localStorage.setItem('ive_client_name', name)
    set({ myName: name })
    // Broadcast updated identity
    const { ws, myClientId, myColor, activeSessionId } = get()
    if (ws && ws.readyState === WebSocket.OPEN && myClientId) {
      ws.send(JSON.stringify({ action: 'presence_update', client_id: myClientId, name, color: myColor, viewing_session: activeSessionId }))
    }
  },

  setMyColor: (color) => {
    localStorage.setItem('ive_client_color', color)
    set({ myColor: color })
    const { ws, myClientId, myName, activeSessionId } = get()
    if (ws && ws.readyState === WebSocket.OPEN && myClientId) {
      ws.send(JSON.stringify({ action: 'presence_update', client_id: myClientId, name: myName, color, viewing_session: activeSessionId }))
    }
  },

  handlePresenceSnapshot: (peers) => {
    const { myClientId } = get()
    const map = {}
    for (const p of peers) {
      if (p.client_id !== myClientId) {
        map[p.client_id] = { name: p.name, color: p.color, viewing_session: p.viewing_session }
      }
    }
    set({ peers: map })
  },

  handlePresenceJoin: (data) => set((s) => {
    if (data.client_id === s.myClientId) return {}
    return {
      peers: { ...s.peers, [data.client_id]: { name: data.name, color: data.color, viewing_session: null } },
    }
  }),

  handlePresenceUpdate: (data) => set((s) => {
    if (data.client_id === s.myClientId) return {}
    return {
      peers: { ...s.peers, [data.client_id]: { name: data.name, color: data.color, viewing_session: data.viewing_session } },
    }
  }),

  handlePresenceLeave: (data) => set((s) => {
    const { [data.client_id]: _, ...rest } = s.peers
    return { peers: rest }
  }),

  stopSession: (sessionId) => {
    const { ws } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ action: 'stop', session_id: sessionId }))
  },

  restartSession: (sessionId) => {
    const { ws } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return null
    const pending = sessionStartPromises.get(sessionId)
    if (pending) return pending
    // Clear terminal buffer for a clean slate. The PTY must start with the
    // size the user will actually see: a TUI like Claude Code draws its first
    // frame for the start size, and a resize right after leaves a garbled
    // or duplicated first screen. A terminal that was just opened is still
    // xterm's unfitted 80x24 here and its cell may be about to grow (focus
    // view), so wait for layout to settle and fit before sending start_pty.
    const ctrl = terminalControls.get(sessionId)
    if (ctrl?.clear) ctrl.clear()
    startedSessions.add(sessionId)
    pendingPtyStarts.add(sessionId)
    const sendStart = () => {
      pendingPtyStarts.delete(sessionId)
      const liveWs = get().ws
      if (!liveWs || liveWs.readyState !== WebSocket.OPEN) {
        // The socket closed while we waited for layout: nothing was started,
        // so nothing may claim it was. The reconnect path restarts it.
        startedSessions.delete(sessionId)
        return false
      }
      const live = terminalControls.get(sessionId)
      const size = live?.fitNow?.() || live?.getSize?.() || { cols: 120, rows: 40 }
      liveWs.send(JSON.stringify({ action: 'start_pty', session_id: sessionId, cols: size.cols, rows: size.rows }))
      // Only now is the PTY really on its way. Marking it alive earlier let
      // ensureSessionRunning take its pty_alive shortcut and send input
      // before start_pty, which the backend drops ("Session not running").
      set((s) => s.sessions[sessionId]
        ? {
            sessionStarted: { ...s.sessionStarted, [sessionId]: true },
            sessionPtyStartedAt: { ...s.sessionPtyStartedAt, [sessionId]: Date.now() },
            sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], status: 'idle', pty_alive: true } },
          }
        : {}
      )
      return true
    }
    // Fonts first: the GPU renderer re-measures its cells once the terminal
    // font is ready, and the PTY must start with those final dimensions.
    const fontsReady = Promise.race([globalThis.document?.fonts?.ready || Promise.resolve(), new Promise((r) => setTimeout(r, 500))])
    // Also when no terminal is mounted yet: addSession() starts the PTY right
    // away, and the layout wait lets React mount the terminal so sendStart
    // can fit it instead of guessing 120x40.
    const settled = fontsReady.then(afterLayout)

    // Resolves true once start_pty is sent and the TUI had time to boot,
    // false when the socket closed before start_pty could be sent.
    const ready = settled.then(sendStart)
      .then((ok) => ok ? new Promise((resolve) => setTimeout(() => resolve(true), PTY_BOOT_DELAY_MS)) : false)
      .finally(() => sessionStartPromises.delete(sessionId))
    sessionStartPromises.set(sessionId, ready)
    return ready
  },

  // Ensure a session's PTY is alive before sending input. Used by Execute,
  // tester invocation, and pipeline run startup paths where the row may
  // exist in DB but the PTY has been stopped (status='exited') or never
  // started in this client session (not in startedSessions).
  // Resolves once a start_pty has been sent and the Ink TUI has had a
  // chance to render its first frame.
  ensureSessionRunning: async (sessionId) => {
    if (!sessionId) return false
    const state = get()
    const sess = state.sessions[sessionId]
    if (!sess) return false
    if (sess.is_external) return true

    // A start in flight wins over pty_alive: input sent before its start_pty
    // reaches the backend is dropped.
    const pending = sessionStartPromises.get(sessionId)
    if (pending) return (await pending) !== false

    if (sess.status !== 'exited' && sess.pty_alive) return true

    if (sess.status !== 'exited' && startedSessions.has(sessionId)) {
      await new Promise((r) => setTimeout(r, PTY_BOOT_DELAY_MS))
      return true
    }

    const ready = state.restartSession(sessionId)
    if (!ready || typeof ready.then !== 'function') return false
    return (await ready) !== false
  },

  restartAllSessions: () => {
    const { ws, sessions } = get()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Plain terminals are left alone: restarting one would kill the user's shell.
    const running = Object.values(sessions).filter((s) => s.status === 'running' && s.cli_type !== 'shell')
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
          get().addNotification({
            type: 'error',
            message: e?.message || 'Cascade aborted: failed to update permission mode.',
            sessionId,
          })
          return
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
        const parsedSteps = typeof run.steps === 'string' ? JSON.parse(run.steps) : (run.steps || [])
        const parsedOriginal = typeof run.original_steps === 'string' ? JSON.parse(run.original_steps || '[]') : (run.original_steps || [])
        const parsedVars = typeof run.variables === 'string' ? JSON.parse(run.variables || '[]') : (run.variables || [])
        const parsedVarVals = typeof run.variable_values === 'string' ? JSON.parse(run.variable_values || '{}') : (run.variable_values || {})
        set((s) => ({
          cascadeRunners: {
            ...s.cascadeRunners,
            [sessionId]: {
              runId: run.id,
              sessionId,
              cascadeId: cascade.id,
              name: cascade.name,
              steps: parsedSteps,
              originalSteps: parsedOriginal,
              currentStep: run.current_step,
              totalSteps: parsedSteps.length,
              loop: !!run.loop,
              loopReprompt: !!run.loop_reprompt,
              autoApprovePlan: !!cascade.auto_approve,
              running: true,
              status: run.status,
              iteration: run.iteration,
              startedAt: Date.now(),
              variables: parsedVars,
              variableValues: parsedVarVals,
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
      // Capture runner info before deleting it from state
      const runner = get().cascadeRunners[session_id]
      const runnerName = runner?.name || 'Cascade'
      set((s) => {
        const next = { ...s.cascadeRunners }
        delete next[session_id]
        return { cascadeRunners: next }
      })
      get().addNotification({
        type: 'info',
        message: `Cascade "${runnerName}" completed (${total_steps} steps).`,
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
  loadPipelineRuns: async (workspaceId, pipelineId, activeOnly, taskId) => {
    try {
      const list = await api.listPipelineRuns(workspaceId, pipelineId, activeOnly, taskId)
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

  cascades: [],
  setCascades: (cascades) => set({ cascades: Array.isArray(cascades) ? cascades : [] }),
  loadCascades: async () => {
    try {
      const list = await api.getCascades()
      if (Array.isArray(list)) set({ cascades: list })
    } catch (e) {
      console.error('loadCascades failed:', e)
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

  // Global composer input draft per session (preserves drafts across view unmounts)
  sessionInputs: {},
  setSessionInput: (sessionId, text) =>
    set((s) => ({ sessionInputs: { ...s.sessionInputs, [sessionId]: text || '' } })),

  // Client-side queued messages waiting for the agent to finish (clock icon)
  queuedCommands: {}, // sessionId -> Array of { id, command, processed, delivery, status }
  setQueuedCommands: (sessionId, queue) =>
    set((s) => ({ queuedCommands: { ...s.queuedCommands, [sessionId]: queue || [] } })),

  // Rich chat/composer draft per session. Kept in the store because grid view
  // swaps ChatPanel with TerminalView, which unmounts the chat component.
  chatDrafts: {},
  updateChatDraft: (sessionId, patchOrUpdater) =>
    set((s) => {
      const current = normalizeChatDraft(s.chatDrafts[sessionId])
      const patch = typeof patchOrUpdater === 'function'
        ? patchOrUpdater(current)
        : patchOrUpdater
      return {
        chatDrafts: {
          ...s.chatDrafts,
          [sessionId]: normalizeChatDraft({ ...current, ...(patch || {}) }),
        },
      }
    }),
  clearChatDraft: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.chatDrafts)) return {}
      const { [sessionId]: _, ...rest } = s.chatDrafts
      return { chatDrafts: rest }
    }),

  // Global pending optimistic messages (preserves in-flight messages across view unmounts)
  pendingOptimisticMessages: {},
  addOptimisticMessage: (sessionId, message) =>
    set((s) => {
      const existing = s.pendingOptimisticMessages[sessionId] || []
      return {
        pendingOptimisticMessages: {
          ...s.pendingOptimisticMessages,
          [sessionId]: [...existing, message].slice(-5),
        },
        awaitingReplies: {
          ...s.awaitingReplies,
          [sessionId]: beginReplyWait(message, s.messages[sessionId] || []),
        },
      }
    }),
  clearOptimisticMessages: (sessionId) =>
    set((s) => {
      const next = { ...s.pendingOptimisticMessages }
      delete next[sessionId]
      return { pendingOptimisticMessages: next }
    }),

  // Last sent prompt from user (restored on abort/exit)
  lastSentPrompts: {},
  setLastSentPrompt: (sessionId, text) =>
    set((s) => ({ lastSentPrompts: { ...s.lastSentPrompts, [sessionId]: text || '' } })),
}))

// Observe the existing field so command-palette and keyboard toggles persist,
// too. No session/project state is written to this layout preference.
const stopSidebarPersistence = persistSidebarVisibility(useStore)
if (import.meta.hot) import.meta.hot.dispose(stopSidebarPersistence)

export default useStore
