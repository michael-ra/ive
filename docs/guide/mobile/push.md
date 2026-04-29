---
title: Push Notifications
---

# Push Notifications

IVE supports Web Push so you can step away from the laptop and still hear when a session needs you. Notifications fire on session-idle, plan-ready, and pipeline events.

## Opting in

1. Install IVE on your phone — see [Mobile Install](./install).
2. In the running PWA, open **Settings → Notifications** (or the prompt that appears on first launch).
3. Tap **Enable**. The browser asks for permission.
4. Done — IVE registers your endpoint with the server and starts delivering pushes.

## What triggers a push

| Event | Default |
|-------|---------|
| Session goes idle (Stop hook fired) | On |
| Plan ready for review | On |
| Pipeline run finished or failed | On |
| Quota exceeded on a running session | On |
| New peer message in workspace | Off |

Toggle each one in Settings → Notifications.

## VAPID keys

The first time a client subscribes, IVE generates a VAPID keypair and stores it in `~/.ive/vapid.json` with mode `0600`. The public key is exposed via `GET /api/push/vapid-pubkey`. You don't need to set this up — it's automatic.

## What if it doesn't work

- **LAN-HTTP installs** — Web Push requires HTTPS. On Local mode over plain HTTP, the browser refuses to subscribe. Use Tunnel mode (which is HTTPS via Cloudflare) for push to work.
- **iOS** — Web Push works only when IVE is installed to the home screen, not in Safari directly. iOS 16.4+.
- **`pywebpush` missing** — IVE degrades gracefully. The Settings page shows "push unavailable" instead of crashing. Install it with `pip install pywebpush` in the IVE venv.

## Privacy

Notifications are delivered through your browser vendor's push service (Apple, Google, Mozilla). The payload contains only the event type and a short label — never source code, prompts, or secrets. The full data stays on your IVE server.

## Related

- [Mobile Install](./install) — PWA setup
- [Sharing Modes](../sharing/modes) — Tunnel mode for HTTPS
