import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookmarkPlus, ChevronRight, CircleHelp, Filter, GitBranch,
  Layers, LayoutGrid, Plus, Search, X,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { matchesKey } from '../../lib/keybindings'
import TaskCard from './TaskCard'
import TaskDetailModal from './TaskDetailModal'
import NewTaskForm from './NewTaskForm'
import DependencyGraph from './DependencyGraph'
import usePanelCreate from '../../hooks/usePanelCreate'
import {
  BOARD_PARK_DAYS,
  BOARD_STALE_DAYS,
  COLUMNS,
  columnAccent,
  needsAttentionReasons,
  parkTaskLabels,
  taskLabels,
} from '../../lib/boardColumns'

const FILTER_ALL = 'all'
const FILTER_ATTENTION = 'attention'
const ARCHIVE_UNDO_MS = 6500

function settingKey(workspaceId) {
  const scope = String(workspaceId || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '_')
  return `board_saved_filters_${scope}`.slice(0, 120)
}

function matchesText(task, query) {
  if (!query) return true
  const haystack = [
    task.title,
    task.description,
    task.priority,
    task.assigned_session_name,
    ...taskLabels(task),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query)
}

function taskPrompt(task) {
  const title = String(task?.title || '').trim()
  const description = String(task?.description || '').trim()
  return description ? `${title}\n\n${description}` : title
}

