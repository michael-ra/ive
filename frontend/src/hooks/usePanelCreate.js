import { useEffect } from 'react'

/**
 * Standard "create item" keyboard shortcuts for modal panels.
 *
 *   Cmd/Ctrl + =  (or +)  → onAdd     — open the create form
 *   Cmd/Ctrl + Enter      → onSubmit  — save the create form
 *
 * The listener is attached on the capture phase so it beats the global
 * useKeyboard handlers, and only while `enabled` is true (typically the
 * panel's mount lifetime). Cmd+= would otherwise trigger browser zoom,
 * so we preventDefault on it.
 */
export default function usePanelCreate({ enabled = true, onAdd, onSubmit } = {}) {
  useEffect(() => {
    if (!enabled) return
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      if ((e.key === '=' || e.key === '+') && onAdd) {
        e.preventDefault()
        onAdd(e)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
        // Cmd+Shift+Enter is reserved for broadcast — don't shadow it.
        e.preventDefault()
        onSubmit(e)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [enabled, onAdd, onSubmit])
}
