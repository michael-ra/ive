---
title: Feature Board
---

# Feature Board

The Feature Board (⌘B) is a built-in Kanban board for managing tasks and features.

![Feature Board](../../screenshots/feature-board.png)

![Feature Board & Task Management](/feature-board-tasks.svg)

## Columns

Tasks flow through six columns representing their lifecycle:

| Column | Meaning |
|--------|---------|
| **Backlog** | Ideas and future work |
| **To Do** | Prioritized, ready to start |
| **Planning** | Being designed or scoped |
| **In Progress** | Actively being worked on |
| **Review** | Awaiting review or testing |
| **Done** | Completed |

## Workspace tabs

The board supports multiple workspaces. Switch between them with the workspace tabs at the top, or use `[` / `]` keyboard shortcuts.

## Creating tasks

- Click **New Task** to open the creation form
- Press **⌘⇧N** for the Quick Feature modal (minimal form for fast capture)

## Moving tasks

Drag a task card to a different column to change its status. The board updates immediately.

## Search and filter

Use the search bar at the top to filter tasks by title or description.

## Keyboard navigation

- **[** / **]** — switch workspace tabs
- **Arrow keys** — navigate cards (2D grid navigation)

## Integration with sessions

Tasks can be assigned to sessions. The Commander orchestrator uses the Feature Board to track worker session progress — it can create tasks, update their status, and mark them done as agents complete work.

## Related

- [Tasks](./tasks) — creating and editing tasks in detail
- [Quick Feature](./quick-feature) — rapid task capture
- [Commander](../agents/commander) — orchestrating agents with tasks
