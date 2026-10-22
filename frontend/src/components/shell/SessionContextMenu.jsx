import { useEffect, useRef, useState } from 'react'
import { X, Pencil, Copy, CopyPlus, ClipboardCopy, Download, Trash2, Sparkles, FileText, Square, ExternalLink, Archive, ArchiveRestore } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { closeSession, deleteSessionWithConfirm } from '../../lib/sessionActions'
import { requestSessionRename } from '../../lib/sessionRename'
import useEscapeToClose from '../../hooks/useEscapeToClose'

// The session menu, in one place: the project tree (right-click or "…"),
// board tiles and cards (useSessionChipMenu). Open, Rename, Clone, Learn
// from this, Copy output / last message, Export, Summary, Close / Restore,
// Stop, Delete.

function clampTo(x, y, menuEl) {
  const pos = { left: x, top: y }
  if (!menuEl) return pos
  const rect = menuEl.getBoundingClientRect()
  if (rect.bottom > window.innerHeight) pos.top = Math.max(4, window.innerHeight - rect.height - 8)
  if (rect.right > window.innerWidth) pos.left = Math.max(4, window.innerWidth - rect.width - 8)
  return pos
}

function MenuShell({ x, y, onClose, children, summary }) {
  const menuRef = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const clickHandler = () => onClose()
    window.addEventListener('click', clickHandler)
    return () => window.removeEventListener('click', clickHandler)
  }, [onClose])
  useEscapeToClose(true, onClose)
  useEffect(() => { setPos(clampTo(x, y, menuRef.current)) }, [x, y])

  return (
    <div
      ref={menuRef}
      role="menu"
      data-session-menu=""
      data-ive-popover=""
      className="ive-session-context-menu x-panel scale-in"
      style={pos}
      onClick={(e) => e.stopPropagation()}
    >
      {summary && <div className="ive-session-context-summary">{summary}</div>}
      {children}
    </div>
  )
}

function MenuItems({ items }) {
  return items.map((item, i) => item === null
    ? <div key={`sep-${i}`} className="ive-session-context-sep" />
    : (
      <button key={item.label} type="button" role="menuitem" onClick={item.action} className={`ive-session-context-item${item.danger ? ' is-danger' : ''}`}>
        <item.icon size={12} aria-hidden="true" />
        {item.label}
      </button>
    ))
}

// Full menu of the project tree.
export default function SessionContextMenu({ x, y, session, onClose, onOpenSummary }) {
  const handleRename = () => { onClose(); requestSessionRename(session.id) }
  const handleCopyOutput = async () => {
    try {
      const data = await api.getSessionOutput(session.id, 200)
      await navigator.clipboard.writeText(data.output || data.text || '')
    } catch { /* silent */ }
    onClose()
  }
  const handleCopyMessages = async () => {
    try {
      const msgs = await api.getMessages(session.id)
      if (msgs.length > 0) await navigator.clipboard.writeText(msgs[msgs.length - 1].content || '')
    } catch { /* silent */ }
    onClose()
  }
  const handleStop = () => { useStore.getState().stopSession(session.id); onClose() }
  const handleOpen = () => { useStore.getState().openSession(session.id); onClose() }
  const handleExport = () => { window.open(`/api/sessions/${session.id}/export`, '_blank'); onClose() }
  const handleDelete = async () => { onClose(); await deleteSessionWithConfirm(session.id) }
  const handleArchive = async () => {
    onClose()
    if (!session.archived) { await closeSession(session.id); return }
    try {
      await api.updateSession(session.id, { archived: 0 })
      useStore.getState().setSessionArchived(session.id, 0)
      useStore.getState().openSession(session.id)
    } catch (err) {
      useStore.getState().addNotification({ type: 'warning', message: `Could not restore "${session.name}": ${err?.message || 'unknown error'}` })
    }
  }
  const handleOpenSummary = () => { onOpenSummary?.(session); onClose() }
  const handleClone = async () => {
    try {
      const cloned = await api.cloneSession(session.id)
      if (cloned?.id) {
        useStore.getState().loadSessions([cloned])
        useStore.getState().openSession(cloned.id)
      }
    } catch { /* silent */ }
    onClose()
  }
  const handleLearn = () => { onClose(); learnFrom(session) }

  const isRunning = session.status === 'running'
  const items = [
    { icon: ExternalLink, label: 'Open', action: handleOpen },
    { icon: Pencil, label: 'Rename', action: handleRename },
    { icon: CopyPlus, label: 'Clone', action: handleClone },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn },
    null,
    { icon: ClipboardCopy, label: 'Copy output', action: handleCopyOutput },
    { icon: Copy, label: 'Copy last message', action: handleCopyMessages },
    { icon: Download, label: 'Export', action: handleExport },
    null,
    ...(onOpenSummary ? [{ icon: FileText, label: 'Summary', action: handleOpenSummary }] : []),
    { icon: session.archived ? ArchiveRestore : Archive, label: session.archived ? 'Restore session' : 'Close session', action: handleArchive },
    null,
    ...(isRunning ? [{ icon: Square, label: 'Stop', action: handleStop }] : []),
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return <MenuShell x={x} y={y} onClose={onClose} summary={session.summary}><MenuItems items={items} /></MenuShell>
}

async function learnFrom(session) {
  try {
    const model = session.model ? `${session.cli_type || 'claude'}:${session.model}` : undefined
    const res = await api.distillSession(session.id, { type: 'guideline', model })
    if (res.error) useStore.getState().addNotification({ type: 'warning', message: `Could not learn from "${session.name}": ${res.error}` })
    else useStore.getState().addNotification({ type: 'info', message: `Learning from "${session.name}" in background...` })
  } catch (e) {
    useStore.getState().addNotification({ type: 'warning', message: `Could not learn from "${session.name}": ${e.message || 'unknown error'}` })
  }
}

// Short menu of tiles and chips (formerly SessionTabs.ContextMenu).
export function ContextMenu({ x, y, session, onClose }) {
  const handleRename = () => { onClose(); requestSessionRename(session.id) }
  const handleClone = async () => {
    const cloned = await api.cloneSession(session.id)
    useStore.getState().addSession(cloned)
    onClose()
  }
  const handleExport = () => { window.open(`/api/sessions/${session.id}/export`, '_blank'); onClose() }
  const handleDelete = async () => { onClose(); await deleteSessionWithConfirm(session.id) }
  const handleLearn = () => { onClose(); learnFrom(session) }

  const items = [
    { icon: Pencil, label: 'Rename', action: handleRename },
    { icon: Copy, label: 'Clone', action: handleClone },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn },
    { icon: Download, label: 'Export', action: handleExport },
    { icon: X, label: 'Close session', action: () => { onClose(); closeSession(session.id) } },
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return <MenuShell x={x} y={y} onClose={onClose}><MenuItems items={items} /></MenuShell>
}
