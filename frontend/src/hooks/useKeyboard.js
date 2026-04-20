import { useEffect } from 'react'
import useStore from '../state/store'
import { api } from '../lib/api'
import { matchesKey } from '../lib/keybindings'
import { terminalControls } from '../lib/terminalWriters'

// Move keyboard focus to the first chrome button (tab bar / TopBar / QuickActions).
// Returns true if focus was moved, false if no chrome button is in the DOM.
function focusFirstChromeButton() {
  // Prefer the active tab if there is one — that's where the user expects to land.
  const activeId = useStore.getState().activeSessionId
  if (activeId) {
    const activeTab = document.querySelector(`[data-chrome-button][data-tab-id="${activeId}"]`)
    if (activeTab) {
      activeTab.focus()
      return true
    }
  }
  const btn = document.querySelector('[data-chrome-button]')
  if (btn) {
    btn.focus()
    return true
  }
  return false
}

// Spatially nearest cell in a custom grid template, given a starting cell and a
// direction. Cells are filtered to only those visible after the workspace scope
// filter (handled by the caller). Returns null if no candidate exists.
function nearestCellInDirection(cells, current, direction) {
  const curCx = current.col + current.colSpan / 2
  const curCy = current.row + current.rowSpan / 2

  let best = null
  let bestDist = Infinity
  for (const c of cells) {
    if (c.id === current.id) continue
    const cx = c.col + c.colSpan / 2
    const cy = c.row + c.rowSpan / 2
    const dx = cx - curCx
    const dy = cy - curCy

    let inDir = false
    if (direction === 'right' && dx > 0.001) inDir = true
    if (direction === 'left' && dx < -0.001) inDir = true
    if (direction === 'down' && dy > 0.001) inDir = true
    if (direction === 'up' && dy < -0.001) inDir = true
    if (!inDir) continue

    // Penalize off-axis distance so neighbors in the requested direction win.
    const horiz = direction === 'left' || direction === 'right'
    const primary = horiz ? Math.abs(dx) : Math.abs(dy)
    const secondary = horiz ? Math.abs(dy) : Math.abs(dx)
    const dist = primary + secondary * 2
    if (dist < bestDist) {
      bestDist = dist
      best = c
    }
  }
  return best
}

// ── Simultaneous-key suppression ─────────────────────────────────────────────
// Capture-phase handler stamps `_ccSuppressed` on the event object BEFORE any
// bubble-phase handler runs. If two meta+nonModifier keydowns occur within 60ms
// with different primary keys, the second one is marked as suppressed.
// This prevents e.g. Cmd+ArrowUp+G (keys pressed nearly simultaneously) from
// triggering Cmd+G after Cmd+ArrowUp already fired.
let _prevMetaKeyTime = 0
let _prevMetaKey = null

function _captureMetaKeys(e) {
  const meta = e.metaKey || e.ctrlKey
  if (!meta) return
  const k = e.key
  if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift') return
  const now = performance.now()
  if (now - _prevMetaKeyTime < 60 && _prevMetaKey !== k) {
    e._ccSuppressed = true
  }
  _prevMetaKeyTime = now
  _prevMetaKey = k
}

