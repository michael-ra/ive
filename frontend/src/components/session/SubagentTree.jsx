import { useState } from 'react'
import { GitBranch, X, Monitor, ChevronDown, ChevronRight, Circle, Sparkles } from 'lucide-react'
import useStore from '../../state/store'
import { getSessionStatusMeta, getSubagentStatusMeta, hasSessionStarted } from '../../lib/sessionStatus'
import { Button } from '../ui'

function SubagentLeaf({ agent, depth, sessionId, onViewTranscript }) {
  const [showTools, setShowTools] = useState(false)
  const hasTools = agent.tools && agent.tools.length > 0
  const statusMeta = getSubagentStatusMeta(agent.status)
  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 text-[11px] font-mono hover:bg-x-hover/60 rounded-sm cursor-pointer transition-colors"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => onViewTranscript?.(sessionId, agent.id)}
        title={`View ${agent.type} output`}
      >
        {hasTools ? (
          <button
            onClick={(e) => { e.stopPropagation(); setShowTools(!showTools) }}
            className="text-x-faint hover:text-x-ink-secondary"
          >
            {showTools ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        <Sparkles size={10} className="text-x-accent shrink-0" />
        <span className={`w-1 h-1 rounded-full shrink-0 ${statusMeta.dotClass}`} title={statusMeta.label} />
        <span className="text-x-ink-secondary shrink-0">{agent.type}</span>
        {hasTools && (
          <span className="text-[11px] text-x-faint">({agent.tools.length})</span>
        )}
        {agent.status === 'completed' && agent.result && (
          <span className="text-x-faint truncate flex-1 min-w-0 italic">
            → {agent.result}
          </span>
        )}
      </div>
      {showTools && hasTools && (
        <div>
          {agent.tools.map((t, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 py-0.5 text-[11px] font-mono text-x-faint"
              style={{ paddingLeft: `${(depth + 1) * 16 + 20}px` }}
            >
              <Circle size={5} className="text-x-line shrink-0" />
              <span className="text-x-ink-secondary">{t.tool}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentNode({ session, children, depth = 0, onSelect, onViewTranscript }) {
  const [expanded, setExpanded] = useState(true)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const subagentsMap = useStore((s) => s.subagents[session.id])
  const sessionStarted = useStore((s) => s.sessionStarted)
  const isActive = session.id === activeSessionId
  const subagents = subagentsMap ? Object.values(subagentsMap) : []
  const hasChildren = children.length > 0 || subagents.length > 0
  const runningCount = subagents.filter((a) => a.status === 'running').length

  return (
    <div>
      <Button type="submit"
        onClick={() => onSelect(session.id)}
        className={`w-full flex items-center gap-1.5 py-1.5 text-left transition-colors ${
          isActive ? 'bg-x-accent-subtle text-x-ink' : 'text-x-ink-secondary hover:bg-x-hover'
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            className="text-x-faint cursor-pointer"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        ) : (
          <Circle size={6} className="text-x-line ml-0.5 mr-0.5" />
        )}

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getSessionStatusMeta(session.status, session.agentState, hasSessionStarted(session, sessionStarted)).dotClass}`} />

        <Monitor size={10} className={session.session_type === 'commander' ? 'text-x-accent-ink' : 'text-x-faint'} />

        <span className="text-xs font-mono truncate flex-1">{session.name}</span>
        {runningCount > 0 && (
          <span className="text-[11px] font-mono text-x-good bg-x-good/10 px-1 rounded">
            {runningCount}
          </span>
        )}
        <span className="text-[11px] font-mono text-x-faint mr-2">{session.model}</span>
        {session.branch_label && (
          <span className="text-[11px] font-mono px-1 rounded border border-x-accent/30 text-x-accent bg-x-tint mr-2">
            {session.branch_label}
          </span>
        )}
      </Button>

      {expanded && (
        <div>
          {/* Child sessions (workers under a commander) */}
          {children.map((child) => (
            <AgentNode
              key={child.session.id}
              session={child.session}
              children={child.children}
              depth={depth + 1}
              onSelect={onSelect}
              onViewTranscript={onViewTranscript}
            />
          ))}
          {/* Internal sub-agents from CLI hooks */}
          {subagents.map((agent) => (
            <SubagentLeaf key={agent.id} agent={agent} depth={depth + 1} sessionId={session.id} onViewTranscript={onViewTranscript} />
          ))}
        </div>
      )}
    </div>
  )
}

function buildTree(sessions, workspaces) {
  const all = Object.values(sessions)
  const childMap = {}

  for (const s of all) {
    const pid = s.parent_session_id || 'root'
    if (!childMap[pid]) childMap[pid] = []
    childMap[pid].push(s)
  }

  function getChildren(parentId) {
    return (childMap[parentId] || []).map((s) => ({
      session: s,
      children: getChildren(s.id),
    }))
  }

  const roots = all.filter((s) => !s.parent_session_id)

  // Group roots by workspace, matching sidebar order
  const wsOrder = (workspaces || []).map((w) => w.id)
  const byWs = {}
  for (const s of roots) {
    const wid = s.workspace_id || '_none'
    if (!byWs[wid]) byWs[wid] = []
    byWs[wid].push(s)
  }
  for (const arr of Object.values(byWs)) {
    arr.sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
  }

  const groups = []
  const seen = new Set()
  for (const wid of wsOrder) {
    if (byWs[wid]) {
      const ws = (workspaces || []).find((w) => w.id === wid)
      groups.push({
        workspaceId: wid,
        workspaceName: ws?.name || wid.slice(0, 8),
        workspaceColor: ws?.color,
        nodes: byWs[wid].map((s) => ({ session: s, children: getChildren(s.id) })),
      })
      seen.add(wid)
    }
  }
  for (const [wid, arr] of Object.entries(byWs)) {
    if (!seen.has(wid)) {
      groups.push({
        workspaceId: wid,
        workspaceName: wid === '_none' ? 'No Workspace' : wid.slice(0, 8),
        nodes: arr.map((s) => ({ session: s, children: getChildren(s.id) })),
      })
    }
  }
  return groups
}

export default function SubagentTree({ onClose }) {
  const sessions = useStore((s) => s.sessions)
  const subagents = useStore((s) => s.subagents)
  const openTabs = useStore((s) => s.openTabs)
  const workspaces = useStore((s) => s.workspaces)
  const groups = buildTree(sessions, workspaces)

  const handleSelect = (sessionId) => {
    const store = useStore.getState()
    if (!openTabs.includes(sessionId)) {
      store.openSession(sessionId)
    } else {
      store.setActiveSession(sessionId)
    }
    onClose()
  }

  const handleViewTranscript = (sessionId, agentId) => {
    useStore.getState().setViewingSubagent(sessionId, agentId)
    onClose()
  }

  const allSessions = Object.values(sessions)
  const commanders = allSessions.filter((s) => s.session_type === 'commander')
  const workers = allSessions.filter((s) => s.session_type !== 'commander')
  const totalInternalAgents = Object.values(subagents).reduce(
    (sum, m) => sum + Object.keys(m).length,
    0
  )
  const runningInternal = Object.values(subagents).reduce(
    (sum, m) => sum + Object.values(m).filter((a) => a.status === 'running').length,
    0
  )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[560px] x-panel shadow-x-3 overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <GitBranch size={14} className="text-x-accent" />
          <span className="text-xs text-x-ink font-medium">Agent Tree</span>
          <span className="text-[11px] text-x-muted">
            {commanders.length} commander{commanders.length !== 1 ? 's' : ''} · {workers.length} worker{workers.length !== 1 ? 's' : ''}
            {totalInternalAgents > 0 && ` · ${totalInternalAgents} sub-agent${totalInternalAgents !== 1 ? 's' : ''}`}
            {runningInternal > 0 && (
              <span className="text-x-good ml-1">({runningInternal} running)</span>
            )}
          </span>
          <div className="flex-1" />
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]">
            <X size={15} />
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.workspaceId}>
                {groups.length > 1 && (
                  <div className="flex items-center gap-2 px-4 py-1.5 mt-1 border-t border-x-line-subtle first:border-t-0 first:mt-0">
                    {group.workspaceColor && (
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: group.workspaceColor }} />
                    )}
                    <span className="text-[11px] font-medium text-x-muted uppercase tracking-wider">{group.workspaceName}</span>
                  </div>
                )}
                {group.nodes.map((node) => (
                  <AgentNode
                    key={node.session.id}
                    session={node.session}
                    children={node.children}
                    onSelect={handleSelect}
                    onViewTranscript={handleViewTranscript}
                  />
                ))}
              </div>
            ))
          ) : (
            <div className="px-4 py-10 text-xs text-x-faint text-center">
              No sessions — create one to start
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
