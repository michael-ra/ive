import { useEffect, useRef } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import useStore from '../../state/store'
import { formatKeyCombo } from '../../lib/keybindings'
import './sidebar-toggle.css'

// Stays in the app bar when Sidebar unmounts, including on Home. The same
// store field is used by the existing configurable keyboard shortcut.
export default function SidebarToggle() {
  const visible = useStore((state) => state.sidebarVisible)
  const binding = useStore((state) => state.keybindings.sidebar)
  const button = useRef(null)
  const wasVisible = useRef(visible)
  const label = visible ? 'Hide sidebar' : 'Show sidebar'
  const Icon = visible ? PanelLeftClose : PanelLeftOpen

  useEffect(() => {
    // Hiding with the shortcut while a sidebar field is focused removes that
    // field. Give focus an accessible destination, without stealing it from
    // a surviving editor or chat input.
    if (wasVisible.current && !visible && document.activeElement === document.body) button.current?.focus()
    wasVisible.current = visible
  }, [visible])

  return (
    <div className="ive-sidebar-toggle-slot">
      <button ref={button} type="button" className="ive-sidebar-toggle" data-sidebar-toggle data-chrome-button
        aria-label={label} aria-expanded={visible}
        aria-controls={visible ? 'ive-project-sidebar' : undefined}
        title={`${label}${binding ? ` (${formatKeyCombo(binding)})` : ''}`}
        onClick={() => useStore.setState((state) => ({ sidebarVisible: !state.sidebarVisible }))}>
        <Icon size={18} aria-hidden="true" />
        <span>Sidebar</span>
      </button>
    </div>
  )
}
