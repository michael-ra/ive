import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Circle, AlertTriangle, Link2, Zap } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const NODE_W = 200
const NODE_H = 62
const LAYER_GAP = 270
const NODE_GAP = 22
const PAD = 60
const PORT_HIT = 18 // clickable area around port

const statusColor = {
  backlog: '#71717a',
  todo: '#a1a1aa',
  planning: '#fb923c',
  in_progress: '#818cf8',
  review: '#fbbf24',
  testing: '#22d3ee',
  documenting: '#a78bfa',
  done: '#4ade80',
  blocked: '#f87171',
}

const statusBg = {
  backlog: 'bg-zinc-800/60',
  todo: 'bg-zinc-800/80',
  planning: 'bg-orange-500/8',
  in_progress: 'bg-indigo-500/8',
  review: 'bg-amber-500/8',
  testing: 'bg-cyan-500/8',
  documenting: 'bg-purple-500/8',
  done: 'bg-green-500/8',
  blocked: 'bg-red-500/8',
}

const priorityBadge = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  normal: 'bg-zinc-700/40 text-zinc-500 border-zinc-600/30',
}

// Edge colors by dependency status
const EDGE_DONE = '#4ade80'       // green — dep satisfied
const EDGE_ACTIVE = '#818cf8'     // indigo — dep in progress
const EDGE_WAITING = '#52525b'    // zinc — dep not started
const EDGE_HOVER_DEL = '#ef4444'  // red — hover to delete
const EDGE_DRAG = '#22d3ee'       // cyan — creating new edge

function parseDeps(raw) {
  if (!raw || raw === '[]') return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw) } catch { return [] }
}

/** Topological layering via longest-path method */
function computeLayers(tasks) {
  const ids = new Set(tasks.map(t => t.id))
  const deps = {}
  const rdeps = {}

  for (const t of tasks) {
    const d = parseDeps(t.depends_on).filter(id => ids.has(id))
    deps[t.id] = d
    rdeps[t.id] = rdeps[t.id] || []
    for (const depId of d) {
      rdeps[depId] = rdeps[depId] || []
      rdeps[depId].push(t.id)
    }
  }

  const layers = {}
  const visited = new Set()
  const inStack = new Set()
  let hasCycle = false

  function dfs(id) {
    if (inStack.has(id)) { hasCycle = true; return 0 }
    if (visited.has(id)) return layers[id]
    inStack.add(id)
    let maxDepLayer = -1
    for (const depId of (deps[id] || [])) {
      maxDepLayer = Math.max(maxDepLayer, dfs(depId))
    }
    inStack.delete(id)
    visited.add(id)
    layers[id] = maxDepLayer + 1
    return layers[id]
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) dfs(t.id)
  }

  let maxLayer = 0
  for (const id in layers) maxLayer = Math.max(maxLayer, layers[id])

  return { layers, maxLayer, deps, rdeps, hasCycle }
}

/** Collect full upstream + downstream chain from a node */
function getChain(taskId, deps, rdeps) {
  const upstream = new Set()
  const downstream = new Set()
  const qu = [taskId]
  // Upstream: follow deps
  while (qu.length) {
    const id = qu.pop()
    for (const depId of (deps[id] || [])) {
      if (!upstream.has(depId)) { upstream.add(depId); qu.push(depId) }
    }
  }
  // Downstream: follow rdeps
  const qd = [taskId]
  while (qd.length) {
    const id = qd.pop()
    for (const rid of (rdeps[id] || [])) {
      if (!downstream.has(rid)) { downstream.add(rid); qd.push(rid) }
    }
  }
  return { upstream, downstream }
}

