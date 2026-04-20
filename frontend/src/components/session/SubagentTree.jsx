import { useState } from 'react'
import { GitBranch, X, Monitor, ChevronDown, ChevronRight, Circle, Sparkles } from 'lucide-react'
import useStore from '../../state/store'

function SubagentLeaf({ agent, depth, sessionId, onViewTranscript }) {
  const [showTools, setShowTools] = useState(false)
  const hasTools = agent.tools && agent.tools.length > 0
  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 text-[11px] font-mono hover:bg-bg-hover/60 rounded-sm cursor-pointer transition-colors"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => onViewTranscript?.(sessionId, agent.id)}
        title={`View ${agent.type} output`}
      >
        {hasTools ? (
          <button
            onClick={(e) => { e.stopPropagation(); setShowTools(!showTools) }}
            className="text-text-faint hover:text-text-secondary"
          >
            {showTools ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : (
          <span className="w-[10px]" />
        )}
        <Sparkles size={10} className="text-purple-400 shrink-0" />
        <span className={`w-1 h-1 rounded-full shrink-0 ${
          agent.status === 'running' ? 'bg-green-400 animate-subtle-pulse' : 'bg-zinc-600'
        }`} />
        <span className="text-text-secondary shrink-0">{agent.type}</span>
        {hasTools && (
          <span className="text-[9px] text-text-faint">({agent.tools.length})</span>
        )}
        {agent.status === 'completed' && agent.result && (
          <span className="text-text-faint truncate flex-1 min-w-0 italic">
            → {agent.result}
          </span>
        )}
      </div>
      {showTools && hasTools && (
        <div>
          {agent.tools.map((t, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 py-0.5 text-[10px] font-mono text-text-faint"
              style={{ paddingLeft: `${(depth + 1) * 16 + 20}px` }}
            >
              <Circle size={5} className="text-border-primary shrink-0" />
              <span className="text-amber-300/80">{t.tool}</span>
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
  const isActive = session.id === activeSessionId
  const subagents = subagentsMap ? Object.values(subagentsMap) : []
  const hasChildren = children.length > 0 || subagents.length > 0
  const runningCount = subagents.filter((a) => a.status === 'running').length

  return (
    <div>
      <button
        onClick={() => onSelect(session.id)}
        className={`w-full flex items-center gap-1.5 py-1.5 text-left transition-colors rounded-md ${
          isActive ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            className="text-text-faint cursor-pointer"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        ) : (
          <Circle size={6} className="text-border-primary ml-0.5 mr-0.5" />
        )}

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          session.status === 'running' ? 'bg-green-400 animate-subtle-pulse' :
          session.status === 'exited' ? 'bg-yellow-400' : 'bg-zinc-700'
        }`} />

        <Monitor size={10} className={session.session_type === 'commander' ? 'text-amber-400' : 'text-text-faint'} />

        <span className="text-xs font-mono truncate flex-1">{session.name}</span>
        {runningCount > 0 && (
          <span className="text-[9px] font-mono text-green-400 bg-green-500/10 px-1 rounded">
            {runningCount}
          </span>
        )}
        <span className="text-[10px] font-mono text-text-faint mr-2">{session.model}</span>
        {session.branch_label && (
          <span className="text-[9px] font-mono px-1 rounded border border-purple-500/25 text-purple-400/80 bg-purple-500/10 mr-2">
            {session.branch_label}
          </span>
        )}
      </button>

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <GitBranch size={14} className="text-accent-primary" />
          <span className="text-xs text-text-primary font-medium">Agent Tree</span>
          <span className="text-[10px] text-text-faint">
            {commanders.length} commander{commanders.length !== 1 ? 's' : ''} · {workers.length} worker{workers.length !== 1 ? 's' : ''}
            {totalInternalAgents > 0 && ` · ${totalInternalAgents} sub-agent${totalInternalAgents !== 1 ? 's' : ''}`}
            {runningInternal > 0 && (
              <span className="text-green-400 ml-1">({runningInternal} running)</span>
            )}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.workspaceId}>
                {groups.length > 1 && (
                  <div className="flex items-center gap-2 px-4 py-1.5 mt-1 border-t border-border-secondary first:border-t-0 first:mt-0">
                    {group.workspaceColor && (
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: group.workspaceColor }} />
                    )}
                    <span className="text-[10px] font-medium text-text-faint uppercase tracking-wider">{group.workspaceName}</span>
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
            <div className="px-4 py-10 text-xs text-text-faint text-center">
              No sessions — create one to start
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
