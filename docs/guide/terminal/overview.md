---
title: Terminal
---

# Terminal

Each session runs in a full **xterm.js** terminal emulator, backed by a real PTY process.

![Multi-Agent Terminals](/multi-agent-terminals.svg)

## Features

- **Full terminal emulation** — ANSI colors, cursor movement, inline images all work
- **Interactive prompts** — Shift+Tab for plan mode, slash commands, tool approvals
- **Message markers** — jump between Claude's responses with ⌘⇧↑/↓
- **Context menu** — right-click to copy, clear, or annotate
- **Token badge** — floating badge shows current token count

## Keyboard navigation

| Shortcut | Action |
|----------|--------|
| ⌘⇧↑ | Jump to previous message start |
| ⌘⇧↓ | Jump to next message start |
| ⌘. | Stop the session (SIGTERM) |

## @-token expansion

Type `@` in the terminal to trigger token expansion. Available tokens:

| Token | Expands to |
|-------|-----------|
| `@prompt:Name` | Contents of a saved prompt |
| `@research:Topic` | A research query |
| `@ralph:Prompt` | RALPH mode execution |

A floating badge shows a preview of what the token will expand to before you send.

## Output capture

Commander automatically captures session output. Access captures via:
- `GET /api/sessions/:id/captures` — list captures with timestamps
- `GET /api/sessions/:id/output` — raw PTY output

## Force message (Shift+Enter)

Pressing **Shift+Enter** opens the Force Bar — type a message to interrupt the current task and inject new instructions. This sends an Escape signal followed by your message.

## Related

- [Composer](./composer) — structured multi-line input
- [Broadcast](./broadcast) — send to multiple sessions
- [Force Message](./force-message) — interrupt and inject
