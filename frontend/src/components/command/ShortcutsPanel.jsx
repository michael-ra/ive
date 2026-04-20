import { useState, useEffect, useMemo, useRef } from 'react'
import { X, Keyboard, RotateCcw } from 'lucide-react'
import useStore from '../../state/store'
import {
  KEYBINDING_DEFS,
  getOverrides,
  setKeybinding,
  resetKeybinding,
  resetAllKeybindings,
  findConflict,
  formatKeyCombo,
  isGlobalSection,
} from '../../lib/keybindings'

// Non-configurable shortcuts shown as static read-only rows.
const STATIC_SECTIONS = [
  { section: 'Navigation', items: [
    { keys: '\u23181-9', action: 'Switch to tab N' },
    { keys: 'Esc', action: 'Close panel / Go back' },
  ]},
  { section: 'Sessions', items: [
    { keys: '\u21E7\u21B5', action: 'Force message (interrupt + send)' },
  ]},
  { section: 'Feature Board', items: [
    { keys: '\u2190 \u2192', action: 'Move between columns' },
    { keys: '\u2191 \u2193', action: 'Move between cards' },
    { keys: '\u21B5', action: 'Open focused task' },
    { keys: '\u2318\u232B', action: 'Delete focused task' },
  ]},
  { section: 'Grid View', items: [
    { keys: '\u2318\u2190\u2192\u2191\u2193', action: 'Move between grid cells' },
    { keys: '\u2318\u2191 at top', action: 'Escape to chrome (tab bar)' },
  ]},
  { section: 'Chrome Focus', items: [
    { keys: '\u2190/\u2192/\u2191/\u2193', action: 'Cycle chrome buttons' },
    { keys: '\u21B5 / Space', action: 'Activate focused button' },
    { keys: 'Esc', action: 'Return focus to terminal' },
  ]},
  { section: 'In Any Panel', items: [
    { keys: '\u2191 / \u2193', action: 'Navigate list items' },
    { keys: 'Home / End', action: 'Jump to first / last' },
    { keys: '\u21B5', action: 'Activate selected item' },
    { keys: '\u2318\u232B', action: 'Delete selected item' },
    { keys: '\u2318=', action: 'New item (open create form)' },
    { keys: '\u2318\u21B5', action: 'Save current create form' },
  ]},
  { section: 'Screenshot Annotator', items: [
    { keys: 'R', action: 'Rectangle tool' },
    { keys: 'A', action: 'Arrow tool' },
    { keys: 'D', action: 'Freehand draw' },
    { keys: 'T', action: 'Text tool' },
    { keys: '\u2318Z', action: 'Undo' },
    { keys: '\u2318\u21E7Z', action: 'Redo' },
    { keys: '\u2318S', action: 'Save screenshot' },
  ]},
  { section: 'In Terminal', items: [
    { keys: '@ralph', action: 'Ralph loop mode (execute\u2192verify\u2192fix)' },
    { keys: '@research <q>', action: 'Deep research (background, default model)' },
    { keys: '@research--<model> <q>', action: 'Deep research with explicit model' },
    { keys: '@prompt:<name>', action: 'Inline a saved prompt by name (use \"name\" for spaces)' },
    { keys: '\u2318\u21E7A', action: 'Annotate terminal output' },
  ]},
]

// Order in which sections appear. Configurable sections first, then static-only.
const SECTION_ORDER = [
  'Navigation', 'Panels', 'Sessions', 'Feature Board', 'Task Modal',
  'Grid View', 'Chrome Focus', 'Screenshot Annotator', 'In Any Panel', 'In Terminal',
]

