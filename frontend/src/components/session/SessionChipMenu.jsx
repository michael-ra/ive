import { useCallback, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import useStore from '../../state/store'
import { ContextMenu } from '../shell/SessionContextMenu'

// Between 768 and 1679 px the tab strip is hidden, so the Session-view chips
// and the overview cell headers carry what the tabs offered there: drag to
// reorder (the overview grid follows openTabs order) and the tab context
// menu (rename, learn from this, close, delete) on right-click or "…".
const TAB_MIME = 'application/x-ive-session-tab'

function reorderOnto(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return
  const { openTabs, reorderTabs } = useStore.getState()
  const from = openTabs.indexOf(fromId)
  const to = openTabs.indexOf(toId)
  if (from < 0 || to < 0) return
  reorderTabs(from, to)
}

export default function useSessionChipMenu() {
  const [menu, setMenu] = useState(null)

  const openAt = useCallback((id, x, y) => {
    const session = useStore.getState().sessions[id]
    if (session) setMenu({ x, y, session })
  }, [])

  // Spread onto a chip or cell header: drag to reorder + right-click menu.
  const chipProps = useCallback((id) => ({
    draggable: true,
    'data-reorder-session': id,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(TAB_MIME, id)
    },
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(TAB_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      e.currentTarget.setAttribute('data-drop-target', 'true')
    },
    onDragLeave: (e) => e.currentTarget.removeAttribute('data-drop-target'),
    onDrop: (e) => {
      e.currentTarget.removeAttribute('data-drop-target')
      const from = e.dataTransfer.getData(TAB_MIME)
      if (!from) return
      e.preventDefault()
      e.stopPropagation()
      reorderOnto(from, id)
    },
    onContextMenu: (e) => {
      e.preventDefault()
      e.stopPropagation()
      openAt(id, e.clientX, e.clientY)
    },
  }), [openAt])

  // The visible "…" button for the same menu (touchpads, discoverability).
  const MenuButton = useCallback(({ id, name, className = '' }) => (
    <button
      type="button"
      className={`ive-session-menu-button ${className}`}
      aria-label={`More actions for ${name || 'session'}`}
      aria-haspopup="menu"
      title="Rename, learn from this, close, delete"
      onClick={(e) => {
        // Keep the click from reaching the menu's own window "click outside".
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        openAt(id, r.left, r.bottom + 4)
      }}
    >
      <MoreHorizontal size={14} aria-hidden="true" />
    </button>
  ), [openAt])

  const element = menu
    ? <ContextMenu x={menu.x} y={menu.y} session={menu.session} onClose={() => setMenu(null)} />
    : null

  return { chipProps, MenuButton, element }
}