export default function DependencyGraph({ tasks, onTaskClick, workspaceId }) {
  const updateTaskInStore = useStore(s => s.updateTaskInStore)
  const allTasks = useStore(s => s.tasks)
  const workspaces = useStore(s => s.workspaces)
  const containerRef = useRef(null)

  // Edge creation drag
  const [dragEdge, setDragEdge] = useState(null)
  const justDraggedRef = useRef(false)
  const [hoverNodeId, setHoverNodeId] = useState(null)
  // Selected node for chain highlighting
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  // Hovered edge for deletion
  const [hoverEdge, setHoverEdge] = useState(null)

  // Pan + zoom
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const panRef = useRef(null)

  // Compute layout
  const layout = useMemo(() => {
    if (tasks.length === 0) return { nodes: [], edges: [], width: 400, height: 200, nodePos: {}, hasCycle: false, deps: {}, rdeps: {} }

    const { layers, maxLayer, deps, rdeps, hasCycle } = computeLayers(tasks)

    const layerGroups = {}
    for (const t of tasks) {
      const l = layers[t.id] ?? 0
      layerGroups[l] = layerGroups[l] || []
      layerGroups[l].push(t)
    }

    const statusOrder = { blocked: 0, backlog: 1, todo: 2, planning: 3, in_progress: 4, review: 5, testing: 6, documenting: 7, done: 8 }
    const prioOrder = { critical: 0, high: 1, normal: 2 }
    for (const l in layerGroups) {
      layerGroups[l].sort((a, b) => {
        const sa = statusOrder[a.status] ?? 1
        const sb = statusOrder[b.status] ?? 1
        if (sa !== sb) return sa - sb
        const pa = prioOrder[a.priority] ?? 2
        const pb = prioOrder[b.priority] ?? 2
        if (pa !== pb) return pa - pb
        return (a.title || '').localeCompare(b.title || '')
      })
    }

    const nodes = []
    let maxH = 0
    for (let l = 0; l <= maxLayer; l++) {
      const group = layerGroups[l] || []
      const x = PAD + l * LAYER_GAP
      group.forEach((t, i) => {
        const y = PAD + i * (NODE_H + NODE_GAP)
        nodes.push({ task: t, x, y, layer: l })
        maxH = Math.max(maxH, y + NODE_H)
      })
    }

    const nodePos = Object.fromEntries(nodes.map(n => [n.task.id, n]))
    const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]))

    const edges = []
    for (const t of tasks) {
      const depIds = parseDeps(t.depends_on).filter(id => nodePos[id])
      for (const depId of depIds) {
        const from = nodePos[depId]
        const to = nodePos[t.id]
        if (from && to) {
          // Edge color based on dependency task status
          const depTask = taskMap[depId]
          const depStatus = depTask?.status
          const isDone = depStatus === 'done' || depStatus === 'verified'
          const isActive = depStatus === 'in_progress' || depStatus === 'review' || depStatus === 'testing'
          edges.push({
            fromId: depId,
            toId: t.id,
            x1: from.x + NODE_W,
            y1: from.y + NODE_H / 2,
            x2: to.x,
            y2: to.y + NODE_H / 2,
            color: isDone ? EDGE_DONE : isActive ? EDGE_ACTIVE : EDGE_WAITING,
            satisfied: isDone,
          })
        }
      }
    }

    return {
      nodes,
      edges,
      width: Math.max(400, PAD * 2 + (maxLayer + 1) * LAYER_GAP),
      height: Math.max(200, maxH + PAD),
      nodePos,
      hasCycle,
      deps,
      rdeps,
    }
  }, [tasks])

  const { nodes, edges, width, height, nodePos, hasCycle, deps, rdeps } = layout

  // "Ready to start" detection: all deps done + task is backlog/todo
  const readyIds = useMemo(() => {
    const ready = new Set()
    for (const n of nodes) {
      const t = n.task
      if (t.status !== 'backlog' && t.status !== 'todo') continue
      const taskDeps = parseDeps(t.depends_on).filter(id => nodePos[id])
      if (taskDeps.length === 0) continue // no deps = not interesting for "ready"
      const allDone = taskDeps.every(id => {
        const dt = allTasks[id]
        return dt && (dt.status === 'done' || dt.status === 'verified')
      })
      if (allDone) ready.add(t.id)
    }
    return ready
  }, [nodes, nodePos, allTasks])

  // Chain highlight for selected node
  const chain = useMemo(() => {
    if (!selectedNodeId || !deps[selectedNodeId]) return null
    return getChain(selectedNodeId, deps, rdeps)
  }, [selectedNodeId, deps, rdeps])

  // Edge bezier path
  const edgePath = useCallback((x1, y1, x2, y2) => {
    const dx = Math.abs(x2 - x1)
    const cp = Math.max(60, dx * 0.4)
    return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`
  }, [])

  // --- Pan handlers ---
  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('[data-node]') || e.target.closest('[data-port]')) return
    e.preventDefault()
    panRef.current = { startX: e.clientX, startY: e.clientY, startTx: transform.x, startTy: transform.y }
  }, [transform])

  const handleMouseMove = useCallback((e) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.startX
      const dy = e.clientY - panRef.current.startY
      setTransform(t => ({ ...t, x: panRef.current.startTx + dx, y: panRef.current.startTy + dy }))
    }
    if (dragEdge) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        setDragEdge(d => ({
          ...d,
          mx: (e.clientX - rect.left - transform.x) / transform.scale,
          my: (e.clientY - rect.top - transform.y) / transform.scale,
        }))
      }
    }
  }, [dragEdge, transform])

  const handleMouseUp = useCallback(async () => {
    panRef.current = null

    if (dragEdge && hoverNodeId && hoverNodeId !== dragEdge.fromId) {
      justDraggedRef.current = true
      setTimeout(() => { justDraggedRef.current = false }, 50)

      const targetTask = allTasks[hoverNodeId]
      if (targetTask) {
        const currentDeps = parseDeps(targetTask.depends_on)
        if (!currentDeps.includes(dragEdge.fromId)) {
          const newDeps = [...currentDeps, dragEdge.fromId]
          updateTaskInStore({ ...targetTask, depends_on: newDeps })

          // Auto-enable workspace deps flag if needed
          const ws = workspaces.find(w => w.id === workspaceId)
          if (ws && !ws.task_dependencies_enabled) {
            try { await api.updateWorkspace(workspaceId, { task_dependencies_enabled: 1 }) } catch {}
          }

          try {
            await api.updateTask2(hoverNodeId, { depends_on: newDeps })
          } catch (err) {
            console.error('Failed to add dependency:', err)
            updateTaskInStore(targetTask)
          }
        }
      }
    } else if (dragEdge) {
      justDraggedRef.current = true
      setTimeout(() => { justDraggedRef.current = false }, 50)
    }
    setDragEdge(null)
  }, [dragEdge, hoverNodeId, allTasks, updateTaskInStore, workspaces, workspaceId])

  // Zoom with scroll
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.92 : 1.08
    setTransform(t => {
      const newScale = Math.max(0.2, Math.min(2.5, t.scale * delta))
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return { ...t, scale: newScale }
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      return {
        scale: newScale,
        x: mx - (mx - t.x) * (newScale / t.scale),
        y: my - (my - t.y) * (newScale / t.scale),
      }
    })
  }, [])

  // Port drag start
  const handlePortDown = useCallback((e, taskId) => {
    e.stopPropagation()
    e.preventDefault()
    const node = nodePos[taskId]
    if (!node) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setDragEdge({
      fromId: taskId,
      x1: node.x + NODE_W,
      y1: node.y + NODE_H / 2,
      mx: (e.clientX - rect.left - transform.x) / transform.scale,
      my: (e.clientY - rect.top - transform.y) / transform.scale,
    })
  }, [nodePos, transform])

  // Remove dependency
  const handleEdgeClick = useCallback(async (e, fromId, toId) => {
    e.stopPropagation()
    const targetTask = allTasks[toId]
    if (!targetTask) return
    const currentDeps = parseDeps(targetTask.depends_on)
    const newDeps = currentDeps.filter(id => id !== fromId)
    updateTaskInStore({ ...targetTask, depends_on: newDeps })
    try {
      await api.updateTask2(toId, { depends_on: newDeps })
    } catch (err) {
      console.error('Failed to remove dependency:', err)
      updateTaskInStore(targetTask)
    }
    setHoverEdge(null)
  }, [allTasks, updateTaskInStore])

  // Node click — select for chain highlight, or open detail
  const handleNodeClick = useCallback((e, task) => {
    e.stopPropagation()
    if (justDraggedRef.current) return // prevent click after drag-to-connect
    if (selectedNodeId === task.id) {
      // Second click on selected node → open detail
      setSelectedNodeId(null)
      onTaskClick?.(task)
    } else {
      // First click → select and highlight chain
      setSelectedNodeId(task.id)
    }
  }, [selectedNodeId, onTaskClick])

  // Double-click → open detail directly
  const handleNodeDblClick = useCallback((e, task) => {
    e.stopPropagation()
    setSelectedNodeId(null)
    onTaskClick?.(task)
  }, [onTaskClick])

  // Deselect when clicking background
  const handleBgClick = useCallback(() => {
    if (!panRef.current) setSelectedNodeId(null)
  }, [])

  // Wheel listener
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Fit-to-view on initial layout
  const fitView = useCallback(() => {
    const el = containerRef.current
    if (!el || nodes.length === 0) return
    const rect = el.getBoundingClientRect()
    const scaleX = (rect.width - 60) / width
    const scaleY = (rect.height - 60) / height
    const scale = Math.min(1, Math.min(scaleX, scaleY))
    setTransform({
      x: (rect.width - width * scale) / 2,
      y: (rect.height - height * scale) / 2,
      scale,
    })
  }, [nodes.length, width, height])

  useEffect(() => { fitView() }, [nodes.length > 0 ? `${width}:${height}` : ''])

  // Stats
  const connectedCount = nodes.filter(n => {
    const d = parseDeps(n.task.depends_on).some(id => nodePos[id])
    const hasDependents = edges.some(e => e.fromId === n.task.id)
    return d || hasDependents
  }).length

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600">
        <div className="text-center">
          <Link2 size={24} className="mx-auto mb-2 opacity-40" />
          <p className="text-[11px] font-mono">No tasks in this view</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-zinc-800/50 shrink-0">
        <span className="text-[10px] font-mono text-zinc-500">
          {connectedCount} connected
        </span>
        <span className="text-[10px] font-mono text-zinc-600">
          {nodes.length - connectedCount} standalone
        </span>
        {readyIds.size > 0 && (
          <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
            <Zap size={9} /> {readyIds.size} ready
          </span>
        )}
        {hasCycle && (
          <span className="flex items-center gap-1 text-[10px] font-mono text-amber-400">
            <AlertTriangle size={10} /> cycle detected
          </span>
        )}
        <div className="flex-1" />
        {/* Legend */}
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: EDGE_DONE }} /> done
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: EDGE_ACTIVE }} /> active
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: EDGE_WAITING }} /> waiting
          </span>
        </div>
        <button
          onClick={fitView}
          className="px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 bg-zinc-800 border border-zinc-700 rounded transition-colors"
        >
          fit
        </button>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing relative"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { panRef.current = null; setDragEdge(null) }}
        onClick={handleBgClick}
      >
        {/* Onboarding hint when no edges exist */}
        {edges.length === 0 && nodes.length > 1 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-zinc-900/90 border border-zinc-700/50 rounded-lg px-6 py-4 text-center backdrop-blur-sm">
              <Link2 size={20} className="mx-auto mb-2 text-indigo-400/60" />
              <p className="text-[11px] font-mono text-zinc-400 mb-1">
                No dependencies yet
              </p>
              <p className="text-[10px] font-mono text-zinc-600 max-w-[260px]">
                Drag from the <span className="text-indigo-400">dot</span> on any task's right edge to another task to create a dependency.
                Click a task to highlight its chain. Double-click to open details.
              </p>
            </div>
          </div>
        )}

        <div
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
            width,
            height,
            position: 'relative',
          }}
        >
          {/* SVG edges */}
          <svg
            width={width}
            height={height}
            className="absolute inset-0 pointer-events-none"
            style={{ overflow: 'visible' }}
          >
            <defs>
              <marker id="arrow-done" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={EDGE_DONE} opacity="0.7" />
              </marker>
              <marker id="arrow-active" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={EDGE_ACTIVE} opacity="0.7" />
              </marker>
              <marker id="arrow-waiting" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={EDGE_WAITING} opacity="0.7" />
              </marker>
              <marker id="arrow-delete" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={EDGE_HOVER_DEL} opacity="0.8" />
              </marker>
              <marker id="arrow-drag" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={EDGE_DRAG} opacity="0.8" />
              </marker>
            </defs>

            {edges.map(edge => {
              const key = `${edge.fromId}:${edge.toId}`
              const isHovered = hoverEdge === key
              // Dim edges not in selected chain
              const inChain = !selectedNodeId ||
                selectedNodeId === edge.fromId || selectedNodeId === edge.toId ||
                (chain && (chain.upstream.has(edge.fromId) || chain.downstream.has(edge.toId)) &&
                 (chain.upstream.has(edge.toId) || chain.downstream.has(edge.fromId) ||
                  edge.fromId === selectedNodeId || edge.toId === selectedNodeId))
              // More precise: edge is in chain if both endpoints are in chain+selected
              const chainNodes = chain ? new Set([selectedNodeId, ...chain.upstream, ...chain.downstream]) : null
              const edgeInChain = !chainNodes || (chainNodes.has(edge.fromId) && chainNodes.has(edge.toId))

              const displayColor = isHovered ? EDGE_HOVER_DEL : edge.color
              const markerKey = isHovered ? 'delete' : edge.satisfied ? 'done' : edge.color === EDGE_ACTIVE ? 'active' : 'waiting'

              return (
                <g key={key} opacity={edgeInChain ? 1 : 0.15}>
                  {/* Fat invisible hitbox */}
                  <path
                    d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth="20"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onMouseEnter={() => setHoverEdge(key)}
                    onMouseLeave={() => setHoverEdge(null)}
                    onClick={(ev) => handleEdgeClick(ev, edge.fromId, edge.toId)}
                  />
                  {/* Visible edge */}
                  <path
                    d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
                    fill="none"
                    stroke={displayColor}
                    strokeWidth={isHovered ? 2.5 : edge.satisfied ? 2 : 1.5}
                    strokeOpacity={isHovered ? 0.9 : 0.6}
                    markerEnd={`url(#arrow-${markerKey})`}
                    style={{ transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s' }}
                  />
                  {/* Delete X on hover */}
                  {isHovered && (
                    <g style={{ pointerEvents: 'none' }}>
                      <circle cx={(edge.x1 + edge.x2) / 2} cy={(edge.y1 + edge.y2) / 2} r="9" fill="#1c1c28" stroke={EDGE_HOVER_DEL} strokeWidth="1.5" />
                      <line x1={(edge.x1 + edge.x2) / 2 - 3} y1={(edge.y1 + edge.y2) / 2 - 3} x2={(edge.x1 + edge.x2) / 2 + 3} y2={(edge.y1 + edge.y2) / 2 + 3} stroke={EDGE_HOVER_DEL} strokeWidth="1.5" />
                      <line x1={(edge.x1 + edge.x2) / 2 + 3} y1={(edge.y1 + edge.y2) / 2 - 3} x2={(edge.x1 + edge.x2) / 2 - 3} y2={(edge.y1 + edge.y2) / 2 + 3} stroke={EDGE_HOVER_DEL} strokeWidth="1.5" />
                    </g>
                  )}
                </g>
              )
            })}

            {/* Drag preview */}
            {dragEdge && (
              <path
                d={edgePath(dragEdge.x1, dragEdge.y1, dragEdge.mx, dragEdge.my)}
                fill="none"
                stroke={hoverNodeId && hoverNodeId !== dragEdge.fromId ? EDGE_DRAG : '#6366f1'}
                strokeWidth="2"
                strokeDasharray={hoverNodeId && hoverNodeId !== dragEdge.fromId ? 'none' : '6 4'}
                strokeOpacity="0.7"
                markerEnd="url(#arrow-drag)"
              />
            )}
          </svg>

          {/* Nodes */}
          {nodes.map(n => {
            const t = n.task
            const color = statusColor[t.status] || statusColor.backlog
            const bg = statusBg[t.status] || statusBg.backlog
            const isDropTarget = dragEdge && hoverNodeId === t.id && dragEdge.fromId !== t.id
            const isDragSource = dragEdge?.fromId === t.id
            const isSelected = selectedNodeId === t.id
            const isReady = readyIds.has(t.id)

            // Dim nodes not in chain when a node is selected
            const chainNodes = chain ? new Set([selectedNodeId, ...chain.upstream, ...chain.downstream]) : null
            const inChain = !chainNodes || chainNodes.has(t.id)

            return (
              <div
                key={t.id}
                data-node={t.id}
                className={`absolute select-none ${bg} border rounded-lg transition-all cursor-pointer ${
                  isDropTarget
                    ? 'border-cyan-500 ring-1 ring-cyan-500/40 scale-[1.03]'
                    : isSelected
                      ? 'border-indigo-400 ring-1 ring-indigo-500/30'
                      : isDragSource
                        ? 'border-indigo-500/60 opacity-70'
                        : isReady
                          ? 'border-emerald-500/50 ring-1 ring-emerald-500/20'
                          : 'border-zinc-700/60 hover:border-zinc-500/60'
                }`}
                style={{
                  left: n.x,
                  top: n.y,
                  width: NODE_W,
                  height: NODE_H,
                  opacity: inChain ? 1 : 0.2,
                  transition: 'opacity 0.2s, border-color 0.15s, transform 0.15s',
                }}
                onClick={(e) => handleNodeClick(e, t)}
                onDoubleClick={(e) => handleNodeDblClick(e, t)}
                onMouseEnter={() => setHoverNodeId(t.id)}
                onMouseLeave={() => setHoverNodeId(null)}
              >
                {/* Status accent bar */}
                <div
                  className="absolute top-0 left-0 w-1 rounded-l-lg"
                  style={{ height: NODE_H, backgroundColor: color }}
                />

                {/* "Ready" glow indicator */}
                {isReady && (
                  <div className="absolute -top-0.5 -right-0.5">
                    <Zap size={10} className="text-emerald-400" fill="currentColor" />
                  </div>
                )}

                {/* Content */}
                <div className="flex flex-col justify-center h-full pl-3.5 pr-8 py-1.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Circle size={5} className="shrink-0 fill-current" style={{ color }} />
                    <span className="text-[10px] font-mono text-zinc-300 truncate leading-tight">
                      {t.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 pl-3.5">
                    <span className={`px-1 py-0 text-[8px] font-mono rounded border ${priorityBadge[t.priority] || priorityBadge.normal}`}>
                      {t.priority || 'normal'}
                    </span>
                    <span className="text-[8px] font-mono text-zinc-600">
                      {t.status?.replace('_', ' ')}
                    </span>
                    {isReady && (
                      <span className="text-[8px] font-mono text-emerald-400/80">ready</span>
                    )}
                  </div>
                </div>

                {/* Output port — generous hit area */}
                <div
                  data-port="out"
                  className="absolute top-1/2 -translate-y-1/2 cursor-crosshair group/port"
                  style={{ right: -(PORT_HIT / 2), width: PORT_HIT, height: PORT_HIT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseDown={(e) => handlePortDown(e, t.id)}
                >
                  <div className={`w-3 h-3 rounded-full border-2 transition-all ${
                    isDragSource
                      ? 'bg-indigo-500 border-indigo-400 scale-110'
                      : 'bg-zinc-800 border-zinc-600 group-hover/port:bg-indigo-500 group-hover/port:border-indigo-400 group-hover/port:scale-125'
                  }`} />
                </div>

                {/* Input port */}
                {parseDeps(t.depends_on).filter(id => nodePos[id]).length > 0 && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center"
                    style={{ left: -(PORT_HIT / 2), width: PORT_HIT, height: PORT_HIT }}
                  >
                    <div className="w-3 h-3 rounded-full bg-indigo-500/20 border-2 border-indigo-500/40" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
