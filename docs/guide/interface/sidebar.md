---
title: Sidebar
---

# Sidebar

The sidebar (⌘\) shows your workspace tree and session list.

## Layout

```
┌─────────────────┐
│ ● Workspace A   │  ← workspace (colored dot)
│   • Session 1   │  ← session (status dot)
│   • Session 2   │
│ ● Workspace B   │
│   • Session 3   │
└─────────────────┘
```

## Workspaces

Each workspace is a folder on disk, shown with a color-coded dot. Click a workspace header to expand/collapse its sessions.

**Workspace context menu** (right-click):
- Rename workspace
- Change color
- Open in Finder / IDE
- Workspace settings
- Create Commander session
- Delete workspace

## Sessions

Each session shows a status indicator:
- **Green dot** — running (Claude is working)
- **Yellow dot** — idle (waiting for input)
- **Gray dot** — exited

**Session context menu** (right-click):
- Rename session
- Clone session
- Export (markdown or JSON)
- Copy output to clipboard
- Open in split view
- Delete session

## Drag-and-drop

Drag sessions to reorder them within a workspace. The order is persisted.

## Mailbox pill

The bottom of the sidebar shows a notification badge (mailbox pill) when there are unread messages in the Inbox or peer messages waiting.

## Collapsing

Press **⌘\** to toggle the sidebar. When collapsed, more terminal space is available. The sidebar can also be auto-hidden based on General Settings.

## Related

- [Session Tabs](./session-tabs) — tab bar for open sessions
- [Workspaces API](../../api/workspaces) — workspace management endpoints
