---
title: Keyboard Shortcuts
---

# Keyboard Shortcuts

All shortcuts use **⌘** (Cmd) on macOS or **Ctrl** on Linux/Windows.

Shortcuts are configurable — open the Shortcuts panel (⌘⇧K) to remap any binding.

![Shortcuts panel](../screenshots/shortcuts.png)

## Navigation

| Shortcut | Action |
|----------|--------|
| ⌘K | Open Command Palette |
| ⌘/ | Open Prompt Library |
| ⌘⇧Q | Open Quick Action Palette |
| ⌘F | Search across sessions |
| ⌘P | Preview palette (screenshot / open URL) |
| ⌘\ | Toggle sidebar |

## Panels

| Shortcut | Action |
|----------|--------|
| ⌘B | Feature Board (Kanban) |
| ⌘M | Mission Control (session dashboard) |
| ⌘G | Guidelines |
| ⌘⇧S | MCP Servers |
| ⌘T | Agent Tree (subagent hierarchy) |
| ⌘E | Composer (structured multi-line input) |
| ⌘⇧P | Scratchpad (per-session notes) |
| ⌘I | Inbox (pending/exited sessions) |
| ⌘R | Research Panel |
| ⌘J | Marketplace |
| ⌘⇧L | Skills Library |
| ⌘⇧R | Code Review |
| ⌘⇧A | Annotate terminal |
| ⌘⇧F | Quick Feature (fast task creation) |
| ⌘⇧K | Keyboard Shortcuts reference |

## Sessions

| Shortcut | Action |
|----------|--------|
| ⌘N | New session |
| ⌘W | Close current tab |
| ⌘. | Stop session |
| ⌘D | Split view |
| ⌘⇧↵ | Broadcast to selected sessions |
| ⇧↵ | Force message (interrupt + send) |
| ⌘U | Usage (opens claude.ai/settings/usage) |
| ⌘1–9 | Switch to tab N |

## Visual collaboration

| Shortcut | Action |
|----------|--------|
| ⌘P | Preview Palette (open URL or screenshot) |
| ⌘↵ | One-shot screenshot (in Live Preview) |
| ⌘R *(hold)* | Voice walkthrough — record screen + mic, paste into session on release |
| ⌘⇧A | Annotate terminal output |
| ⌘V | Paste image from clipboard into terminal |

## Sharing & Mobile

| Shortcut | Action |
|----------|--------|
| ⌘K → "Sharing" | Open the Sharing panel (mode, invites, joiners) |
| ⌘K → "Briefing" | Open the Catch-up briefing |

## Terminal navigation

| Shortcut | Action |
|----------|--------|
| ⌘⇧↑ | Jump to previous message in terminal |
| ⌘⇧↓ | Jump to next message in terminal |
| ⌘← | Jump to beginning of line |
| ⌘→ | Jump to end of line |
| ⌥← | Word-by-word cursor left |
| ⌥→ | Word-by-word cursor right |

## Grid navigation

| Shortcut | Action |
|----------|--------|
| ⌃⌥← ↑ → ↓ | Navigate grid cells spatially |

## Feature Board

| Shortcut | Action |
|----------|--------|
| `[` | Previous workspace tab |
| `]` | Next workspace tab |

## Task Modal

| Shortcut | Action |
|----------|--------|
| ⌥← | Previous tab |
| ⌥→ | Next tab |
| ⌥↑ | Previous field |
| ⌥↓ | Next field |

## Customizing shortcuts

1. Open the Shortcuts panel (⌘⇧K)
2. Click any binding to remap it
3. Press the new key combination
4. The panel detects conflicts with existing bindings

Customizations are stored in `localStorage` (`cc-keybindings`) and persist across sessions.
