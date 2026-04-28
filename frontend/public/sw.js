// IVE service worker. Cache the app shell so the PWA opens offline; never
// cache /api/* or /ws (live data + WebSocket upgrade). Push handler is a
// stub so the manifest can be installed today; PR 4 (catch-me-up) will
// fill in the body.
const CACHE = 'ive-shell-v1'
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

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
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
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

  // Cache-first for the shell, network-fallback for everything else.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit
      return fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(event.request, copy))
          }
          return res
        })
        .catch(() => caches.match('/index.html'))
    }),
  )
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