export default function ShortcutsPanel({ onClose }) {
  const keybindings = useStore((s) => s.keybindings)
  const reloadKeybindings = useStore((s) => s.reloadKeybindings)
  const [recordingId, setRecordingId] = useState(null)
  const [conflictMsg, setConflictMsg] = useState(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so Escape works even when opened from terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  const overrides = getOverrides()
  const hasOverrides = Object.keys(overrides).length > 0

  // Group configurable defs by section
  const configurableSections = useMemo(() => {
    const map = {}
    for (const def of KEYBINDING_DEFS) {
      ;(map[def.section] ??= []).push(def)
    }
    return map
  }, [])

  // Static items grouped by section (pre-computed)
  const staticBySection = useMemo(() => {
    const map = {}
    for (const s of STATIC_SECTIONS) {
      ;(map[s.section] ??= []).push(...s.items)
    }
    return map
  }, [])

  // Recording mode: capture-phase handler intercepts all keypresses
  useEffect(() => {
    if (!recordingId) return
    const handler = (e) => {
      e.preventDefault()
      e.stopImmediatePropagation()

      // Escape → cancel recording
      if (e.key === 'Escape') {
        setRecordingId(null)
        setConflictMsg(null)
        return
      }

      // Ignore modifier-only presses
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return

      const combo = { key: e.key }
      if (e.metaKey || e.ctrlKey) combo.meta = true
      if (e.shiftKey) combo.shift = true
      if (e.altKey) combo.alt = true

      // Global shortcuts need at least Cmd/Ctrl or Alt
      const def = KEYBINDING_DEFS.find((d) => d.id === recordingId)
      if (def && isGlobalSection(def.section) && !combo.meta && !combo.alt) return

      // Conflict check
      const conflict = findConflict(recordingId, combo, keybindings)
      if (conflict) {
        setConflictMsg(`Conflicts with: ${conflict.label}`)
        setTimeout(() => setConflictMsg(null), 3000)
      }

      setKeybinding(recordingId, combo)
      reloadKeybindings()
      setRecordingId(null)
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => window.removeEventListener('keydown', handler, true)
  }, [recordingId, keybindings, reloadKeybindings])

  const handleReset = (id) => {
    resetKeybinding(id)
    reloadKeybindings()
  }

  const handleResetAll = () => {
    resetAllKeybindings()
    reloadKeybindings()
    setConflictMsg(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[580px] max-h-[80vh] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-5 py-3 border-b border-zinc-800 shrink-0">
          <Keyboard size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-200 font-mono font-medium">Keyboard Shortcuts</span>
          <div className="flex-1" />
          {hasOverrides && (
            <button
              onClick={handleResetAll}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 hover:bg-zinc-700/50 rounded border border-zinc-700 transition-colors mr-2"
            >
              <RotateCcw size={10} /> reset all
            </button>
          )}
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Conflict message */}
        {conflictMsg && (
          <div className="mx-5 mt-2 px-3 py-1.5 text-[11px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded">
            {conflictMsg}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {SECTION_ORDER.map((sectionName) => {
            const configItems = configurableSections[sectionName] || []
            const staticItems = staticBySection[sectionName] || []
            if (configItems.length === 0 && staticItems.length === 0) return null

            return (
              <div key={sectionName}>
                <h3 className="text-[11px] font-mono text-zinc-500 uppercase tracking-wider mb-2">
                  {sectionName}
                </h3>
                <div className="space-y-0.5">
                  {/* Configurable bindings */}
                  {configItems.map((def) => {
                    const isRecording = recordingId === def.id
                    const isCustomized = def.id in overrides
                    const combo = keybindings[def.id]

                    return (
                      <div
                        key={def.id}
                        className={`flex items-center justify-between py-1 px-1.5 rounded transition-colors ${
                          isRecording ? 'bg-indigo-500/10' : 'hover:bg-zinc-800/30'
                        }`}
                      >
                        <span className="text-[12px] font-mono text-zinc-300 flex-1">{def.label}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setRecordingId(isRecording ? null : def.id)
                              setConflictMsg(null)
                            }}
                            className={`px-2 py-1 text-[11px] font-mono rounded border min-w-[50px] text-center transition-colors ${
                              isRecording
                                ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300 animate-pulse'
                                : isCustomized
                                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:border-amber-400/50'
                                  : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                            }`}
                          >
                            {isRecording ? 'press keys\u2026' : formatKeyCombo(combo)}
                          </button>
                          {isCustomized && !isRecording && (
                            <button
                              onClick={() => handleReset(def.id)}
                              title="Reset to default"
                              className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
                            >
                              <RotateCcw size={10} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  {/* Static (non-configurable) bindings */}
                  {staticItems.map((item) => (
                    <div key={item.keys} className="flex items-center justify-between py-1 px-1.5 rounded hover:bg-zinc-800/30">
                      <span className="text-[12px] font-mono text-zinc-400">{item.action}</span>
                      <kbd className="px-2 py-1 text-[11px] font-mono bg-zinc-800/50 text-zinc-500 rounded border border-zinc-800 min-w-[50px] text-center">
                        {item.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-2 border-t border-zinc-800 shrink-0">
          <span className="text-[10px] font-mono text-zinc-600">
            click a binding to remap \u00B7 Esc to cancel \u00B7 customized bindings shown in <span className="text-amber-400/70">amber</span>
          </span>
        </div>
      </div>
    </div>
  )
}
