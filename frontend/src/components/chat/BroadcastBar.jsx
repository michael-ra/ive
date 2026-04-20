import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Radio, X, Send, AlertTriangle, Globe, FolderOpen, Save, Trash2, Users } from 'lucide-react'
import useStore from '../../state/store'
import { broadcastCommand } from '../../lib/terminal'
import { isVaguePrompt } from '../../lib/constants'
import { TOKEN_REGEX } from '../../lib/tokens'
import { api } from '../../lib/api'
import TokenChips from './TokenChips'

export default function BroadcastBar({ onClose }) {
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState({})
  const [globalOverride, setGlobalOverride] = useState(false)
  const [groups, setGroups] = useState([])
  const [savingGroup, setSavingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [activeGroupId, setActiveGroupId] = useState(null)
  const inputRef = useRef(null)
  const groupNameRef = useRef(null)
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)

  // Detect @global in the input text
  const hasGlobalToken = TOKEN_REGEX.global.test(input)
  const isGlobal = globalOverride || hasGlobalToken || !activeWorkspaceId

  // Workspace-scoped tabs vs all tabs
  const scopedTabs = useMemo(() => {
    if (isGlobal) return openTabs
    return openTabs.filter((id) => sessions[id]?.workspace_id === activeWorkspaceId)
  }, [openTabs, sessions, activeWorkspaceId, isGlobal])

  // Cross-workspace tabs (shown dimmed when in global mode)
  const crossWorkspaceTabs = useMemo(() => {
    if (!isGlobal || !activeWorkspaceId) return []
    return openTabs.filter((id) => sessions[id]?.workspace_id !== activeWorkspaceId)
  }, [openTabs, sessions, activeWorkspaceId, isGlobal])

  const activeWsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name

  // Load broadcast groups
  const loadGroups = useCallback(async () => {
    try {
      const data = await api.getBroadcastGroups()
      setGroups(data)
    } catch {
      // table may not exist yet if server hasn't restarted
    }
  }, [])

  useEffect(() => {
    // Select all scoped sessions by default
    const all = {}
    scopedTabs.forEach((id) => (all[id] = true))
    setSelected(all)
    inputRef.current?.focus()
    loadGroups()
  }, [])

  // When scope changes, auto-select newly visible sessions
  useEffect(() => {
    setSelected((prev) => {
      const next = { ...prev }
      scopedTabs.forEach((id) => {
        if (!(id in next)) next[id] = true
      })
      return next
    })
  }, [isGlobal, scopedTabs])

  // Focus the group name input when save mode activates
  useEffect(() => {
    if (savingGroup) {
      // Wait for DOM to update then focus
      requestAnimationFrame(() => groupNameRef.current?.focus())
    }
  }, [savingGroup])

  const toggleSession = (id) => {
    setSelected((s) => ({ ...s, [id]: !s[id] }))
    setActiveGroupId(null)
  }

  const handleSend = () => {
    const text = input.trim()
    if (!text) return

    const ids = Object.keys(selected).filter((id) => selected[id])
    if (ids.length === 0) return

    broadcastCommand(ids, text)

    setInput('')
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (savingGroup) {
        setSavingGroup(false)
        setGroupName('')
      } else {
        onClose()
      }
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Group actions ──────────────────────────────────────────────

  const applyGroup = (group) => {
    const openSet = new Set(openTabs)
    const next = {}
    group.session_ids.forEach((id) => {
      if (openSet.has(id)) next[id] = true
    })
    setSelected(next)
    setActiveGroupId(group.id)
  }

  const handleSaveGroup = async () => {
    const name = groupName.trim()
    if (!name) return

    const sessionIds = Object.keys(selected).filter((id) => selected[id])
    if (sessionIds.length === 0) return

    try {
      await api.createBroadcastGroup({
        name,
        session_ids: sessionIds,
        workspace_id: activeWorkspaceId || null,
      })
      setSavingGroup(false)
      setGroupName('')
      await loadGroups()
    } catch {
      // silent — server may need restart for new table
    }
  }

  const handleUpdateGroup = async (group) => {
    const sessionIds = Object.keys(selected).filter((id) => selected[id])
    if (sessionIds.length === 0) return
    try {
      await api.updateBroadcastGroup(group.id, { session_ids: sessionIds })
      await loadGroups()
    } catch {
      // silent
    }
  }

  const handleDeleteGroup = async (e, groupId) => {
    e.stopPropagation()
    try {
      await api.deleteBroadcastGroup(groupId)
      if (activeGroupId === groupId) setActiveGroupId(null)
      setGroups((prev) => prev.filter((g) => g.id !== groupId))
    } catch {
      // silent
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length
  const vague = isVaguePrompt(input)

  // Group tabs by workspace for display when in global mode
  const groupedByWorkspace = useMemo(() => {
    if (!isGlobal || !activeWorkspaceId) return null
    const wsGroups = {}
    openTabs.forEach((id) => {
      const s = sessions[id]
      if (!s) return
      const wsId = s.workspace_id || '__none__'
      if (!wsGroups[wsId]) wsGroups[wsId] = []
      wsGroups[wsId].push(id)
    })
    return wsGroups
  }, [openTabs, sessions, isGlobal, activeWorkspaceId])

  const renderSessionChip = (id, dimmed = false) => {
    const s = sessions[id]
    if (!s) return null
    return (
      <button
        key={id}
        onClick={() => toggleSession(id)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
          selected[id]
            ? dimmed
              ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
              : 'bg-orange-500/15 text-orange-400 border border-orange-500/25'
            : 'bg-bg-tertiary text-text-faint border border-border-primary'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${
          selected[id] ? (dimmed ? 'bg-cyan-400' : 'bg-orange-400') : 'bg-zinc-600'
        }`} />
        {s.name}
      </button>
    )
  }

  // Count how many sessions in a group are currently selected
  const groupSelectedCount = (group) => {
    return group.session_ids.filter((id) => selected[id]).length
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] max-h-[72vh] flex flex-col ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary shrink-0">
          <Radio size={14} className="text-orange-400" />
          <span className="text-xs text-text-secondary font-medium">
            Broadcast to {selectedCount} session{selectedCount !== 1 ? 's' : ''}
          </span>
          <div className="flex-1" />
          {activeWorkspaceId && (
            <button
              onClick={() => setGlobalOverride((g) => !g)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                isGlobal
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25'
                  : 'bg-bg-tertiary text-text-faint border border-border-primary hover:text-text-secondary'
              }`}
              title={isGlobal ? 'Broadcasting globally — click for workspace only' : 'Broadcasting to workspace — click for all'}
            >
              {isGlobal ? <Globe size={10} /> : <FolderOpen size={10} />}
              {isGlobal ? 'global' : activeWsName || 'workspace'}
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Saved broadcast groups (compact row) ──────────── */}
        {groups.length > 0 && (
          <div className="px-4 py-2 border-b border-border-secondary shrink-0">
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => {
                const sel = groupSelectedCount(g)
                const total = g.session_ids.length
                const isActive = activeGroupId === g.id
                return (
                  <button
                    key={g.id}
                    onClick={() => applyGroup(g)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      handleUpdateGroup(g)
                    }}
                    className={`group/chip flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-violet-500/15 text-violet-400 border border-violet-500/25'
                        : 'bg-bg-tertiary text-text-faint border border-border-primary hover:text-text-secondary hover:border-border-secondary'
                    }`}
                    title={`${g.name} (${sel}/${total} selected)\nRight-click to update with current selection`}
                  >
                    <Users size={10} className={isActive ? 'text-violet-400' : 'text-text-faint'} />
                    {g.name}
                    <span className={`text-[10px] ${sel === 0 ? 'text-red-400/60' : isActive ? 'text-violet-400/60' : 'text-text-faint/60'}`}>
                      {sel}/{total}
                    </span>
                    <span
                      onClick={(e) => handleDeleteGroup(e, g.id)}
                      className="hidden group-hover/chip:inline-flex items-center ml-0.5 text-text-faint hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={9} />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="px-4 py-2.5 border-b border-border-secondary overflow-y-auto shrink-0">
          {/* When global, group by workspace */}
          {isGlobal && groupedByWorkspace ? (
            <div className="space-y-2">
              {Object.entries(groupedByWorkspace).map(([wsId, ids]) => {
                const ws = workspaces.find((w) => w.id === wsId)
                const isCross = wsId !== activeWorkspaceId
                return (
                  <div key={wsId}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`text-[10px] font-medium ${isCross ? 'text-cyan-400/70' : 'text-text-secondary'}`}>
                        {ws?.name || 'No workspace'}
                      </span>
                      {isCross && <Globe size={9} className="text-cyan-400/50" />}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ids.map((id) => renderSessionChip(id, isCross))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {scopedTabs.map((id) => renderSessionChip(id))}
              {scopedTabs.length === 0 && (
                <span className="text-xs text-text-faint">No open sessions in this workspace</span>
              )}
            </div>
          )}
        </div>

        <div className="p-4 shrink-0">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="message to broadcast... (⌘↵ send)"
            rows={3}
            className="w-full px-3 py-2 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 font-mono resize-none transition-colors"
          />
          {vague && (
            <div className="flex items-start gap-1.5 mt-2 px-1 text-xs text-amber-400/80">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>Prompt looks vague — consider adding file paths, function names, or numbered steps. Prefix with <code className="bg-bg-tertiary px-1 rounded text-[11px]">!</code> to skip.</span>
            </div>
          )}
          <TokenChips text={input} className="mt-2" />
          <div className="mt-2 text-[10px] text-text-faint font-mono">
            tip: use <span className="text-cyan-300">@global</span> to broadcast across all workspaces, <span className="text-violet-300">@prompt:&lt;name&gt;</span> to inline a prompt, <span className="text-amber-300">@ralph</span> for loop mode
          </div>

          {/* ── Save group form (inline at bottom) ──────────── */}
          {savingGroup && (
            <div className="flex items-center gap-2 mt-3 p-2 rounded-md bg-bg-tertiary border border-border-secondary">
              <Users size={12} className="text-violet-400 shrink-0" />
              <input
                ref={groupNameRef}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSaveGroup()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setSavingGroup(false)
                    setGroupName('')
                  }
                  e.stopPropagation()
                }}
                placeholder="group name..."
                className="flex-1 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded text-text-primary placeholder-text-faint focus:outline-none focus:border-violet-500/50 font-mono"
              />
              <button
                onClick={handleSaveGroup}
                disabled={!groupName.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                save
              </button>
              <button
                onClick={() => { setSavingGroup(false); setGroupName('') }}
                className="px-2 py-1.5 text-xs text-text-faint hover:text-text-secondary transition-colors"
              >
                cancel
              </button>
            </div>
          )}

          <div className="flex items-center justify-between mt-3">
            {!savingGroup && selectedCount > 0 ? (
              <button
                onClick={() => setSavingGroup(true)}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-text-secondary hover:text-violet-400 hover:bg-violet-500/10 border border-transparent hover:border-violet-500/20 transition-colors"
                title="Save current selection as a broadcast group"
              >
                <Save size={12} />
                save group
              </button>
            ) : (
              <div />
            )}
            <button
              onClick={handleSend}
              disabled={!input.trim() || selectedCount === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-orange-600 hover:bg-orange-500 disabled:opacity-30 text-white rounded-md transition-colors"
            >
              <Send size={12} />
              {vague ? 'broadcast anyway' : 'broadcast'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
