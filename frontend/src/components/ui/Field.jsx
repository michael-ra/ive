import { forwardRef } from 'react'
import { cx } from './cx'

// ── Field / Input / Textarea / Label ─────────────────────────────────────────
// Sans eyebrow labels (not lowercase-mono). Inputs are calm inset surfaces with
// a neutral focus border. Pass `mono` for code-like content (IDs, prompts).

export function Label({ className, children, ...rest }) {
  return (
    <span className={cx('text-xs font-medium text-x-ink-secondary', className)} {...rest}>
      {children}
    </span>
  )
}

export function Field({ label, hint, htmlFor, className, children }) {
  return (
    <label htmlFor={htmlFor} className={cx('flex flex-col gap-1.5', className)}>
      {(label || hint) && (
        <span className="flex items-baseline gap-2 flex-wrap">
          {label && <Label>{label}</Label>}
          {hint && <span className="text-[11px] font-normal normal-case text-x-muted">{hint}</span>}
        </span>
      )}
      {children}
    </label>
  )
}

const INPUT_BASE =
  'w-full bg-x-surface border border-x-line rounded-md px-3 text-[13px] text-x-ink ' +
  'placeholder:text-x-muted transition-colors duration-[80ms] focus:outline-none ' +
  'focus:border-x-focus'

export const Input = forwardRef(function Input({ className, mono = false, ...rest }, ref) {
  return <input ref={ref} className={cx(INPUT_BASE, 'h-8', mono && 'font-mono text-[12px]', className)} {...rest} />
})

export const Textarea = forwardRef(function Textarea({ className, mono = false, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(INPUT_BASE, 'py-2 resize-none leading-relaxed', mono && 'font-mono text-[12px]', className)}
      {...rest}
    />
  )
})

export default Field
