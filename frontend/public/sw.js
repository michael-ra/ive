// IVE service worker. Cache the app shell so the PWA opens offline; never
// cache /api/* or /ws (live data + WebSocket upgrade). Push handler is a
// stub so the manifest can be installed today; PR 4 (catch-me-up) will
// fill in the body.
const CACHE = 'ive-shell-v3'
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest', '/theme-bootstrap.js']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL).catch(() => null),
    ).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('ive-shell-') && k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  // Never cache live endpoints.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/preview/') ||
    url.pathname.startsWith('/auth') ||
    url.pathname === '/join'
  ) {
    return  // default network behavior
  }
  if (event.request.method !== 'GET') return

  const navigation = event.request.mode === 'navigate'
  const shell = SHELL.includes(url.pathname)
  const asset = url.pathname.startsWith('/assets/')
  if (!navigation && !shell && !asset) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    // Built assets have content hashes. HTML and public bootstrap files do
    // not: revalidate them so an installed PWA can actually receive fixes.
    if (asset && !navigation) {
      const hit = await cache.match(event.request)
      if (hit) return hit
    }
    try {
      const response = await fetch(event.request, asset ? undefined : { cache: 'no-cache' })
      if ((shell || asset) && response.status === 200 && response.type === 'basic' && !response.redirected) {
        // Quota/cache failures must not break an otherwise healthy response.
        await cache.put(event.request, response.clone()).catch(() => {})
      }
      return response
    } catch (error) {
      const hit = await cache.match(event.request)
      if (hit) return hit
      // Returning HTML for a missing script masks the real failure and is
      // rejected by nosniff. The app-shell fallback is for page loads only.
      if (navigation) {
        const page = await cache.match('/index.html') || await cache.match('/')
        if (page) return page
      }
      throw error
    }
  })())
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const title = data.title || 'IVE'
  const opts = {
    body: data.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { url: data.url || '/' },
    // Tag dedupes successive notifications for the same session/event:
    // a fresh "session done" replaces the previous one rather than
    // stacking up on the user's lockscreen.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
  }
  event.waitUntil(self.registration.showNotification(title, opts))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(url) && 'focus' in w) return w.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    }),
  )
})
