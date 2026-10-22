import { useState, useEffect, useMemo, useRef } from 'react'
import { RotateCcw } from 'lucide-react'
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
  isMacBrowser,
  getTabSwitchCombo,
  isPtyControlKey,
  isBrowserReservedControlKey,
} from '../../lib/keybindings'
import { Button } from '../ui'

// Non-configurable shortcuts shown as static read-only rows.
const STATIC_SECTIONS = [
  { section: 'Navigation', items: [
    { keys: `${formatKeyCombo(getTabSwitchCombo())}–9`, action: 'Switch to tab N' },
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
    { keys: '\u2303\u2325\u2190\u2192\u2191\u2193', action: 'Move between grid cells' },
    { keys: '\u2303\u2325\u2191 at top', action: 'Escape to chrome (tab bar)' },
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
  { section: 'Find Bar', items: [
    { keys: '\u21B5 / \u21E7\u21B5', action: 'Next / previous match' },
    { keys: '\u2318G / \u21E7\u2318G', action: 'Next / previous match' },
    { keys: 'Esc', action: 'Close, back to the message field or terminal' },
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
  'Grid View', 'Chrome Focus', 'Find Bar', 'Screenshot Annotator', 'In Any Panel', 'In Terminal',
]

export default function ShortcutsPanel() {
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
      if (e.metaKey) combo.meta = true
      if (e.ctrlKey) combo.ctrl = true
      if (e.shiftKey) combo.shift = true
      if (e.altKey) combo.alt = true

      // Global shortcuts need at least Cmd/Ctrl or Alt
      const def = KEYBINDING_DEFS.find((d) => d.id === recordingId)
      if (def && isGlobalSection(def.section) && !combo.meta && !combo.ctrl && !combo.alt) return

      // Conflict check
      const conflict = findConflict(recordingId, combo, keybindings)
      if (conflict) {
        setConflictMsg(`Conflicts with: ${conflict.label}`)
        setTimeout(() => setConflictMsg(null), 3000)
      } else if (!isBrowserReservedControlKey({ key: combo.key, ctrlKey: !!combo.ctrl, metaKey: !!combo.meta, altKey: !!combo.alt, shiftKey: !!combo.shift })
        && isPtyControlKey({ key: combo.key, ctrlKey: !!combo.ctrl, metaKey: !!combo.meta, altKey: !!combo.alt, shiftKey: !!combo.shift })) {
        setConflictMsg(`${formatKeyCombo(combo)} stays with the agent inside terminals`)
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
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-col overflow-hidden outline-none"
      >
        {isMacBrowser() && (
          <p className="px-5 py-3 text-xs text-x-muted border-b border-x-line">
            ⌃ means Control; ⌘ means Command. Browser-reserved shortcuts use Control here, for example ⌃N for a new session. Inside agent terminals only ⌃N, ⌃⇧N, ⌃T, ⌃W and ⌃1–9 reach IVE; all other Control keys, including ⌃R, ⌃D and ⌃M, go to the agent.
          </p>
        )}
        {hasOverrides && (
          <div className="flex shrink-0 justify-end border-b border-x-line px-5 py-2">
            <Button type="submit"
              onClick={handleResetAll}
              className="flex items-center gap-1 h-[26px] px-2.5 text-[11px] font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms] ease-x"
            >
              <RotateCcw size={10} /> reset all
            </Button>
          </div>
        )}

        {/* Conflict message */}
        {conflictMsg && (
          <div className="mx-5 mt-2 px-3 py-1.5 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md">
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
                <h3 className="text-[11px] font-medium text-x-muted uppercase tracking-[0.06em] mb-2">
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
                        className={`flex items-center justify-between py-1 px-1.5 rounded-md transition-colors duration-[80ms] ease-x ${
                          isRecording ? 'bg-x-tint' : 'hover:bg-x-hover'
                        }`}
                      >
                        <span className="text-xs text-x-ink-secondary flex-1">{def.label}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setRecordingId(isRecording ? null : def.id)
                              setConflictMsg(null)
                            }}
                            className={`px-2 py-1 text-[11px] font-mono rounded border min-w-[50px] text-center transition-colors duration-[80ms] ease-x ${
                              isRecording
                                ? 'bg-x-tint border-x-accent/45 text-x-accent animate-subtle-pulse'
                                : isCustomized
                                  ? 'bg-x-accent-ink/10 border-x-accent-ink/30 text-x-accent-ink hover:border-x-accent-ink/45'
                                  : 'bg-x-surface-2 border-x-line text-x-ink-secondary hover:border-x-line-strong'
                            }`}
                          >
                            {isRecording ? 'press keys\u2026' : formatKeyCombo(combo)}
                          </button>
                          {isCustomized && !isRecording && (
                            <button
                              onClick={() => handleReset(def.id)}
                              title="Reset to default"
                              className="p-1 text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms] ease-x"
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
                    <div key={item.keys} className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-x-hover transition-colors duration-[80ms] ease-x">
                      <span className="text-xs text-x-ink-secondary">{item.action}</span>
                      <kbd className="px-2 py-1 text-[11px] font-mono bg-x-surface-2 text-x-ink-secondary rounded border border-x-line min-w-[50px] text-center">
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
        <div className="flex items-center gap-2 px-5 py-2 border-t border-x-line shrink-0">
          <span className="text-[11px] text-x-muted">
            Click a binding to remap · Esc to cancel · Customized bindings use the accent
          </span>
        </div>
      </div>
  )
}
