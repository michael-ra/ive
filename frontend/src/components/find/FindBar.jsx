import { ChevronUp, ChevronDown, X, Search } from 'lucide-react'
import useStore from '../../state/store'
import { formatKeyCombo, isMacPlatform } from '../../lib/keybindings'
import { flushSync } from 'react-dom'

/**
 * Open a find bar and give its field the keyboard in the same task as the
 * ⌘F keydown. Focusing a frame later let a fast typist's next character land
 * in the composer or the terminal; committing the open state synchronously
 * means the field exists (and has the focus) before the next key event.
 */
export function openAndFocus(update, inputRef) {
  try { flushSync(update) } catch { update() }
  const focus = () => { inputRef.current?.focus(); inputRef.current?.select() }
  if (inputRef.current) focus()
  else requestAnimationFrame(focus)
}

// The find strip shown over a chat transcript or a terminal. Pure UI: the
// owner (ChatFindBar / TerminalFindBar) does the matching.
//
// Keys inside the field: Enter / ⇧Enter (and ⌘G / ⇧⌘G, Ctrl+G off Mac) go to
// the next / previous match, Escape closes. They never reach the global
// shortcut handler, so ⌘G does not open Guidelines while searching.
export default function FindBar({
  kind,
  query,
  onQueryChange,
  status,
  hasMatches,
  onStep,
  onClose,
  inputRef,
  scopeLabel,
  scopeAction = null,
  top = null,
}) {
  const globalCombo = useStore((s) => s.keybindings?.globalSearch)
  const nextKey = isMacPlatform() ? '⌘G' : 'Ctrl+G'
  const where = kind === 'terminal' ? 'terminal' : 'chat'

  const onKeyDown = (e) => {
    const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      onStep(e.shiftKey ? -1 : 1)
      return
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      e.stopPropagation()
      onStep(e.shiftKey ? -1 : 1)
    }
  }

  const openGlobal = () => {
    onClose(false)
    window.dispatchEvent(new CustomEvent('open-panel', { detail: 'search' }))
  }

  return (
    <div
      role="search"
      aria-label={`Find in this ${where}`}
      data-find-bar={kind}
      data-find-ignore=""
      data-grid-focus-ignore="true"
      style={top != null ? { top } : undefined}
      className={`ive-find-bar absolute top-2 z-40 right-3 w-[min(440px,calc(100%-24px))] ${kind === 'chat' ? 'md:right-14 md:w-[min(440px,calc(100%-72px))] ' : ''}rounded-[10px] border border-x-line bg-x-surface shadow-x-3 text-xs`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5">
        <Search size={13} className="text-x-muted shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Find in this ${where}`}
          aria-label={`Find in this ${where}`}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none"
        />
        <span
          data-find-status=""
          aria-live="polite"
          className={`shrink-0 tabular-nums text-[11px] ${status === 'No matches' ? 'text-x-danger' : 'text-x-muted'}`}
        >
          {status}
        </span>
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={!hasMatches}
          aria-label="Previous match (⇧Enter)"
          title={`Previous match (⇧Enter, ⇧${nextKey})`}
          className="ive-find-btn"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={!hasMatches}
          aria-label="Next match (Enter)"
          title={`Next match (Enter, ${nextKey})`}
          className="ive-find-btn"
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={() => onClose(true)}
          aria-label="Close search (Esc)"
          title="Close (Esc)"
          className="ive-find-btn"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-x-line-subtle px-2.5 py-1 text-[11px] text-x-muted">
        <span className="min-w-0 truncate" data-find-scope="">
          {scopeLabel}
          {scopeAction && (
            <>
              {' · '}
              <button type="button" className="underline underline-offset-2 hover:text-x-ink" onClick={scopeAction.onClick}>
                {scopeAction.label}
              </button>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={openGlobal}
          className="shrink-0 hover:text-x-ink"
          title="Search the messages of every session"
        >
          All sessions{globalCombo ? <span className="ml-1 font-mono text-x-faint">{formatKeyCombo(globalCombo)}</span> : null}
        </button>
      </div>
    </div>
  )
}
