import { useState, useEffect, useCallback, useRef } from 'react'
import { X, LayoutGrid, Plus, Layers, Search } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { matchesKey, formatKeyCombo } from '../../lib/keybindings'
import TaskCard from './TaskCard'
import TaskDetailModal from './TaskDetailModal'
import NewTaskForm from './NewTaskForm'
import usePanelCreate from '../../hooks/usePanelCreate'

const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To Do' },
  { key: 'planning', label: 'Planning', color: 'text-amber-400' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'testing', label: 'Testing' },
  { key: 'documenting', label: 'Docs' },
  { key: 'done', label: 'Done' },
]

const columnAccent = {
  backlog: 'text-zinc-500',
  todo: 'text-zinc-400',
  planning: 'text-orange-400',
  in_progress: 'text-indigo-400',
  review: 'text-amber-400',
  testing: 'text-cyan-400',
  documenting: 'text-purple-400',
  done: 'text-green-400',
}

export default function FeatureBoard({ onClose }) {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const tasks = useStore((s) => s.tasks)
  const loadTasks = useStore((s) => s.loadTasks)
  const updateTaskInStore = useStore((s) => s.updateTaskInStore)
  const removeTaskFromStore = useStore((s) => s.removeTaskFromStore)

  const [selectedTask, setSelectedTask] = useState(null)
  const [showNewTask, setShowNewTask] = useState(false)
  const [dragOverCol, setDragOverCol] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef(null)

  // Workspace tab: null = "All projects", or a specific workspace id.
  const [boardWsId, setBoardWsId] = useState(activeWorkspaceId)
  const isAllView = boardWsId === null

  // 2D keyboard focus within the kanban grid.
  const [focusCol, setFocusCol] = useState(-1)
  const [focusRow, setFocusRow] = useState(-1)
  // Focus zone: 'none' | 'tabs' | 'grid'
  const [focusZone, setFocusZone] = useState('none')
  const [focusTabIdx, setFocusTabIdx] = useState(-1)
  const boardRef = useRef(null)

  // ⌘= opens the new-task form. ⌘↵ submission lives inside NewTaskForm so it
  // only fires when the form is actually mounted.
  usePanelCreate({
    enabled: !selectedTask && !showNewTask,
    onAdd: () => setShowNewTask(true),
  })

  // Intercept Escape in capture phase so inner modals close before the board does
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (selectedTask) {
          e.stopImmediatePropagation()
          setSelectedTask(null)
        } else if (showNewTask) {
          e.stopImmediatePropagation()
          setShowNewTask(false)
        }
        // If neither is open, let App.jsx handle it (closes the board)
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => window.removeEventListener('keydown', handler, true)
  }, [selectedTask, showNewTask])

  // ── Data ──────────────────────────────────────────────────────────────────
  // Fetch ALL tasks on mount so the "All projects" tab and tab switching work
  // without extra API calls. loadTasks merges, so pre-existing tasks are kept.
  useEffect(() => {
    api.getTasks().then((result) => {
      const list = Array.isArray(result) ? result : result?.tasks || []
      loadTasks(list)
    })
  }, [loadTasks])

  // Workspace name lookup for the "All" view badge on cards.
  const wsMap = Object.fromEntries(workspaces.map((w) => [w.id, w.name]))

  // Filter tasks for the selected tab + search query.
  const query = searchQuery.toLowerCase().trim()
  const filteredTasks = Object.values(tasks).filter((t) => {
    if (!isAllView && t.workspace_id !== boardWsId) return false
    if (!query) return true
    const labels = Array.isArray(t.labels)
      ? t.labels.join(' ')
      : typeof t.labels === 'string' ? t.labels : ''
    return (
      (t.title || '').toLowerCase().includes(query) ||
      labels.toLowerCase().includes(query) ||
      String(t.priority || '').toLowerCase().includes(query) ||
      (t.assigned_session_name || '').toLowerCase().includes(query)
    )
  })

  const tasksByColumn = {}
  for (const col of COLUMNS) {
    tasksByColumn[col.key] = filteredTasks.filter((t) => t.status === col.key)
  }

  const totalCount = filteredTasks.length

  // The workspace used for creating new tasks: explicit tab, or fallback.
  const effectiveWsId = boardWsId || activeWorkspaceId || workspaces[0]?.id

  // ── Workspace tabs ────────────────────────────────────────────────────────
  // Tab order: [All, ...workspaces]  (null id = "All").
  const tabIds = [null, ...workspaces.map((w) => w.id)]

  const handleTabSwitch = useCallback(
    (id) => {
      setBoardWsId(id)
      setSearchQuery('')
      // Reset grid focus when switching boards so arrow keys start fresh.
      setFocusCol(-1)
      setFocusRow(-1)
    },
    []
  )

  // ── 2D Keyboard Navigation ───────────────────────────────────────────────
  useEffect(() => {
    if (selectedTask || showNewTask) return // let modals handle keys

    const handler = (e) => {
      const t = e.target
      const tag = t?.tagName?.toLowerCase()

      // "/" focuses search from anywhere (except inputs)
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && !t?.isContentEditable) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }

      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return

      // Workspace tab switching (default [ / ], configurable)
      const kb = useStore.getState().keybindings
      if (matchesKey(e, kb.boardTabPrev) || matchesKey(e, kb.boardTabNext)) {
        e.preventDefault()
        const curIdx = tabIds.indexOf(boardWsId)
        const next = matchesKey(e, kb.boardTabPrev)
          ? Math.max(0, curIdx - 1)
          : Math.min(tabIds.length - 1, curIdx + 1)
        handleTabSwitch(tabIds[next])
        setFocusZone('tabs')
        setFocusTabIdx(next)
        return
      }

      // ── Tabs zone navigation ──────────────────────────────────────────
      if (focusZone === 'tabs') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          setFocusTabIdx((i) => Math.max(0, i - 1))
          return
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          setFocusTabIdx((i) => Math.min(tabIds.length - 1, i + 1))
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          // Switch active tab to the focused one, then enter the grid
          handleTabSwitch(tabIds[focusTabIdx] ?? tabIds[0])
          setFocusZone('grid')
          setFocusCol((c) => (c < 0 ? 0 : c))
          setFocusRow(0)
          return
        }
        if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          const id = tabIds[focusTabIdx] ?? tabIds[0]
          handleTabSwitch(id)
          return
        }
        // ArrowUp from tabs → do nothing (already at top)
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          return
        }
      }

      // ── Grid zone navigation ──────────────────────────────────────────
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setFocusZone('grid')
        const nextCol = Math.min(COLUMNS.length - 1, (focusCol < 0 ? 0 : focusCol + 1))
        const nextColTasks = tasksByColumn[COLUMNS[nextCol]?.key] || []
        setFocusCol(nextCol)
        setFocusRow((r) => Math.min(r < 0 ? 0 : r, nextColTasks.length - 1))
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusZone('grid')
        const nextCol = Math.max(0, (focusCol < 0 ? 0 : focusCol - 1))
        const nextColTasks = tasksByColumn[COLUMNS[nextCol]?.key] || []
        setFocusCol(nextCol)
        setFocusRow((r) => Math.min(r < 0 ? 0 : r, nextColTasks.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (focusZone === 'none' || focusCol < 0) {
          setFocusZone('grid')
          setFocusCol(0)
          setFocusRow(0)
          return
        }
        const colTasks = tasksByColumn[COLUMNS[focusCol]?.key] || []
        setFocusZone('grid')
        setFocusRow((r) => Math.min(colTasks.length - 1, (r < 0 ? 0 : r + 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (focusZone === 'none' || focusCol < 0) {
          // Enter tabs zone
          const curIdx = tabIds.indexOf(boardWsId)
          setFocusZone('tabs')
          setFocusTabIdx(curIdx >= 0 ? curIdx : 0)
          return
        }
        if (focusRow <= 0) {
          // At top of grid → move focus to tabs
          const curIdx = tabIds.indexOf(boardWsId)
          setFocusZone('tabs')
          setFocusTabIdx(curIdx >= 0 ? curIdx : 0)
          setFocusRow(-1)
          return
        }
        setFocusRow((r) => Math.max(0, r - 1))
        return
      }

      // Home / End → first / last card in current column
      if (e.key === 'Home' && focusCol >= 0) {
        e.preventDefault()
        setFocusRow(0)
        return
      }
      if (e.key === 'End' && focusCol >= 0) {
        e.preventDefault()
        const colTasks = tasksByColumn[COLUMNS[focusCol]?.key] || []
        setFocusRow(colTasks.length - 1)
        return
      }

      // Enter → open focused task
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey) && focusCol >= 0 && focusRow >= 0) {
        e.preventDefault()
        const colTasks = tasksByColumn[COLUMNS[focusCol]?.key] || []
        const task = colTasks[focusRow]
        if (task) setSelectedTask(task)
        return
      }

      // ⌘⌫ / Delete → remove focused task
      if (
        focusCol >= 0 && focusRow >= 0 &&
        (e.key === 'Delete' || ((e.metaKey || e.ctrlKey) && e.key === 'Backspace'))
      ) {
        e.preventDefault()
        const colTasks = tasksByColumn[COLUMNS[focusCol]?.key] || []
        const task = colTasks[focusRow]
        if (task) handleTaskDelete(task.id)
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedTask, showNewTask, focusCol, focusRow, focusZone, focusTabIdx, boardWsId, tasksByColumn, tabIds, handleTabSwitch])

  // Keep the focused card or tab scrolled into view.
  useEffect(() => {
    if (focusZone === 'tabs' && focusTabIdx >= 0) {
      const el = boardRef.current?.querySelector(`[data-tab-idx="${focusTabIdx}"]`)
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    } else if (focusCol >= 0 && focusRow >= 0) {
      const el = boardRef.current?.querySelector(`[data-focus="${focusCol}-${focusRow}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusZone, focusTabIdx, focusCol, focusRow])

  // ── Drag handlers ─────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e, colKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverCol(colKey)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null)
  }, [])

  const handleDrop = useCallback(
    async (e, colKey) => {
      e.preventDefault()
      setDragOverCol(null)
      const taskId = e.dataTransfer.getData('text/plain')
      if (!taskId) return
      const task = tasks[taskId]
      if (!task || task.status === colKey) return

      // Optimistic update
      updateTaskInStore({ ...task, status: colKey })
      try {
        const updated = await api.updateTask2(taskId, { status: colKey })
        if (updated?.id) updateTaskInStore(updated)
      } catch {
        // Revert on error
        updateTaskInStore(task)
      }
    },
    [tasks, updateTaskInStore]
  )

  const handleTaskSave = async (updatedTask) => {
    const result = await api.updateTask2(updatedTask.id, updatedTask)
    if (result?.id) updateTaskInStore(result)
    else updateTaskInStore(updatedTask)
    setSelectedTask(null)
  }

  const handleTaskDelete = async (id) => {
    await api.deleteTask(id)
    removeTaskFromStore(id)
    setSelectedTask(null)
  }

  const handleTaskCreated = (task) => {
    if (task?.id) updateTaskInStore(task)
    setShowNewTask(false)
  }

  // Workspace stats
  const inProgress = tasksByColumn.in_progress?.length || 0
  const done = tasksByColumn.done?.length || 0

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-sm flex flex-col"
      data-board-overlay
      onClick={onClose}
    >
      <div
        ref={boardRef}
        className="flex-1 flex flex-col m-4 bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-5 py-3 border-b border-zinc-800 shrink-0">
          <LayoutGrid size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-200 font-mono font-semibold">Feature Board</span>
          <div className="flex-1" />
          <div className="relative flex items-center">
            <Search size={12} className="absolute left-2 text-zinc-600 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tasks…"
              className="w-48 pl-7 pr-7 py-1 text-[11px] font-mono bg-zinc-900/80 border border-zinc-700/50 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (searchQuery) {
                    setSearchQuery('')
                  } else {
                    searchRef.current?.blur()
                  }
                }
              }}
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); searchRef.current?.focus() }}
                className="absolute right-1.5 text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <span className="text-[11px] font-mono text-zinc-500">
            {totalCount} tasks
          </span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Workspace tabs */}
        <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-zinc-800/60 overflow-x-auto shrink-0">
          <span className="text-[10px] text-zinc-600 font-mono mr-1.5 shrink-0">
            <kbd className="text-zinc-700">{formatKeyCombo(useStore.getState().keybindings.boardTabPrev)}</kbd> <kbd className="text-zinc-700">{formatKeyCombo(useStore.getState().keybindings.boardTabNext)}</kbd>
          </span>
          {tabIds.map((id, idx) => {
            const isAll = id === null
            const ws = isAll ? null : workspaces.find((w) => w.id === id)
            const label = isAll ? 'All Projects' : (ws?.name || 'Unknown')
            const count = isAll
              ? Object.values(tasks).length
              : Object.values(tasks).filter((t) => t.workspace_id === id).length
            const isActive = boardWsId === id
            const isTabFocused = focusZone === 'tabs' && focusTabIdx === idx

            return (
              <button
                key={id ?? '__all'}
                data-tab-idx={idx}
                onClick={() => handleTabSwitch(id)}
                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono rounded transition-colors shrink-0 ${
                  isActive
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 border border-transparent'
                } ${isTabFocused ? 'ring-1 ring-indigo-400/60' : ''}`}
              >
                {isAll && <Layers size={10} />}
                {label}
                <span className={`text-[10px] ${isActive ? 'text-indigo-400/70' : 'text-zinc-700'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Columns */}
        <div className="flex-1 flex gap-1.5 p-4 overflow-x-auto min-h-0">
          {COLUMNS.map((col, colIdx) => {
            const colTasks = tasksByColumn[col.key] || []
            const isOver = dragOverCol === col.key
            const isColFocused = focusCol === colIdx

            return (
              <div
                key={col.key}
                className={`flex flex-col w-[240px] min-w-[240px] rounded-lg border transition-colors ${
                  isOver
                    ? 'border-indigo-500/50 bg-indigo-500/5'
                    : isColFocused
                      ? 'border-zinc-700 bg-[#111118]/50'
                      : 'border-zinc-800 bg-[#111118]/30'
                }`}
                onDragOver={(e) => handleDragOver(e, col.key)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.key)}
              >
                {/* Column header */}
                <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-zinc-800/50 shrink-0">
                  <span className={`text-[11px] font-mono font-semibold uppercase tracking-wider ${columnAccent[col.key]}`}>
                    {col.label}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-700">
                    {colTasks.length}
                  </span>
                  <div className="flex-1" />
                  {col.key === 'backlog' && (
                    <button
                      onClick={() => setShowNewTask(!showNewTask)}
                      className="text-zinc-600 hover:text-indigo-400 transition-colors"
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>

                {/* New task form (backlog only) */}
                {col.key === 'backlog' && showNewTask && (
                  <NewTaskForm
                    workspaceId={effectiveWsId}
                    onCreated={handleTaskCreated}
                    onClose={() => setShowNewTask(false)}
                  />
                )}

                {/* Cards */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {colTasks.map((task, rowIdx) => (
                    <div key={task.id} data-focus={`${colIdx}-${rowIdx}`}>
                      <TaskCard
                        task={task}
                        isFocused={focusCol === colIdx && focusRow === rowIdx}
                        workspaceName={isAllView ? wsMap[task.workspace_id] : undefined}
                        onClick={(t) => setSelectedTask(t)}
                      />
                    </div>
                  ))}
                  {colTasks.length === 0 && !showNewTask && (
                    <div className="text-center py-6 text-[11px] font-mono text-zinc-700">
                      no tasks
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-5 py-1.5 border-t border-zinc-800 shrink-0">
          <span className="text-[11px] font-mono text-zinc-600">
            {totalCount} total
          </span>
          <span className="text-[11px] font-mono text-indigo-400/70">
            {inProgress} in progress
          </span>
          <span className="text-[11px] font-mono text-green-400/70">
            {done} done
          </span>
          <span className="ml-auto text-[11px] font-mono text-zinc-700">
            {isAllView
              ? `${workspaces.length} workspaces`
              : workspaces.find((w) => w.id === boardWsId)?.path || ''}
          </span>
        </div>
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          workspaceId={selectedTask.workspace_id || effectiveWsId}
          commanderSessionId={
            Object.values(useStore.getState().sessions).find(
              (s) => s.workspace_id === (selectedTask.workspace_id || effectiveWsId) && s.session_type === 'commander'
            )?.id
          }
          onClose={() => setSelectedTask(null)}
          onSave={handleTaskSave}
          onDelete={handleTaskDelete}
        />
      )}
    </div>
  )
}
