---
title: Joiner Sessions & Modes
---

# Joiner Sessions & Modes

When someone redeems your [invite](./invites), IVE creates a **joiner session** for them. Their access is clamped to one of three modes — picked by you when you minted the invite.

## The three modes

| Mode | What they can do | What they can't |
|------|------------------|-----------------|
| **Brief** | Browse the board, create tasks, comment, give thumbs-up on plans | Drive sessions, run pipelines, see API keys, change MCP servers |
| **Code** | Drive PTY sessions in `auto` or `plan` mode, edit files, search the web | Run shell, change accounts, manage MCP servers, install plugins |
| **Full** | Owner-equivalent — anything you can do | Nothing. Use sparingly and with a short TTL. |

A joiner sees the same UI you do, with controls greyed out where their mode doesn't permit. Brief joiners see read-only badges on most action buttons; Code joiners see the permission mode locked.

## Bash in Code mode

By default, Code joiners cannot run shell commands. If you want them to, configure an allowlist in **Settings → General**: a list of safe binaries (e.g. `ls`, `cat`, `grep`, `git status`). Anything outside the allowlist is blocked at hook time.

## API keys are owner-only

Joiners — even Full — can use sessions backed by your API keys, but they can't read, list, or rotate the keys themselves. The API Keys panel returns 403 for anyone except the owner. See [API Keys](../settings/api-keys).

## Sliding TTL

Each joiner session has a sliding expiry: every request bumps `expires_at` forward by the TTL you set when minting the invite. There's a hard ceiling of 90 days from the original creation, regardless of how active the session is.

This means an idle session expires on schedule, but an active one stays alive without interruption — until the hard cap.

## Revoking

Open **Sharing → Active Sessions** and click revoke on any row.

Revocation is single-round-trip: the session's cookie stops working, and any open WebSocket the joiner has is closed within milliseconds. They land back on the auth screen on next interaction.

::: tip
Revoking a session does NOT burn the invite that minted it. If you want to make sure that invite can't mint a new session, revoke the invite too.
:::

## Owner indicator

The Sidebar shows your own mode as a coloured pill — `Brief`, `Code`, `Full`, or `Owner` if you're on localhost. Click it to log out.

## Localhost is always trusted

When IVE is reached from `127.0.0.1`, it skips auth entirely and treats you as Owner / Full. This is what makes the bootstrap CLI banner and MCP sub-processes work even after you've revoked every session.

In Tunnel mode, IVE checks Cloudflare's forwarding headers so a proxied request never gets localhost trust.

## Related

- [Invites & QR Codes](./invites) — minting access
- [Sharing Modes](./modes) — Off / Local / Tunnel
- [API Keys](../settings/api-keys) — owner-only key panel
