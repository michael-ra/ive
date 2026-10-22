import { initTheme } from './lib/theme'

// A rebuild under an open tab deletes the old hashed chunks; lazy routes then
// die with "Importing a module script failed". Reload once to pick up the new
// build instead of crashing the panel (guard prevents a reload loop).
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const key = 'ive-chunk-reload'
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  setTimeout(() => sessionStorage.removeItem(key), 10000)
  window.location.reload()
})
// Resolve + apply the theme (data-theme on <html>) before anything renders.
initTheme()

import React from 'react'
import ReactDOM from 'react-dom/client'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
import './index.css'

// Register the PWA service worker. Only in production (Vite dev server
// strips the SW header to avoid stale cache during HMR sessions).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration is best-effort; failures don't break the app.
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
