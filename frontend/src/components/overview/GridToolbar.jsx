import { useState } from 'react'
import { Globe, FolderOpen, LayoutGrid, Columns2, Rows2, Grid2x2, Sliders } from 'lucide-react'
import useStore from '../../state/store'
import useEscapeToClose from '../../hooks/useEscapeToClose'
import { IconButton } from '../ui'

const BUILTINS = [
  { id: 'equal', icon: Grid2x2, label: 'Equal grid' },
  { id: 'focusRight', icon: Columns2, label: 'Focus left · stack right' },
  { id: 'focusBottom', icon: Rows2, label: 'Focus top · stack bottom' },
]

// Grid-mode tools in the header: the scope (all projects / this project)
// and the layout menu (built-in layouts, custom templates, adjust grid).
export default function GridToolbar() {
  const tabScope = useStore((s) => s.tabScope)
  const setTabScope = useStore((s) => s.setTabScope)
  const gridLayout = useStore((s) => s.gridLayout)
  const gridTemplates = useStore((s) => s.gridTemplates)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)
  const gridAdjustMode = useStore((s) => s.gridAdjustMode)
  const [open, setOpen] = useState(false)
  useEscapeToClose(open, () => setOpen(false))

  const activeTpl = activeGridTemplateId ? gridTemplates.find((t) => t.id === activeGridTemplateId) : null
  const builtin = BUILTINS.find((b) => b.id === gridLayout) || BUILTINS[0]
  const Icon = activeTpl ? LayoutGrid : builtin.icon
  const currentLabel = activeTpl ? activeTpl.name : builtin.label

  return (
    <div className="ive-grid-toolbar" data-grid-toolbar="">
      <div className="ive-scope-toggle" role="group" aria-label="Session tab scope">
        <IconButton icon={Globe} label="Global Dashboard (All workspaces)" iconSize={15} data-chrome-button size="sm"
          onClick={() => setTabScope('project')} selected={tabScope === 'project'} aria-pressed={tabScope === 'project'} />
        <IconButton icon={FolderOpen} label="Workspace Dashboard (Active workspace only)" iconSize={15} data-chrome-button size="sm"
          onClick={() => setTabScope('workspace')} selected={tabScope === 'workspace'} aria-pressed={tabScope === 'workspace'} />
      </div>
      <div className="ive-grid-layout">
        <button
          type="button"
          data-chrome-button
          data-layout-trigger
          className="ive-header-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={`Layout: ${currentLabel} — click to choose`}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
        {open && (
          <div data-layout-menu data-ive-popover="" role="menu" className="ive-grid-layout-menu x-panel scale-in">
            <div className="t-label ive-grid-layout-title">Built-in</div>
            {BUILTINS.map((b) => {
              const BIcon = b.icon
              const isActive = !activeGridTemplateId && gridLayout === b.id
              return (
                <button key={b.id} type="button" role="menuitem" className={`ive-grid-layout-item${isActive ? ' is-active' : ''}`}
                  onClick={() => { useStore.getState().setGridLayout(b.id); setOpen(false) }}>
                  <BIcon size={12} aria-hidden="true" />
                  <span className="flex-1 truncate">{b.label}</span>
                  {isActive && <span aria-hidden="true">●</span>}
                </button>
              )
            })}
            {gridTemplates.length > 0 && (
              <>
                <div className="t-label ive-grid-layout-title">Custom templates</div>
                {gridTemplates.map((tpl) => {
                  const isActive = activeGridTemplateId === tpl.id
                  return (
                    <button key={tpl.id} type="button" role="menuitem" className={`ive-grid-layout-item${isActive ? ' is-active' : ''}`}
                      onClick={() => { useStore.getState().setActiveGridTemplateId(tpl.id); setOpen(false) }}>
                      <LayoutGrid size={12} aria-hidden="true" />
                      <span className="flex-1 truncate">{tpl.name}</span>
                      {isActive && <span aria-hidden="true">●</span>}
                    </button>
                  )
                })}
              </>
            )}
            <div className="ive-session-context-sep" />
            <button type="button" role="menuitem" className={`ive-grid-layout-item${gridAdjustMode ? ' is-active' : ''}`}
              onClick={() => { useStore.getState().setGridAdjustMode(!gridAdjustMode); setOpen(false) }}>
              <Sliders size={12} aria-hidden="true" />
              <span className="flex-1 truncate">Adjust grid</span>
            </button>
            <button type="button" role="menuitem" className="ive-grid-layout-item is-accent"
              onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('open-panel', { detail: 'grid-templates' })) }}>
              <span aria-hidden="true">+</span>
              <span className="flex-1 truncate">Manage templates...</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
