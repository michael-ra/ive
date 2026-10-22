import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import useEscapeToClose from '../../hooks/useEscapeToClose'

// Click dropdown for a launch setting of a running session (model,
// effort, permission mode).
// Same feedback as the Perms menu: "Switching to …" while the CLI restarts,
// "· after this answer" while a busy session finishes, and "Apply now".
// The menu is portalled with fixed position: the header strip clips overflow
// (Overview tiles), which would cut the option list off.
export default function LaunchSettingPicker({
  testId,
  sessionId,
  icon,
  label,
  displayValue,
  title,
  options,
  selected,
  apply,
  onSelect,
  onApplyNow,
  openRequest = 0,
  uppercase = false,
  width = 'w-48',
  showCurrent = false,
  footer,
  pendingText = 'Applies after the current answer.',
  applyNowLabel = 'Apply now',
  applyNowTitle = 'Stops the current answer and restarts the session with the new setting. The conversation is resumed.',
}) {
  const switching = apply && ['scheduled', 'applying'].includes(apply.state)
  const pending = apply?.state === 'pending'
  const applyLabel = (value) => options.find((o) => o.value === (value ?? ''))?.short || value || 'default'
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  const focusRequested = useRef(false)
  const [pos, setPos] = useState(null)
  useEscapeToClose(Boolean(pos), () => {
    setPos(null)
    rootRef.current?.querySelector('button')?.focus()
  })
  const show = () => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    // Keep the menu on screen (phones): below the button when there is room,
    // otherwise above it, never taller than the space it gets.
    const vh = window.visualViewport?.height || window.innerHeight
    const below = vh - rect.bottom - 12
    const above = rect.top - 12
    const right = Math.max(8, window.innerWidth - rect.right)
    if (below >= 320 || below >= above) setPos({ top: rect.bottom + 4, right, maxHeight: Math.max(120, Math.min(320, below)) })
    else setPos({ bottom: vh - rect.top + 4, right, maxHeight: Math.max(120, Math.min(320, above)) })
  }
  // A composer command can open the same picker without synthesizing a click.
  useLayoutEffect(() => {
    if (!openRequest) return
    focusRequested.current = true
    show()
  }, [openRequest])
  useLayoutEffect(() => {
    if (!pos || !focusRequested.current || !menuRef.current) return
    focusRequested.current = false
    const menu = menuRef.current
    const selectedButton = menu.querySelector('[aria-pressed="true"]') || menu.querySelector('button')
    selectedButton?.focus()
  }, [pos])
  // A button half scrolled out of a narrow strip (phones): keep the whole
  // menu inside the screen.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!pos || !el) return
    const r = el.getBoundingClientRect()
    if (r.left >= 8) return
    const right = Math.max(8, window.innerWidth - 8 - r.width)
    setPos((p) => (p && Math.abs((p.right || 0) - right) >= 1 ? { ...p, right } : p))
  }, [pos])
  // A tap or click outside closes it (there is no mouseleave on a touch screen).
  useEffect(() => {
    if (!pos) return
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      setPos(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [pos])

  return (
    <div
      ref={rootRef}
      className="ive-strip-launch inline-flex relative"
      data-testid={testId}
      data-session-id={sessionId}
    >
      <button
        type="button"
        title={title}
        aria-label={`${label} ${displayValue}`}
        aria-expanded={Boolean(pos)}
        onClick={() => (pos ? setPos(null) : show())}
        className="flex items-center gap-1.5 max-w-[240px] bg-x-bg/40 hover:bg-x-bg/80 border border-x-line/45 hover:border-x-accent/45 rounded-md px-2 py-1 transition-all duration-200 cursor-pointer"
      >
        {icon}
        <span className="ive-strip-label text-x-muted font-sans">{label}</span>
        {showCurrent ? (
          <span className="font-semibold text-x-ink truncate" data-testid={`${testId}-value`}>
            {displayValue}
            {(pending || switching) && <span className="ml-1 font-normal text-x-muted" data-testid={`${testId}-${switching ? 'applying' : 'pending'}`}>
              {switching ? '· switching…' : '· change pending'}
            </span>}
          </span>
        ) : switching ? (
          <span className="flex items-center gap-1 text-x-accent min-w-0" data-testid={`${testId}-applying`}>
            <Loader2 size={10} className="animate-spin shrink-0" />
            <span className="font-sans">Switching to</span>
            <span className={`font-semibold truncate ${uppercase ? 'uppercase' : ''}`}>{applyLabel(apply.value)}</span>
          </span>
        ) : (
          <span
            className={`font-semibold text-x-ink truncate ${uppercase ? 'uppercase' : ''}`}
            data-testid={`${testId}-value`}
            title={pending ? 'Applies after the current answer' : undefined}
          >
            {pending ? applyLabel(apply.value) : displayValue}
            {pending && (
              <span className="ml-1 normal-case font-sans font-normal text-x-muted" data-testid={`${testId}-pending`}>· after this answer</span>
            )}
          </span>
        )}
        <ChevronDown size={11} className={`text-x-muted shrink-0 transition-transform ${pos ? 'rotate-180' : ''}`} />
      </button>

      {pos && createPortal(
        <div
          ref={menuRef}
          data-testid={`${testId}-menu`}
          data-ive-popover=""
          data-session-id={sessionId}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right, maxHeight: pos.maxHeight, maxWidth: 'calc(100vw - 16px)' }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const buttons = [...menuRef.current.querySelectorAll('button:not(:disabled)')]
              const index = buttons.indexOf(document.activeElement)
              buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
            }
          }}
          className={`${width} overflow-y-auto bg-x-surface border border-x-line rounded-lg shadow-x-1 py-1 z-[200] animate-in fade-in`}
        >
          {showCurrent && apply && ['pending', 'scheduled', 'applying', 'failed'].includes(apply.state) && (
            <div className="border-b border-x-line/60 px-3 py-2 font-sans text-xs" role="status">
              <div>{apply.state === 'failed' ? 'Not applied' : 'Requested'}: {applyLabel(apply.value)}</div>
              {apply.state === 'failed' && <div className="text-x-muted mt-1">{apply.error || 'Could not confirm the new mode.'} Select a mode to retry.</div>}
            </div>
          )}
          {options.map((opt) => {
            const active = (selected ?? '') === opt.value
            return (
              <button
                type="button"
                key={opt.value || '__default'}
                aria-pressed={active}
                onClick={() => { onSelect(opt.value); if (window.matchMedia?.('(pointer: coarse)').matches) setPos(null) }}
                title={opt.description || undefined}
                className={`ive-launch-option w-full text-left px-3 py-1.5 hover:bg-x-accent/20 text-xs flex items-center justify-between gap-2 cursor-pointer font-sans ${
                  active ? 'text-x-accent font-medium' : 'text-x-ink-secondary'
                }`}
              >
                <span className="min-w-0"><span>{opt.label}</span>{showCurrent && opt.description && <span className="block text-[11px] font-normal text-x-muted mt-0.5">{opt.description}</span>}</span>
                {active && <Check size={11} className="shrink-0" />}
              </button>
            )
          })}
          {pending && (
            <div className="mt-1 border-t border-x-line/60 px-3 pt-1.5 pb-1 font-sans text-[11px] text-x-muted">
              <div>{pendingText}</div>
              <button
                type="button"
                onClick={onApplyNow}
                className="mt-1 text-x-accent hover:underline cursor-pointer"
                title={applyNowTitle}
              >
                {applyNowLabel}
              </button>
            </div>
          )}
          {footer && <div className="border-t border-x-line/60 mt-1 px-3 py-2 text-[11px] text-x-muted font-sans">{footer}</div>}
        </div>,
        document.body,
      )}
    </div>
  )
}
