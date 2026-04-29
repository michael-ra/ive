---
title: Invites & QR Codes
---

# Invites & QR Codes

When you're sharing IVE on a LAN or a tunnel, an invite is the safest way to hand out access. Each invite carries the **mode** (Brief / Code / Full) and a TTL — when somebody redeems it they get their own session that you can revoke at any time.

## Why invites instead of the auth token

The legacy `AUTH_TOKEN` is a single shared secret. If you hand it out and want to take it back, your only option is rotating it everywhere. Invites mint per-person sessions, so revocation is one click.

## Three projections of the same secret

Every invite has three encodings of the same underlying random key. Pick whichever the recipient can act on fastest:

| Form | Looks like | Best for |
|------|-----------|----------|
| **4-word passcode** | `harbor-velvet-orbit-cobra` | Reading aloud over a call |
| **Compact code** | `K7QM-9R3F-PWVD` | Copy/paste, dictation |
| **QR code** | square image | In-person — point a phone at it |

The 4-word passcode comes from the EFF Long wordlist (7,776 words). It's designed to be unambiguous when spoken — "harbor" never sounds like "velvet".

## Creating an invite

1. Open **Sharing** from Cmd+K.
2. Click **New Invite**.
3. Choose the mode (see [Joiner Sessions](./joiner-sessions) for what each mode allows).
4. Set the TTL — anywhere from 15 minutes to 30 days.
5. Optionally add a label so future-you remembers who it was for.

You'll get all three projections at once. Send whichever fits.

## Redeeming

The recipient opens IVE's URL and either:

- **Pastes the passcode** at `/join`. The form takes any of the three forms. After 5 wrong attempts the invite burns.
- **Scans the QR**. The QR contains a magic-link `/join?t=…` URL — link previews in some chat apps will burn the token by following the URL, so the QR path is reserved for in-person.

Once redeemed, IVE sets a session cookie on the recipient's browser. They're now a [joiner](./joiner-sessions) — clamped to the mode you chose.

## Single-use, rate-limited

- Each invite redeems exactly once.
- 5 wrong attempts on a known invite burns it.
- Unknown-token brute force is rate-limited per IP.

## Listing & revoking invites

The Sharing panel shows your active invites with their label, mode, expiry, and redemption status. Revoking an unredeemed invite makes it un-redeemable; revoking a redeemed invite is a separate action — see [Joiner Sessions](./joiner-sessions).

## Related

- [Sharing Modes](./modes) — Off / Local / Tunnel
- [Joiner Sessions](./joiner-sessions) — what redemption gives a friend
- [API: Invites](../../api/overview) — programmatic minting
