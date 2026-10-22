import { closeSession } from '../../lib/sessionActions'
import { useState, useEffect, useRef } from 'react'
import { FolderOpen, MessageSquare, Search, Layers, Keyboard, Sparkles, SquareTerminal } from 'lucide-react'
import { openQuickStart, openSessionSetup } from '../../lib/quickStart'
import { newTerminal } from '../../lib/shellSession'
import { isShellSession } from '../../lib/sessionStatus'
import { isHelperSession } from '../../lib/visibleSessions'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { ACTIONS } from '../../lib/commandActions'
import { IA_SURFACES } from '../../lib/informationArchitecture'
import { formatKeyCombo, getTabSwitchCombo } from '../../lib/keybindings'

// Shown first when nothing is typed: the everyday actions, so the palette is
// a starting point and not only a long alphabet of tools.
const SUGGESTED_IDS = ['board', 'new-session', 'review', 'toggle-terminal', 'command-palette']
const SURFACE_TEXT = new Map(IA_SURFACES.map((s) => [s.id, `${s.description || ''} ${s.groupLabel || ''}`]))
// Palette-only entries (handled here or by App), searchable like every action.
const PALETTE_ACTIONS = [
  { id: 'start-task', label: 'Start a task', icon: Sparkles, section: 'Work', keywords: 'plan goal request' },
  { id: 'cheat-sheet', label: 'Quick help & all shortcuts', icon: Keyboard, section: 'Help', shortcut: '?', keywords: 'keyboard shortcuts cheat sheet' },
]
const SUGGESTED_FIRST = ['start-task']
const SUGGESTED_LAST = ['cheat-sheet']

