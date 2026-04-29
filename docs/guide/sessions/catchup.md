---
title: Catch-up Briefing
---

# Catch-up Briefing

Step away for a coffee or a week. When you come back, IVE has a 2–5 sentence summary of what your agents shipped, what your team committed, and what the memory hub picked up.

## When it shows up

- **Banner**: appears automatically when your local "last seen" timestamp is more than 30 minutes old. Click it to open the full panel; click dismiss to hide it for this session.
- **Manually**: open from Cmd+K and search "Briefing", or hit the keyboard shortcut from the [Shortcuts panel](../keyboard-shortcuts).

## What's in the briefing

The panel merges three input streams into one summary:

1. **Events** — task moves, session lifecycle, pipeline runs, plans, peer messages, memory writes. Mode-aware: Brief joiners see only task / pipeline / plan / peer-message / memory events; Code and Full see everything.
2. **Git commits** — per-workspace commits in the window with shortstats (files changed, lines +/−).
3. **Memory hub** — workspace memory rows whose contents changed during the window.

These are fed to a small LLM (Haiku by default, swappable to Sonnet or Gemini Flash) for the prose summary. If the LLM call times out or fails, you still get a deterministic count fallback.

## Time ranges

Presets are one tap each:

| Preset | Range |
|--------|-------|
| 1h | Last hour |
| 8h | Last 8 hours |
| 24h | Last day |
| 7d | Last week |
| 30d | Last month |

Or use the **Custom** range with two datetime pickers for arbitrary windows.

## Per-workspace filtering

By default the briefing covers every workspace. Pick one from the dropdown to scope it to a single project — useful when you've been gone a while and only care about one repo's progress.

## Model toggle

Toggle between **Haiku** (fast, cheap, default) and **Sonnet** (slower, better at synthesizing larger windows). For 30-day briefings, Sonnet is usually worth the wait. Click **Regenerate** to re-run with the new model.

## Pieces under the prose

Below the summary you'll see:

- **Commits** — list with author, message, shortstat, link to diff.
- **Memory** — workspace + scope + change size.
- **Raw event log** — collapsible. Each event with a one-line description and a link to the relevant session / task.

## Related

- [Keyboard Shortcuts](../keyboard-shortcuts) — open from Cmd+K
- [Memory Sync](../memory/sync) — what populates the Memory section
- [Sharing Modes](../sharing/modes) — joiner-mode filtering of the event stream
