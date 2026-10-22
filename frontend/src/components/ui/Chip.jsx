import { cx } from './cx'

// ── Chip / Dot ───────────────────────────────────────────────────────────────
// Small status/label pills. `neutral` is the default; colored variants are for
// genuine semantic meaning only (status, type encodings) — keep them sparse.
const COLORS = {
  neutral: 'bg-x-muted/10 border-x-line text-x-ink-secondary',
  accent: 'bg-x-accent/10 border-x-accent/30 text-x-accent',
  amber: 'bg-x-accent-ink/10 border-x-accent-ink/30 text-x-accent-ink',
  red: 'bg-x-accent-ink/10 border-x-accent-ink/30 text-x-accent-ink',
  emerald: 'bg-x-good/10 border-x-good/30 text-x-good',
  // Violet is retired from chrome — legacy "violet" chips render as accent.
  violet: 'bg-x-accent/10 border-x-accent/30 text-x-accent',
}

export function Chip({ color = 'neutral', icon: Icon, className, children, ...rest }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
        COLORS[color] || COLORS.neutral,
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={11} strokeWidth={2} />}
      {children}
    </span>
  )
}

// Dot — a small status/type indicator. Accepts a raw color (used by the graph's
// node-type legend) or a className.
export function Dot({ color, size = 6, className, style }) {
  return (
    <span
      className={cx('inline-block rounded-full shrink-0', className)}
      style={{ width: size, height: size, background: color || 'currentColor', ...style }}
    />
  )
}

export default Chip