export default function CommandPalette({ onClose, onAction, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const openTabs = useStore((s) => s.openTabs)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const viewMode = useStore((s) => s.viewMode)
  const tabGroups = useStore((s) => s.tabGroups)

  // Filter actions based on workspace capabilities and view mode
  const activeWs = workspaces.find((ws) => ws.id === activeWorkspaceId)
  const filteredActions = ACTIONS.filter((a) => {
    if (a.id === 'pop-out-terminal' && !activeWs?.native_terminals_enabled) return false
    if (a.gridOnly && viewMode !== 'grid') return false
    return true
  })

  // Build full action list including dynamic items
  const allActions = [
    ...PALETTE_ACTIONS,
    ...filteredActions,
    ...workspaces.map((ws) => ({
      id: `ws-${ws.id}`,
      label: `Switch to ${ws.name}`,
      icon: FolderOpen,
      section: 'Workspaces',
      data: ws,
    })),
    ...openTabs.map((id, i) => {
      const s = sessions[id]
      return s ? {
        id: `tab-${id}`,
        label: s.model ? `${s.name} (${s.model})` : s.name,
        icon: isShellSession(s) ? SquareTerminal : MessageSquare,
        section: 'Open Tabs',
        shortcut: i < 9 ? formatKeyCombo(getTabSwitchCombo(String(i + 1))) : undefined,
        data: s,
      } : null
    }).filter(Boolean),
    // Every other session too, so a session can be opened by typing its name.
    // Helper sessions (Commander, Brainstormer) are hidden everywhere else and
    // reachable only here, marked as helpers.
    ...Object.values(sessions)
      .filter((s) => s && !s.archived && !openTabs.includes(s.id))
      .map((s) => ({
        id: `session-${s.id}`,
        label: s.name || 'Untitled session',
        keywords: `${s.model || ''} ${isShellSession(s) ? 'terminal shell' : ''} ${isHelperSession(s) ? 'helper commander brainstormer' : ''} ${workspaces.find((w) => w.id === s.workspace_id)?.name || ''}`,
        icon: isShellSession(s) ? SquareTerminal : isHelperSession(s) ? Sparkles : MessageSquare,
        section: isHelperSession(s) ? 'Helper sessions' : 'Sessions',
        hint: isHelperSession(s) ? 'helper' : undefined,
        helper: isHelperSession(s),
        data: s,
      })),
    ...tabGroups.map((g) => ({
      id: `tab-group-${g.id}`,
      label: `Open: ${g.name}`,
      icon: Layers,
      section: 'Tab Groups',
      data: g,
    })),
  ]

  const q = query.trim().toLowerCase()
  const suggested = [...SUGGESTED_FIRST, ...SUGGESTED_IDS, ...SUGGESTED_LAST]
    .map((id) => allActions.find((a) => a.id === id))
    .filter(Boolean)
    .map((a) => ({ ...a, key: `suggested-${a.id}`, section: 'Suggested' }))
  const suggestedIds = new Set(suggested.map((a) => a.id))
  const filtered = q
    ? allActions.filter((a) =>
        [a.label, a.section, a.hint, a.keywords, SURFACE_TEXT.get(a.id)]
          .some((text) => text && text.toLowerCase().includes(q))
      )
    // Empty query: suggestions first, then everything else once (no duplicates).
    : [...suggested, ...allActions.filter((a) => !suggestedIds.has(a.id))]

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector('[data-selected="true"]')
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIdx])

  const execute = (action) => {
    onClose()

    const store = useStore.getState()
    switch (action.id) {
      case 'new-session':
        // Same as the "New session" button: the quick start prompt.
        openQuickStart()
        break
      case 'new-session-setup':
        openSessionSetup()
        break
      case 'new-terminal':
        newTerminal().catch((err) => store.addNotification?.({ type: 'error', message: err?.message || 'The terminal could not be opened.' }))
        break
      case 'close-tab':
        if (store.activeSessionId) closeSession(store.activeSessionId)
        break
      case 'stop-session':
        if (store.activeSessionId) store.stopSession(store.activeSessionId)
        break
      case 'restart-session':
        if (store.activeSessionId && ['exited', 'stopped'].includes(store.sessions[store.activeSessionId]?.status)) {
          store.restartSession(store.activeSessionId)
        }
        break
      case 'toggle-sidebar':
        useStore.setState((s) => ({ sidebarVisible: !s.sidebarVisible }))
        break
      case 'prompt-library':
        onAction?.('prompt-library')
        break
      case 'new-prompt':
        onAction?.('new-prompt')
        break
      case 'guidelines':
        onAction?.('guidelines')
        break
      case 'broadcast':
        onAction?.('broadcast')
        break
      case 'split-view':
        onAction?.('split-view')
        break
      case 'clone-session':
        if (store.activeSessionId) {
          api.cloneSession(store.activeSessionId).then((s) => store.addSession(s))
        }
        break
      case 'export-session':
        if (store.activeSessionId) {
          window.open(`/api/sessions/${store.activeSessionId}/export`, '_blank')
        }
        break
      case 'distill-session':
        onAction?.('distill-session')
        break
      case 'pop-out-terminal':
        if (store.activeSessionId) {
          const sid = store.activeSessionId
          api.popOutSession(sid).then((res) => {
            if (res.ok) {
              // Mark session as external in local state
              const cur = store.sessions[sid]
              if (cur) {
                useStore.setState((s) => ({
                  sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], is_external: 1 } }
                }))
              }
            }
          }).catch((err) => alert(`Pop out failed: ${err.message}`))
        }
        break
      case 'search':
        onAction?.('search')
        break
      case 'find-in-session':
        onAction?.('find-in-session')
        break
      case 'mission-control':
        onAction?.('mission-control')
        break
      case 'import-history':
        onAction?.('import-history')
        break
      case 'inbox':
        onAction?.('inbox')
        break
      case 'plan-viewer':
        onAction?.('plan-viewer')
        break
      case 'feature-board':
        onAction?.('feature-board')
        break
      case 'agent-tree':
        onAction?.('agent-tree')
        break
      case 'scratchpad':
        onAction?.('scratchpad')
        break
      case 'manage-templates':
        onAction?.('manage-templates')
        break
      case 'adjust-grid':
        onAction?.('adjust-grid')
        break
      case 'accounts':
        onAction?.('accounts')
        break
      case 'config-viewer':
        onAction?.('config-viewer')
        break
      case 'research':
        onAction?.('research')
        break
      case 'docs-panel':
        onAction?.('docs-panel')
        break
      case 'annotate':
        onAction?.('annotate')
        break
      case 'code-review':
        onAction?.('code-review')
        break
      case 'cascades':
        onAction?.('cascades')
        break
      case 'save-template': {
        const sess = store.sessions[store.activeSessionId]
        if (sess) {
          const tname = prompt('Template name:', `${sess.model} ${sess.permission_mode} ${sess.effort}`)
          if (tname?.trim()) {
            // Fetch guidelines, MCP servers, + conversation turns
            Promise.all([
              api.getSessionGuidelines(sess.id),
              api.getSessionMcpServers(sess.id),
              fetch(`/api/sessions/${sess.id}/turns`).then((r) => r.json()),
            ]).then(([guidelines, mcpResp, turns]) => {
              api.createTemplate({
                name: tname.trim(),
                cli_type: sess.cli_type,
                model: sess.model,
                permission_mode: sess.permission_mode,
                effort: sess.effort,
                budget_usd: sess.budget_usd,
                system_prompt: sess.system_prompt,
                allowed_tools: sess.allowed_tools,
                guideline_ids: (Array.isArray(guidelines) ? guidelines : (guidelines.guidelines || [])).map((g) => g.id),
                mcp_server_ids: (mcpResp.mcp_servers || []).map((s) => s.id),
                conversation_turns: turns || [],
              })
            })
          }
        }
        break
      }
      default:
        if (action.id.startsWith('tab-group-')) {
          store.activateTabGroup(action.data)
        } else if (action.id === 'cheat-sheet') {
          window.dispatchEvent(new Event('open-cheat-sheet'))
        } else if (action.id.startsWith('session-')) {
          if (action.data.workspace_id) store.setActiveWorkspace(action.data.workspace_id)
          // Helper sessions live only on the session level: no board card, no
          // sidebar row, so open them full size right away.
          if (action.helper) store.goSession(action.data.id)
          else { store.openSession(action.data.id); useStore.setState({ showHome: false }) }
        } else if (action.id.startsWith('tab-')) {
          const sid = action.id.replace('tab-', '')
          store.setActiveSession(sid)
        } else if (action.id.startsWith('ws-')) {
          store.setActiveWorkspace(action.data.id)
        } else {
          // Forward any unhandled action to the parent (App.jsx)
          onAction?.(action.id)
        }
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSelectedIdx((i) => Math.max(0, Math.min(i + delta, filtered.length - 1)))
    } else if (e.key === 'Enter' && filtered[selectedIdx]) {
      // Opening a session focuses its terminal during this keydown; without
      // preventDefault the Enter's keypress lands in the agent's prompt.
      e.preventDefault()
      e.stopPropagation()
      execute(filtered[selectedIdx])
    }
  }

  // Group by section
  const sections = {}
  filtered.forEach((a, i) => {
    if (!sections[a.section]) sections[a.section] = []
    sections[a.section].push({ ...a, flatIdx: i })
  })

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[520px] x-panel shadow-x-3 overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="relative">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-x-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tools, sessions and projects…"
            aria-label="Search tools, sessions and projects"
            className="w-full pl-10 pr-4 py-3.5 text-[13px] bg-transparent border-b border-x-line text-x-ink placeholder:text-x-muted focus:outline-none"
          />
          <kbd className="absolute right-4 top-1/2 -translate-y-1/2 text-[11px] text-x-muted bg-x-surface-2 px-1.5 py-0.5 rounded border border-x-line font-mono">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {Object.entries(sections).map(([section, actions]) => (
            <div key={section}>
              <div className="px-4 pt-2.5 pb-1 text-[11px] text-x-muted uppercase tracking-[0.06em] font-medium">
                {section}
              </div>
              {actions.map((action) => {
                const Icon = action.icon
                const isSelected = action.flatIdx === selectedIdx
                return (
                  <button
                    key={action.key || action.id}
                    data-command-id={action.id}
                    data-selected={isSelected}
                    onClick={() => execute(action)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors duration-[80ms] ease-x ${
                      isSelected ? 'bg-x-tint text-x-ink' : 'text-x-ink-secondary hover:bg-x-hover'
                    }`}
                  >
                    <Icon size={15} strokeWidth={1.75} className={isSelected ? 'text-x-accent' : 'text-x-muted'} />
                    <span className="flex-1 text-xs">{action.label}</span>
                    {action.helper && (
                      <span data-helper-session className="text-[11px] text-x-muted bg-x-surface-2 px-1.5 py-0.5 rounded border border-x-line">helper</span>
                    )}
                    {action.shortcut && (
                      <kbd className="text-[11px] text-x-muted bg-x-surface-2 px-1.5 py-0.5 rounded border border-x-line font-mono">
                        {action.shortcut}
                      </kbd>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-xs text-x-muted text-center">
              No matching commands
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-x-line text-[11px] text-x-muted">
          <span className="flex items-center gap-1"><kbd className="bg-x-surface-2 px-1 rounded border border-x-line font-mono">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="bg-x-surface-2 px-1 rounded border border-x-line font-mono">↵</kbd> select</span>
          <span className="flex items-center gap-1"><kbd className="bg-x-surface-2 px-1 rounded border border-x-line font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
