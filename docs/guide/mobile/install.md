---
title: Mobile Install (PWA)
---

# Mobile Install (PWA)

IVE is a Progressive Web App. Add it to your phone's home screen and it behaves like a native app — full-screen, its own icon, push notifications, even offline shell access for the cached pieces.

## What you need

- IVE running and reachable from your phone. Either:
  - **Same Wi-Fi** — flip [Sharing](../sharing/modes) to **Local** and use the LAN URL.
  - **Anywhere** — flip Sharing to **Tunnel** and use the public Cloudflare URL.
- A redeemed [invite](../sharing/invites), or the auth token paste flow on first load.

## iOS (Safari)

1. Open the IVE URL in Safari.
2. Tap the **Share** icon.
3. Tap **Add to Home Screen**.
4. Confirm the name. Done.

The app launches full-screen with a dark theme and the IVE icon. iOS doesn't expose `beforeinstallprompt`, so IVE pops a one-time hint with the steps above when it detects iOS without an install.

## Android (Chrome / Edge)

1. Open the IVE URL.
2. The browser shows an install banner — tap **Install**.
3. If you missed the banner, open the browser menu and pick **Install app** or **Add to Home Screen**.

## What works on mobile

- Full terminal — xterm.js works on touch with a software keyboard.
- Feature Board, Inbox, Sharing panel, Catch-up briefing, accounts.
- Push notifications when a session goes idle or finishes (see [Push Notifications](./push)).
- The app shell is cached, so launching from the home screen is instant even on slow connections.

## What doesn't

- Anything that needs `os.fork()` runs on the **server**, so the spawning machine has to be online and reachable. The phone just renders the UI.
- API responses are never cached — they always go to the server, so a stale page won't claim a session is alive when it isn't.

## Service worker

The service worker is at `/sw.js` and is registered automatically in production. It uses cache-first for the app shell and network-only for `/api/*`. Cached assets are version-pinned to the build so a redeploy invalidates them.

## Related

- [Push Notifications](./push) — opt-in alerts
- [Sharing Modes](../sharing/modes) — getting reachable from the phone
- [Invites](../sharing/invites) — get on a phone without typing the auth token
