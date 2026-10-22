// Platform adapter — lets the SAME React app run three ways without forking the code:
//   1. Web (browser, dev):   API at relative '/api' (Vite proxies to the backend on :5111)
//   2. Web (served/remote):  API at relative '/api' (same-origin; backend serves the build)
//   3. Tauri desktop shell:  API at an ABSOLUTE backend URL (no Vite proxy inside the shell)
//
// It's also the seam for native ops (file dialogs, sidecar control): call invokeNative() which
// uses Tauri IPC when running in the shell. See frontend/src-tauri/ for the shell.

const DEFAULT_BACKEND = 'http://127.0.0.1:5111'

export const isTauri = () =>
  typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__)

// Backend origin used by the Tauri shell. Overridable via an injected global or localStorage
// (so a packaged app can point at a non-default backend port without a rebuild).
function backendOrigin() {
  if (typeof window !== 'undefined' && window.__IVE_BACKEND__) return window.__IVE_BACKEND__
  // The packaged desktop app serves UI and API from its own local backend.
  // Prefer that origin over a stale webview storage setting or the dev port.
  if (typeof window !== 'undefined' && isTauri()
      && window.location?.protocol === 'http:'
      && window.location?.hostname === '127.0.0.1') return window.location.origin
  try {
    const o = localStorage.getItem('ive_backend_url')
    if (o) return o
  } catch { /* no localStorage (SSR/sandbox) */ }
  return DEFAULT_BACKEND
}

// HTTP API base. Web → relative '/api' (Vite proxy / same-origin). Tauri → absolute to backend.
export const apiBase = () => (isTauri() ? `${backendOrigin()}/api` : '/api')

// Documentation workers need the running UI origin, not a fixed Vite dev port.
// Resolving only the origin also strips paths, query strings and credentials.
export const appOrigin = () => new URL(
  apiBase(), typeof window !== 'undefined' ? (window.location?.href || DEFAULT_BACKEND) : DEFAULT_BACKEND,
).origin

// WebSocket origin (Live voice, terminal streams). Web → same-origin ws(s). Tauri → absolute.
export const wsBase = () => {
  if (isTauri()) return backendOrigin().replace(/^http/, 'ws')
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}

// Native op seam — Tauri IPC when in the shell, otherwise the caller should fall back to a
// browser/back-end equivalent. Keeps native concerns out of the React components.
export async function invokeNative(cmd, args) {
  if (!isTauri()) throw new Error(`invokeNative('${cmd}') called outside the Tauri shell`)
  // @vite-ignore: optional dep — only resolved inside the Tauri shell, so the plain web build
  // doesn't fail when @tauri-apps/api isn't installed.
  const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core')
  return invoke(cmd, args)
}
