import { useSyncExternalStore } from 'react'
import { Sun, Moon } from 'lucide-react'
import { cx } from './cx'
import { getTheme, toggleTheme, subscribeTheme } from '../../lib/theme'

// ── ThemeToggle — dark/light switch (sun in dark, moon in light) ─────────────
// Small square chrome button; matches the status-bar w-6 h-6 rounded-md border
// pattern by default. Persists via src/lib/theme.js (localStorage "ive-theme").
export function ThemeToggle({ className, size = 13 }) {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  const isDark = theme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'
  const Icon = isDark ? Sun : Moon
  return (
    <button
      type="button"
      onClick={() => toggleTheme()}
      title={label}
      aria-label={label}
      className={cx(
        'flex items-center justify-center w-6 h-6 rounded-md border transition-colors',
        'text-x-muted border-x-line-subtle bg-transparent',
        'hover:text-x-ink hover:bg-x-hover',
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-x-focus',
        className,
      )}
    >
      <Icon size={size} strokeWidth={1.75} />
    </button>
  )
}

export default ThemeToggle
