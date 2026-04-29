---
title: API Keys
---

# API Keys

The API Keys panel is where you store credentials for everything IVE talks to outside Claude / Gemini themselves: GitHub, Brave Search, Product Hunt, SearXNG, your raw Anthropic / Google / Hugging Face keys.

## Owner-only

This panel is gated to the **Full** mode and only the owner. Joiners — Brief, Code, or Full — cannot read, list, or modify these keys. Even the API endpoints (`GET/PUT /api/api-keys`) return 403 for any non-owner request.

A session running under one of your accounts can still *use* the keys (because the agent inherits your environment), but a friend driving that session can't lift the credentials off your machine.

## What's in the panel

| Key | Used by |
|-----|---------|
| **GitHub Token** | Plugin/skill registry sync, Observatory feeds |
| **Brave API Key** | Premium search backend in Deep Research |
| **Product Hunt** | Observatory daily feed |
| **SearXNG URL** | Self-hosted meta-search backend |
| **Anthropic** | Direct API mode in `llm_router` (when no installed CLI is available) |
| **Google** | Same, for Gemini |
| **Hugging Face** | Optional model downloads |

None of these are required to start using IVE. Deep Research works on DuckDuckGo, arXiv, Semantic Scholar, and GitHub without any key. Brave and SearXNG simply *light up extra signal* when configured.

## Adding a key

1. Open **Settings → API Keys**.
2. Paste the key into the row.
3. Click **Save**. The full value is stored in `~/.ive/data.db`; the panel only ever shows the last 4 characters as a preview.

## Testing a key

Click **Test** next to a key — IVE sends a low-cost request to verify it. The result shows next to the row.

## Where they're persisted

Encrypted at rest by SQLite + filesystem permissions on `~/.ive/data.db`. They never leave the local machine and are never synced through Cloudflare's tunnel — even when Tunnel mode is active, the API Keys API path is owner-gated.

## Related

- [Accounts](./accounts) — Claude / Gemini OAuth and API key accounts (separate concept)
- [Sharing Modes](../sharing/modes) — who can reach the panel at all
- [Joiner Sessions](../sharing/joiner-sessions) — what joiners can / can't see