export default function FeatureBoard({ onClose, initialAction = null, onActionConsumed }) {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const tasks = useStore((state) => state.tasks)
  const sessions = useStore((state) => state.sessions)
  const loadTasks = useStore((state) => state.loadTasks)
  const updateTaskInStore = useStore((state) => state.updateTaskInStore)
  const removeTaskFromStore = useStore((state) => state.removeTaskFromStore)

  const [selectedTask, setSelectedTask] = useState(null)
  const [detailDirty, setDetailDirty] = useState(false)
  const [showNewTask, setShowNewTask] = useState(false)
  const [composerDirty, setComposerDirty] = useState(false)
  const [dragOverCol, setDragOverCol] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState('kanban')
  const [hoveredTaskId, setHoveredTaskId] = useState(null)
  const [smartFilter, setSmartFilter] = useState(FILTER_ALL)
  const [savedFilters, setSavedFilters] = useState([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [archiveUndo, setArchiveUndo] = useState(null)
  const [actionNote, setActionNote] = useState(null)
  const [boardWsId, setBoardWsId] = useState(activeWorkspaceId)
  const [focusCol, setFocusCol] = useState(-1)
  const [focusRow, setFocusRow] = useState(-1)
  const boardRef = useRef(null)
  const searchRef = useRef(null)
  const archiveTimerRef = useRef(null)
  const noteTimerRef = useRef(null)
  const consumedInitialAction = useRef(false)
  const isAllView = boardWsId === null

  const showNote = useCallback((text, tone = 'muted') => {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    setActionNote({ text, tone })
    noteTimerRef.current = setTimeout(() => setActionNote(null), 4500)
  }, [])

  useEffect(() => () => {
    if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current)
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
  }, [])

  useEffect(() => {
    boardRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    api.getTasks().then((result) => {
      const list = Array.isArray(result) ? result : result?.tasks || []
      loadTasks(list)
    }).catch(() => showNote('Could not refresh the board', 'error'))
  }, [loadTasks, showNote])

  useEffect(() => {
    let cancelled = false
    const key = settingKey(boardWsId)
    setSavedFilters([])
    api.getAppSetting(key).then((result) => {
      if (cancelled || !result?.value) return
      try {
        const parsed = JSON.parse(result.value)
        if (Array.isArray(parsed)) setSavedFilters(parsed.filter((item) => typeof item === 'string').slice(0, 8))
      } catch {}
    }).catch(() => {})
    return () => { cancelled = true }
  }, [boardWsId])

  useEffect(() => {
    if (consumedInitialAction.current || !initialAction) return
    consumedInitialAction.current = true
    if (initialAction === 'new') {
      setViewMode('kanban')
      setShowNewTask(true)
    } else if (initialAction === 'attention') {
      setViewMode('kanban')
      setSmartFilter(FILTER_ATTENTION)
    } else if (initialAction === 'filter') {
      requestAnimationFrame(() => searchRef.current?.focus())
    } else if (initialAction === 'shortcuts') {
      setShortcutsOpen(true)
    }
    onActionConsumed?.()
  }, [initialAction, onActionConsumed])

  usePanelCreate({
    enabled: !selectedTask && !showNewTask,
    onAdd: () => { setViewMode('kanban'); setShowNewTask(true) },
  })

  const wsMap = useMemo(
    () => Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces]
  )
  const attentionByTask = useMemo(() => {
    const map = {}
    for (const task of Object.values(tasks)) map[task.id] = needsAttentionReasons(task, sessions)
    return map
  }, [tasks, sessions])
  const workspaceTasks = useMemo(() => Object.values(tasks).filter((task) => {
    if (task.status === 'archived') return false
    return isAllView || task.workspace_id === boardWsId
  }), [tasks, isAllView, boardWsId])
  const attentionCount = useMemo(
    () => workspaceTasks.filter((task) => attentionByTask[task.id]?.length > 0).length,
    [workspaceTasks, attentionByTask]
  )
  const query = searchQuery.toLowerCase().trim()
  const filteredTasks = useMemo(() => workspaceTasks.filter((task) => {
    if (smartFilter === FILTER_ATTENTION && !attentionByTask[task.id]?.length) return false
    return matchesText(task, query)
  }), [workspaceTasks, smartFilter, attentionByTask, query])
  const tasksByColumn = useMemo(() => Object.fromEntries(
    COLUMNS.map((column) => [column.key, filteredTasks.filter((task) => task.status === column.key)])
  ), [filteredTasks])
  const totalCount = filteredTasks.length
  const effectiveWsId = boardWsId || activeWorkspaceId || workspaces[0]?.id
  const tabIds = useMemo(() => [null, ...workspaces.map((workspace) => workspace.id)], [workspaces])

  const cardPositions = useMemo(() => COLUMNS.flatMap((column, col) =>
    (tasksByColumn[column.key] || []).map((task, row) => ({ task, col, row }))
  ), [tasksByColumn])
  const focusedTask = focusCol >= 0 && focusRow >= 0
    ? tasksByColumn[COLUMNS[focusCol]?.key]?.[focusRow]
    : null

  const setTaskFocus = useCallback((task) => {
    const position = cardPositions.find((item) => item.task.id === task?.id)
    if (!position) return
    setFocusCol(position.col)
    setFocusRow(position.row)
  }, [cardPositions])

  const moveLinear = useCallback((delta) => {
    if (!cardPositions.length) return
    const current = cardPositions.findIndex((item) => item.col === focusCol && item.row === focusRow)
    const next = current < 0
      ? (delta < 0 ? cardPositions.length - 1 : 0)
      : Math.max(0, Math.min(cardPositions.length - 1, current + delta))
    setFocusCol(cardPositions[next].col)
    setFocusRow(cardPositions[next].row)
  }, [cardPositions, focusCol, focusRow])

  const moveHorizontal = useCallback((delta) => {
    if (!cardPositions.length) return
    if (focusCol < 0) {
      setFocusCol(cardPositions[0].col)
      setFocusRow(cardPositions[0].row)
      return
    }
    for (let col = focusCol + delta; col >= 0 && col < COLUMNS.length; col += delta) {
      const columnTasks = tasksByColumn[COLUMNS[col].key] || []
      if (columnTasks.length) {
        setFocusCol(col)
        setFocusRow(Math.min(Math.max(focusRow, 0), columnTasks.length - 1))
        return
      }
    }
  }, [cardPositions, focusCol, focusRow, tasksByColumn])

  useEffect(() => {
    if (focusCol < 0 || focusRow < 0) return
    const current = tasksByColumn[COLUMNS[focusCol]?.key]?.[focusRow]
    if (!current) {
      setFocusCol(-1)
      setFocusRow(-1)
    }
  }, [tasksByColumn, focusCol, focusRow])

  useEffect(() => {
    if (focusCol < 0 || focusRow < 0) return
    boardRef.current?.querySelector(`[data-focus="${focusCol}-${focusRow}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focusCol, focusRow])

  const closeComposer = useCallback(() => {
    if (composerDirty && !window.confirm('Discard new card title?')) return false
    setShowNewTask(false)
    setComposerDirty(false)
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
    return true
  }, [composerDirty])

  const requestBoardClose = useCallback(() => {
    if (showNewTask && !closeComposer()) return
    onClose?.()
  }, [showNewTask, closeComposer, onClose])

  const closeTaskDetail = useCallback(() => {
    if (detailDirty && !window.confirm('Discard unsaved card changes?')) return false
    setSelectedTask(null)
    setDetailDirty(false)
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
    return true
  }, [detailDirty])

  useEffect(() => {
    const handler = (event) => {
      if (event.key !== 'Escape') return
      if (searchRef.current === event.target) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (searchQuery) setSearchQuery('')
        else {
          searchRef.current?.blur()
          boardRef.current?.focus({ preventScroll: true })
        }
        return
      }
      if (editingTaskId) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setEditingTaskId(null)
        setEditingTitle('')
        requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
        return
      }
      if (showNewTask) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeComposer()
        return
      }
      if (shortcutsOpen) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setShortcutsOpen(false)
        return
      }
      if (selectedTask) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeTaskDetail()
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      requestBoardClose()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [searchQuery, editingTaskId, showNewTask, shortcutsOpen, selectedTask, closeComposer, closeTaskDetail, requestBoardClose])

  const optimisticUpdate = useCallback(async (task, patch, failureText) => {
    const before = task
    updateTaskInStore({ ...task, ...patch })
    try {
      const updated = await api.updateTask2(task.id, patch)
      if (updated?.id) updateTaskInStore(updated)
      return updated
    } catch (error) {
      updateTaskInStore(before)
      showNote(failureText || 'Change rolled back', 'error')
      throw error
    }
  }, [showNote, updateTaskInStore])

  const startTitleEdit = useCallback((task) => {
    if (!task) return
    setEditingTaskId(task.id)
    setEditingTitle(task.title || '')
  }, [])

  const commitTitleEdit = useCallback(async () => {
    const task = tasks[editingTaskId]
    const title = editingTitle.trim()
    if (!task || !title) return
    setEditingTaskId(null)
    setEditingTitle('')
    if (title === task.title) return
    try { await optimisticUpdate(task, { title }, 'Title change rolled back') } catch {}
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
  }, [editingTaskId, editingTitle, tasks, optimisticUpdate])

  const moveTask = useCallback(async (task, status) => {
    if (!task || task.status === status) return
    try { await optimisticUpdate(task, { status }, 'Move rolled back') } catch {}
  }, [optimisticUpdate])

  const archiveTask = useCallback(async (task) => {
    if (!task) return
    if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current)
    updateTaskInStore({ ...task, status: 'archived' })
    setArchiveUndo({ task })
    setFocusCol(-1)
    setFocusRow(-1)
    archiveTimerRef.current = setTimeout(() => setArchiveUndo(null), ARCHIVE_UNDO_MS)
    try {
      const updated = await api.updateTask2(task.id, { status: 'archived' })
      if (useStore.getState().tasks[task.id]?.status === 'archived' && updated?.id) updateTaskInStore(updated)
    } catch {
      if (useStore.getState().tasks[task.id]?.status === 'archived') updateTaskInStore(task)
      setArchiveUndo(null)
      showNote('Archive rolled back', 'error')
    }
  }, [showNote, updateTaskInStore])

  const undoArchive = useCallback(async () => {
    const task = archiveUndo?.task
    if (!task) return
    if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current)
    setArchiveUndo(null)
    updateTaskInStore(task)
    try {
      const updated = await api.updateTask2(task.id, { status: task.status })
      if (updated?.id) updateTaskInStore(updated)
      requestAnimationFrame(() => setTaskFocus(updated || task))
    } catch {
      updateTaskInStore({ ...task, status: 'archived' })
      showNote('Undo failed; card remains archived', 'error')
    }
  }, [archiveUndo, setTaskFocus, showNote, updateTaskInStore])

  const parkTask = useCallback(async (task) => {
    if (!task) return
    try {
      await optimisticUpdate(task, { labels: parkTaskLabels(task) }, 'Park change rolled back')
      showNote(`Parked for ${BOARD_PARK_DAYS} days`)
    } catch {}
  }, [optimisticUpdate, showNote])

  const routeToWorker = useCallback((task) => {
    const workspaceId = task?.workspace_id || activeWorkspaceId
    if (!task || !workspaceId) return
    useStore.setState({
      newSessionWorkspaceId: workspaceId,
      newSessionPrefillPurpose: taskPrompt(task),
      newSessionPrefillTaskId: task.id,
      newSessionPrefillName: String(task.title || '').slice(0, 60),
    })
    onClose?.()
  }, [activeWorkspaceId, onClose])

  const handleBoardKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return
    const target = event.target
    const tag = target?.tagName?.toLowerCase()
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable
    if (isField) return

    const keybindings = useStore.getState().keybindings
    if (matchesKey(event, keybindings.boardTabPrev) || matchesKey(event, keybindings.boardTabNext)) {
      event.preventDefault()
      const current = tabIds.indexOf(boardWsId)
      const delta = matchesKey(event, keybindings.boardTabPrev) ? -1 : 1
      const next = Math.max(0, Math.min(tabIds.length - 1, current + delta))
      setBoardWsId(tabIds[next])
      setSearchQuery('')
      setFocusCol(-1)
      setFocusRow(-1)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === '/') {
      event.preventDefault()
      searchRef.current?.focus()
    } else if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      event.preventDefault()
      setShortcutsOpen((open) => !open)
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      setViewMode('kanban')
      setShowNewTask(true)
    } else if (event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveLinear(1)
    } else if (event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveLinear(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveHorizontal(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveHorizontal(-1)
    } else if (event.key === 'Enter' && focusedTask) {
      event.preventDefault()
      setDetailDirty(false)
      setSelectedTask(focusedTask)
    } else if (event.key.toLowerCase() === 'e' && focusedTask) {
      event.preventDefault()
      startTitleEdit(focusedTask)
    } else if (event.key.toLowerCase() === 's' && focusedTask) {
      event.preventDefault()
      routeToWorker(focusedTask)
    } else if (event.key.toLowerCase() === 'x' && focusedTask) {
      event.preventDefault()
      archiveTask(focusedTask)
    } else if (event.key.toLowerCase() === 'p' && focusedTask && smartFilter === FILTER_ATTENTION) {
      event.preventDefault()
      parkTask(focusedTask)
    } else if (/^[1-9]$/.test(event.key) && focusedTask) {
      const column = COLUMNS[Number(event.key) - 1]
      if (column) {
        event.preventDefault()
        moveTask(focusedTask, column.key)
      }
    }
  }, [archiveTask, boardWsId, focusedTask, moveHorizontal, moveLinear, moveTask, parkTask, routeToWorker, smartFilter, startTitleEdit, tabIds])

  const persistSavedFilters = useCallback((next) => {
    setSavedFilters(next)
    api.setAppSetting(settingKey(boardWsId), JSON.stringify(next)).catch(() => showNote('Saved filters could not sync', 'error'))
  }, [boardWsId, showNote])

  const saveCurrentFilter = () => {
    const value = searchQuery.trim()
    if (!value || savedFilters.includes(value)) return
    persistSavedFilters([...savedFilters, value].slice(-8))
  }

  const removeSavedFilter = (value) => {
    persistSavedFilters(savedFilters.filter((item) => item !== value))
  }

  const getTaskDeps = useCallback((task) => {
    const raw = task?.depends_on
    if (!raw || raw === '[]') return []
    if (Array.isArray(raw)) return raw
    try { return JSON.parse(raw) } catch { return [] }
  }, [])
  const { hoveredTaskBlockers, hoveredTaskDependents } = useMemo(() => {
    if (!hoveredTaskId || !tasks[hoveredTaskId]) return { hoveredTaskBlockers: [], hoveredTaskDependents: [] }
    return {
      hoveredTaskBlockers: getTaskDeps(tasks[hoveredTaskId]),
      hoveredTaskDependents: Object.values(tasks).filter((task) => getTaskDeps(task).includes(hoveredTaskId)).map((task) => task.id),
    }
  }, [getTaskDeps, hoveredTaskId, tasks])

  const handleDrop = useCallback(async (event, columnKey) => {
    event.preventDefault()
    setDragOverCol(null)
    const task = tasks[event.dataTransfer.getData('text/plain')]
    if (task) await moveTask(task, columnKey)
  }, [moveTask, tasks])

  const handleTaskSave = async (updatedTask) => {
    const before = tasks[updatedTask.id] || updatedTask
    updateTaskInStore(updatedTask)
    setSelectedTask(null)
    setDetailDirty(false)
    try {
      const result = await api.updateTask2(updatedTask.id, updatedTask)
      if (result?.id) updateTaskInStore(result)
    } catch {
      updateTaskInStore(before)
      showNote('Card changes rolled back', 'error')
    }
  }

  const handleTaskDelete = async (id) => {
    await api.deleteTask(id)
    removeTaskFromStore(id)
    setSelectedTask(null)
    setDetailDirty(false)
  }

  const handleTaskCreated = (task) => {
    if (task?.id) updateTaskInStore(task)
    setShowNewTask(false)
    setComposerDirty(false)
    requestAnimationFrame(() => {
      boardRef.current?.focus({ preventScroll: true })
      if (task) setTaskFocus(task)
    })
  }

  const inProgress = tasksByColumn.in_progress?.length || 0
  const done = tasksByColumn.done?.length || 0

  return (
    <div className="x-board-overlay fixed inset-0 z-50 bg-x-scrim backdrop-blur-[4px] flex flex-col animate-in" data-board-overlay onClick={requestBoardClose}>
      <section
        ref={boardRef}
        tabIndex={-1}
        aria-label="Feature Board"
        data-testid="feature-board"
        className="x-board-surface flex-1 flex flex-col m-2 md:m-4 x-panel shadow-x-3 overflow-hidden min-w-0 scale-in focus:outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleBoardKeyDown}
      >
        <header className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-3 border-b border-x-line shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-lg bg-x-surface-2 border border-x-line flex items-center justify-center">
              <LayoutGrid size={13} className="text-x-muted" />
            </span>
            <span className="text-[13px] text-x-ink font-semibold">Feature Board</span>
          </div>
          <div className="flex-1 min-w-[1rem]" />

          <div className="relative flex items-center order-last w-full sm:order-none sm:w-auto">
            <Search size={12} className="absolute left-3 text-x-muted pointer-events-none" />
            <input
              ref={searchRef}
              data-testid="board-filter"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter cards…"
              aria-label="Filter board cards"
              className="w-full sm:w-56 h-8 pl-8 pr-16 text-[12px] bg-x-surface border border-x-line rounded-full text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            />
            {searchQuery && (
              <>
                <button onClick={saveCurrentFilter} aria-label="Save current filter" title="Save filter" className="absolute right-8 text-x-muted hover:text-x-ink">
                  <BookmarkPlus size={12} />
                </button>
                <button onClick={() => { setSearchQuery(''); searchRef.current?.focus() }} aria-label="Clear filter" className="absolute right-2 text-x-muted hover:text-x-ink">
                  <X size={12} />
                </button>
              </>
            )}
          </div>

          <div className="flex items-center bg-x-surface-2 p-0.5 rounded-full border border-x-line shrink-0">
            <button onClick={() => setViewMode('kanban')} className={`px-2.5 py-1 text-[11px] flex items-center gap-1 rounded-full ${viewMode === 'kanban' ? 'bg-x-surface text-x-ink' : 'text-x-muted hover:text-x-ink'}`}>
              <LayoutGrid size={10} /> board
            </button>
            <button onClick={() => setViewMode('graph')} className={`px-2.5 py-1 text-[11px] flex items-center gap-1 rounded-full ${viewMode === 'graph' ? 'bg-x-surface text-x-ink' : 'text-x-muted hover:text-x-ink'}`}>
              <GitBranch size={10} /> graph
            </button>
          </div>
          <button
            onClick={() => setShortcutsOpen((open) => !open)}
            aria-label="Board keyboard shortcuts"
            aria-expanded={shortcutsOpen}
            title="Board keyboard shortcuts (?)"
            className="h-8 w-8 rounded-lg border border-x-line bg-x-surface-2 text-x-muted hover:text-x-ink flex items-center justify-center"
          >
            <CircleHelp size={14} />
          </button>
          <button onClick={requestBoardClose} aria-label="Close Feature Board" className="h-8 w-8 rounded-lg text-x-muted hover:text-x-ink hover:bg-x-hover flex items-center justify-center">
            <X size={16} />
          </button>
        </header>

        <div className="x-entity-header px-5 md:px-7 py-4 shrink-0">
          <div className="x-entity-eyebrow">Projects <span>›</span> <strong>Feature Board</strong></div>
          <div className="x-entity-title-row">
            <div>
              <h1>Feature Board</h1>
              <p>A mirror of work already in motion — optional, immediate, and never a gate.</p>
            </div>
            <div className="x-entity-actions">
              <span className="x-pill font-mono">{totalCount} shown</span>
              <span className="x-pill x-pill-muted font-mono">{attentionCount} attention</span>
            </div>
          </div>
        </div>

        <nav className="flex items-center gap-1 px-4 md:px-5 py-2 border-b border-x-line overflow-x-auto shrink-0 tab-scroll-hide select-none" aria-label="Board workspace">
          <div className="flex gap-1.5">
            {tabIds.map((id) => {
              const isAll = id === null
              const workspace = isAll ? null : workspaces.find((item) => item.id === id)
              const count = isAll ? Object.values(tasks).filter((task) => task.status !== 'archived').length : Object.values(tasks).filter((task) => task.workspace_id === id && task.status !== 'archived').length
              const active = boardWsId === id
              return (
                <button
                  key={id ?? '__all'}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => { setBoardWsId(id); setSearchQuery(''); setFocusCol(-1); setFocusRow(-1) }}
                  className={`flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-full border shrink-0 ${active ? 'bg-x-surface-2 border-x-line-strong text-x-ink' : 'border-transparent text-x-muted hover:text-x-ink hover:bg-x-hover'}`}
                >
                  {isAll && <Layers size={10} />}
                  <span>{isAll ? 'All Projects' : workspace?.name || 'Unknown'}</span>
                  <span className="text-[10px] font-mono text-x-muted">({count})</span>
                </button>
              )
            })}
          </div>
        </nav>

        <div className="flex flex-wrap items-center gap-1.5 px-4 md:px-5 py-2 border-b border-x-line bg-x-surface shrink-0" data-testid="board-filter-chips">
          <button
            onClick={() => setSmartFilter(FILTER_ALL)}
            className={`x-pill min-h-6 px-2.5 text-[11px] ${smartFilter === FILTER_ALL ? 'border-x-line-strong text-x-ink' : 'text-x-muted'}`}
          >
            All
          </button>
          <button
            data-testid="needs-attention-filter"
            onClick={() => { setSmartFilter((current) => current === FILTER_ATTENTION ? FILTER_ALL : FILTER_ATTENTION); setViewMode('kanban') }}
            className={`x-pill min-h-6 px-2.5 text-[11px] gap-1.5 ${smartFilter === FILTER_ATTENTION ? 'border-x-line-strong text-x-ink bg-x-surface-2' : 'text-x-muted'}`}
          >
            <Filter size={10} /> Needs attention <span className="font-mono">({attentionCount})</span>
          </button>
          {savedFilters.map((filter) => (
            <span key={filter} className="inline-flex items-stretch rounded-full border border-x-line bg-x-surface-2 overflow-hidden">
              <button onClick={() => { setSearchQuery(filter); setSmartFilter(FILTER_ALL); setViewMode('kanban') }} className="pl-2.5 pr-1.5 py-1 text-[11px] text-x-muted hover:text-x-ink">
                {filter}
              </button>
              <button onClick={() => removeSavedFilter(filter)} aria-label={`Remove saved filter ${filter}`} className="pl-1 pr-2 py-1 text-x-muted hover:text-x-ink">
                <X size={10} />
              </button>
            </span>
          ))}
          {archiveUndo && (
            <span data-testid="board-archive-undo" className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-x-muted font-mono">
              Archived “{archiveUndo.task.title}” · <button onClick={undoArchive} className="text-x-ink hover:text-x-accent-ink font-semibold">Undo</button>
            </span>
          )}
          {!archiveUndo && actionNote && (
            <span className={`ml-auto text-[11px] font-mono ${actionNote.tone === 'error' ? 'text-x-accent-ink' : 'text-x-muted'}`} role="status">
              {actionNote.text}
            </span>
          )}
        </div>

        {shortcutsOpen && (
          <div data-testid="board-shortcuts" className="px-5 py-3 border-b border-x-line bg-x-surface-2 shrink-0">
            <div className="flex items-center gap-2 text-[11px] text-x-muted font-mono flex-wrap">
              {[
                ['j / k / arrows', 'move'], ['enter', 'open'], ['e', 'edit title'], ['s', 'route worker'],
                ['x', 'archive'], ['p', 'park in triage'], ['1–9', 'move column'], ['n', 'new card'],
                ['/', 'filter'], ['?', 'keys'], ['esc', 'cancel'],
              ].map(([key, label]) => (
                <span key={key} className="inline-flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded border border-x-line bg-x-surface text-x-ink-secondary">{key}</kbd>
                  <span>{label}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {viewMode === 'kanban' ? (
          <div className="flex-1 flex gap-3 p-3 md:p-5 overflow-x-auto min-h-0" data-testid="board-columns">
            {COLUMNS.map((column, colIdx) => {
              const columnTasks = tasksByColumn[column.key] || []
              const isOver = dragOverCol === column.key
              return (
                <section
                  key={column.key}
                  data-column={column.key}
                  className={`flex flex-col w-[82vw] min-w-[82vw] sm:w-[260px] sm:min-w-[260px] rounded-xl border overflow-hidden transition-colors duration-[80ms] ${isOver ? 'border-x-line-strong bg-x-hover' : 'border-x-line bg-x-surface'}`}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverCol(column.key) }}
                  onDragLeave={() => setDragOverCol(null)}
                  onDrop={(event) => handleDrop(event, column.key)}
                >
                  <header className="flex items-center gap-2 px-3 py-2.5 border-b border-x-line bg-x-surface shrink-0 select-none">
                    <span className={`text-[11px] font-mono uppercase tracking-[0.06em] ${columnAccent[column.key]}`}>{column.label}</span>
                    <span className="text-[10px] font-mono text-x-muted">({columnTasks.length})</span>
                    <span className="flex-1" />
                    {column.key === 'backlog' && (
                      <button
                        onClick={() => { if (showNewTask) closeComposer(); else setShowNewTask(true) }}
                        aria-label="Add card"
                        title="Add card (n)"
                        className="w-6 h-6 rounded-full bg-x-accent text-x-on-accent flex items-center justify-center hover:bg-x-accent-ink transition-colors duration-[80ms]"
                      >
                        <Plus size={13} />
                      </button>
                    )}
                  </header>

                  {column.key === 'backlog' && showNewTask && (
                    <NewTaskForm
                      workspaceId={effectiveWsId}
                      onCreated={handleTaskCreated}
                      onClose={closeComposer}
                      onDirtyChange={setComposerDirty}
                    />
                  )}

                  <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
                    {columnTasks.map((task, rowIdx) => {
                      const relState = hoveredTaskId
                        ? task.id === hoveredTaskId ? 'hovered'
                          : hoveredTaskBlockers.includes(task.id) ? 'blocker'
                            : hoveredTaskDependents.includes(task.id) ? 'dependent' : 'unrelated'
                        : null
                      return (
                        <div key={task.id} data-focus={`${colIdx}-${rowIdx}`}>
                          <TaskCard
                            task={task}
                            onStart={routeToWorker}
                            isFocused={focusCol === colIdx && focusRow === rowIdx}
                            workspaceName={isAllView ? wsMap[task.workspace_id] : undefined}
                            onClick={(clicked) => { setTaskFocus(clicked); setDetailDirty(false); setSelectedTask(clicked) }}
                            relState={relState}
                            onMouseEnter={() => setHoveredTaskId(task.id)}
                            onMouseLeave={() => setHoveredTaskId(null)}
                            isEditing={editingTaskId === task.id}
                            editValue={editingTitle}
                            onEditChange={setEditingTitle}
                            onEditCommit={commitTitleEdit}
                            onEditCancel={() => { setEditingTaskId(null); setEditingTitle(''); boardRef.current?.focus({ preventScroll: true }) }}
                            attentionReasons={smartFilter === FILTER_ATTENTION ? attentionByTask[task.id] : []}
                          />
                        </div>
                      )
                    })}
                    {columnTasks.length === 0 && !(column.key === 'backlog' && showNewTask) && (
                      <div className="text-center py-8 text-[11px] font-mono text-x-faint">no cards</div>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <DependencyGraph tasks={filteredTasks} onTaskClick={(task) => { setDetailDirty(false); setSelectedTask(task) }} workspaceId={effectiveWsId} />
        )}

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 md:px-6 pr-20 md:pr-24 py-2 border-t border-x-line shrink-0 select-none text-[10px] font-mono text-x-muted">
          <span>{totalCount} total</span>
          <span>{inProgress} in progress</span>
          <span className="text-x-good">{done} done</span>
          <span className="ml-auto inline-flex items-center gap-1 truncate max-w-full">
            <ChevronRight size={10} /> {isAllView ? `${workspaces.length} workspaces` : workspaces.find((workspace) => workspace.id === boardWsId)?.path || ''}
          </span>
        </footer>
      </section>

      {selectedTask && (
        <TaskDetailModal
          task={tasks[selectedTask.id] || selectedTask}
          workspaceId={selectedTask.workspace_id || effectiveWsId}
          commanderSessionId={(() => {
            const matches = Object.values(sessions).filter((session) => session.workspace_id === (selectedTask.workspace_id || effectiveWsId) && session.session_type === 'commander')
            return (matches.find((session) => session.status !== 'exited') || matches[0])?.id
          })()}
          onClose={closeTaskDetail}
          onDirtyChange={setDetailDirty}
          onCloseBoard={onClose}
          onSave={handleTaskSave}
          onDelete={handleTaskDelete}
        />
      )}
    </div>
  )
}
