import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, Check, GripVertical, LayoutGrid } from 'lucide-react'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import { uuid } from '../../lib/uuid'
import { Button, EmptyState } from '../ui'

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
export default function GridTemplateEditor() {
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
      id: uuid(),
      name: 'New layout',
      cols: 3,
      cells: [
        { id: uuid(), col: 1, row: 1, colSpan: 2, rowSpan: 2 },
        { id: uuid(), col: 3, row: 1, colSpan: 1, rowSpan: 1 },
        { id: uuid(), col: 3, row: 2, colSpan: 1, rowSpan: 1 },
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
      cells: [...e.cells, { id: uuid(), col: 1, row: 1, colSpan: 1, rowSpan: 1 }],
    }))
  }

  const removeCell = (cellId) => {
    setEditing((e) => ({ ...e, cells: e.cells.filter((c) => c.id !== cellId) }))
  }

  // Compute the total rows used by the template so the preview height makes sense.
  const totalRowsOf = (tpl) =>
    Math.max(1, ...tpl.cells.map((c) => (c.row || 1) + (c.rowSpan || 1) - 1))

  return (
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-col overflow-hidden outline-none"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line shrink-0">
          <span className="text-xs text-x-ink font-medium">
            {editing ? (editing._isNew ? 'New layout template' : `Edit: ${editing.name}`) : 'Grid layout templates'}
          </span>
        </div>

        {!editing ? (
          /* ─── List view ─── */
          <div ref={listRef} className="flex flex-1 flex-col overflow-y-auto p-3 space-y-2">
            {gridTemplates.length === 0 && (
              <EmptyState
                icon={LayoutGrid}
                title="Build a reusable session layout"
                description="Grid templates arrange multiple live sessions into a layout you can restore from the top bar."
                action={(
                  <Button variant="primary" icon={Plus} onClick={startNew}>
                    New template
                  </Button>
                )}
              />
            )}
            {gridTemplates.map((tpl, idx) => {
              const rows = totalRowsOf(tpl)
              return (
                <div
                  key={tpl.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`group flex items-center gap-3 p-2.5 border rounded-md transition-colors duration-[80ms] ease-x cursor-pointer ${
                    selectedIdx === idx
                      ? 'bg-x-tint border-x-accent/45'
                      : 'bg-x-surface hover:bg-x-hover border-x-line hover:border-x-line-strong'
                  }`}
                >
                  {/* Mini preview */}
                  <div
                    className="grid gap-0.5 shrink-0 bg-x-surface-2 rounded"
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
                        className="bg-x-accent/40 border border-x-accent/60 rounded-sm"
                        style={{
                          gridColumn: `${c.col} / span ${c.colSpan}`,
                          gridRow: `${c.row} / span ${c.rowSpan}`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-x-ink font-medium truncate">{tpl.name}</div>
                    <div className="text-[11px] text-x-faint">
                      {tpl.cols} cols × {rows} rows · {tpl.cells.length} cells
                    </div>
                  </div>
                  {activeGridTemplateId === tpl.id && (
                    <span className="text-[11px] text-x-good font-medium">active</span>
                  )}
                  <Button type="submit"
                    onClick={() => setActiveGridTemplateId(activeGridTemplateId === tpl.id ? null : tpl.id)}
                    className="px-2 py-1 text-[11px] font-medium bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms] ease-x"
                  >
                    {activeGridTemplateId === tpl.id ? 'deactivate' : 'use'}
                  </Button>
                  <Button type="submit"
                    onClick={() => startEdit(tpl)}
                    className="px-2 py-1 text-[11px] font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms] ease-x"
                  >
                    edit
                  </Button>
                  <Button type="submit"
                    onClick={() => {
                      if (confirm(`Delete template "${tpl.name}"?`)) removeGridTemplate(tpl.id)
                    }}
                    className="p-1 text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors duration-[80ms] ease-x"
                  >
                    <Trash2 size={11} />
                  </Button>
                </div>
              )
            })}
            {gridTemplates.length > 0 && (
              <Button
                variant="primary"
                icon={Plus}
                onClick={startNew}
                className="mt-2 w-full"
              >
                New template
              </Button>
            )}
          </div>
        ) : (
          /* ─── Edit view ─── */
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing((tpl) => ({ ...tpl, name: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                autoFocus
              />
            </div>

            <div>
              <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Columns</label>
              <input
                type="number"
                min={1}
                max={6}
                value={editing.cols}
                onChange={(e) => setEditing((tpl) => ({ ...tpl, cols: Math.max(1, Math.min(6, parseInt(e.target.value) || 1)) }))}
                className="w-20 px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus tabular-nums"
              />
            </div>

            {/* Live preview — drag cells to reposition */}
            <div>
              <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Preview <span className="text-x-muted normal-case font-normal">— drag cells to move</span></label>
              <PreviewGrid editing={editing} updateCell={updateCell} />
            </div>

            {/* Cells list */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-x-ink-secondary">Cells</label>
                <Button type="submit"
                  onClick={addCell}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms] ease-x"
                >
                  <Plus size={10} /> add cell
                </Button>
              </div>
              <CellsList editing={editing} updateCell={updateCell} removeCell={removeCell} />
            </div>

            <div className="flex gap-1.5 pt-2 border-t border-x-line">
              <Button type="submit"
                onClick={saveEditing}
                disabled={!editing.name.trim() || editing.cells.length === 0}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 disabled:cursor-not-allowed text-x-on-accent transition-colors duration-[80ms] ease-x"
              >
                <Check size={12} /> Save template
              </Button>
              <Button type="submit"
                onClick={() => setEditing(null)}
                className="px-3 py-2 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms] ease-x"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
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
        className="grid gap-1 bg-x-surface-2 rounded-md p-1 border border-x-line"
        style={{
          height: 140,
          gridTemplateColumns: `repeat(${editing.cols}, 1fr)`,
          gridTemplateRows: `repeat(${totalRows}, 1fr)`,
        }}
      >
        {slots.map(({ col, row }) => (
          <div
            key={`slot-${col}-${row}`}
            className={`rounded-sm transition-colors duration-[80ms] ease-x ${
              dropTarget?.col === col && dropTarget?.row === row
                ? 'bg-x-accent/20 border border-dashed border-x-accent/50'
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
            className={`pointer-events-auto rounded-sm flex items-center justify-center text-[11px] font-mono cursor-grab active:cursor-grabbing transition-colors duration-[80ms] ease-x ${
              dragId === c.id
                ? 'bg-x-accent/50 border border-x-accent text-x-ink opacity-60'
                : 'bg-x-accent/30 border border-x-accent/60 text-x-ink hover:bg-x-accent/40'
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
          className={`flex items-center gap-2 px-2 py-1.5 bg-x-surface border rounded-md cursor-grab active:cursor-grabbing transition-colors duration-[80ms] ease-x ${
            overIdx === i && dragIdx !== i ? 'border-x-accent/60 bg-x-tint' : 'border-x-line'
          }`}
        >
          <GripVertical size={10} className="text-x-faint shrink-0" />
          <span className="text-[11px] text-x-faint font-mono w-12 shrink-0">cell {i + 1}</span>
          <NumField label="col"  value={c.col}     onChange={(v) => updateCell(c.id, { col: v })} max={editing.cols} />
          <NumField label="row"  value={c.row}     onChange={(v) => updateCell(c.id, { row: v })} max={6} />
          <NumField label="cs"   value={c.colSpan} onChange={(v) => updateCell(c.id, { colSpan: v })} max={editing.cols} />
          <NumField label="rs"   value={c.rowSpan} onChange={(v) => updateCell(c.id, { rowSpan: v })} max={6} />
          <Button type="submit"
            onClick={() => removeCell(c.id)}
            className="ml-auto p-1 text-x-faint hover:text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors duration-[80ms] ease-x"
          >
            <Trash2 size={10} />
          </Button>
        </div>
      ))}
    </div>
  )
}

function NumField({ label, value, onChange, max = 6 }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-x-faint font-mono">
      {label}
      <input
        type="number"
        min={1}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(max, parseInt(e.target.value) || 1)))}
        className="w-10 px-1 py-0.5 bg-x-surface-2 border border-x-line rounded text-x-ink text-center font-mono tabular-nums focus:outline-none focus:border-x-accent"
      />
    </label>
  )
}
