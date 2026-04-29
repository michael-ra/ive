---
title: Sharing Modes
---

# Sharing Modes

IVE has three runtime modes that control who can reach your instance. Switch between them from the **Sharing** panel — open it from Cmd+K and search "Sharing".

| Mode | Reachable from | When to use |
|------|----------------|-------------|
| **Off** | localhost only | Default. You're the only person on the box. |
| **Local** | Your LAN | You want your phone or a teammate's laptop on the same Wi-Fi to reach IVE. |
| **Tunnel** | Public URL via Cloudflare | You want to code from your phone outside the house, or hand a friend a link. |

Switching modes is non-destructive — sessions keep running, the page just rebinds.

## Off (default)

The backend listens on `127.0.0.1:5111` only. Nothing on your LAN can reach it. This is the right setting for solo work.

## Local

The backend listens on `0.0.0.0:5111` so other devices on your LAN can reach `http://<your-ip>:5111`. Auth is still required — anyone connecting needs the AUTH_TOKEN or a redeemed [invite](./invites).

When you flip to Local, the Sharing panel shows the LAN URL and a QR code that drops your phone straight onto the right address.

## Tunnel

IVE spawns a Cloudflare quick tunnel (`cloudflared tunnel --url`) and prints the public `*.trycloudflare.com` URL. Anyone with the link plus a valid auth token or invite can connect.

::: warning
Tunnel mode exposes IVE to the internet. The legacy `?token=` URL grant is disabled while the tunnel is active — visitors must redeem an invite or paste the token into the auth form, which mints a revocable joiner session. See [Joiner Sessions](./joiner-sessions).
:::

You'll see a red banner in the terminal where IVE is running while the tunnel is up. Closing the panel or switching to Off tears the tunnel down.

## Mode persistence

Your choice is saved. If you boot IVE next time and the previous mode was Tunnel, IVE prompts before re-establishing it.

## Related

- [Invites & QR Codes](./invites) — hand out time-limited access
- [Joiner Sessions](./joiner-sessions) — Brief / Code / Full clamps
- [Mobile Install](../mobile/install) — PWA + push notifications