export default function useKeyboard({
  onCommandPalette,
  onPromptPalette,
  onGuidelinePanel,
  onMcpServers,
  onSplitView,
  onBroadcast,
  onSearch,
  onMissionControl,
  onInbox,
  onFeatureBoard,
  onPipelineEditor,
  onAgentTree,
  onScratchpad,
  onShortcuts,
  onResearch,
  onComposer,
  onPreview,
  onMarketplace,
  onQuickActionPalette,
  onSkillsLibrary,
  onCodeReview,
  onAnnotate,
  onQuickFeature,
} = {}) {
  // Register capture-phase listener once (no deps) — survives re-renders
  useEffect(() => {
    window.addEventListener('keydown', _captureMetaKeys, true)
    return () => window.removeEventListener('keydown', _captureMetaKeys, true)
  }, [])

  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey
      // Global shortcuts require at least Cmd/Ctrl or Alt
      if (!meta && !e.altKey) return

      // If a different meta+key just fired (<60ms ago), this is a simultaneous
      // multi-key press — skip it. The flag is set by the capture-phase handler
      // which runs before this bubble-phase handler for the SAME event dispatch.
      if (e._ccSuppressed) return

      const store = useStore.getState()
      const kb = store.keybindings

      // ── Configurable shortcuts ──────────────────────────────────────────
      if (matchesKey(e, kb.broadcast))      { e.preventDefault(); onBroadcast?.(); return }
      if (matchesKey(e, kb.shortcuts))       { e.preventDefault(); onShortcuts?.(); return }
      if (matchesKey(e, kb.search))          { e.preventDefault(); onSearch?.(); return }
      if (matchesKey(e, kb.research))        { e.preventDefault(); onResearch?.(); return }
      if (matchesKey(e, kb.commandPalette))  { e.preventDefault(); onCommandPalette?.(); return }
      if (matchesKey(e, kb.promptPalette))   { e.preventDefault(); onPromptPalette?.(); return }
      if (matchesKey(e, kb.previewUrl))      { e.preventDefault(); onPreview?.(); return }
      if (matchesKey(e, kb.missionControl))  { e.preventDefault(); onMissionControl?.(); return }
      if (matchesKey(e, kb.featureBoard))    { e.preventDefault(); onFeatureBoard?.(); return }
      if (matchesKey(e, kb.pipelineEditor)) { e.preventDefault(); onPipelineEditor?.(); return }
      if (matchesKey(e, kb.inbox))           { e.preventDefault(); onInbox?.(); return }
      if (matchesKey(e, kb.agentTree))       { e.preventDefault(); onAgentTree?.(); return }
      if (matchesKey(e, kb.composer))        { e.preventDefault(); onComposer?.(); return }
      if (matchesKey(e, kb.scratchpad))      { e.preventDefault(); onScratchpad?.(); return }
      if (matchesKey(e, kb.guidelines))      { e.preventDefault(); onGuidelinePanel?.(); return }
      if (matchesKey(e, kb.mcpServers))      { e.preventDefault(); onMcpServers?.(); return }
      if (matchesKey(e, kb.marketplace))     { e.preventDefault(); onMarketplace?.(); return }
      if (matchesKey(e, kb.quickActionPalette)) { e.preventDefault(); onQuickActionPalette?.(); return }
      if (matchesKey(e, kb.skillsLibrary))  { e.preventDefault(); onSkillsLibrary?.(); return }
      if (matchesKey(e, kb.codeReview))     { e.preventDefault(); onCodeReview?.(); return }
      if (matchesKey(e, kb.annotate))       { e.preventDefault(); onAnnotate?.(); return }
      if (matchesKey(e, kb.quickFeature))   { e.preventDefault(); onQuickFeature?.(); return }
      if (matchesKey(e, kb.splitView))       { e.preventDefault(); onSplitView?.(); return }
      if (matchesKey(e, kb.usage))           { e.preventDefault(); window.open('https://claude.ai/settings/usage', '_blank'); return }

      if (matchesKey(e, kb.sidebar)) {
        e.preventDefault()

        useStore.setState((s) => ({ sidebarVisible: !s.sidebarVisible }))
        return
      }

      if (matchesKey(e, kb.newSession)) {
        e.preventDefault()

        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) {
          api.createSession(wsId).then((session) => store.addSession(session))
        }
        return
      }

      if (matchesKey(e, kb.closeTab)) {
        e.preventDefault()

        if (store.activeSessionId) store.closeTab(store.activeSessionId)
        return
      }

      if (matchesKey(e, kb.stopSession)) {
        e.preventDefault()

        if (store.activeSessionId) store.stopSession(store.activeSessionId)
        return
      }

      // ── Jump to message start in active terminal ────────────────────────
      // Drives the Terminal.jsx-registered jumpToMessage handler so the
      // shortcut works even when focus has drifted off the terminal.
      if (matchesKey(e, kb.msgPrev) || matchesKey(e, kb.msgNext)) {
        const ctrl = store.activeSessionId && terminalControls.get(store.activeSessionId)
        if (ctrl?.jumpToMessage) {
          e.preventDefault()
          ctrl.jumpToMessage(matchesKey(e, kb.msgPrev) ? 'prev' : 'next')
        }

        return
      }

      // ── Hardcoded: Tab switching (Cmd+1-9) ──────────────────────────────
      if (meta && e.key >= '1' && e.key <= '9') {
        e.preventDefault()

        const idx = parseInt(e.key) - 1
        if (idx < store.openTabs.length) {
          store.setActiveSession(store.openTabs[idx])
        }
        return
      }

      // ── Hardcoded: Grid navigation (Ctrl+Opt+arrows) ───────────────────
      // Ctrl+Opt to avoid: macOS Cmd+Arrow (scroll/cursor), Chrome
      // Cmd+Opt+Arrow (tab switch), Ctrl+Arrow (Spaces), AND Opt+Arrow
      // (word-by-word cursor movement in terminal).
      if (e.altKey && e.ctrlKey && !e.metaKey && !e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {

        // Skip when a fullscreen overlay (Feature Board, etc.) is active
        if (document.querySelector('[data-board-overlay]')) return

        // Tabs visible after the project/workspace scope filter — must match
        // the same filter App.jsx uses for the grid view.
        const allTabs = store.openTabs
        const tabs = (store.tabScope === 'workspace' && store.activeWorkspaceId)
          ? allTabs.filter((id) => store.sessions[id]?.workspace_id === store.activeWorkspaceId)
          : allTabs

        // ── Custom template grid: walk cells spatially via col/row ──
        const activeTpl = store.activeGridTemplateId && store.viewMode === 'grid'
          ? store.gridTemplates.find((t) => t.id === store.activeGridTemplateId)
          : null

        if (activeTpl) {
          e.preventDefault()
          e.stopPropagation()
          const tplAssignments = activeTpl.cell_assignments || {}
          const visibleCells = activeTpl.cells
            .map((c) => {
              let sid = tplAssignments[c.id]
              if (
                sid &&
                store.tabScope === 'workspace' &&
                store.activeWorkspaceId &&
                store.sessions[sid]?.workspace_id !== store.activeWorkspaceId
              ) {
                sid = null
              }
              return { ...c, sessionId: sid }
            })
            .filter((c) => c.sessionId)

          if (visibleCells.length === 0) {
            if (e.key === 'ArrowUp') focusFirstChromeButton()
            return
          }

          const cur =
            visibleCells.find((c) => c.sessionId === store.activeSessionId) ||
            visibleCells[0]

          const dirMap = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
          }
          const next = nearestCellInDirection(visibleCells, cur, dirMap[e.key])
          if (next) {
            store.setActiveSession(next.sessionId)
            requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
          } else if (e.key === 'ArrowUp') {
            // No cell above the current one → escape to chrome.
            focusFirstChromeButton()
          }
          return
        }

        // ── Built-in grid / tabs view ──
        if (tabs.length === 0 || !store.activeSessionId) {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            focusFirstChromeButton()
          }
          return
        }
        const cur = tabs.indexOf(store.activeSessionId)
        if (cur < 0) {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            focusFirstChromeButton()
          }
          return
        }

        // Tabs view: single row. Cmd+Up always escapes to chrome.
        if (store.viewMode !== 'grid') {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'ArrowUp') {
            focusFirstChromeButton()
            return
          }
          if (e.key === 'ArrowDown') return
          let next = cur
          if (e.key === 'ArrowLeft') next = cur - 1
          if (e.key === 'ArrowRight') next = cur + 1
          if (next >= 0 && next < tabs.length) {
            store.setActiveSession(tabs[next])
          }
          return
        }

        // Built-in grid: column count mirrors App.jsx (1→1, 2→2, 3-4→2, 5+→3).
        e.preventDefault()
        e.stopPropagation()
        const cols = tabs.length <= 2 ? tabs.length : tabs.length <= 4 ? 2 : 3
        let next = cur
        if (e.key === 'ArrowLeft') next = cur - 1
        if (e.key === 'ArrowRight') next = cur + 1
        if (e.key === 'ArrowDown') next = cur + cols
        if (e.key === 'ArrowUp') {
          next = cur - cols
          if (next < 0) {
            // Top row → escape to chrome.
            focusFirstChromeButton()
            return
          }
        }
        if (next >= 0 && next < tabs.length) {
          store.setActiveSession(tabs[next])
          requestAnimationFrame(() => window.dispatchEvent(new Event('cc-focus-terminal')))
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCommandPalette, onPromptPalette, onGuidelinePanel, onMcpServers, onSplitView, onBroadcast, onSearch, onMissionControl, onInbox, onFeatureBoard, onPipelineEditor, onAgentTree, onScratchpad, onShortcuts, onResearch, onComposer, onPreview, onMarketplace, onQuickActionPalette, onSkillsLibrary, onCodeReview, onAnnotate, onQuickFeature])

  // ── Chrome focus mode ──
  // When a [data-chrome-button] has focus, plain arrow keys cycle through them,
  // Enter/Space activates, Escape returns focus to the active terminal.
  // The mode is entered via Cmd+Up from the terminal/grid (handled above).
  useEffect(() => {
    const handler = (e) => {
      const active = document.activeElement
      if (!active || !active.matches || !active.matches('[data-chrome-button]')) return

      const buttons = Array.from(document.querySelectorAll('[data-chrome-button]'))
      if (buttons.length === 0) return
      const cur = buttons.indexOf(active)
      if (cur < 0) return

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp': {
          e.preventDefault()
          const next = cur > 0 ? buttons[cur - 1] : buttons[buttons.length - 1]
          next.focus()
          break
        }
        case 'ArrowRight':
        case 'ArrowDown': {
          e.preventDefault()
          const next = cur < buttons.length - 1 ? buttons[cur + 1] : buttons[0]
          next.focus()
          break
        }
        case 'Home': {
          e.preventDefault()
          buttons[0].focus()
          break
        }
        case 'End': {
          e.preventDefault()
          buttons[buttons.length - 1].focus()
          break
        }
        case 'Enter':
        case ' ': {
          e.preventDefault()
          active.click()
          break
        }
        case 'Escape': {
          e.preventDefault()
          active.blur()
          // Hand focus back to the active terminal so typing resumes immediately.
          window.dispatchEvent(new CustomEvent('cc-focus-terminal'))
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
