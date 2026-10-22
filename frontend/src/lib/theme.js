/**
 * Theme runtime — dark/light switching for the IVE design system.
 *
 * Contract (QA depends on these):
 *   - localStorage key: "ive-theme.v2", values "dark" | "light" | "system".
 *   - <html data-theme="dark|light"> drives the CSS token swap (src/index.css:
 *     :root = light values, html[data-theme="dark"] = dark values).
 *   - No stored choice → LIGHT (light-first design). "system" is an explicit
 *     opt-in that follows prefers-color-scheme live.
 *
 * initTheme() must run BEFORE first paint — it is invoked at the top of
 * src/main.jsx, and index.html first loads public/theme-bootstrap.js, which
 * pre-sets data-theme so the CSS never flashes the wrong theme.
 *
 */

// v2: key bumped for the Xirp light-first redesign — ignores stale "dark"
// preferences written by the pre-redesign dark-only app.
export const THEME_STORAGE_KEY = 'ive-theme.v2'

/** <meta name="theme-color"> per theme — keeps the Tauri titlebar matched. */
const META_THEME_COLORS = { dark: '#0E1014', light: '#FFFFFF' }

const listeners = new Set()

function readStoredPreference() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (value === 'dark' || value === 'light' || value === 'system') return value
  } catch {
    // localStorage can throw in locked-down webviews — fall through.
  }
  return null
}

function systemTheme() {
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  } catch {
    // matchMedia unavailable → fall through to light.
  }
  return 'light'
}

/** The user's stored preference: "dark" | "light" | "system". Nothing stored
 *  resolves to "light" — the design system is light-first; dark and
 *  OS-following are explicit opt-ins. */
export function getThemePreference() {
  return readStoredPreference() || 'light'
}

/** The resolved, currently-effective theme: "dark" | "light". */
export function getTheme() {
  const pref = readStoredPreference()
  if (pref === 'dark' || pref === 'light') return pref
  if (pref === 'system') return systemTheme()
  return 'light'
}

function applyTheme(theme) {
  const root = document.documentElement
  root.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', META_THEME_COLORS[theme] || META_THEME_COLORS.dark)
  for (const fn of listeners) {
    try { fn(theme) } catch { /* listener errors must not break theming */ }
  }
  try {
    window.dispatchEvent(new CustomEvent('ive-theme-change', { detail: { theme } }))
  } catch { /* CustomEvent should always exist; belt-and-braces */ }
}

/**
 * Persist a preference ("dark" | "light" | "system") and apply the resolved
 * theme immediately.
 */
export function setTheme(preference) {
  const value = preference === 'dark' || preference === 'light' || preference === 'system'
    ? preference
    : 'system'
  try { window.localStorage.setItem(THEME_STORAGE_KEY, value) } catch { /* best-effort */ }
  applyTheme(value === 'system' ? systemTheme() : value)
}

/** Flip between dark and light (stores an explicit choice). */
export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

/**
 * Subscribe to resolved-theme changes. Returns an unsubscribe function.
 * Compatible with React's useSyncExternalStore.
 */
export function subscribeTheme(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Apply the theme now and start following OS scheme changes (only honored
 * while the user hasn't stored an explicit "dark"/"light" choice).
 * Idempotent enough for a single SPA entry; call once from main.jsx.
 */
export function initTheme() {
  applyTheme(getTheme())
  try {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      const pref = readStoredPreference()
      if (pref !== 'dark' && pref !== 'light') applyTheme(getTheme())
    }
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
    else if (typeof media.addListener === 'function') media.addListener(onChange)
  } catch {
    // No matchMedia → stay on the resolved default (light).
  }
}
