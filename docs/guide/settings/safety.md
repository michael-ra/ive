---
title: Safety Gate (AVCP) & Auto Auth Cycling
---

# Safety Gate & Auto Auth Cycling

Two safety nets that let you leave agents running unattended without having to babysit every install command or quota wall.

## Anti-Vibe-Code-Pwner (AVCP)

AVCP is a supply-chain scanner that runs on every package install your agents try to do — `npm install`, `pip install`, GitHub Actions, MCP servers — *before* the install actually executes.

It checks each package across nine signals: typo-squatting against popular names, suspicious post-install scripts, recently uploaded versions from new accounts, executable payloads in unusual file paths, network calls in install hooks, and a few more. Anything that looks like a packaged supply-chain attack gets blocked and surfaced in the **Safety Gate** panel.

### Where it hooks in

- **Claude Code** — `.claude/settings.json` ships a `PreToolUse` hook on `Bash` that intercepts `npm install`, `pip install`, etc.
- **Gemini CLI** — same idea, registered as a Gemini extension hook.
- **Shell wrapper** — optional system-wide protection for non-IVE installs.

### Configuring

Open **Settings → Safety Gate** to:

- See blocked installs and override individual ones (with reason).
- Set the strictness level — `strict` (default) blocks anything suspicious, `relaxed` only blocks high-confidence threats.
- Add packages to a per-workspace allowlist for things AVCP gets wrong.

### Zero external dependencies

AVCP is Python stdlib only. No SaaS, no API keys, no telemetry. The package data it inspects is fetched from public registries (npm, PyPI) and cached locally.

## Auto Auth Cycling

When a Claude Max account hits `quota_exceeded` mid-session, IVE doesn't make you wait for a refresh — it rotates to your next OAuth account in LRU order and the session keeps going.

### How it works

1. The CLI emits a `quota_exceeded` lifecycle event.
2. `auth_cycler.py` picks the next OAuth account by least-recently-used.
3. If the target account's auth snapshot is older than 1 hour or missing, IVE refreshes it via headless Playwright using the saved cookies.
4. `sessions.account_id` is swapped on the running session.
5. The frontend auto-restarts the PTY 1.5s later.

The agent doesn't notice. The user doesn't notice. The PR still ships.

### Enabling

Auto cycling is on by default behind the `experimental_auto_auth_cycling` flag — check **Settings → Experimental** to toggle it.

### Adding accounts to the rotation

See [Accounts](./accounts) for the OAuth account setup flow. The auto-snapshot on save means you don't have to click "Snapshot Auth" manually anymore — just save the form and IVE takes a fresh snapshot.

### What if every account is exhausted?

IVE pauses the session and surfaces a notification. You see a banner; the cycler waits for the next account to come off cooldown.

## Related

- [Accounts](./accounts) — OAuth and API key accounts
- [Experimental](./experimental) — feature flags
- [Sessions: Configuration](../sessions/configuration) — assigning accounts at start
