import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Trash2, LayoutGrid, Check, GripVertical } from 'lucide-react'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

/**
 * Visual editor for custom grid layouts.
 *
 * A template is { id, name, cols, cells: [{ id, col, row, colSpan, rowSpan }] }.
 * Cells are placed explicitly via CSS Grid, so two cells with the same row/col will overlap.
 * The user is responsible for laying them out without conflicts; a tiny live preview shows
 * the result so they can spot mistakes immediately.
 *
 * Once saved, the template appears in the layout dropdown in SessionTabs and can be activated
 * for the grid view. Sessions are then drag-dropped onto cells from the sidebar or tabs.
 */
export default function GridTemplateEditor({ onClose }) {
  const gridTemplates = useStore((s) => s.gridTemplates)
  const addGridTemplate = useStore((s) => s.addGridTemplate)
  const updateGridTemplate = useStore((s) => s.updateGridTemplate)
  const removeGridTemplate = useStore((s) => s.removeGridTemplate)
  const setActiveGridTemplateId = useStore((s) => s.setActiveGridTemplateId)
  const activeGridTemplateId = useStore((s) => s.activeGridTemplateId)

  const [editing, setEditing] = useState(null) // null = list view, otherwise the template being edited
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const listRef = useRef(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  useListKeyboardNav({
    enabled: !editing,
    itemCount: gridTemplates.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const tpl = gridTemplates[idx]
      if (tpl) startEdit(tpl)
    },
    onDelete: (idx) => {
      const tpl = gridTemplates[idx]
      if (tpl && confirm(`Delete template "${tpl.name}"?`)) removeGridTemplate(tpl.id)
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const startNew = () => {
    setEditing({
      id: crypto.randomUUID(),
      name: 'New layout',
      cols: 3,
      cells: [
        { id: crypto.randomUUID(), col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { id: crypto.randomUUID(), col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { id: crypto.randomUUID(), col: 3, row: 2, colSpan: 1, rowSpan: 1 },
      ],
      cell_assignments: {},
      _isNew: true,
    })
  }

  const startEdit = (tpl) =>
    setEditing({
      ...tpl,
      cells: tpl.cells.map((c) => ({ ...c })),
      cell_assignments: { ...(tpl.cell_assignments || {}) },
    })

  const saveEditing = async () => {
    if (!editing) return
    const { _isNew, ...clean } = editing
    if (_isNew) await addGridTemplate(clean)
    else await updateGridTemplate(clean.id, clean)
    setEditing(null)
  }

  const updateCell = (cellId, patch) => {
    setEditing((e) => ({
      ...e,
      cells: e.cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c)),
    }))
  }

  const addCell = () => {
    setEditing((e) => ({
      ...e,
      cells: [...e.cells, { id: crypto.randomUUID(), col: 1, row: 1, colSpan: 1, rowSpan: 1 }],
    }))
  }

  const removeCell = (cellId) => {
    setEditing((e) => ({ ...e, cells: e.cells.filter((c) => c.id !== cellId) }))
  }

  // Compute the total rows used by the template so the preview height makes sense.
  const totalRowsOf = (tpl) =>
    Math.max(1, ...tpl.cells.map((c) => (c.row || 1) + (c.rowSpan || 1) - 1))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[640px] max-h-[80vh] ide-panel overflow-hidden flex flex-col scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary shrink-0">
          <LayoutGrid size={14} className="text-indigo-400" />
          <span className="text-xs text-text-primary font-medium">
            {editing ? (editing._isNew ? 'New layout template' : `Edit: ${editing.name}`) : 'Grid layout templates'}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {!editing ? (
          /* ─── List view ─── */
          <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
            {gridTemplates.length === 0 && (
              <div className="text-center py-8 text-text-faint text-xs">
                No custom templates yet. Click <span className="text-text-secondary font-medium">+ New template</span> to create one.
              </div>
            )}
            {gridTemplates.map((tpl, idx) => {
              const rows = totalRowsOf(tpl)
              return (
                <div
                  key={tpl.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`group flex items-center gap-3 p-2.5 border rounded-md transition-colors cursor-pointer ${
                    selectedIdx === idx
                      ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40 border-accent-primary/30'
                      : 'bg-bg-tertiary/40 hover:bg-bg-hover border-border-secondary'
                  }`}
                >
                  {/* Mini preview */}
                  <div
                    className="grid gap-0.5 shrink-0 bg-bg-inset rounded"
                    style={{
                      width: 64,
                      height: 40,
                      gridTemplateColumns: `repeat(${tpl.cols}, 1fr)`,
                      gridTemplateRows: `repeat(${rows}, 1fr)`,
                      padding: 2,
                    }}
                  >
                    {tpl.cells.map((c) => (
                      <div
                        key={c.id}
                        className="bg-indigo-500/40 border border-indigo-400/60 rounded-sm"
                        style={{
                          gridColumn: `${c.col} / span ${c.colSpan}`,
                          gridRow: `${c.row} / span ${c.rowSpan}`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-primary font-medium truncate">{tpl.name}</div>
                    <div className="text-[10px] text-text-faint font-mono">
                      {tpl.cols} cols × {rows} rows · {tpl.cells.length} cells
                    </div>
                  </div>
                  {activeGridTemplateId === tpl.id && (
                    <span className="text-[9px] text-emerald-400 font-mono uppercase tracking-wider">active</span>
                  )}
                  <button
                    onClick={() => setActiveGridTemplateId(activeGridTemplateId === tpl.id ? null : tpl.id)}
                    className="px-2 py-1 text-[10px] font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded transition-colors"
                  >
                    {activeGridTemplateId === tpl.id ? 'deactivate' : 'use'}
                  </button>
                  <button
                    onClick={() => startEdit(tpl)}
                    className="px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete template "${tpl.name}"?`)) removeGridTemplate(tpl.id)
                    }}
                    className="p-1 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )
            })}
            <button
              onClick={startNew}
              className="w-full mt-2 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors"
            >
              <Plus size={12} /> New template
            </button>
          </div>
        ) : (
          /* ─── Edit view ─── */
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 block">Name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing((tpl) => ({ ...tpl, name: e.target.value }))}
                className="w-full px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary focus:outline-none focus:border-accent-primary/50 ide-focus-ring"
                autoFocus
              />
            </div>

            <div>
              <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 block">Columns</label>
              <input
                type="number"
                min={1}
                max={6}
                value={editing.cols}
                onChange={(e) => setEditing((tpl) => ({ ...tpl, cols: Math.max(1, Math.min(6, parseInt(e.target.value) || 1)) }))}
                className="w-20 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary focus:outline-none focus:border-accent-primary/50 ide-focus-ring font-mono"
              />
            </div>

            {/* Live preview — drag cells to reposition */}
            <div>
              <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 block">Preview <span className="text-text-faint/60 normal-case font-normal">— drag cells to move</span></label>
              <PreviewGrid editing={editing} updateCell={updateCell} />
            </div>

            {/* Cells list */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider">Cells</label>
                <button
                  onClick={addCell}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded transition-colors"
                >
                  <Plus size={10} /> add cell
                </button>
              </div>
              <CellsList editing={editing} updateCell={updateCell} removeCell={removeCell} />
            </div>

            <div className="flex gap-1.5 pt-2 border-t border-border-secondary">
              <button
                onClick={saveEditing}
                disabled={!editing.name.trim() || editing.cells.length === 0}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-accent-primary hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md transition-colors"
              >
                <Check size={12} /> Save template
              </button>
              <button
                onClick={() => setEditing(null)}
                className="px-3 py-2 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Drag-and-drop grid preview. Renders invisible drop-target cells behind the
 *  real cells so the user can drag a cell to a new grid position. */
function PreviewGrid({ editing, updateCell }) {
  const [dragId, setDragId] = useState(null)
  const [dropTarget, setDropTarget] = useState(null) // { col, row }
  const gridRef = useRef(null)

  const totalRows = Math.max(1, ...editing.cells.map((c) => (c.row || 1) + (c.rowSpan || 1) - 1))

  // Build a set of all possible grid slots for drop targets
  const slots = []
  for (let r = 1; r <= totalRows; r++) {
    for (let c = 1; c <= editing.cols; c++) {
      slots.push({ col: c, row: r })
    }
  }

  const handleDrop = useCallback((col, row) => {
    if (!dragId) return
    updateCell(dragId, { col, row })
    setDragId(null)
    setDropTarget(null)
  }, [dragId, updateCell])

  return (
    <div className="relative">
      {/* Invisible drop-target grid behind the cells */}
      <div
        ref={gridRef}
        className="grid gap-1 bg-bg-inset rounded p-1 border border-border-secondary"
        style={{
          height: 140,
          gridTemplateColumns: `repeat(${editing.cols}, 1fr)`,
          gridTemplateRows: `repeat(${totalRows}, 1fr)`,
        }}
      >
        {slots.map(({ col, row }) => (
          <div
            key={`slot-${col}-${row}`}
            className={`rounded transition-colors ${
              dropTarget?.col === col && dropTarget?.row === row
                ? 'bg-indigo-500/20 border border-dashed border-indigo-400/50'
                : 'border border-transparent'
            }`}
            style={{ gridColumn: col, gridRow: row }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget({ col, row }) }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => { e.preventDefault(); handleDrop(col, row) }}
          />
        ))}
      </div>
      {/* Draggable cells on top */}
      <div
        className="absolute inset-0 grid gap-1 rounded p-1 pointer-events-none"
        style={{
          gridTemplateColumns: `repeat(${editing.cols}, 1fr)`,
          gridTemplateRows: `repeat(${totalRows}, 1fr)`,
        }}
      >
        {editing.cells.map((c, i) => (
          <div
            key={c.id}
            draggable
            onDragStart={(e) => {
              setDragId(c.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', c.id)
            }}
            onDragEnd={() => { setDragId(null); setDropTarget(null) }}
            className={`pointer-events-auto rounded flex items-center justify-center text-[10px] font-mono cursor-grab active:cursor-grabbing transition-all ${
              dragId === c.id
                ? 'bg-indigo-500/50 border border-indigo-300 text-indigo-100 opacity-60'
                : 'bg-indigo-500/30 border border-indigo-400/60 text-indigo-200 hover:bg-indigo-500/40'
            }`}
            style={{
              gridColumn: `${c.col} / span ${c.colSpan}`,
              gridRow: `${c.row} / span ${c.rowSpan}`,
            }}
          >
            <GripVertical size={8} className="mr-0.5 opacity-40" />
            cell {i + 1}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Draggable cells list — reorder cells by dragging rows. */
function CellsList({ editing, updateCell, removeCell }) {
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)

  return (
    <div className="space-y-1.5">
      {editing.cells.map((c, i) => (
        <div
          key={c.id}
          draggable
          onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('cell-idx', String(i)) }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverIdx(i) }}
          onDragLeave={() => setOverIdx(null)}
          onDrop={(e) => {
            e.preventDefault()
            // Swap positions between dragged and target cell
            if (dragIdx != null && dragIdx !== i) {
              const src = editing.cells[dragIdx]
              const dst = editing.cells[i]
              if (src && dst) {
                updateCell(src.id, { col: dst.col, row: dst.row })
                updateCell(dst.id, { col: src.col, row: src.row })
              }
            }
            setDragIdx(null)
            setOverIdx(null)
          }}
          onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
          className={`flex items-center gap-2 px-2 py-1.5 bg-bg-tertiary/40 border rounded cursor-grab active:cursor-grabbing transition-colors ${
            overIdx === i && dragIdx !== i ? 'border-indigo-400/60 bg-accent-subtle' : 'border-border-secondary'
          }`}
        >
          <GripVertical size={10} className="text-text-faint/40 shrink-0" />
          <span className="text-[10px] text-text-faint font-mono w-12 shrink-0">cell {i + 1}</span>
          <NumField label="col"  value={c.col}     onChange={(v) => updateCell(c.id, { col: v })} max={editing.cols} />
          <NumField label="row"  value={c.row}     onChange={(v) => updateCell(c.id, { row: v })} max={6} />
          <NumField label="cs"   value={c.colSpan} onChange={(v) => updateCell(c.id, { colSpan: v })} max={editing.cols} />
          <NumField label="rs"   value={c.rowSpan} onChange={(v) => updateCell(c.id, { rowSpan: v })} max={6} />
          <button
            onClick={() => removeCell(c.id)}
            className="ml-auto p-1 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
          >
            <Trash2 size={10} />
          </button>
        </div>
      ))}
    </div>
  )
}

function NumField({ label, value, onChange, max = 6 }) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-text-faint font-mono">
      {label}
      <input
        type="number"
        min={1}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(max, parseInt(e.target.value) || 1)))}
        className="w-10 px-1 py-0.5 bg-bg-inset border border-border-secondary rounded text-text-primary text-center font-mono focus:outline-none focus:border-accent-primary/50"
      />
    </label>
  )
}
