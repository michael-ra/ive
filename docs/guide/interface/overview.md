---
title: Interface Overview
---

# Interface Overview

IVE's UI is divided into four zones:

![Main interface layout](../../screenshots/main-layout.png)

![Plan Workflow](/plan-workflow.svg)

## Sidebar (left)

The sidebar shows your **workspace tree** and **session list**. Each workspace is a folder on disk, color-coded for quick identification. Sessions within each workspace appear below it.

- Press **⌘\** to toggle the sidebar
- Right-click any session for a context menu (rename, clone, export, delete)
- Drag sessions to reorder them
- The **mailbox pill** at the bottom shows unread notifications

## Top bar

The top bar shows the current workspace name and session configuration. It also exposes quick controls for model, permission mode, and effort level.

## Terminal (center)

The main area is an **xterm.js terminal** running your CLI session. It behaves like a real terminal — keyboard shortcuts, ANSI colors, and interactive prompts all work.

Message markers appear at the start of each Claude response, letting you jump between them with **⌘⇧↑/↓**.

## Status bar (bottom)

The status bar shows:
- WebSocket connection state
- Current session status (running / idle / exited)
- Token usage for the active session
- Quick action buttons

## Panels (overlays)

Most features open as overlay panels. Press the corresponding keyboard shortcut or use the Command Palette (⌘K) to open them. All panels can be closed with **Escape**.

| Panel | Shortcut |
|-------|----------|
| Feature Board | ⌘B |
| Mission Control | ⌘M |
| Guidelines | ⌘G |
| Research | ⌘R |
| Inbox | ⌘I |
| Agent Tree | ⌘T |
| Code Review | ⌘⇧G |

## Related

- [Sidebar](./sidebar) — workspace and session management
- [Session Tabs](./session-tabs) — tab bar and split view
- [Keyboard Shortcuts](../keyboard-shortcuts) — full shortcut reference
