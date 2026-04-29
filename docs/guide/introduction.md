---
title: Introduction
---

# IVE

IVE is a local web app for controlling multiple Claude Code and Gemini CLI terminals from a single browser UI.

![IVE main interface](../screenshots/main-layout.png)

## What it does

Instead of juggling multiple terminal windows, IVE gives you:

- **Multi-session management** — run many Claude Code or Gemini CLI agents simultaneously in browser tabs
- **Full terminal emulation** — real PTY sessions with xterm.js (Shift+Tab, plan mode, slash commands all work)
- **Kanban task board** — built-in project management tied to your agent sessions
- **Research engine** — self-hosted deep research with web search and source citation
- **MCP integration** — attach MCP servers per-session, manage them from a UI
- **Broadcast & orchestration** — send prompts to multiple sessions at once, chain them with cascades
- **Sharing & multiplayer** — hand a friend a [4-word invite](./sharing/invites) and they land in your agent army with [clamped access](./sharing/joiner-sessions)
- **Mobile** — [install IVE to your phone's home screen](./mobile/install) and code from anywhere with push notifications
- **Voice walkthroughs** — [hold ⌘R](./screenshots) to record screen + voice over the live preview, paste straight into the session
- **Catch-up briefing** — [step away for a week](./sessions/catchup), come back to a 2–5 sentence summary of everything that shipped

## Architecture overview

```
Browser (localhost:5173)
  └── React 19 + xterm.js + Zustand
        ↕ WebSocket /ws  +  REST /api
Backend (localhost:5111)
  └── Python aiohttp
        ├── PTY sessions (os.fork + pty.openpty)
        ├── SQLite database (~/.ive/data.db)
        ├── Hook relay (CLI lifecycle events)
        └── Deep research subprocess
```

Everything runs locally — no external services, no cloud.

## Two supported CLIs

| CLI | Models | Notes |
|-----|--------|-------|
| **Claude Code** | Haiku, Sonnet, Opus | Full feature support |
| **Gemini CLI** | Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash, 3-flash-preview, 3.1-pro-preview | Subset of features |

## Key concepts

- **Workspace** — a folder on disk. Each workspace has its own color, sessions, and settings.
- **Session** — a real terminal running `claude` or `gemini` interactively.
- **Guidelines** — reusable system-prompt fragments attached per-session.
- **Cascade** — a sequential chain of prompts executed automatically.
- **RALPH mode** — an autonomous execute → verify → fix loop (up to 20 iterations).

## Related

- [Installation](./installation) — set up and run
- [Quick Start](./quick-start) — create your first session
- [Keyboard Shortcuts](./keyboard-shortcuts) — full shortcut reference
