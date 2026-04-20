import { useState, useEffect, useRef } from 'react'
import { FolderOpen, MessageSquare, Search, Layers } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'
import { ACTIONS } from '../../lib/commandActions'

export default function CommandPalette({ onClose, onAction }) {
  const [query, setQuery] = useState('')
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
        label: `${s.name} (${s.model})`,
        icon: MessageSquare,
        section: 'Open Tabs',
        shortcut: i < 9 ? `⌘${i + 1}` : undefined,
        data: s,
      } : null
    }).filter(Boolean),
    ...tabGroups.map((g) => ({
      id: `tab-group-${g.id}`,
      label: `Open: ${g.name}`,
      icon: Layers,
      section: 'Tab Groups',
      data: g,
    })),
  ]

  const filtered = query
    ? allActions.filter((a) =>
        a.label.toLowerCase().includes(query.toLowerCase()) ||
        a.section.toLowerCase().includes(query.toLowerCase())
      )
    : allActions

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
      case 'new-session': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) api.createSession(wsId).then((s) => store.addSession(s))
        break
      }
      case 'close-tab':
        if (store.activeSessionId) store.closeTab(store.activeSessionId)
        break
      case 'stop-session':
        if (store.activeSessionId) store.stopSession(store.activeSessionId)
        break
      case 'restart-session':
        if (store.activeSessionId && store.sessions[store.activeSessionId]?.status === 'exited') {
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
      case 'start-commander': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) {
          api.startCommander(wsId).then((s) => {
            store.addSession(s)
          })
        }
        break
      }
      case 'start-documentor': {
        const wsId = store.activeWorkspaceId || store.workspaces[0]?.id
        if (wsId) {
          api.startDocumentor(wsId).then((s) => {
            store.addSession(s)
            setTimeout(() => {
              sendTerminalCommand(s.id, 'Begin documenting this project now. Start with get_knowledge_base() to understand the product, then scaffold_docs() and systematically document each feature with screenshots and GIF demos. Build the site when done.')
            }, 3000)
          })
        }
        break
      }
      case 'scratchpad':
        onAction?.('scratchpad')
        break
      case 'manage-templates':
        onAction?.('manage-templates')
        break
      case 'grid-layout-editor':
        onAction?.('grid-layout-editor')
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[520px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="relative">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="w-full pl-10 pr-4 py-3.5 text-sm bg-transparent border-b border-border-primary text-text-primary placeholder-text-faint focus:outline-none"
          />
          <kbd className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-text-faint bg-bg-tertiary px-1.5 py-0.5 rounded border border-border-secondary font-mono">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {Object.entries(sections).map(([section, actions]) => (
            <div key={section}>
              <div className="px-4 pt-2.5 pb-1 text-[10px] text-text-faint uppercase tracking-widest font-semibold">
                {section}
              </div>
              {actions.map((action) => {
                const Icon = action.icon
                const isSelected = action.flatIdx === selectedIdx
                return (
                  <button
                    key={action.id}
                    data-selected={isSelected}
                    onClick={() => execute(action)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors ${
                      isSelected ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    <Icon size={15} className={isSelected ? 'text-accent-primary' : 'text-text-faint'} />
                    <span className="flex-1 text-xs">{action.label}</span>
                    {action.shortcut && (
                      <kbd className="text-[10px] text-text-faint bg-bg-tertiary px-1.5 py-0.5 rounded border border-border-secondary font-mono">
                        {action.shortcut}
                      </kbd>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-xs text-text-faint text-center">
              No matching commands
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border-secondary text-[10px] text-text-faint">
          <span className="flex items-center gap-1"><kbd className="bg-bg-tertiary px-1 rounded border border-border-secondary font-mono">↑↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="bg-bg-tertiary px-1 rounded border border-border-secondary font-mono">↵</kbd> select</span>
          <span className="flex items-center gap-1"><kbd className="bg-bg-tertiary px-1 rounded border border-border-secondary font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
