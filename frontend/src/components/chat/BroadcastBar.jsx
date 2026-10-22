import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Radio, X, Send, AlertTriangle, Globe, FolderOpen, Save, Trash2, Users } from 'lucide-react'
import useStore from '../../state/store'
import { broadcastCommand } from '../../lib/terminal'
import { isVaguePrompt } from '../../lib/constants'
import { TOKEN_REGEX } from '../../lib/tokens'
import { api } from '../../lib/api'
import TokenChips from './TokenChips'
import { getBroadcastRecipients } from '../../lib/broadcastScope'

export default function BroadcastBar({ onClose }) {
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState({})
  const [globalOverride, setGlobalOverride] = useState(false)
  const [groups, setGroups] = useState([])
  const [groupError, setGroupError] = useState('')
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
    return openTabs.filter((id) => sessions[id] && (isGlobal || sessions[id].workspace_id === activeWorkspaceId))
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
      setGroups(Array.isArray(data) ? data : [])
      setGroupError('')
    } catch (error) {
      setGroupError(error.message || 'Saved recipient groups could not be loaded. You can still select sessions below.')
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
      const next = {}
      scopedTabs.forEach((id) => {
        next[id] = id in prev ? prev[id] : true
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

    const ids = getBroadcastRecipients(selected, scopedTabs, openTabs, sessions)
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
    const groupSelection = Object.fromEntries((group.session_ids || []).map((id) => [id, true]))
    const next = Object.fromEntries(getBroadcastRecipients(groupSelection, scopedTabs, openTabs, sessions).map((id) => [id, true]))
    setSelected(next)
    setActiveGroupId(group.id)
  }

  const handleSaveGroup = async () => {
    const name = groupName.trim()
    if (!name) return

    const sessionIds = getBroadcastRecipients(selected, scopedTabs, openTabs, sessions)
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
    } catch (error) {
      setGroupError(error.message || 'The recipient group could not be saved. Your selection is unchanged.')
    }
  }

  const handleUpdateGroup = async (group) => {
    const sessionIds = getBroadcastRecipients(selected, scopedTabs, openTabs, sessions)
    if (sessionIds.length === 0) return
    try {
      await api.updateBroadcastGroup(group.id, { session_ids: sessionIds })
      await loadGroups()
    } catch (error) {
      setGroupError(error.message || 'The recipient group could not be updated. Try again.')
    }
  }

  const handleDeleteGroup = async (e, groupId) => {
    e.stopPropagation()
    try {
      await api.deleteBroadcastGroup(groupId)
      if (activeGroupId === groupId) setActiveGroupId(null)
      setGroups((prev) => prev.filter((g) => g.id !== groupId))
      setGroupError('')
    } catch (error) {
      setGroupError(error.message || 'The recipient group could not be deleted. Try again.')
    }
  }

  const selectedIds = getBroadcastRecipients(selected, scopedTabs, openTabs, sessions)
  const selectedCount = selectedIds.length
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
        aria-pressed={Boolean(selected[id])}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors duration-[80ms] ${
          selected[id]
            ? dimmed
              ? 'bg-x-tint text-x-accent border border-x-tint-line'
              : 'bg-x-accent-ink/10 text-x-accent-ink border border-x-accent-ink/30'
            : 'bg-x-surface text-x-muted border border-x-line hover:bg-x-hover hover:text-x-ink-secondary'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${
          selected[id] ? (dimmed ? 'bg-x-accent' : 'bg-x-accent-ink') : 'bg-x-faint'
        }`} />
        {s.name}
      </button>
    )
  }

  // Count how many sessions in a group are currently selected
  const groupSelectedCount = (group) => {
    const groupIds = new Set(group.session_ids || [])
    return selectedIds.filter((id) => groupIds.has(id)).length
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[560px] max-h-[72vh] flex flex-col x-panel shadow-x-3 overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line shrink-0">
          <Radio size={14} className="text-x-accent-ink" />
          <span className="text-xs text-x-ink-secondary font-medium">
            Broadcast to {selectedCount} session{selectedCount !== 1 ? 's' : ''}
          </span>
          <div className="flex-1" />
          {activeWorkspaceId && (
            <button
              onClick={() => setGlobalOverride((g) => !g)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors duration-[80ms] ${
                isGlobal
                  ? 'bg-x-tint text-x-accent border border-x-tint-line'
                  : 'bg-x-surface text-x-muted border border-x-line hover:bg-x-hover hover:text-x-ink-secondary'
              }`}
              title={isGlobal ? 'Broadcasting globally — click for workspace only' : 'Broadcasting to workspace — click for all'}
            >
              {isGlobal ? <Globe size={10} /> : <FolderOpen size={10} />}
              {isGlobal ? 'global' : activeWsName || 'workspace'}
            </button>
          )}
          <button onClick={onClose} aria-label="Close broadcast" className="p-1 rounded-md hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={15} />
          </button>
        </div>

        {groupError && <div role="alert" className="px-4 py-2 text-xs text-x-accent-ink border-b border-x-line">{groupError}</div>}
        <p className="px-4 py-2 text-xs text-x-muted">One message goes to every selected session shown below. Each keeps its own conversation. Saved groups are limited to the current project scope.</p>

        {/* ── Saved broadcast groups (compact row) ──────────── */}
        {groups.length > 0 && (
          <div className="px-4 py-2 border-b border-x-line-subtle shrink-0">
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
                    className={`group/chip flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors duration-[80ms] ${
                      isActive
                        ? 'bg-x-tint text-x-accent border border-x-tint-line'
                        : 'bg-x-surface text-x-muted border border-x-line hover:bg-x-hover hover:text-x-ink-secondary hover:border-x-line-strong'
                    }`}
                    title={`${g.name} (${sel}/${total} selected)\nRight-click to update with current selection`}
                  >
                    <Users size={10} className={isActive ? 'text-x-accent' : 'text-x-muted'} />
                    {g.name}
                    <span className={`text-[11px] tabular-nums ${sel === 0 ? 'text-x-accent-ink/70' : isActive ? 'text-x-accent/70' : 'text-x-muted/70'}`}>
                      {sel}/{total}
                    </span>
                    <span
                      onClick={(e) => handleDeleteGroup(e, g.id)}
                      className="hidden group-hover/chip:inline-flex items-center ml-0.5 text-x-muted hover:text-x-accent-ink transition-colors duration-[80ms]"
                    >
                      <Trash2 size={9} />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="px-4 py-2.5 border-b border-x-line-subtle overflow-y-auto shrink-0">
          {/* When global, group by workspace */}
          {isGlobal && groupedByWorkspace ? (
            <div className="space-y-2">
              {Object.entries(groupedByWorkspace).map(([wsId, ids]) => {
                const ws = workspaces.find((w) => w.id === wsId)
                const isCross = wsId !== activeWorkspaceId
                return (
                  <div key={wsId}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`text-[11px] font-medium ${isCross ? 'text-x-accent/80' : 'text-x-ink-secondary'}`}>
                        {ws?.name || 'No workspace'}
                      </span>
                      {isCross && <Globe size={9} className="text-x-accent/60" />}
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
                <span className="text-xs text-x-faint">No open sessions in this workspace</span>
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
            className="w-full px-3 py-2 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono resize-none transition-colors duration-[80ms]"
          />
          {vague && (
            <div className="flex items-start gap-1.5 mt-2 px-1 text-xs text-x-accent-ink/80">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>Prompt looks vague — consider adding file paths, function names, or numbered steps. Prefix with <code className="bg-x-surface px-1 rounded text-[11px]">!</code> to skip.</span>
            </div>
          )}
          <TokenChips text={input} className="mt-2" />
          <div className="mt-2 text-[11px] text-x-faint font-mono">
            Use <span className="text-x-accent">@global</span> for all projects or <span className="text-x-accent">@prompt:&lt;name&gt;</span> to insert a saved prompt. Start an auto-fix loop with <span className="text-x-accent-ink">@ralph</span> in one session’s chat so its work and results stay together.
          </div>

          {/* ── Save group form (inline at bottom) ──────────── */}
          {savingGroup && (
            <div className="flex items-center gap-2 mt-3 p-2 rounded-md bg-x-surface border border-x-line-subtle">
              <Users size={12} className="text-x-accent shrink-0" />
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
                className="flex-1 px-2 py-1.5 text-xs bg-x-surface-2 border border-x-line rounded text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
              />
              <button
                onClick={handleSaveGroup}
                disabled={!groupName.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 disabled:cursor-not-allowed text-x-on-accent rounded transition-colors duration-[80ms]"
              >
                save
              </button>
              <button
                onClick={() => { setSavingGroup(false); setGroupName('') }}
                className="px-2 py-1.5 text-xs text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
              >
                cancel
              </button>
            </div>
          )}

          <div className="flex items-center justify-between mt-3">
            {!savingGroup && selectedCount > 0 ? (
              <button
                onClick={() => setSavingGroup(true)}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
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
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 text-x-on-accent rounded-md transition-colors duration-[80ms] active:scale-[.98]"
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
