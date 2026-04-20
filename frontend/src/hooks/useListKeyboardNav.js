import { useEffect } from 'react'

/**
 * Standard list keyboard navigation for modal panels.
 *
 *   ↑ / ↓        — move selection (clamped to bounds)
 *   Home / End   — jump to first / last
 *   Enter        — activate selected item (calls onActivate(idx))
 *   Delete / ⌘⌫  — remove selected item (calls onDelete(idx))
 *
 * The handler is attached on the bubble phase and bails out when focus is in
 * an input/textarea/contenteditable, so typing in a search box doesn't get
 * hijacked. Inputs that *want* to forward ↑/↓ into the list (e.g. a search
 * field at the top of the list) should call this hook AND wire their own
 * onKeyDown to call setSelectedIdx directly.
 */
export default function useListKeyboardNav({
  enabled = true,
  itemCount,
  selectedIdx,
  setSelectedIdx,
  onActivate,
  onDelete,
} = {}) {
  useEffect(() => {
    if (!enabled || itemCount <= 0) return
    const handler = (e) => {
      const t = e.target
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return

      // Only handle bare arrow/Home/End keys — modifier combos (Cmd+Arrow,
      // Shift+Arrow, etc.) belong to other handlers (grid nav, chrome nav, etc.)
      const hasModifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey

      if (e.key === 'ArrowDown' && !hasModifier) {
        e.preventDefault()
        const next = selectedIdx < 0 ? 0 : Math.min(itemCount - 1, selectedIdx + 1)
        setSelectedIdx(next)
      } else if (e.key === 'ArrowUp' && !hasModifier) {
        e.preventDefault()
        const next = selectedIdx <= 0 ? 0 : selectedIdx - 1
        setSelectedIdx(next)
      } else if (e.key === 'Home' && !hasModifier) {
        e.preventDefault()
        setSelectedIdx(0)
      } else if (e.key === 'End' && !hasModifier) {
        e.preventDefault()
        setSelectedIdx(itemCount - 1)
      } else if (e.key === 'Enter' && selectedIdx >= 0 && onActivate) {
        // Don't shadow ⌘↵ — that's reserved for usePanelCreate (form submit).
        if (e.metaKey || e.ctrlKey) return
        e.preventDefault()
        onActivate(selectedIdx)
      } else if (
        onDelete && selectedIdx >= 0 &&
        (e.key === 'Delete' || ((e.metaKey || e.ctrlKey) && e.key === 'Backspace'))
      ) {
        e.preventDefault()
        onDelete(selectedIdx)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, itemCount, selectedIdx, setSelectedIdx, onActivate, onDelete])
}
