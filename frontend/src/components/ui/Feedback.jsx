import { Loader2, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cx } from './cx'

// ── Spinner / Loading / StatusBar / EmptyState ───────────────────────────────

export function Spinner({ size = 16, className }) {
  return <Loader2 size={size} className={cx('animate-spin text-x-accent', className)} />
}

export function Loading({ label = 'Loading…', className }) {
  return (
    <div className={cx('flex-1 flex items-center justify-center', className)}>
      <div className="flex items-center gap-2.5 text-x-muted">
        <Spinner size={15} />
        <span className="text-[13px]">{label}</span>
      </div>
    </div>
  )
}

const TONES = {
  error: { cls: 'text-x-accent-ink bg-x-accent-ink/[0.08] border-x-accent-ink/20', Icon: AlertTriangle },
  warn: { cls: 'text-x-accent-ink bg-x-accent-ink/[0.08] border-x-accent-ink/20', Icon: AlertTriangle },
  ok: { cls: 'text-x-good bg-x-good/[0.08] border-x-good/20', Icon: CheckCircle2 },
  info: { cls: 'text-x-ink-secondary bg-x-muted/[0.06] border-x-line', Icon: Info },
}

// StatusBar — an inline status strip (run results, errors, warnings). Honest,
// quiet by default; semantic color only on the strip itself.
export function StatusBar({ tone = 'info', icon, className, children }) {
  const t = TONES[tone] || TONES.info
  const Icon = icon || t.Icon
  return (
    <div className={cx('flex items-center gap-2 px-5 py-2.5 text-[12px] border-b shrink-0', t.cls, className)}>
      <Icon size={13} strokeWidth={2} className="shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, description, action, align = 'center', className }) {
  const startAligned = align === 'start'
  return (
    <div className={cx(`flex-1 flex items-center px-6 py-12 ${startAligned ? 'justify-start' : 'justify-center'}`, className)}>
      <div className={`flex max-w-sm flex-col gap-3 ${startAligned ? 'items-start text-left' : 'items-center text-center'}`}>
        {Icon && (
          <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-x-surface border border-x-line text-x-muted">
            <Icon size={22} strokeWidth={1.5} />
          </span>
        )}
        {title && <div className="text-[14px] font-medium text-x-ink-secondary">{title}</div>}
        {description && <p className="text-[12.5px] text-x-muted leading-relaxed">{description}</p>}
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </div>
  )
}

export default Loading
